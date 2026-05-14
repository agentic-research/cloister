// Integration tests for schema-bridge.
//
// Build CodeGeneratorRequest messages by hand using capnp's builder
// API rather than shelling out to `capnp compile`. This keeps the
// test loop hermetic — no capnp CLI dependency, no fixture .capnp
// files to parse, just direct Rust → IR → zod.
//
// Coverage:
//   - golden: a struct with scalar fields → expected zod source
//   - golden: cross-struct reference → emits `OtherSchema`
//   - fail-case: list field → UnmappedConstruct("list")
//   - fail-case: top-level enum → UnmappedConstruct("enum")
//   - fail-case: in-struct union → UnmappedConstruct("union (in-struct)")
//   - fail-case: group field → UnmappedConstruct("group")

use capnp::message::{Builder, HeapAllocator};
use capnp::schema_capnp;

use schema_bridge::error::SchemaBridgeError;
use schema_bridge::{inputs, outputs};

fn parse(message: &Builder<HeapAllocator>) -> Result<schema_bridge::Schema, SchemaBridgeError> {
    let reader = message.get_root_as_reader::<schema_capnp::code_generator_request::Reader>()?;
    inputs::capnp::parse(reader)
}

// Set a node up as a file marker. Voids on capnp union variants are
// `set_<variant>(())` rather than `init_<variant>()` in 0.21+.
fn fill_file_node(mut n: schema_capnp::node::Builder<'_>, id: u64, display_name: &str) {
    n.set_id(id);
    n.set_display_name(display_name);
    n.set_display_name_prefix_length(0);
    n.set_file(());
}

// ── Golden: scalar struct ───────────────────────────────────────────

#[test]
fn struct_with_scalars_emits_zod() {
    let mut message = Builder::new_default();
    {
        let request = message.init_root::<schema_capnp::code_generator_request::Builder>();
        let mut nodes = request.init_nodes(2);
        fill_file_node(nodes.reborrow().get(0), 0xFFFE, "test.capnp");

        let mut node = nodes.reborrow().get(1);
        node.set_id(0xAAAA);
        node.set_display_name("test.capnp:Greeting");
        node.set_display_name_prefix_length("test.capnp:".len() as u32);
        let mut s = node.init_struct();
        s.set_discriminant_count(0);
        let mut fields = s.init_fields(2);
        {
            let mut field = fields.reborrow().get(0);
            field.set_name("subject");
            field.set_code_order(0);
            let mut slot = field.init_slot();
            slot.reborrow().init_type().set_text(());
        }
        {
            let mut field = fields.reborrow().get(1);
            field.set_name("loud");
            field.set_code_order(1);
            let mut slot = field.init_slot();
            slot.reborrow().init_type().set_bool(());
        }
    }

    let schema = parse(&message).expect("parse");
    let emitted = outputs::zod::emit(&schema).expect("emit");

    assert!(
        emitted.contains("export const GreetingSchema: z.ZodType<Greeting>"),
        "emit missing schema decl:\n{emitted}"
    );
    assert!(emitted.contains("subject: z.string()"), "emit:\n{emitted}");
    assert!(emitted.contains("loud: z.boolean()"), "emit:\n{emitted}");
    assert!(emitted.contains("export interface Greeting"), "emit:\n{emitted}");
    assert!(emitted.contains("subject: string;"), "emit:\n{emitted}");
    assert!(emitted.contains("loud: boolean;"), "emit:\n{emitted}");
}

// ── Golden: struct-to-struct reference ─────────────────────────────

#[test]
fn struct_ref_emits_named_schema() {
    let mut message = Builder::new_default();
    let outer_id: u64 = 0xAAAA;
    let inner_id: u64 = 0xBBBB;
    {
        let request = message.init_root::<schema_capnp::code_generator_request::Builder>();
        let mut nodes = request.init_nodes(3);
        fill_file_node(nodes.reborrow().get(0), 0xFFFE, "test.capnp");

        // Outer { inner :Inner; }
        {
            let mut node = nodes.reborrow().get(1);
            node.set_id(outer_id);
            node.set_display_name("test.capnp:Outer");
            node.set_display_name_prefix_length("test.capnp:".len() as u32);
            let mut s = node.init_struct();
            s.set_discriminant_count(0);
            let mut fields = s.init_fields(1);
            let mut field = fields.reborrow().get(0);
            field.set_name("inner");
            field.set_code_order(0);
            let mut slot = field.init_slot();
            let ty = slot.reborrow().init_type();
            let mut sty = ty.init_struct();
            sty.set_type_id(inner_id);
        }

        // Inner { tag :Text; }
        {
            let mut node = nodes.reborrow().get(2);
            node.set_id(inner_id);
            node.set_display_name("test.capnp:Inner");
            node.set_display_name_prefix_length("test.capnp:".len() as u32);
            let mut s = node.init_struct();
            s.set_discriminant_count(0);
            let mut fields = s.init_fields(1);
            let mut field = fields.reborrow().get(0);
            field.set_name("tag");
            field.set_code_order(0);
            let mut slot = field.init_slot();
            slot.reborrow().init_type().set_text(());
        }
    }

    let schema = parse(&message).expect("parse");
    let emitted = outputs::zod::emit(&schema).expect("emit");

    assert!(emitted.contains("inner: InnerSchema"), "emit:\n{emitted}");
    assert!(emitted.contains("inner: Inner;"), "emit:\n{emitted}");
}

// ── Golden: list of scalars ────────────────────────────────────────

#[test]
fn list_of_scalars_emits_array() {
    let mut message = Builder::new_default();
    {
        let request = message.init_root::<schema_capnp::code_generator_request::Builder>();
        let mut nodes = request.init_nodes(2);
        fill_file_node(nodes.reborrow().get(0), 0xFFFE, "test.capnp");

        let mut node = nodes.reborrow().get(1);
        node.set_id(0xAAAA);
        node.set_display_name("test.capnp:HasList");
        node.set_display_name_prefix_length("test.capnp:".len() as u32);
        let mut s = node.init_struct();
        s.set_discriminant_count(0);
        let mut fields = s.init_fields(1);
        let mut field = fields.reborrow().get(0);
        field.set_name("tags");
        field.set_code_order(0);
        let mut slot = field.init_slot();
        let ty = slot.reborrow().init_type();
        let list = ty.init_list();
        list.init_element_type().set_text(());
    }

    let schema = parse(&message).expect("parse");
    let emitted = outputs::zod::emit(&schema).expect("emit");
    assert!(
        emitted.contains("tags: z.array(z.string())"),
        "emit:\n{emitted}"
    );
    assert!(emitted.contains("tags: string[];"), "emit:\n{emitted}");
}

// ── Golden: nested list of lists ───────────────────────────────────

#[test]
fn list_of_lists_recurses() {
    let mut message = Builder::new_default();
    {
        let request = message.init_root::<schema_capnp::code_generator_request::Builder>();
        let mut nodes = request.init_nodes(2);
        fill_file_node(nodes.reborrow().get(0), 0xFFFE, "test.capnp");

        let mut node = nodes.reborrow().get(1);
        node.set_id(0xAAAA);
        node.set_display_name("test.capnp:Matrix");
        node.set_display_name_prefix_length("test.capnp:".len() as u32);
        let mut s = node.init_struct();
        s.set_discriminant_count(0);
        let mut fields = s.init_fields(1);
        let mut field = fields.reborrow().get(0);
        field.set_name("rows");
        field.set_code_order(0);
        let mut slot = field.init_slot();
        let outer = slot.reborrow().init_type().init_list();
        let inner = outer.init_element_type().init_list();
        inner.init_element_type().set_int32(());
    }

    let schema = parse(&message).expect("parse");
    let emitted = outputs::zod::emit(&schema).expect("emit");
    assert!(
        emitted.contains("rows: z.array(z.array(z.number().int()))"),
        "emit:\n{emitted}"
    );
    assert!(emitted.contains("rows: number[][];"), "emit:\n{emitted}");
}

// ── Regression-guard: list of an unmapped element still errors ────

#[test]
fn list_of_unmapped_element_fails_fast() {
    let mut message = Builder::new_default();
    {
        let request = message.init_root::<schema_capnp::code_generator_request::Builder>();
        let mut nodes = request.init_nodes(2);
        fill_file_node(nodes.reborrow().get(0), 0xFFFE, "test.capnp");

        let mut node = nodes.reborrow().get(1);
        node.set_id(0xAAAA);
        node.set_display_name("test.capnp:HasInterfaces");
        node.set_display_name_prefix_length("test.capnp:".len() as u32);
        let mut s = node.init_struct();
        s.set_discriminant_count(0);
        let mut fields = s.init_fields(1);
        let mut field = fields.reborrow().get(0);
        field.set_name("services");
        field.set_code_order(0);
        let mut slot = field.init_slot();
        let ty = slot.reborrow().init_type();
        let list = ty.init_list();
        let elem = list.init_element_type();
        elem.init_interface();
    }

    let err = parse(&message).expect_err("must reject list-of-interface");
    match err {
        SchemaBridgeError::UnmappedConstruct { kind, .. } => {
            assert_eq!(kind, "interface (type ref)");
        }
        other => panic!("expected UnmappedConstruct('interface (type ref)'), got {other:?}"),
    }
}

// ── Golden: top-level enum + struct field of enum type ─────────────

#[test]
fn enum_emits_zod_enum_and_string_union() {
    let mut message = Builder::new_default();
    let enum_id: u64 = 0xCCCC;
    {
        let request = message.init_root::<schema_capnp::code_generator_request::Builder>();
        let mut nodes = request.init_nodes(3);
        fill_file_node(nodes.reborrow().get(0), 0xFFFE, "test.capnp");

        // Enum Tier { hypervisor @0; cluster @1; }
        {
            let mut n = nodes.reborrow().get(1);
            n.set_id(enum_id);
            n.set_display_name("test.capnp:Tier");
            n.set_display_name_prefix_length("test.capnp:".len() as u32);
            let e = n.init_enum();
            let mut enumerants = e.init_enumerants(2);
            enumerants.reborrow().get(0).set_name("hypervisor");
            enumerants.reborrow().get(1).set_name("cluster");
        }

        // struct Bundle { tier @0 :Tier; }
        {
            let mut n = nodes.reborrow().get(2);
            n.set_id(0xAAAA);
            n.set_display_name("test.capnp:Bundle");
            n.set_display_name_prefix_length("test.capnp:".len() as u32);
            let mut s = n.init_struct();
            s.set_discriminant_count(0);
            let mut fields = s.init_fields(1);
            let mut field = fields.reborrow().get(0);
            field.set_name("tier");
            field.set_code_order(0);
            let mut slot = field.init_slot();
            let ty = slot.reborrow().init_type();
            let mut et = ty.init_enum();
            et.set_type_id(enum_id);
        }
    }

    let schema = parse(&message).expect("parse");
    let emitted = outputs::zod::emit(&schema).expect("emit");
    assert!(
        emitted.contains(r#"export const TierSchema = z.enum(["hypervisor", "cluster"]);"#),
        "emit:\n{emitted}"
    );
    assert!(
        emitted.contains(r#"export type Tier = "hypervisor" | "cluster";"#),
        "emit:\n{emitted}"
    );
    assert!(emitted.contains("tier: TierSchema"), "emit:\n{emitted}");
    assert!(emitted.contains("tier: Tier;"), "emit:\n{emitted}");
}

// ── Regression-guard: anonymous inline union ──────────────────────
//
// `struct Foo { union { … } }` (no group wrapper). Real capnp form
// but cloister's schemas always use the `name :union { … }` sugar,
// so we don't emit for it yet. Kept as a fail-fast so a schema
// change to this form lights up.

#[test]
fn anonymous_inline_union_fails_fast() {
    let mut message = Builder::new_default();
    {
        let request = message.init_root::<schema_capnp::code_generator_request::Builder>();
        let mut nodes = request.init_nodes(2);
        fill_file_node(nodes.reborrow().get(0), 0xFFFE, "test.capnp");

        let mut node = nodes.reborrow().get(1);
        node.set_id(0xAAAA);
        node.set_display_name("test.capnp:Variant");
        node.set_display_name_prefix_length("test.capnp:".len() as u32);
        let mut s = node.init_struct();
        s.set_discriminant_count(2);
    }

    let err = parse(&message).expect_err("must reject anonymous inline union");
    match err {
        SchemaBridgeError::UnmappedConstruct { kind, .. } => {
            assert!(
                kind.starts_with("anonymous inline union"),
                "got kind {kind:?}"
            );
        }
        other => panic!("expected UnmappedConstruct, got {other:?}"),
    }
}

// ── Regression-guard: non-union group field ────────────────────────
//
// `struct Foo { thing :group { a @0 :Int32 } }` (group field whose
// target struct has no union) is a real capnp form for field
// namespacing. Unused in cloister; reject loudly.

#[test]
fn non_union_group_fails_fast() {
    let mut message = Builder::new_default();
    let outer_id: u64 = 0xAAAA;
    let group_id: u64 = 0xBBBB;
    {
        let request = message.init_root::<schema_capnp::code_generator_request::Builder>();
        let mut nodes = request.init_nodes(3);
        fill_file_node(nodes.reborrow().get(0), 0xFFFE, "test.capnp");

        // Outer struct with a `nested` group field.
        {
            let mut node = nodes.reborrow().get(1);
            node.set_id(outer_id);
            node.set_display_name("test.capnp:WithGroup");
            node.set_display_name_prefix_length("test.capnp:".len() as u32);
            let mut s = node.init_struct();
            s.set_discriminant_count(0);
            let mut fields = s.init_fields(1);
            let mut field = fields.reborrow().get(0);
            field.set_name("nested");
            field.set_code_order(0);
            field.set_discriminant_value(0xffff);
            let mut group = field.init_group();
            group.set_type_id(group_id);
        }

        // The group node — a struct with no union (discriminant_count = 0).
        {
            let mut node = nodes.reborrow().get(2);
            node.set_id(group_id);
            node.set_display_name("test.capnp:WithGroup.nested");
            node.set_display_name_prefix_length("test.capnp:".len() as u32);
            let mut s = node.init_struct();
            s.set_is_group(true);
            s.set_discriminant_count(0);
            // Field on the group — body doesn't matter for the test.
            let mut fields = s.init_fields(1);
            let mut field = fields.reborrow().get(0);
            field.set_name("a");
            field.set_code_order(0);
            let mut slot = field.init_slot();
            slot.reborrow().init_type().set_int32(());
        }
    }

    let err = parse(&message).expect_err("must reject non-union group");
    match err {
        SchemaBridgeError::UnmappedConstruct { kind, .. } => {
            assert_eq!(kind, "non-union group");
        }
        other => panic!("expected UnmappedConstruct('non-union group'), got {other:?}"),
    }
}

// ── Golden: named union via group, struct variants ────────────────
//
// The shape used by `Backend.kind :union { durableObject @2 :DoBackend;
// httpForward @3 :HttpForwardBackend; … }` in manifest/cloister.capnp.

#[test]
fn named_union_struct_variants_emits_discriminated_union() {
    let mut message = Builder::new_default();
    let backend_id: u64 = 0xAAAA;
    let kind_group_id: u64 = 0xBBBB;
    let do_backend_id: u64 = 0xCCCC;
    let http_backend_id: u64 = 0xDDDD;
    {
        let request = message.init_root::<schema_capnp::code_generator_request::Builder>();
        let mut nodes = request.init_nodes(5);
        fill_file_node(nodes.reborrow().get(0), 0xFFFE, "test.capnp");

        // Backend struct with name + kind union.
        {
            let mut node = nodes.reborrow().get(1);
            node.set_id(backend_id);
            node.set_display_name("test.capnp:Backend");
            node.set_display_name_prefix_length("test.capnp:".len() as u32);
            let mut s = node.init_struct();
            s.set_discriminant_count(0);
            let mut fields = s.init_fields(2);
            // name @0 :Text
            {
                let mut field = fields.reborrow().get(0);
                field.set_name("name");
                field.set_code_order(0);
                field.set_discriminant_value(0xffff);
                let mut slot = field.init_slot();
                slot.reborrow().init_type().set_text(());
            }
            // kind :group { union { ... } }
            {
                let mut field = fields.reborrow().get(1);
                field.set_name("kind");
                field.set_code_order(1);
                field.set_discriminant_value(0xffff);
                let mut group = field.init_group();
                group.set_type_id(kind_group_id);
            }
        }

        // The kind group: anonymous struct, discriminant_count = 2.
        {
            let mut node = nodes.reborrow().get(2);
            node.set_id(kind_group_id);
            node.set_display_name("test.capnp:Backend.kind");
            node.set_display_name_prefix_length("test.capnp:".len() as u32);
            let mut s = node.init_struct();
            s.set_is_group(true);
            s.set_discriminant_count(2);
            let mut fields = s.init_fields(2);
            // durableObject (discriminant 0) → :DoBackend
            {
                let mut field = fields.reborrow().get(0);
                field.set_name("durableObject");
                field.set_code_order(0);
                field.set_discriminant_value(0);
                let mut slot = field.init_slot();
                let ty = slot.reborrow().init_type();
                let mut sty = ty.init_struct();
                sty.set_type_id(do_backend_id);
            }
            // httpForward (discriminant 1) → :HttpForwardBackend
            {
                let mut field = fields.reborrow().get(1);
                field.set_name("httpForward");
                field.set_code_order(1);
                field.set_discriminant_value(1);
                let mut slot = field.init_slot();
                let ty = slot.reborrow().init_type();
                let mut sty = ty.init_struct();
                sty.set_type_id(http_backend_id);
            }
        }

        // DoBackend and HttpForwardBackend — trivial structs, refs only.
        for (i, (id, name)) in [(do_backend_id, "DoBackend"), (http_backend_id, "HttpForwardBackend")]
            .into_iter()
            .enumerate()
        {
            let mut node = nodes.reborrow().get(3 + i as u32);
            node.set_id(id);
            node.set_display_name(&format!("test.capnp:{name}"));
            node.set_display_name_prefix_length("test.capnp:".len() as u32);
            let mut s = node.init_struct();
            s.set_discriminant_count(0);
            s.init_fields(0);
        }
    }

    let schema = parse(&message).expect("parse");
    let emitted = outputs::zod::emit(&schema).expect("emit");

    // zod side: union variants are NESTED under the discriminant
    // name ("kind"), one variant per single-key object, with .strict()
    // to enforce exactly-one. This matches capnp's JSON convention:
    // `"kind": { "durableObject": {…} }`.
    assert!(
        emitted.contains("kind: z.union(["),
        "emit:\n{emitted}"
    );
    assert!(
        emitted.contains("z.object({ durableObject: DoBackendSchema }).strict()"),
        "emit:\n{emitted}"
    );
    assert!(
        emitted.contains("z.object({ httpForward: HttpForwardBackendSchema }).strict()"),
        "emit:\n{emitted}"
    );
    // No intersection wrapper now — base fields are siblings of the
    // nested union object in a single z.object().
    assert!(
        !emitted.contains("z.intersection"),
        "should NOT use z.intersection under the new shape.\nemit:\n{emitted}"
    );

    // TS side: interface with the union field typed as a nested-
    // object union.
    assert!(
        emitted.contains("export interface Backend {"),
        "emit:\n{emitted}"
    );
    assert!(
        emitted.contains("kind: { durableObject: DoBackend } | { httpForward: HttpForwardBackend };"),
        "emit:\n{emitted}"
    );
}

// ── Golden: named union with Void variants (pure discriminator) ───
//
// The shape used by `Wire.transport :union { uds @3 :Void; leylineNet
// @4 :Void; }` in manifest/cluster.capnp. No payload on either
// variant — just the discriminant.

#[test]
fn named_union_void_variants_omits_payload() {
    let mut message = Builder::new_default();
    let wire_id: u64 = 0xAAAA;
    let transport_group_id: u64 = 0xBBBB;
    {
        let request = message.init_root::<schema_capnp::code_generator_request::Builder>();
        let mut nodes = request.init_nodes(3);
        fill_file_node(nodes.reborrow().get(0), 0xFFFE, "test.capnp");

        // Wire struct: only the transport union, no base fields.
        {
            let mut node = nodes.reborrow().get(1);
            node.set_id(wire_id);
            node.set_display_name("test.capnp:Wire");
            node.set_display_name_prefix_length("test.capnp:".len() as u32);
            let mut s = node.init_struct();
            s.set_discriminant_count(0);
            let mut fields = s.init_fields(1);
            let mut field = fields.reborrow().get(0);
            field.set_name("transport");
            field.set_code_order(0);
            field.set_discriminant_value(0xffff);
            let mut group = field.init_group();
            group.set_type_id(transport_group_id);
        }

        // transport group: union { uds @3 :Void; leylineNet @4 :Void; }
        {
            let mut node = nodes.reborrow().get(2);
            node.set_id(transport_group_id);
            node.set_display_name("test.capnp:Wire.transport");
            node.set_display_name_prefix_length("test.capnp:".len() as u32);
            let mut s = node.init_struct();
            s.set_is_group(true);
            s.set_discriminant_count(2);
            let mut fields = s.init_fields(2);
            for (i, name) in ["uds", "leylineNet"].iter().enumerate() {
                let mut field = fields.reborrow().get(i as u32);
                field.set_name(name);
                field.set_code_order(i as u16);
                field.set_discriminant_value(i as u16);
                let mut slot = field.init_slot();
                slot.reborrow().init_type().set_void(());
            }
        }
    }

    let schema = parse(&message).expect("parse");
    let emitted = outputs::zod::emit(&schema).expect("emit");

    // zod: Void variants emit as `{ name: z.null() }` (matches
    // capnp's JSON convention `"transport": { "uds": null }`).
    assert!(
        emitted.contains("transport: z.union(["),
        "emit:\n{emitted}"
    );
    assert!(
        emitted.contains("z.object({ uds: z.null() }).strict()"),
        "emit:\n{emitted}"
    );
    assert!(
        emitted.contains("z.object({ leylineNet: z.null() }).strict()"),
        "emit:\n{emitted}"
    );

    // TS: interface with the transport field typed as a nested
    // object union over `null` payloads.
    assert!(
        emitted.contains("export interface Wire {"),
        "emit:\n{emitted}"
    );
    assert!(
        emitted.contains("transport: { uds: null } | { leylineNet: null };"),
        "emit:\n{emitted}"
    );
}
