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
        let mut elem = list.init_element_type();
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

// ── Fail-case: top-level enum ──────────────────────────────────────

#[test]
fn enum_node_fails_fast() {
    let mut message = Builder::new_default();
    {
        let request = message.init_root::<schema_capnp::code_generator_request::Builder>();
        let mut nodes = request.init_nodes(2);
        fill_file_node(nodes.reborrow().get(0), 0xFFFE, "test.capnp");

        let mut n = nodes.reborrow().get(1);
        n.set_id(0xAAAA);
        n.set_display_name("test.capnp:Color");
        n.set_display_name_prefix_length("test.capnp:".len() as u32);
        n.init_enum();
    }

    let err = parse(&message).expect_err("must reject enum");
    match err {
        SchemaBridgeError::UnmappedConstruct { kind, .. } => assert_eq!(kind, "enum"),
        other => panic!("expected UnmappedConstruct('enum'), got {other:?}"),
    }
}

// ── Fail-case: in-struct union (discriminant_count > 0) ───────────

#[test]
fn in_struct_union_fails_fast() {
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

    let err = parse(&message).expect_err("must reject union");
    match err {
        SchemaBridgeError::UnmappedConstruct { kind, .. } => {
            assert_eq!(kind, "union (in-struct)");
        }
        other => panic!("expected UnmappedConstruct('union (in-struct)'), got {other:?}"),
    }
}

// ── Fail-case: group field ─────────────────────────────────────────

#[test]
fn group_field_fails_fast() {
    let mut message = Builder::new_default();
    {
        let request = message.init_root::<schema_capnp::code_generator_request::Builder>();
        let mut nodes = request.init_nodes(2);
        fill_file_node(nodes.reborrow().get(0), 0xFFFE, "test.capnp");

        let mut node = nodes.reborrow().get(1);
        node.set_id(0xAAAA);
        node.set_display_name("test.capnp:WithGroup");
        node.set_display_name_prefix_length("test.capnp:".len() as u32);
        let mut s = node.init_struct();
        s.set_discriminant_count(0);
        let mut fields = s.init_fields(1);
        let mut field = fields.reborrow().get(0);
        field.set_name("nested");
        field.set_code_order(0);
        let mut group = field.init_group();
        group.set_type_id(0xBBBB);
    }

    let err = parse(&message).expect_err("must reject group");
    match err {
        SchemaBridgeError::UnmappedConstruct { kind, .. } => assert_eq!(kind, "group"),
        other => panic!("expected UnmappedConstruct('group'), got {other:?}"),
    }
}
