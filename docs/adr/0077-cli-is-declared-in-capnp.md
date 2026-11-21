---
title: "ADR-0077: The CLI is declared in capnp; its help, docs, parsers and output formats are generated"
status: Accepted (2026-11-21)
date: 2026-11-21
tags: [cli, schema-bridge, generated, output-format, format-version, surface, one-file-build]
tracking-bead: cloister-ca2582
relates_to:
  - 0004-capnp-manifest.md
  - 0025-bidi-toml-pipeline.md
  - 0036-schema-bridge-multi-output.md
  - 0073-resource-facts-are-imported-never-granted.md
  - 0075-one-graph.md
---

# ADR-0077: The CLI is declared in capnp; its help, docs, parsers and output formats are generated

## Status

Accepted (2026-11-21), on the owner's direction that the CLI's contract be
generated rather than hand-kept. Part 1 (output formats) needs nothing new and
is built first. Part 2 (the command surface) needs three annotations from LLO
and waits on them. Part 3 (parsers) follows Part 2, one command at a time.

## Context

`cloister` now ships as one file (`dist/cloister.mjs`) and a GitHub Action, and
its first release is about to fix what other people depend on: the commands,
their flags, and the JSON that `inspect --json` and `cluster graph --json`
print. Today each of those is held by hand, in more than one place:

- **The command surface** is `cli/surface.mjs`, a hand-written list. Help and
  `docs/reference/cli.md` are generated from it, which was the right first
  step. But every command then parses its flags again, by hand, and nothing
  checks that the parser accepts what the list declares. Until this week each
  command also answered `--help` its own way, and several did real work first.
- **The JSON outputs** have no declaration at all. Their shape is whatever the
  code builds. A finding's kind is implicit in which keys happen to be present
  (`connection`, `access`, `exposure`, `wire` with `binding`, `from` with
  `dial`). Neither output carries a version, so a consumer cannot tell a shape
  it knows from one it does not.

This repository already settled how a contract is held: one capnp schema, and
LLO's schema-bridge generating every projection from it (ADR-0004, ADR-0025,
ADR-0036). `cluster.capnp` becomes `cluster.zod.ts` and the published
`cluster.toml.schema.json`, and a rail keeps each in step. LLO already uses the
same generator for an operation surface: its `execution/v1` contract declares
each operation as a struct annotated `$Op(name, input, output)`, and
schema-bridge's tool-definitions output turns that into `{name, description,
inputSchema}`. A CLI command is the same thing: a name, a description, typed
flags with defaults and required-ness, and, for some, a typed output.

## Decision

`manifest/cli.capnp` declares the CLI. Everything else about it is generated.

### Part 1: output formats are declared, versioned and checked

1. Each JSON output is a struct in `manifest/cli.capnp`, documented with
   `$Traits.doc` (the only comments schema-bridge carries into generated
   files). Today: the `inspect --json` report and the `cluster graph --json`
   graph. A finding is a struct with an anonymous union, one variant per kind
   of finding, so "exactly one of these" is in the schema, not in the reader's
   head.
2. Each carries **`formatVersion`**, `"MAJOR.MINOR"`: the convention of
   Terraform's own `format_version`, which ADR-0073 already reads, in these
   outputs' camelCase. A consumer
   refuses a major it does not know and ignores fields it does not know. A
   minor change only adds; anything else is a major change.
3. schema-bridge generates `src/generated/cli.zod.ts` and the published
   `schema/cli.schema.json`, kept in step by a drift rail like
   `cluster:jsonschema:check-drift`.
4. Every JSON output a test produces is parsed with the generated zod schema,
   **strictly**, before the test looks at it. The declaration cannot describe
   less or more than the code emits.
5. `schema/cli-formats.lock.json` records, per output, its `formatVersion` and
   the digest of its generated schema. A rail fails when the digest changes and
   the version does not, and when a property is removed or retyped under a
   minor bump.
6. The shape may change to fit the declaration until the first `cli/v*` tag.
   Nothing has been released under it.

### Part 2: the command surface is declared

1. Each command is a struct annotated `$Traits.op(name = "<command words>",
   input = "<Flags struct>", output = "<Output struct>")`. The input struct's
   fields are its flags, with type, default (capnp's own `= value`), and
   `$Traits.optional` for what is not required. `$Traits.doc` on the op is the
   summary; on the input struct, the detail.
2. schema-bridge's tool-definitions output generates `src/generated/cli.tools.json`.
   `cli/surface.mjs` becomes a projection of it: it reads the generated list
   instead of holding one.
3. What `_traits.capnp` cannot say today, and is asked of LLO because LLO owns
   that vocabulary
   ([agentic-research/ley-line-open#599](https://github.com/agentic-research/ley-line-open/issues/599),
   with the schema-bridge limits Part 1 met):
   - a **positional** argument (`runtime plan <bundle>`), with its order;
   - a flag's **value placeholder** in help (`<file>`, `<name>`);
   - a free **tag** on an op, so cloister can mark a command `standalone`
     (runs in the one-file build) without LLO knowing what that means.
   Until they land, those three stay in a small hand table beside the
   generated list, and a rail requires every key in it to name a generated
   command, so the table can only shrink.

### Part 3: parsers are generated

Each command's flags are parsed from the generated input schema instead of by
hand: `cli/lib/flags.mjs` reads the command's entry in
`src/generated/cli.tools.json` and parses with Node's `util.parseArgs`, strict.
A field `fooBar` is `--foo-bar`, a Bool is a switch, a default is capnp's own
`= value`; an undeclared flag, a missing value, a stray argument or a flag
given twice is refused by name. This moves one command at a time, starting
with `cluster graph`. Until Part 2 generates `cli/surface.mjs`, a test holds
the flags it lists for each declared command equal to the declaration.

## Consequences

- One file says what the CLI is. Help, `docs/reference/cli.md`, the published
  output schemas, the parsers and the tests all read it.
- A consumer of `--json`, including the GitHub Action, can check
  `formatVersion` and validate against a published schema.
- The `inspect --json` report changes shape once, before release: a finding
  names its kind by which variant it carries, as the schema says.
- The first `cli/v*` tag waits for Part 1. Part 2 and Part 3 do not block it:
  they change how the surface is held, not what it is.

## Considered and rejected

- **A hand-written JSON Schema per output.** It is a second copy of what the
  code builds, and nothing would keep the two together but care.
- **Deriving the schema from the code (TypeScript types, or sampling
  outputs).** The declaration would follow the code instead of constraining
  it, and a sample only shows the shapes the fixtures happen to reach: the
  sample plans reach a few of the finding shapes the code can build, not all.
- **A TypeScript CLI framework (commander, yargs, oclif).** Each holds the
  surface in code, in its own shape. The surface would still not be a schema
  that another tool, or another language, can read.
