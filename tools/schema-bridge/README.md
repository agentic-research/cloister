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

## v1 scope (what's mapped today)

| capnp construct  | IR                | zod emit                           |
|------------------|-------------------|------------------------------------|
| `struct`         | `Struct { fields }`| `z.lazy(() => z.object({…}))`     |
| scalar fields    | `Scalar(_)`       | `z.string()` / `z.number()` / etc. |
| struct refs      | `StructRef(name)` | `{Name}Schema`                     |

| Deliberately unmapped (errors today)| reason                                 |
|-------------------------------------|----------------------------------------|
| `enum`                              | needs zod enum mapping + TS string union|
| `union` (in-struct)                 | needs zod discriminated union          |
| `list`                              | needs `z.array(...)` + element walk    |
| `group`                             | needs nested-anonymous-struct emit     |
| `interface`                         | RPC types — out of scope for now       |
| `const`, `annotation`               | not used at the surfaces we care about |
| `anyPointer`                        | typed-erasure escape hatch; unmapped   |
| generics (`$Foo(T)`)                | needs IR generics representation       |

Adding any of these is a focused change: extend the IR variant, add
the emit in `outputs/zod.rs`, add one golden test + one fail-case
test. The fail-case test stays even after the construct is supported,
to guard against regressions in adjacent constructs (e.g. don't let
`group` start silently emitting nothing).

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

1. JSON-extension input adapter for the aggregation pattern (capnp
   defines the structural backbone, JSON files supply per-variant
   field extensions). Where the polymorphism for skill / mcp / agent
   actually lands.
2. Enum + union support — needed before the EnabledItem union can be
   defined.
3. List + group support — needed for any non-trivial schema.
4. JSON Schema output adapter (`outputs/json_schema.rs`) — drives the
   `$schema` field in `.cloister.json` for editor autocomplete.
5. TS-types-only output adapter, separated from the zod emit, so
   consumers can pick one or both.
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
