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
use capnp::private::layout::{PointerBuilder, StructBuilder, StructSize};
use capnp::schema_capnp;
use capnp::traits::FromPointerBuilder;
use capnp::Word;

use schema_bridge::error::SchemaBridgeError;
use schema_bridge::{emit, inputs, outputs, OutputFormat};

// Builder-side mirror of the parser's StructPeek wrapper: lets a test
// initialize an `any_pointer` as a raw struct so we can poke individual
// data / pointer slots to mimic what `capnp compile` would emit for a
// user-authored `const Foo :Bar = (…);`. The (data, pointers) sizing
// is hard-coded big enough to cover the test fixtures — three data
// words and two pointer slots is more than `with_const.capnp` needs.
// Per cloister-946a59.
struct StructPoke<'a>(StructBuilder<'a>);
impl<'a> FromPointerBuilder<'a> for StructPoke<'a> {
    fn init_pointer(builder: PointerBuilder<'a>, _len: u32) -> Self {
        StructPoke(builder.init_struct(StructSize {
            data: 3,
            pointers: 2,
        }))
    }
    fn get_from_pointer(
        builder: PointerBuilder<'a>,
        _default: Option<&'a [Word]>,
    ) -> capnp::Result<Self> {
        Ok(StructPoke(builder.get_struct(
            StructSize {
                data: 3,
                pointers: 2,
            },
            None,
        )?))
    }
}

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

// ── cloister-cf2e6a: struct z.object() must be .strict() ───────────
//
// Without .strict(), zod silently drops unknown fields on parse. An
// operator typo like `holdsCredentials = ["SECRET"]` (extra 's') gets
// silently discarded — the credential vanishes with no diagnostic.
// .strict() turns the typo into a ZodError at the boundary where
// schema-bridge is the source of truth.
//
// Surfaced as skeptic N1 during cloister-ae06f3's adversarial review;
// filed as cloister-cf2e6a; fixed here.

#[test]
fn struct_zod_object_is_strict() {
    let mut message = Builder::new_default();
    {
        let request = message.init_root::<schema_capnp::code_generator_request::Builder>();
        let mut nodes = request.init_nodes(2);
        fill_file_node(nodes.reborrow().get(0), 0xFFFE, "test.capnp");

        let mut node = nodes.reborrow().get(1);
        node.set_id(0xAAAA);
        node.set_display_name("test.capnp:Strict");
        node.set_display_name_prefix_length("test.capnp:".len() as u32);
        let mut s = node.init_struct();
        s.set_discriminant_count(0);
        let mut fields = s.init_fields(1);
        let mut field = fields.reborrow().get(0);
        field.set_name("only");
        field.set_code_order(0);
        field.init_slot().init_type().set_text(());
    }

    let schema = parse(&message).expect("parse");
    let emitted = outputs::zod::emit(&schema).expect("emit");

    // The outer struct z.object MUST be terminated with .strict() so
    // unknown keys are rejected at parse time (zod default is to
    // silently drop them). Per cloister-cf2e6a / skeptic N1.
    assert!(
        emitted.contains("}).strict()"),
        "struct z.object must be .strict() — emitted:\n{emitted}"
    );
    // And the existing schema decl is still there.
    assert!(
        emitted.contains("export const StrictSchema: z.ZodType<Strict>"),
        "schema decl missing — emitted:\n{emitted}"
    );
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
    // Lists emit `z.array(T).readonly()` on the zod side + `readonly T[]`
    // on the interface — paired so `z.ZodType<HasList>` type-resolves
    // (zod's ZodReadonly<ZodArray<…>> infers to `readonly T[]`). Per
    // cloister-818f2b.
    assert!(
        emitted.contains("tags: z.array(z.string()).readonly()"),
        "emit:\n{emitted}"
    );
    assert!(emitted.contains("tags: readonly string[];"), "emit:\n{emitted}");
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
    // List<List<T>> recurses both readonly modifiers — outer + inner.
    // The TS form `readonly readonly T[][]` reads `ReadonlyArray<ReadonlyArray<T>>`
    // which is the correct nesting. Per cloister-818f2b.
    assert!(
        emitted.contains("rows: z.array(z.array(z.number().int()).readonly()).readonly()"),
        "emit:\n{emitted}"
    );
    assert!(
        emitted.contains("rows: readonly readonly number[][];"),
        "emit:\n{emitted}"
    );
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

// ── (was: anonymous_inline_union_fails_fast — removed cloister-77172d) ──
//
// The fail-fast guard for `struct Foo { union { … } }` (no group
// wrapper) was removed when schema-bridge gained native support for
// the construct. The activated emit test below
// (`anonymous_inline_union_emits_flat`) is the new authoritative
// behavior assertion.

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

// ── Regression-guard: $Json.flatten annotation on a union field ───
//
// `$Json.flatten` changes capnp's JSON encoding from the nested
// `"kind": { "variant": payload }` form to the flat-with-variant-name
// form. Our v1 emit assumes the nested form; an annotated field
// would produce a schema that silently rejects the JSON. Fail loudly
// so the day someone adds `$Json.flatten` the codegen lights up.
// Annotation id `@0x82d3e852af0336bf` is from capnp/compat/json.capnp.

#[test]
fn json_flatten_annotation_fails_fast() {
    let mut message = Builder::new_default();
    {
        let request = message.init_root::<schema_capnp::code_generator_request::Builder>();
        let mut nodes = request.init_nodes(2);
        fill_file_node(nodes.reborrow().get(0), 0xFFFE, "test.capnp");

        let mut node = nodes.reborrow().get(1);
        node.set_id(0xAAAA);
        node.set_display_name("test.capnp:Annotated");
        node.set_display_name_prefix_length("test.capnp:".len() as u32);
        let mut s = node.init_struct();
        s.set_discriminant_count(0);
        let mut fields = s.init_fields(1);
        let mut field = fields.reborrow().get(0);
        field.set_name("payload");
        field.set_code_order(0);
        field.set_discriminant_value(0xffff);
        let mut anns = field.reborrow().init_annotations(1);
        anns.reborrow().get(0).set_id(0x82d3e852af0336bf);
        let mut slot = field.init_slot();
        slot.reborrow().init_type().set_text(());
    }

    let err = parse(&message).expect_err("must reject $Json.flatten");
    match err {
        SchemaBridgeError::UnmappedConstruct { kind, .. } => {
            assert_eq!(kind, "annotation `$Json.flatten`");
        }
        other => panic!("expected UnmappedConstruct, got {other:?}"),
    }
}

// ── Regression-guard: unknown annotation reports raw hex id ───────

#[test]
fn unknown_annotation_fails_fast_with_hex_id() {
    let mut message = Builder::new_default();
    {
        let request = message.init_root::<schema_capnp::code_generator_request::Builder>();
        let mut nodes = request.init_nodes(2);
        fill_file_node(nodes.reborrow().get(0), 0xFFFE, "test.capnp");

        let mut node = nodes.reborrow().get(1);
        node.set_id(0xAAAA);
        node.set_display_name("test.capnp:Annotated");
        node.set_display_name_prefix_length("test.capnp:".len() as u32);
        let mut anns = node.reborrow().init_annotations(1);
        // arbitrary id, NOT one of the known json.* ids
        anns.reborrow().get(0).set_id(0xCAFEBABEu64);
        let mut s = node.init_struct();
        s.set_discriminant_count(0);
        s.init_fields(0);
    }

    let err = parse(&message).expect_err("must reject unknown annotation");
    match err {
        SchemaBridgeError::UnmappedConstruct { kind, .. } => {
            assert!(kind.starts_with("annotation @"), "got kind {kind:?}");
            assert!(kind.contains("cafebabe"), "got kind {kind:?}");
        }
        other => panic!("expected UnmappedConstruct, got {other:?}"),
    }
}

// ── Aspirational stubs (#[ignore]'d) ──────────────────────────────
//
// Cargo prints `X ignored` on every run, so these gaps stay visible
// without breaking the suite. Each stub documents what the eventual
// success looks like; removing `#[ignore]` is the activation gesture
// once support lands. Paired with the regression-guard fail-fast
// tests above — those stay forever, these go green and stay.

// $Json.flatten changes the union encoding from
//   { kind: { variant: payload } }
// to flat
//   { variant: payload }
// alongside base fields. Different emit shape; future work.
#[test]
#[ignore = "schema-bridge does not yet emit the flat shape for $Json.flatten"]
fn flat_union_emit_under_json_flatten() {
    // When implemented, this test should:
    //  - build a struct with a $Json.flatten-annotated union group
    //  - parse it
    //  - assert the emitted zod is `z.object({ ...base, ...union })`
    //    where union variants are siblings of base fields, not nested
    //    under the discriminant name
    //  - assert the emitted TS type intersects the variants directly
    unimplemented!("activate once schema-bridge handles `$Json.flatten`")
}

// Anonymous inline unions (`struct Foo { union { ... } }` with no
// group wrapping) encode flat — variant name is a sibling key on the
// parent struct, not nested under any group name. Activated by
// cloister-77172d.
#[test]
fn anonymous_inline_union_emits_flat() {
    // Mirrors notme's `Proof` struct shape:
    //   struct Proof {
    //     union {
    //       ghaOidc       @0 :GHAClaims;
    //       passkey       @1 :Data;
    //       bootstrapCode @2 :Text;
    //     }
    //   }
    // Empty base fields — pure inline union.
    let mut message = Builder::new_default();
    let proof_id: u64 = 0xAAAA;
    let claims_id: u64 = 0xCAFE;
    {
        let request = message.init_root::<schema_capnp::code_generator_request::Builder>();
        let mut nodes = request.init_nodes(3);
        fill_file_node(nodes.reborrow().get(0), 0xFFFE, "test.capnp");

        // Proof struct: discriminant on the parent (not a group).
        {
            let mut node = nodes.reborrow().get(1);
            node.set_id(proof_id);
            node.set_display_name("test.capnp:Proof");
            node.set_display_name_prefix_length("test.capnp:".len() as u32);
            let mut s = node.init_struct();
            s.set_discriminant_count(3);
            let mut fields = s.init_fields(3);
            // ghaOidc @0 :GHAClaims
            {
                let mut field = fields.reborrow().get(0);
                field.set_name("ghaOidc");
                field.set_code_order(0);
                field.set_discriminant_value(0);
                let mut slot = field.init_slot();
                slot.reborrow().init_type().init_struct().set_type_id(claims_id);
            }
            // passkey @1 :Data
            {
                let mut field = fields.reborrow().get(1);
                field.set_name("passkey");
                field.set_code_order(1);
                field.set_discriminant_value(1);
                field.init_slot().init_type().set_data(());
            }
            // bootstrapCode @2 :Text
            {
                let mut field = fields.reborrow().get(2);
                field.set_name("bootstrapCode");
                field.set_code_order(2);
                field.set_discriminant_value(2);
                field.init_slot().init_type().set_text(());
            }
        }
        // GHAClaims — trivial empty struct (variants need a referent).
        {
            let mut node = nodes.reborrow().get(2);
            node.set_id(claims_id);
            node.set_display_name("test.capnp:GHAClaims");
            node.set_display_name_prefix_length("test.capnp:".len() as u32);
            let mut s = node.init_struct();
            s.set_discriminant_count(0);
            s.init_fields(0);
        }
    }

    let schema = parse(&message).expect("parse");
    let emitted = outputs::zod::emit(&schema).expect("emit");

    // Zod: `z.union([branch1, branch2, branch3])` where each branch
    // is a `z.object({ <variant>: T }).strict()`. No outer nested-
    // discriminator wrapper.
    assert!(
        emitted.contains("export const ProofSchema: z.ZodType<Proof> = z.lazy(() =>"),
        "schema decl missing:\n{emitted}"
    );
    assert!(
        emitted.contains("z.union(["),
        "missing z.union — emit:\n{emitted}"
    );
    assert!(
        emitted.contains("z.object({\n      ghaOidc: GHAClaimsSchema,\n    }).strict()"),
        "ghaOidc branch missing or wrong shape:\n{emitted}"
    );
    assert!(
        emitted.contains("z.object({\n      passkey: z.instanceof(Uint8Array),\n    }).strict()"),
        "passkey branch missing or wrong shape:\n{emitted}"
    );
    assert!(
        emitted.contains("z.object({\n      bootstrapCode: z.string(),\n    }).strict()"),
        "bootstrapCode branch missing or wrong shape:\n{emitted}"
    );

    // TS type alias (not interface) — discriminated union over flat
    // single-key objects.
    assert!(
        emitted.contains("export type Proof = { ghaOidc: GHAClaims } | { passkey: Uint8Array } | { bootstrapCode: string };"),
        "TS flat-union shape missing:\n{emitted}"
    );

    // Go: variants inline as omitempty pointer fields on the parent
    // (no helper type). Pivot to the Go emitter too.
    let emitted_go = outputs::go::emit(&schema, "test").expect("go emit");
    assert!(
        emitted_go.contains("type Proof struct {"),
        "Go struct missing:\n{emitted_go}"
    );
    assert!(
        emitted_go.contains("GhaOidc *GHAClaims `json:\"ghaOidc,omitempty\"`"),
        "Go ghaOidc field missing:\n{emitted_go}"
    );
    assert!(
        emitted_go.contains("Passkey *[]byte `json:\"passkey,omitempty\"`"),
        "Go passkey field missing:\n{emitted_go}"
    );
    assert!(
        emitted_go.contains("BootstrapCode *string `json:\"bootstrapCode,omitempty\"`"),
        "Go bootstrapCode field missing:\n{emitted_go}"
    );
    // No helper union type for the anonymous-inline form.
    assert!(
        !emitted_go.contains("ProofUnion"),
        "Go must NOT emit a helper union type for anonymous-inline; got:\n{emitted_go}"
    );
}

// Non-union groups (`field :group { x @0 :T; y @1 :U; }`) are field
// namespacing without a discriminator. Capnp's JSON encodes them as a
// nested object under the group name. Future emit:
// `field: z.object({ x: ..., y: ... })`.
#[test]
#[ignore = "schema-bridge does not yet emit for non-union groups"]
fn non_union_group_emits_nested_object() {
    unimplemented!("activate once schema-bridge handles non-union groups")
}

// ── Golden: top-level scalar const ─────────────────────────────────
//
// Mirrors `const contractVersion :Int32 = 1;` (and friends) in
// tests/fixtures/with_const.capnp. The emit shape is
// `export const NAME = <literal> as const;` so consuming TS gets the
// narrowed literal type rather than a widened `number`/`string`.
// Per cloister-946a59 (L1 of substrate-IDL).

#[test]
fn test_const_scalar() {
    let mut message = Builder::new_default();
    {
        let request = message.init_root::<schema_capnp::code_generator_request::Builder>();
        let mut nodes = request.init_nodes(4);
        fill_file_node(nodes.reborrow().get(0), 0xFFFE, "with_const.capnp");

        // const contractVersion :Int32 = 1;
        {
            let mut node = nodes.reborrow().get(1);
            node.set_id(0xC0DE_0001);
            node.set_display_name("with_const.capnp:contractVersion");
            node.set_display_name_prefix_length("with_const.capnp:".len() as u32);
            let mut c = node.init_const();
            c.reborrow().init_type().set_int32(());
            c.init_value().set_int32(1);
        }

        // const productName :Text = "notme";
        {
            let mut node = nodes.reborrow().get(2);
            node.set_id(0xC0DE_0002);
            node.set_display_name("with_const.capnp:productName");
            node.set_display_name_prefix_length("with_const.capnp:".len() as u32);
            let mut c = node.init_const();
            c.reborrow().init_type().set_text(());
            c.init_value().set_text("notme");
        }

        // const debugMode :Bool = false;
        {
            let mut node = nodes.reborrow().get(3);
            node.set_id(0xC0DE_0003);
            node.set_display_name("with_const.capnp:debugMode");
            node.set_display_name_prefix_length("with_const.capnp:".len() as u32);
            let mut c = node.init_const();
            c.reborrow().init_type().set_bool(());
            c.init_value().set_bool(false);
        }
    }

    let schema = parse(&message).expect("parse");
    assert_eq!(schema.consts.len(), 3, "schema: {schema:?}");

    let emitted = outputs::zod::emit(&schema).expect("emit");
    // Each const becomes a single line `export const <name> = <lit> as const;`.
    assert!(
        emitted.contains("export const contractVersion = 1 as const;"),
        "scalar int const missing or wrong shape:\n{emitted}"
    );
    assert!(
        emitted.contains("export const productName = \"notme\" as const;"),
        "scalar text const missing or wrong shape:\n{emitted}"
    );
    assert!(
        emitted.contains("export const debugMode = false as const;"),
        "scalar bool const missing or wrong shape:\n{emitted}"
    );
}

// ── Golden: top-level list const ───────────────────────────────────
//
// Mirrors `const allowedScopes :List(Text) = ["read", "write", "admin"];`
// in tests/fixtures/with_const.capnp. The emit shape is a TS array
// literal followed by `as const` — TS's `as const` on an array narrows
// each element to its literal type AND makes the array `readonly`,
// which is the contract `@notme/contract` needs from its SCOPES
// declaration. Per cloister-946a59.

#[test]
fn test_const_list() {
    let mut message = Builder::new_default();
    {
        let request = message.init_root::<schema_capnp::code_generator_request::Builder>();
        let mut nodes = request.init_nodes(2);
        fill_file_node(nodes.reborrow().get(0), 0xFFFE, "with_const.capnp");

        // const allowedScopes :List(Text) = ["read", "write", "admin"];
        let mut node = nodes.reborrow().get(1);
        node.set_id(0xC0DE_0010);
        node.set_display_name("with_const.capnp:allowedScopes");
        node.set_display_name_prefix_length("with_const.capnp:".len() as u32);
        let mut c = node.init_const();
        // type: List(Text)
        {
            let ty = c.reborrow().init_type();
            let list = ty.init_list();
            list.init_element_type().set_text(());
        }
        // value: List with three text entries.
        {
            let value = c.init_value();
            let any_ptr = value.init_list();
            let mut list: capnp::text_list::Builder = any_ptr.initn_as(3);
            list.set(0, "read");
            list.set(1, "write");
            list.set(2, "admin");
        }
    }

    let schema = parse(&message).expect("parse");
    assert_eq!(schema.consts.len(), 1);

    let emitted = outputs::zod::emit(&schema).expect("emit");
    assert!(
        emitted.contains(r#"export const allowedScopes = ["read", "write", "admin"] as const;"#),
        "list const missing or wrong shape:\n{emitted}"
    );
}

// ── Golden: top-level struct const ─────────────────────────────────
//
// Mirrors `struct ErrorStatus { code; message; retryable; }` +
// `const notFoundStatus :ErrorStatus = (code = 404, message = "not
// found", retryable = false);` in tests/fixtures/with_const.capnp. The
// emit shape is `{ field: value, ... } as const` with declaration-order
// field preservation. The wire-layout decoder reads each field from
// the const value's StructReader by its capnp ABI offset, which is
// what `capnp compile` writes into the CodeGeneratorRequest. Per
// cloister-946a59.

#[test]
fn test_const_struct() {
    let mut message = Builder::new_default();
    let status_struct_id: u64 = 0xC0DE_0100;
    {
        let request = message.init_root::<schema_capnp::code_generator_request::Builder>();
        let mut nodes = request.init_nodes(3);
        fill_file_node(nodes.reborrow().get(0), 0xFFFE, "with_const.capnp");

        // struct ErrorStatus { code @0 :Int32; message @1 :Text;
        //                       retryable @2 :Bool; }
        // capnp lays out data fields in size-descending order, then
        // pointer fields:
        //   code      :Int32 at data offset 0 (i32-sized slot)
        //   retryable :Bool  at bit offset 32 (after the int32)
        //   message   :Text  at pointer offset 0
        // Picking these explicit offsets matches what `capnp compile`
        // would emit; the parser reads them via slot.offset.
        {
            let mut node = nodes.reborrow().get(1);
            node.set_id(status_struct_id);
            node.set_display_name("with_const.capnp:ErrorStatus");
            node.set_display_name_prefix_length("with_const.capnp:".len() as u32);
            let mut s = node.init_struct();
            s.set_discriminant_count(0);
            let mut fields = s.init_fields(3);
            // code @0 :Int32 at data slot 0 (i32-sized)
            {
                let mut field = fields.reborrow().get(0);
                field.set_name("code");
                field.set_code_order(0);
                field.set_discriminant_value(0xffff);
                let mut slot = field.init_slot();
                slot.set_offset(0);
                slot.reborrow().init_type().set_int32(());
            }
            // message @1 :Text at pointer slot 0
            {
                let mut field = fields.reborrow().get(1);
                field.set_name("message");
                field.set_code_order(1);
                field.set_discriminant_value(0xffff);
                let mut slot = field.init_slot();
                slot.set_offset(0);
                slot.reborrow().init_type().set_text(());
            }
            // retryable @2 :Bool at bit offset 32
            {
                let mut field = fields.reborrow().get(2);
                field.set_name("retryable");
                field.set_code_order(2);
                field.set_discriminant_value(0xffff);
                let mut slot = field.init_slot();
                slot.set_offset(32);
                slot.reborrow().init_type().set_bool(());
            }
        }

        // const notFoundStatus :ErrorStatus = (code = 404,
        //                                      message = "not found",
        //                                      retryable = false);
        {
            let mut node = nodes.reborrow().get(2);
            node.set_id(0xC0DE_0101);
            node.set_display_name("with_const.capnp:notFoundStatus");
            node.set_display_name_prefix_length("with_const.capnp:".len() as u32);
            let mut c = node.init_const();
            // type: StructRef → ErrorStatus
            {
                let ty = c.reborrow().init_type();
                let mut sty = ty.init_struct();
                sty.set_type_id(status_struct_id);
            }
            // value: struct with the three fields poked at their ABI
            // offsets via the StructPoke wrapper. retryable defaults
            // to false → leave the bool slot zeroed (no set_bool call).
            {
                let value = c.init_value();
                let any_ptr = value.init_struct();
                let StructPoke(mut builder) = any_ptr.init_as::<StructPoke>();
                builder.set_data_field::<i32>(0, 404);
                // pointer slot 0 = message field
                let mut t = builder.reborrow().get_pointer_field(0).init_text(9);
                t.push_str("not found");
                // retryable @ bit 32 stays false (zero-init), which
                // matches the schema fixture.
            }
        }
    }

    let schema = parse(&message).expect("parse");
    assert_eq!(schema.consts.len(), 1, "schema: {schema:?}");

    let emitted = outputs::zod::emit(&schema).expect("emit");
    // Declaration-order: code, message, retryable.
    assert!(
        emitted.contains(
            r#"export const notFoundStatus = { code: 404, message: "not found", retryable: false } as const;"#
        ),
        "struct const missing or wrong shape:\n{emitted}"
    );
}

// ── Output multiplexer ─────────────────────────────────────────────
//
// Phase 1 piece A (cloister-7585bc): the binary dispatches on an
// [`OutputFormat`] so bead B (Go emitter) and beyond can drop in
// without touching the dispatch site. Today only `Zod` exists; the
// dispatcher is exercised through these tests so the seam stays
// honest. Per ADR-0036.

#[test]
fn output_format_parses_known_zod() {
    let fmt = OutputFormat::parse("zod").expect("parse zod");
    assert_eq!(fmt, OutputFormat::Zod);
}

#[test]
fn output_format_parse_rejects_unknown_with_known_list() {
    let err = OutputFormat::parse("zods").expect_err("must reject typo");
    match err {
        SchemaBridgeError::UnknownOutputFormat { name, known } => {
            assert_eq!(name, "zods");
            // Hint must surface the live format list so the user
            // doesn't guess. Today: just "zod"; bead B adds "go".
            assert!(known.contains("zod"), "known list missing zod: {known}");
        }
        other => panic!("expected UnknownOutputFormat, got {other:?}"),
    }
}

#[test]
fn output_format_file_suffix_zod_is_zod_ts() {
    // Drives `<basename>.<suffix>` filename derivation in main.rs.
    // Bead B will assert "go" here for the Go variant.
    assert_eq!(OutputFormat::Zod.file_suffix(), "zod.ts");
}

#[test]
fn output_format_from_binary_name_zod() {
    // Canonical happy path — Cargo `[[bin]]` ships
    // `capnpc-schema-bridge-zod`; main.rs reads argv[0] basename and
    // delegates here.
    let fmt = OutputFormat::from_binary_name("capnpc-schema-bridge-zod")
        .expect("parse capnpc-schema-bridge-zod");
    assert_eq!(fmt, OutputFormat::Zod);
}

#[test]
fn output_format_from_binary_name_rejects_unprefixed() {
    // Legacy `capnpc-schema-bridge` (no `-<format>` suffix) was the
    // pre-multiplexer name. Clean break — bare name now errors loudly
    // so any consumer with a stale invocation lights up rather than
    // silently routing to Zod.
    let err = OutputFormat::from_binary_name("capnpc-schema-bridge")
        .expect_err("must reject legacy unprefixed name");
    match err {
        SchemaBridgeError::UnknownOutputFormat { name, known } => {
            assert_eq!(name, "capnpc-schema-bridge");
            assert!(
                known.contains("capnpc-schema-bridge-"),
                "hint must surface required prefix: {known}"
            );
        }
        other => panic!("expected UnknownOutputFormat, got {other:?}"),
    }
}

#[test]
fn output_format_from_binary_name_rejects_unknown_suffix() {
    // `-bogus` parses past the prefix strip but fails on format match
    // — different error path from the unprefixed case above; both
    // must surface clearly.
    let err = OutputFormat::from_binary_name("capnpc-schema-bridge-bogus")
        .expect_err("must reject unknown format suffix");
    match err {
        SchemaBridgeError::UnknownOutputFormat { name, .. } => {
            assert_eq!(name, "bogus");
        }
        other => panic!("expected UnknownOutputFormat, got {other:?}"),
    }
}

#[test]
fn emit_dispatches_zod_equivalently_to_outputs_zod() {
    // Sanity: the multiplexer's emit(&schema, Zod) must produce the
    // same source as the direct call. Any divergence means the
    // dispatcher grew side-effects it shouldn't have.
    let mut message = Builder::new_default();
    {
        let request = message.init_root::<schema_capnp::code_generator_request::Builder>();
        let mut nodes = request.init_nodes(2);
        fill_file_node(nodes.reborrow().get(0), 0xFFFE, "test.capnp");

        let mut node = nodes.reborrow().get(1);
        node.set_id(0xAAAA);
        node.set_display_name("test.capnp:Mux");
        node.set_display_name_prefix_length("test.capnp:".len() as u32);
        let mut s = node.init_struct();
        s.set_discriminant_count(0);
        let mut fields = s.init_fields(1);
        let mut field = fields.reborrow().get(0);
        field.set_name("name");
        field.set_code_order(0);
        field.init_slot().init_type().set_text(());
    }

    let schema = parse(&message).expect("parse");
    let direct = outputs::zod::emit(&schema).expect("direct emit");
    let muxed = emit(&schema, OutputFormat::Zod, "test").expect("mux emit");
    assert_eq!(direct, muxed, "Zod dispatcher must be a pure passthrough");
}

// ── Go emitter (cloister-75f6d5) ──────────────────────────────────
//
// v1: types + json tags only. Canonical encoders land in C
// (cloister-765d83). Tests mirror the zod tests' fixture-building
// pattern so the same construct produces both outputs from one IR.

#[test]
fn go_emit_struct_scalars_has_package_and_json_tags() {
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
            field.init_slot().init_type().set_text(());
        }
        {
            let mut field = fields.reborrow().get(1);
            field.set_name("loud");
            field.set_code_order(1);
            field.init_slot().init_type().set_bool(());
        }
    }

    let schema = parse(&message).expect("parse");
    let emitted = outputs::go::emit(&schema, "test").expect("emit");

    // Package name comes from the basename passed in (main.rs derives
    // from the request's first requested file).
    assert!(emitted.contains("package test"), "emit:\n{emitted}");
    // Struct + PascalCased field names with `json:"<capnp-name>"`
    // tags preserving the wire name.
    assert!(emitted.contains("type Greeting struct {"), "emit:\n{emitted}");
    assert!(
        emitted.contains("Subject string `json:\"subject\"`"),
        "emit:\n{emitted}"
    );
    assert!(
        emitted.contains("Loud bool `json:\"loud\"`"),
        "emit:\n{emitted}"
    );
}

#[test]
fn go_emit_enum_renders_typed_string_const_block() {
    let mut message = Builder::new_default();
    {
        let request = message.init_root::<schema_capnp::code_generator_request::Builder>();
        let mut nodes = request.init_nodes(2);
        fill_file_node(nodes.reborrow().get(0), 0xFFFE, "test.capnp");

        let mut n = nodes.reborrow().get(1);
        n.set_id(0xCCCC);
        n.set_display_name("test.capnp:Tier");
        n.set_display_name_prefix_length("test.capnp:".len() as u32);
        let e = n.init_enum();
        let mut enumerants = e.init_enumerants(2);
        enumerants.reborrow().get(0).set_name("hypervisor");
        enumerants.reborrow().get(1).set_name("cluster");
    }

    let schema = parse(&message).expect("parse");
    let emitted = outputs::go::emit(&schema, "test").expect("emit");

    assert!(emitted.contains("type Tier string"), "emit:\n{emitted}");
    assert!(
        emitted.contains("TierHypervisor Tier = \"hypervisor\""),
        "emit:\n{emitted}"
    );
    assert!(
        emitted.contains("TierCluster Tier = \"cluster\""),
        "emit:\n{emitted}"
    );
}

#[test]
fn go_emit_list_of_scalars_is_slice() {
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
        let list = slot.reborrow().init_type().init_list();
        list.init_element_type().set_text(());
    }

    let schema = parse(&message).expect("parse");
    let emitted = outputs::go::emit(&schema, "test").expect("emit");

    assert!(
        emitted.contains("Tags []string `json:\"tags\"`"),
        "emit:\n{emitted}"
    );
}

#[test]
fn go_emit_named_union_struct_variants_emits_nested_union_type() {
    // Mirrors `Backend.kind :union { durableObject @0 :DoBackend;
    // httpForward @1 :HttpForwardBackend }`. Go shape: a sibling
    // type `BackendKindUnion` with one nullable pointer per variant
    // and `json:"<name>,omitempty"` so the marshaler emits only the
    // set branch.
    let mut message = Builder::new_default();
    let backend_id: u64 = 0xAAAA;
    let kind_group_id: u64 = 0xBBBB;
    let do_backend_id: u64 = 0xCCCC;
    let http_backend_id: u64 = 0xDDDD;
    {
        let request = message.init_root::<schema_capnp::code_generator_request::Builder>();
        let mut nodes = request.init_nodes(5);
        fill_file_node(nodes.reborrow().get(0), 0xFFFE, "test.capnp");

        // Backend struct: name + kind union.
        {
            let mut node = nodes.reborrow().get(1);
            node.set_id(backend_id);
            node.set_display_name("test.capnp:Backend");
            node.set_display_name_prefix_length("test.capnp:".len() as u32);
            let mut s = node.init_struct();
            s.set_discriminant_count(0);
            let mut fields = s.init_fields(2);
            {
                let mut field = fields.reborrow().get(0);
                field.set_name("name");
                field.set_code_order(0);
                field.set_discriminant_value(0xffff);
                field.init_slot().init_type().set_text(());
            }
            {
                let mut field = fields.reborrow().get(1);
                field.set_name("kind");
                field.set_code_order(1);
                field.set_discriminant_value(0xffff);
                let mut group = field.init_group();
                group.set_type_id(kind_group_id);
            }
        }
        // kind group: union of two struct variants.
        {
            let mut node = nodes.reborrow().get(2);
            node.set_id(kind_group_id);
            node.set_display_name("test.capnp:Backend.kind");
            node.set_display_name_prefix_length("test.capnp:".len() as u32);
            let mut s = node.init_struct();
            s.set_is_group(true);
            s.set_discriminant_count(2);
            let mut fields = s.init_fields(2);
            {
                let mut field = fields.reborrow().get(0);
                field.set_name("durableObject");
                field.set_code_order(0);
                field.set_discriminant_value(0);
                let mut slot = field.init_slot();
                slot.reborrow().init_type().init_struct().set_type_id(do_backend_id);
            }
            {
                let mut field = fields.reborrow().get(1);
                field.set_name("httpForward");
                field.set_code_order(1);
                field.set_discriminant_value(1);
                let mut slot = field.init_slot();
                slot.reborrow()
                    .init_type()
                    .init_struct()
                    .set_type_id(http_backend_id);
            }
        }
        // DoBackend / HttpForwardBackend — trivial structs.
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
    let emitted = outputs::go::emit(&schema, "test").expect("emit");

    // Helper type for the union.
    assert!(
        emitted.contains("type BackendKindUnion struct {"),
        "emit:\n{emitted}"
    );
    assert!(
        emitted.contains("DurableObject *DoBackend `json:\"durableObject,omitempty\"`"),
        "emit:\n{emitted}"
    );
    assert!(
        emitted.contains("HttpForward *HttpForwardBackend `json:\"httpForward,omitempty\"`"),
        "emit:\n{emitted}"
    );
    // Outer struct carries the union field by helper-type name.
    assert!(
        emitted.contains("Name string `json:\"name\"`"),
        "emit:\n{emitted}"
    );
    assert!(
        emitted.contains("Kind BackendKindUnion `json:\"kind\"`"),
        "emit:\n{emitted}"
    );
}

#[test]
fn go_emit_named_union_void_variants_uses_empty_struct_pointer() {
    // `Wire.transport :union { uds @0 :Void; leylineNet @1 :Void; }`.
    // Void variants type as `*struct{}` so the marshaler can
    // distinguish "not this variant" (nil) from "this variant"
    // (non-nil, payload empty).
    let mut message = Builder::new_default();
    let wire_id: u64 = 0xAAAA;
    let transport_group_id: u64 = 0xBBBB;
    {
        let request = message.init_root::<schema_capnp::code_generator_request::Builder>();
        let mut nodes = request.init_nodes(3);
        fill_file_node(nodes.reborrow().get(0), 0xFFFE, "test.capnp");

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
                field.init_slot().init_type().set_void(());
            }
        }
    }

    let schema = parse(&message).expect("parse");
    let emitted = outputs::go::emit(&schema, "test").expect("emit");

    assert!(
        emitted.contains("type WireTransportUnion struct {"),
        "emit:\n{emitted}"
    );
    assert!(
        emitted.contains("Uds *struct{} `json:\"uds,omitempty\"`"),
        "emit:\n{emitted}"
    );
    assert!(
        emitted.contains("LeylineNet *struct{} `json:\"leylineNet,omitempty\"`"),
        "emit:\n{emitted}"
    );
    assert!(
        emitted.contains("Transport WireTransportUnion `json:\"transport\"`"),
        "emit:\n{emitted}"
    );
}

#[test]
fn go_emit_scalar_const_emits_typed_const() {
    let mut message = Builder::new_default();
    {
        let request = message.init_root::<schema_capnp::code_generator_request::Builder>();
        let mut nodes = request.init_nodes(3);
        fill_file_node(nodes.reborrow().get(0), 0xFFFE, "with_const.capnp");

        {
            let mut node = nodes.reborrow().get(1);
            node.set_id(0xC0DE_0001);
            node.set_display_name("with_const.capnp:contractVersion");
            node.set_display_name_prefix_length("with_const.capnp:".len() as u32);
            let mut c = node.init_const();
            c.reborrow().init_type().set_int32(());
            c.init_value().set_int32(7);
        }
        {
            let mut node = nodes.reborrow().get(2);
            node.set_id(0xC0DE_0002);
            node.set_display_name("with_const.capnp:productName");
            node.set_display_name_prefix_length("with_const.capnp:".len() as u32);
            let mut c = node.init_const();
            c.reborrow().init_type().set_text(());
            c.init_value().set_text("notme");
        }
    }

    let schema = parse(&message).expect("parse");
    let emitted = outputs::go::emit(&schema, "with_const").expect("emit");

    // Capnp camelCase const names → PascalCase Go names.
    assert!(
        emitted.contains("const ContractVersion int32 = 7"),
        "emit:\n{emitted}"
    );
    assert!(
        emitted.contains("const ProductName string = \"notme\""),
        "emit:\n{emitted}"
    );
}

#[test]
fn go_format_dispatch_routes_to_go_emitter() {
    // Cross-format sanity: the lib-level `emit()` dispatcher must
    // route OutputFormat::Go to outputs::go::emit, returning Go
    // source rather than zod TS.
    let mut message = Builder::new_default();
    {
        let request = message.init_root::<schema_capnp::code_generator_request::Builder>();
        let mut nodes = request.init_nodes(2);
        fill_file_node(nodes.reborrow().get(0), 0xFFFE, "test.capnp");

        let mut node = nodes.reborrow().get(1);
        node.set_id(0xAAAA);
        node.set_display_name("test.capnp:Mux");
        node.set_display_name_prefix_length("test.capnp:".len() as u32);
        let mut s = node.init_struct();
        s.set_discriminant_count(0);
        let mut fields = s.init_fields(1);
        let mut field = fields.reborrow().get(0);
        field.set_name("name");
        field.set_code_order(0);
        field.init_slot().init_type().set_text(());
    }

    let schema = parse(&message).expect("parse");
    let emitted = emit(&schema, OutputFormat::Go, "test").expect("mux emit");
    assert!(emitted.contains("package test"), "emit:\n{emitted}");
    assert!(emitted.contains("type Mux struct {"), "emit:\n{emitted}");
    assert!(
        !emitted.contains("import { z }"),
        "must not be zod output:\n{emitted}"
    );
}

#[test]
fn go_format_suffix_is_go() {
    assert_eq!(OutputFormat::Go.file_suffix(), "go");
}

#[test]
fn go_format_parses_from_binary_name() {
    let fmt = OutputFormat::from_binary_name("capnpc-schema-bridge-go").expect("parse");
    assert_eq!(fmt, OutputFormat::Go);
}
