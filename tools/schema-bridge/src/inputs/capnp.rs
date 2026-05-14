// Capnp → IR.
//
// Reads a `CodeGeneratorRequest` (as produced by `capnp compile -o<plugin>`)
// and lowers the subset we currently understand into IR. Anything we
// don't recognize becomes `SchemaBridgeError::UnmappedConstruct` —
// loud, immediate, build-breaking. See README §"Self-maintenance
// invariant".

use std::collections::HashMap;

use ::capnp::schema_capnp;

use crate::error::{Result, SchemaBridgeError};
use crate::ir::{Enum, FieldType, ScalarType, Schema, Struct, StructField, Union, UnionVariant};

// Sentinel capnp uses for a field that is NOT part of a discriminated
// union. Capnp ABI: `Field.discriminantValue` is `0xffff` (== max u16)
// for non-union fields.
const NO_DISCRIMINANT: u16 = 0xffff;

pub fn parse(
    request: schema_capnp::code_generator_request::Reader<'_>,
) -> Result<Schema> {
    let nodes = request.get_nodes()?;

    // Pass 1: catalog every named-type node id → short name AND keep a
    // Reader handle for each node so group resolution can hop from
    // field.typeId back to the group's anonymous struct without
    // re-scanning the whole list. Capnp Readers are zero-cost views
    // into the message arena, so storing them in a HashMap is fine.
    let mut struct_names: HashMap<u64, String> = HashMap::new();
    let mut enum_names: HashMap<u64, String> = HashMap::new();
    let mut node_by_id: HashMap<u64, schema_capnp::node::Reader<'_>> = HashMap::new();
    for node in nodes.iter() {
        node_by_id.insert(node.get_id(), node);
        match node.which()? {
            schema_capnp::node::Which::Struct(_) => {
                // Group nodes have isGroup=true; only catalog real
                // top-level struct names. Anonymous group structs
                // have empty short names anyway, but skipping them
                // here keeps `struct_names` clean for ref resolution.
                let n = short_name(node)?;
                if !n.is_empty() {
                    struct_names.insert(node.get_id(), n);
                }
            }
            schema_capnp::node::Which::Enum(_) => {
                enum_names.insert(node.get_id(), short_name(node)?);
            }
            _ => {}
        }
    }

    // Pass 2: emit IR. Non-struct/non-enum top-level nodes are
    // tolerated only for `file` (the schema's own container);
    // anything else is an unmapped construct. Anonymous group nodes
    // (isGroup=true) are skipped at the top level because they're
    // owned by their parent struct, not first-class IR entities.
    let mut schema = Schema::new();
    for node in nodes.iter() {
        let location = format!("node id={:x}", node.get_id());
        match node.which()? {
            schema_capnp::node::Which::File(_) => continue,
            schema_capnp::node::Which::Struct(s) => {
                if s.get_is_group() {
                    continue;
                }
                schema.structs.push(parse_struct(
                    node,
                    s,
                    &struct_names,
                    &enum_names,
                    &node_by_id,
                    &location,
                )?);
            }
            schema_capnp::node::Which::Enum(e) => {
                schema.enums.push(parse_enum(node, e)?);
            }
            schema_capnp::node::Which::Interface(_) => {
                return Err(SchemaBridgeError::unmapped("interface", location));
            }
            schema_capnp::node::Which::Const(_) => {
                return Err(SchemaBridgeError::unmapped("const", location));
            }
            schema_capnp::node::Which::Annotation(_) => {
                return Err(SchemaBridgeError::unmapped("annotation", location));
            }
        }
    }

    Ok(schema)
}

fn parse_enum(
    node: schema_capnp::node::Reader<'_>,
    e: schema_capnp::node::enum_::Reader<'_>,
) -> Result<Enum> {
    let name = short_name(node)?;
    let mut variants = Vec::new();
    for enumerant in e.get_enumerants()?.iter() {
        variants.push(enumerant.get_name()?.to_str()?.to_owned());
    }
    Ok(Enum { name, variants })
}

fn parse_struct<'a>(
    node: schema_capnp::node::Reader<'a>,
    s: schema_capnp::node::struct_::Reader<'a>,
    struct_names: &HashMap<u64, String>,
    enum_names: &HashMap<u64, String>,
    node_by_id: &HashMap<u64, schema_capnp::node::Reader<'a>>,
    location: &str,
) -> Result<Struct> {
    let name = short_name(node)?;

    // Direct anonymous union on the parent struct (`struct Foo {
    // union { … } }`) is a real capnp form but doesn't appear in
    // cloister today. Keep the error so it's visible the day someone
    // writes it.
    if s.get_discriminant_count() > 0 {
        return Err(SchemaBridgeError::unmapped(
            "anonymous inline union (use `name :union { … }` instead)",
            format!("{location} ({name})"),
        ));
    }

    let mut fields = Vec::new();
    let mut union: Option<Union> = None;

    for field in s.get_fields()?.iter() {
        let field_name = field.get_name()?.to_str()?.to_owned();
        let ordinal = field.get_code_order();
        let field_location = format!("{location} ({name}.{field_name})");

        match field.which()? {
            schema_capnp::field::Which::Slot(slot) => {
                let ty = field_type(slot.get_type()?, struct_names, enum_names, &field_location)?;
                fields.push(StructField {
                    name: field_name,
                    ordinal,
                    ty,
                });
            }
            schema_capnp::field::Which::Group(g) => {
                // A group field points at an anonymous struct node.
                // We only support the case where that node carries a
                // union (the `name :union { … }` sugar). Non-union
                // groups (plain field-namespacing groups) need a
                // separate emit shape and aren't used in cloister.
                let group_id = g.get_type_id();
                let group_node = node_by_id.get(&group_id).ok_or_else(|| {
                    SchemaBridgeError::UnresolvedReference {
                        name: format!("group node id={group_id:x}"),
                        location: field_location.clone(),
                    }
                })?;
                let group_struct = match group_node.which()? {
                    schema_capnp::node::Which::Struct(gs) => gs,
                    _ => {
                        return Err(SchemaBridgeError::SchemaShape(format!(
                            "group field {field_location} references non-struct node"
                        )));
                    }
                };
                if group_struct.get_discriminant_count() == 0 {
                    return Err(SchemaBridgeError::unmapped(
                        "non-union group",
                        field_location,
                    ));
                }
                if union.is_some() {
                    return Err(SchemaBridgeError::SchemaShape(format!(
                        "struct {name} has more than one union group; \
                         capnp permits only one union per struct"
                    )));
                }
                union = Some(parse_union(
                    &field_name,
                    group_struct,
                    struct_names,
                    enum_names,
                    node_by_id,
                    &field_location,
                )?);
            }
        }
    }

    Ok(Struct {
        name,
        fields,
        union,
    })
}

fn parse_union<'a>(
    discriminant_name: &str,
    group: schema_capnp::node::struct_::Reader<'a>,
    struct_names: &HashMap<u64, String>,
    enum_names: &HashMap<u64, String>,
    node_by_id: &HashMap<u64, schema_capnp::node::Reader<'a>>,
    location: &str,
) -> Result<Union> {
    let mut variants = Vec::new();
    for field in group.get_fields()?.iter() {
        let variant_name = field.get_name()?.to_str()?.to_owned();
        let variant_location = format!("{location}.{variant_name}");

        // Defensive: union variants always carry a discriminant value
        // (and non-variant fields shouldn't appear inside a union
        // group). If something with NO_DISCRIMINANT lands here, it's
        // a schema shape we don't understand.
        if field.get_discriminant_value() == NO_DISCRIMINANT {
            return Err(SchemaBridgeError::SchemaShape(format!(
                "field {variant_location} inside a union group has no \
                 discriminant value"
            )));
        }

        match field.which()? {
            schema_capnp::field::Which::Slot(slot) => {
                let ty = field_type(
                    slot.get_type()?,
                    struct_names,
                    enum_names,
                    &variant_location,
                )?;
                variants.push(UnionVariant {
                    name: variant_name,
                    ty,
                });
            }
            schema_capnp::field::Which::Group(_) => {
                // A union variant that is itself a group (sub-struct
                // of fields). Capnp permits this; we don't yet emit
                // it. Loud failure rather than silent.
                let _ = node_by_id; // (lookup deliberately unused here)
                return Err(SchemaBridgeError::unmapped(
                    "group variant inside union",
                    variant_location,
                ));
            }
        }
    }

    Ok(Union {
        discriminant_name: discriminant_name.to_owned(),
        variants,
    })
}

fn field_type(
    ty: schema_capnp::type_::Reader<'_>,
    struct_names: &HashMap<u64, String>,
    enum_names: &HashMap<u64, String>,
    location: &str,
) -> Result<FieldType> {
    use schema_capnp::type_::Which as TW;
    let which = ty.which()?;
    Ok(match which {
        TW::Void(()) => FieldType::Scalar(ScalarType::Void),
        TW::Bool(()) => FieldType::Scalar(ScalarType::Bool),
        TW::Int8(()) => FieldType::Scalar(ScalarType::Int8),
        TW::Int16(()) => FieldType::Scalar(ScalarType::Int16),
        TW::Int32(()) => FieldType::Scalar(ScalarType::Int32),
        TW::Int64(()) => FieldType::Scalar(ScalarType::Int64),
        TW::Uint8(()) => FieldType::Scalar(ScalarType::UInt8),
        TW::Uint16(()) => FieldType::Scalar(ScalarType::UInt16),
        TW::Uint32(()) => FieldType::Scalar(ScalarType::UInt32),
        TW::Uint64(()) => FieldType::Scalar(ScalarType::UInt64),
        TW::Float32(()) => FieldType::Scalar(ScalarType::Float32),
        TW::Float64(()) => FieldType::Scalar(ScalarType::Float64),
        TW::Text(()) => FieldType::Scalar(ScalarType::Text),
        TW::Data(()) => FieldType::Scalar(ScalarType::Data),
        TW::Struct(s) => {
            let id = s.get_type_id();
            let name = struct_names.get(&id).ok_or_else(|| {
                SchemaBridgeError::UnresolvedReference {
                    name: format!("struct id={id:x}"),
                    location: location.to_owned(),
                }
            })?;
            FieldType::StructRef(name.clone())
        }
        TW::List(list) => {
            let elem = field_type(list.get_element_type()?, struct_names, enum_names, location)?;
            FieldType::List(Box::new(elem))
        }
        TW::Enum(e) => {
            let id = e.get_type_id();
            let name = enum_names.get(&id).ok_or_else(|| {
                SchemaBridgeError::UnresolvedReference {
                    name: format!("enum id={id:x}"),
                    location: location.to_owned(),
                }
            })?;
            FieldType::EnumRef(name.clone())
        }
        TW::Interface(_) => {
            return Err(SchemaBridgeError::unmapped("interface (type ref)", location));
        }
        TW::AnyPointer(_) => {
            return Err(SchemaBridgeError::unmapped("anyPointer", location));
        }
    })
}

// Extract the unqualified name from a capnp node. `display_name` is the
// fully-qualified form like `"manifest/cli-config.capnp:EnabledItem"`;
// `display_name_prefix_length` marks where the filename ends.
fn short_name(node: schema_capnp::node::Reader<'_>) -> Result<String> {
    let display = node.get_display_name()?.to_str()?;
    let prefix = node.get_display_name_prefix_length() as usize;
    if prefix > display.len() {
        return Err(SchemaBridgeError::SchemaShape(format!(
            "display_name_prefix_length {prefix} exceeds display_name length {}",
            display.len()
        )));
    }
    Ok(display[prefix..].to_owned())
}
