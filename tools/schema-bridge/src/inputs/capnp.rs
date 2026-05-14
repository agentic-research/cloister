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
use crate::ir::{Enum, FieldType, ScalarType, Schema, Struct, StructField};

pub fn parse(
    request: schema_capnp::code_generator_request::Reader<'_>,
) -> Result<Schema> {
    let nodes = request.get_nodes()?;

    // Pass 1: catalog every named-type node id → short name. We need
    // this before walking fields because a field's type may reference
    // a struct or enum by id that appears later in the iteration order.
    let mut struct_names: HashMap<u64, String> = HashMap::new();
    let mut enum_names: HashMap<u64, String> = HashMap::new();
    for node in nodes.iter() {
        match node.which()? {
            schema_capnp::node::Which::Struct(_) => {
                struct_names.insert(node.get_id(), short_name(node)?);
            }
            schema_capnp::node::Which::Enum(_) => {
                enum_names.insert(node.get_id(), short_name(node)?);
            }
            _ => {}
        }
    }

    // Pass 2: emit IR. Non-struct/non-enum top-level nodes are
    // tolerated only for `file` (the schema's own container);
    // anything else is an unmapped construct.
    let mut schema = Schema::new();
    for node in nodes.iter() {
        let location = format!("node id={:x}", node.get_id());
        match node.which()? {
            schema_capnp::node::Which::File(_) => continue,
            schema_capnp::node::Which::Struct(s) => {
                schema
                    .structs
                    .push(parse_struct(node, s, &struct_names, &enum_names, &location)?);
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

fn parse_struct(
    node: schema_capnp::node::Reader<'_>,
    s: schema_capnp::node::struct_::Reader<'_>,
    struct_names: &HashMap<u64, String>,
    enum_names: &HashMap<u64, String>,
    location: &str,
) -> Result<Struct> {
    let name = short_name(node)?;

    // Discriminated unions inside structs (`union { … }`) are part of
    // v2. A struct with a non-zero discriminant_count has at least one
    // union field — flag it loudly rather than silently dropping
    // variants.
    if s.get_discriminant_count() > 0 {
        return Err(SchemaBridgeError::unmapped(
            "union (in-struct)",
            format!("{location} ({name})"),
        ));
    }

    let mut fields = Vec::new();
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
            schema_capnp::field::Which::Group(_) => {
                return Err(SchemaBridgeError::unmapped(
                    "group",
                    field_location,
                ));
            }
        }
    }

    Ok(Struct {
        name,
        fields,
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
