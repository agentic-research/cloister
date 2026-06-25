# schema-bridge

Capnp + JSON-extension schemas → zod / TS / (future: JSON Schema).
Single source of truth, fail-fast codegen, designed to be extracted to
its own crate once it stabilises.

## Why

cloister had two parallel schema pipelines: capnp→TS for the manifest,
zod→JSON Schema for tool I/O. Adding a third source (the `.cloister.json`
CLI config) would have meant hand-mirroring a capnp struct against a
zod schema, with ADR-0004's append-only / monotonic-ordinal guarantees
dropped on the floor. Bad shape, deferred forever.

schema-bridge is the missing piece: read a capnp schema, lower into a
small intermediate representation (IR), emit every downstream target
from that IR. capnp's own ordinal rules carry through; new fields land
in one place; nothing drifts.

## Self-maintenance invariant

The point of this tool is that it stays correct without anyone
remembering to update it. The mechanism: **any capnp construct without
a complete IR-and-emit mapping is a hard error.**

```text
unmapped capnp construct `list` at node id=aaaa (Foo.items):
  add a mapping for `list` in schema-bridge, or open an issue
```

This means the codegen is *intentionally incomplete*, but every gap is
loud. notme's older `capnp-to-ts.ts` (which this tool replaces in
spirit) silently emitted `z.unknown()` for unrecognised constructs;
that's the precise failure mode schema-bridge exists to prevent.

**Today the codegen is opt-in** — `task cluster:zod` regenerates
`src/generated/cluster.zod.ts` and `task cluster:zod:check-drift`
verifies the committed copy matches. Neither task is wired into
`task lint` or `task verify` yet, so an unmapped capnp construct
won't break CI automatically; it WILL break the moment a developer
runs the regen or drift-check task locally. The plan is to wire
`cluster:zod:check-drift` into `task verify` once the schema-bridge
mapping coverage stabilises (tracked separately) — at that point
unmapped constructs become a hard CI failure. No silent fallbacks
regardless.

## What's mapped today

| capnp construct                        | IR                          | zod emit                                        |
|----------------------------------------|-----------------------------|-------------------------------------------------|
| `struct`                               | `Struct { fields, union }`  | `z.lazy(() => z.object({…}))`                   |
| scalar fields                          | `Scalar(_)`                 | `z.string()` / `z.number()` / etc.              |
| struct refs                            | `StructRef(name)`           | `{Name}Schema`                                  |
| enum refs                              | `EnumRef(name)`             | `{Name}Schema` (where `{Name}Schema = z.enum`) |
| `List(T)`                              | `List(Box<FieldType>)`      | `z.array(T)` (recurses)                         |
| top-level `enum`                       | `Enum { name, variants }`   | `z.enum([…])` + `type X = "a" \| "b"`           |
| `name :union { … }` (group form)       | `Union { discriminant_name: Some(_) }` | nested: `z.object({ disc: z.union([{<variant>: <T>}, …]) })` |
| `struct Foo { union { … } }` (anonymous inline) | `Union { discriminant_name: None }` | flat: `z.union([z.object({…base, <variant>: <T>}).strict(), …])` |
| Void union variants                    | `UnionVariant.ty = Void`    | `{<variant>: z.null()}` inside the union (both shapes) |
| union-only structs (no base fields)    | empty `fields`, `Some(union)` | same union shape, no base-field props |

Verified end-to-end (run `capnp compile -oschema-bridge:<dir>` against
each):

- `manifest/cluster.capnp` → 136 lines clean zod TS (1 enum, 2 named
  unions including all-Void `Wire.transport`)
- `manifest/cloister.capnp` → 246 lines clean zod TS (13 structs,
  `Backend.kind` 6-variant union, `Route.kind` 10-variant mostly-Void
  union)
- `manifest/identity.capnp` → 359 lines clean zod TS + 186 lines Go
  (vendored from notme; covers `Proof`'s anonymous-inline union — the
  second-schema proof per ADR-0036 Phase 1 piece E / cloister-77172d)

| Deliberately unmapped (errors today)| reason                                       |
|-------------------------------------|----------------------------------------------|
| `interface`                         | RPC types — out of scope for now             |
| `anyPointer`                        | typed-erasure escape hatch; unmapped         |
| generics (`$Foo(T)`)                | needs IR generics representation             |
| non-union group (field namespacing) | unused in cloister                           |
| group variant inside a union        | legal capnp, unused in cloister              |
| annotation USES on a node/field     | including `$Json.flatten`, `$Json.discriminator`, `$Json.name`, `$Json.base64`, `$Json.hex`, `$Json.notification` (ids from `capnp/compat/json.capnp`) — affect JSON encoding and so MUST be handled or fail loudly. File-level annotation uses (e.g. `$Go.package` on the file node) are tolerated; node/field-level uses still fail-fast. |

Top-level annotation DECLARATIONS (e.g. an imported `go.capnp` defining
`annotation package(file) :Text;`) are skipped — they're metadata
describing what annotations EXIST, not data to render. USES of those
annotations on individual nodes/fields still fail-fast per the table
above.

Adding any of these is a focused change: extend the IR variant, add
the emit in `outputs/zod.rs`, add one golden test + leave one
fail-case test for the still-unmapped neighbour. The fail-case tests
stay forever as regression guards — they catch a future construct
that silently slips through because it looks "close enough" to
something that IS supported.

## Visibility of known gaps

Every unmapped construct above is paired with two tests:

1. **A regression-guard fail-fast test** — must throw
   `UnmappedConstruct`. Stays active forever; catches a future
   construct that silently slips through.
2. **An `#[ignore]`'d aspirational stub** (where the emit shape is
   already clear) — documents what success will look like. `cargo
   test` prints `<name> ... ignored, schema-bridge does not yet …`
   on every run, so the gap is visible in CI output without breaking
   the build. Activation gesture: remove `#[ignore]`, implement, fill
   in the assertions. The paired regression-guard stays.

Today's `#[ignore]`'d stubs (search for them in
`tests/integration.rs`):

- `flat_union_emit_under_json_flatten` — emit when `$Json.flatten`
  is on a union field
- `non_union_group_emits_nested_object` — emit for
  `field :group { x; y; }` (field namespacing without discriminator)

Closed gaps (no longer #[ignore]'d):

- `anonymous_inline_union_emits_flat` — `struct Foo { union { … } }`
  emits flat per cloister-77172d (the second-schema generalization,
  needed for notme's `Proof` struct in `identity.capnp`)

Constructs without aspirational stubs (`interface`, generics,
`anyPointer`) are deferred indefinitely — they're non-goals for the
zod-validation surface today, not just "not yet."

## How it runs

```sh
# As a capnp plugin (the supported invocation):
capnp compile \
  -o./target/release/capnpc-schema-bridge-zod:./gen \
  manifest/cli-config.capnp
```

One binary per output format, dispatched by argv[0] basename — same
shape as `capnpc-rust` / `capnpc-go` / `capnpc-c++`. Today only
`capnpc-schema-bridge-zod`; bead cloister-75f6d5 adds
`capnpc-schema-bridge-go` alongside (Cargo declares both `[[bin]]`
entries; both compile from the same `src/main.rs`).

`capnp compile` invokes the binary with the parsed `CodeGeneratorRequest`
on stdin. The binary writes `<output-dir>/<schema-basename>.<format-suffix>`
(e.g. `cluster.zod.ts` from `manifest/cluster.capnp`) — zod schemas
plus TS interface declarations in one file. One emit per invocation
today; per-file splitting is on the follow-on list.

For development the library is also drivable directly — see
`tests/integration.rs` for examples of building a `CodeGeneratorRequest`
by hand. That's how the test suite stays hermetic (no capnp CLI
needed in CI).

## Layout

```
tools/schema-bridge/
├── Cargo.toml          standalone workspace; depends only on capnp + thiserror
├── README.md           this file
├── src/
│   ├── lib.rs          public API for tests
│   ├── main.rs         capnp plugin entry — stdin → emit → file
│   ├── error.rs        SchemaBridgeError + UnmappedConstruct
│   ├── ir/             the intermediate representation
│   ├── inputs/         capnp → IR (future: json-extension/ for aggregation)
│   └── outputs/        IR → zod (future: ts.rs, json_schema.rs)
└── tests/
    └── integration.rs  golden + fail-case suite
```

## Follow-on work

Tracked separately from this initial drop. In rough priority order:

1. Wire into `task manifest` + `task verify` — codegen step alongside
   the existing capnp→TS pipeline. Decide whether the output replaces
   `src/generated/cluster.ts` or sits beside it as
   `src/generated/cluster.zod.ts`.
2. JSON-extension input adapter for the aggregation pattern (capnp
   defines the structural backbone, JSON files supply per-variant
   field extensions). Where the polymorphism for skill / mcp / agent
   actually lands.
3. JSON Schema output adapter (`outputs/json_schema.rs`) — drives the
   `$schema` field in `.cloister.json` for editor autocomplete.
4. TS-types-only output adapter, separated from the zod emit, so
   consumers can pick one or both.
5. End-to-end fixture tests against `manifest/*.capnp` — currently
   verified manually (see README "What's mapped today"); locking that
   in as a golden-output test in CI prevents silent regressions.
6. License — deferred per the implementation conversation. Default
   matches cloister (AGPL-3.0-or-later); revisit if extraction to a
   standalone repo lands.

## Non-goals (the helm comparison)

The aggregation pattern this tool serves looks superficially like
helm — multiple inputs composing into one output — but the design
explicitly avoids helm's failure modes:

- ❌ No string templating (no `{{ … }}` substitution anywhere)
- ❌ No runtime value substitution
- ❌ No values.yaml-style override layers chained 4-deep
- ✅ All aggregation is at the IR level, statically resolved
- ✅ Output is plain emitted source code, reviewable and diffable

If a feature looks like it might pull this toward helm-shaped
templating, reject the feature.
