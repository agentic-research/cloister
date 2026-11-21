---
title: "ADR-0077: The CLI is declared once; its help, docs, parsers and output formats are generated"
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

# ADR-0077: The CLI is declared once; its help, docs, parsers and output formats are generated

## Status

Accepted (2026-11-21), on the owner's direction that the CLI's contract be
generated rather than hand-kept. Part 1 (output formats, in capnp) is built.
Part 2 was amended the same day: the command surface is declared in
`cli/surface.mjs`, not capnp, so it needs nothing from LLO. Part 3 (parsers
generated from that declaration) moves one command at a time.

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

The CLI is declared once, and everything else about it is generated from that
declaration or checked against it. Its JSON outputs are declared in
`manifest/cli.capnp`, because they are a published contract other programs
read. Its commands and flags are declared in `cli/surface.mjs`, because only
cloister reads them (Part 2, as amended).

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

**Amended 2026-11-21, before any of the original Part 2 was built.** The
declaration of the commands is `cli/surface.mjs`, not capnp.

The original text made each command a `$Op` struct and `cli/surface.mjs` a
projection of schema-bridge's tool definitions. Building the first command
that way (`cluster graph`) showed what it costs: three annotations asked of
LLO for concepts only a command line has (positional arguments, help-text
placeholders, a free tag for `standalone`), a capnp compile for every flag
change, and, until the move was finished, the same flags declared twice and
held equal by a test.

`cli/surface.mjs` already is a declaration: plain data with no imports, read
by help, `docs/reference/cli.md`, the one-file build's `standalone` set and
the `--help` rule. The only reader of a command's flags is cloister's own
JavaScript. mache, the sibling repository, makes the same choice for the same
kind of surface: its command tree and tool registry are data in its own code,
and every other artifact is generated from them or tested against them.

So capnp stays where a language-neutral, published contract has readers: the
JSON outputs (Part 1). The command surface is the one in `cli/surface.mjs`,
and Part 3 generates its parsers from it. If cloister's commands are one day
offered as MCP tools, `cli/surface.mjs` gains a projection to `tools/list`
beside the help and docs ones; the declaration does not move.

agentic-research/ley-line-open#599 is narrowed to the three schema-bridge
limits Part 1 met; the three annotations are withdrawn.

### Part 3: parsers are generated

Each command's flags are parsed from its declaration instead of by hand:
`cli/lib/flags.mjs` reads the command's entry in `cli/surface.mjs` and parses
with Node's `util.parseArgs`, strict. A flag with a `value` takes one, one
without is a switch, a `repeatable` flag may repeat, an absent flag takes its
declared `default`, and a `required` one must be given. An undeclared flag, a
missing value, a stray argument, a flag given twice and a switch given a value
are each refused by name. Help renders a declared default from the same
entry, so help and parser cannot disagree about it. This moves one command at
a time, starting with `cluster graph`; `cli/test/flags.test.mjs` holds each
moved command to its declaration.

**Amended 2026-11-21: arguments, short aliases and examples are declared too.**
A command's positionals are declared as `arguments`, each `<name>`, required
or not; only the last may repeat. A flag may declare a `short` alias (`-y`),
and a command may declare `examples`. Help and `docs/reference/cli.md` render
all three, and the parser accepts exactly what is declared. `lint:doc-invocations`
parses a documented invocation of a command that declares its arguments with
that command's own parser.

`cli/test/flags.test.mjs` holds every declared command to its declaration
through the real entry point, except an explicit list of commands that still
parse by hand. That list only shrinks: a new command is parsed from its
declaration, or is added to the list where a reviewer sees it.

Moving `add` and `artifacts pull` found what Context predicts. Each accepted
flags its declaration did not list, so help hid them:
- `add` accepted `--provides` and `--requires`;
- `artifacts pull` accepted `--print`, `--yes` and `--allow-unpinned`.

## Consequences

- Two declarations, each said once: `cli/surface.mjs` for the commands (help,
  `docs/reference/cli.md`, the parsers and the one-file build read it) and
  `manifest/cli.capnp` for the outputs (the published schemas, the run-time
  output check and the version lock read it).
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
  surface in code, in its own shape, as calls rather than data. Help, docs,
  the one-file build and the parser would read the framework's objects instead
  of one plain declaration, and the `standalone` and `--help` rules would be
  the framework's hooks to keep in step.
- **The command surface as capnp `$Op` structs (the original Part 2).** See
  the amendment under Part 2: it put CLI-only concepts into LLO's annotation
  vocabulary and held the flags in two places during the move, for no reader
  that needs a language-neutral form.
