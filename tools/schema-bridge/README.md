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

CI runs the codegen on every commit. If schema-bridge can't handle
your new capnp construct, the build breaks until either (a) the
construct is added to schema-bridge with a golden test + fail-case,
or (b) the schema is rewritten without it. No silent fallbacks.

## What's mapped today

| capnp construct                        | IR                          | zod emit                                        |
|----------------------------------------|-----------------------------|-------------------------------------------------|
| `struct`                               | `Struct { fields, union }`  | `z.lazy(() => z.object({…}))`                   |
| scalar fields                          | `Scalar(_)`                 | `z.string()` / `z.number()` / etc.              |
| struct refs                            | `StructRef(name)`           | `{Name}Schema`                                  |
| enum refs                              | `EnumRef(name)`             | `{Name}Schema` (where `{Name}Schema = z.enum`) |
| `List(T)`                              | `List(Box<FieldType>)`      | `z.array(T)` (recurses)                         |
| top-level `enum`                       | `Enum { name, variants }`   | `z.enum([…])` + `type X = "a" \| "b"`           |
| `name :union { … }` (group form)       | `Struct.union: Some(Union)` | `z.intersection(base, z.discriminatedUnion)`    |
| Void union variants                    | `UnionVariant.ty = Void`    | `z.object({ disc: z.literal("name") })`         |
| union-only structs (no base fields)    | empty `fields`, `Some(union)` | `z.discriminatedUnion` directly (no intersect) |

Verified end-to-end (run `capnp compile -oschema-bridge:<dir>` against
each):

- `manifest/cluster.capnp` → 136 lines clean zod TS (1 enum, 2 named
  unions including all-Void `Wire.transport`)
- `manifest/cloister.capnp` → 246 lines clean zod TS (13 structs,
  `Backend.kind` 6-variant union, `Route.kind` 10-variant mostly-Void
  union)

| Deliberately unmapped (errors today)| reason                                       |
|-------------------------------------|----------------------------------------------|
| `interface`                         | RPC types — out of scope for now             |
| `const`, `annotation`               | not used at the schema surfaces we care about |
| `anyPointer`                        | typed-erasure escape hatch; unmapped         |
| generics (`$Foo(T)`)                | needs IR generics representation             |
| anonymous inline union              | unused in cloister; the `name :union {…}` sugar covers all current use|
| non-union group (field namespacing) | unused in cloister                           |
| group variant inside a union        | legal capnp, unused in cloister              |

Adding any of these is a focused change: extend the IR variant, add
the emit in `outputs/zod.rs`, add one golden test + leave one
fail-case test for the still-unmapped neighbour. The fail-case tests
stay forever as regression guards — they catch a future construct
that silently slips through because it looks "close enough" to
something that IS supported.

## How it runs

```sh
# As a capnp plugin (the supported invocation):
capnp compile \
  -o./target/release/capnpc-schema-bridge:./gen \
  manifest/cli-config.capnp
```

`capnp compile` invokes the binary with the parsed `CodeGeneratorRequest`
on stdin. The binary writes `gen/schema.ts` (zod schemas + TS interface
declarations). One emit per invocation today; per-file splitting is on
the follow-on list.

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
