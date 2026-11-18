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
manifest/cluster.capnp  →  src/generated/cluster.zod.ts  →  schema/cluster.toml.schema.json
```

```sh
task cluster:toml:schema         # regenerate
task cluster:toml:schema:check   # fail if the committed file differs (in `task lint`)
```

The generator is `scripts/gen-cluster-toml-schema.mjs`. Two things differ
between the TOML you write and the shape the capnp schema describes, and the
generator applies both:

| In the capnp schema | In cluster.toml | In the JSON Schema |
|---|---|---|
| A union: `kind: { external: {...} }` | `kind = "external"` beside a `[bundles.external]` table | A `oneOf` with one branch per tag. Each fixes the tag with `const` and admits only its own table. |
| A union whose variants carry nothing: `transport: { uds: null }` | `transport = "uds"` | A string with an `enum` |
| A list of inputs, each with a `name` | `[inputs.<name>]` | A table keyed by name, or the list form |

capnp has no required fields, so the schema requires only what a hand-written
file must state: `[metadata]` with a `name` and a `version`.

The schema uses only the keywords cloister's own validator implements
(`scripts/lib/json-schema-subset.mjs`), so a test holds every `cluster.toml`
in the repository to it, along with everything cloister's writer emits.

## Known limits

- **No field descriptions.** The capnp schema's comments do not reach the
  generated zod schema (`ley-line-open-d554a0`), so they do not reach this one.
- **`cloister.capnp` has no schema here.** This covers `cluster.toml` only.
