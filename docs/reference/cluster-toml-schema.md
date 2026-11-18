# The cluster.toml schema

`cluster.toml` has a published JSON Schema:
[`schema/cluster.toml.schema.json`](../../schema/cluster.toml.schema.json).

Its stable address is its `$id`:

```
https://raw.githubusercontent.com/agentic-research/cloister/main/schema/cluster.toml.schema.json
```

That address follows `main`. A checkout or an installed copy of cloister
carries the schema that matches it, at `schema/cluster.toml.schema.json`.

## What it is for

- **An editor** can complete a key and flag a typo while you write. With a
  TOML language server that reads schema directives (taplo, which the "Even
  Better TOML" extension uses), put this on the first line of the file:

  ```toml
  #:schema https://raw.githubusercontent.com/agentic-research/cloister/main/schema/cluster.toml.schema.json
  ```

  `cloister cluster generate` rewrites `cluster.toml` and does not keep
  comments, so the line has to be put back after a rewrite.

- **Another tool** can read or write a `cluster.toml` without copying
  cloister's parser.

- **Cloister's own parser** refuses any key the schema does not define. A
  typo'd key is an error that names the key. Before, some tables dropped a key
  they did not recognise, and the setting silently did not apply.

## What it does not check

A file that validates has the right shape. The build still checks what a
schema cannot:

- names that must be unique, or must match a name declared elsewhere;
- a connection's port existing on its target bundle, with the same
  `appProtocol`;
- a `minStrength` the placements can meet;
- an `appProtocol` being a blessed `art.*` label or a vendor `x-` label;
- a placement's `kind` being one cloister knows.

Those fields are plain strings in the schema.

## How it is produced

It is generated, never written by hand:

```
manifest/cluster.capnp
  →  src/generated/cluster.schema.json     LLO's schema-bridge
  →  schema/cluster.toml.schema.json       scripts/gen-cluster-toml-schema.mjs
```

```sh
task cluster:jsonschema          # step 1: capnp → JSON Schema, by LLO's generator
task cluster:toml:schema         # step 2: reshape it for TOML
```

Both steps have a drift check in `task lint`
(`cluster:jsonschema:check-drift`, `cluster:toml:schema:check`).

Step 1 is LLO's `capnpc-schema-bridge-jsonschema`, the same generator family
that produces `cluster.zod.ts`, pinned by digest in `schema-bridge.lock.json`.
Its output describes the capnp shape: one named definition per struct.

Step 2 exists because a `cluster.toml` is not quite that shape. Three things
differ, and the script applies each:

| In the capnp schema | In cluster.toml | In the JSON Schema |
|---|---|---|
| A union: `kind: { external: {...} }` | `kind = "external"` beside a `[bundles.external]` table | The tag is an `enum` and each variant's table is a field. A `oneOf` forbids the tables of the variants not chosen. |
| A union whose variants carry nothing: `transport: { uds: null }` | `transport = "uds"` | A string with an `enum` |
| A list of inputs, each with a `name` | `[inputs.<name>]` | A table keyed by name, or the list form |

capnp has no required fields: every field has a value on the wire, which is
why LLO's output marks them all required. A hand-written file omits most of
them, so the TOML schema requires only what such a file must state:
`[metadata]` with a `name` and a `version`.

The struct names survive as definitions (`#/$defs/Bundle`,
`#/$defs/PortSpec`), so a tool can refer to one part of the schema. Types
`cluster.capnp` declares for other files are left out.

The schema uses only the keywords cloister's own validator implements
(`scripts/lib/json-schema-subset.mjs`), so a test holds every `cluster.toml`
in the repository to it, along with everything cloister's writer emits.

## Checked against real tools

Besides cloister's own validator, the schema was run through two tools that
share no code with it:

- **Ajv** (draft 2020-12, strict mode) compiles it and agrees with cloister's
  validator on every `cluster.toml` in the repository and on each rejected
  mistake tried.
- **taplo** (`taplo lint`, the engine behind the "Even Better TOML" editor
  extension) accepts every `cluster.toml` in the repository, resolves the
  `#:schema` directive from a relative path, and names a typo'd key:
  `Additional properties are not allowed ('tire' was unexpected)`.

Neither is a dependency or part of `task lint`. The union layout above exists
because of taplo: with a full copy of the struct in each `oneOf` branch, a
typo failed every branch and the message could only say the whole table was
"not valid under any of the schemas".

One message is still vague: a table for a variant the bundle is not (a
`[bundles.workerd]` on an `external` bundle) is reported as a `oneOf` failure
on the whole bundle.

## Known limits

- **Descriptions cover the structs an operator writes most, not all of
  them.** A description is a `$Traits.doc("...")` annotation on a struct or
  field in `cluster.capnp`. LLO's generator turns it into `description`, which
  is what an editor shows on hover. The cluster, bundles, ports, placements,
  connections, confinement, wires, storage and the main input fields have
  one. Routes, the gateway, harness targets, tenancy and edges do not yet.
  The `#` comments in `cluster.capnp` reach no generated file
  (`ley-line-open-d554a0`), so a description has to be written as an
  annotation.
- **`cloister.capnp` has no schema here.** This covers `cluster.toml` only.
