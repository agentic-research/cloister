---
title: "ADR-0073: Resource facts are imported, never granted"
status: Proposed
date: 2026-11-11
tags: [importer, terraform, opentofu, cloudflare, facts, authority, privacy]
tracking-bead: cloister-85999c
relates_to:
  - 0038-derive-bundle-image-from-packages.md
  - 0069-declared-connections.md
  - 0070-placements-and-channel-strength.md
  - 0072-placements-are-realizers.md
---

# ADR-0073: Resource facts are imported, never granted

Tracking bead: `cloister-85999c`. Research:
[IaC graphs as cloister graph input](../research/iac-graphs-as-cloister-input-2026-11-11.md).

## Context

Operators already describe their infrastructure in Terraform or OpenTofu.
Those tools render what they manage as a documented JSON document
(`terraform show -json`), with resource types, resolved attributes and a
marker for each sensitive value. Cloister's graph has a forwarded side
(ADR-0070 §2) that is typed by hand today: which Worker binds which service,
what a tunnel routes to, where a database lives.

Reading the rendered document fills that side in without restating it. It
also carries a risk that this ADR exists to close: an operator's
infrastructure is often more permissive than their intent. If finding a
binding in Terraform state could make it an authorized edge, importing a loose
configuration would quietly grant access nobody declared.

## Decision

### 1. An importer produces facts, and a fact cannot carry authority

`importFacts(document)` returns resource facts. A fact has exactly five
fields: `source`, `address`, `type`, `name`, `attrs`. There is no grant,
connection, edge or wire field, and the constructor refuses one by name. So
"discovered is not authorized" is a property of the type. It doesn't depend on
reviewer discipline.

Only a declaration in `cluster.toml` grants anything. A report can show a
fact beside a declaration. Nothing turns one into the other.

### 2. Input is a rendered document, and cloister runs no tool

The importer reads the output of `terraform show -json` or `tofu show -json`,
state or plan, that the operator rendered. It doesn't run Terraform, read a
backend or parse HCL (ADR-0070 §2: rendered output only, with a real parser).
It refuses a `format_version` major it doesn't know. It also refuses the raw
`.tfstate` file, which is not a documented format.

### 3. Attributes are allowlisted per resource type, and the document's sensitivity markers are honoured

Each adapter names the attributes it may read for one resource type. An
attribute that isn't named is never read. The importer doesn't read:
- a Worker's source;
- the value of a binding (`text`, `json`, key material);
- a tunnel secret;
- who an Access policy admits;
- a DNS record's content.

A named attribute that the document marks in `sensitive_values` is dropped
too. If a whole list is marked sensitive, the list is withheld and the report
says so.

Account, zone and resource ids are kept only as join keys, so the report can
resolve a binding to a name. They are not printed.

### 4. A rendered document is a secret, and the tool treats it as one

`show -json` prints every secret in the state in plain text. So:
- `cloister inspect` refuses an input file that git tracks.
- Committed fixtures are synthetic. A test holds them to reserved example
  names and ids made of one repeated digit.
- Nothing from a run against real infrastructure is written anywhere.

### 5. The first consumer is a report with three findings

`cloister inspect --terraform <file>` lists what the document describes. With
a `cluster.toml`, it compares each declared wire against the document:

| Finding | Meaning | What it does not mean |
|---|---|---|
| `evidenced` | a declared wire has a matching binding | that the binding is the only path |
| `unknown` | a declared wire has no matching binding in this document | that the edge is unenforced; the evidence may live elsewhere |
| `undeclared` | the document binds one workload to another and no wire declares it | that the edge is now allowed; it is reported and nothing else |

The report changes neither input.

### 6. Cloudflare first

The first adapter reads the Cloudflare provider's types:
- Worker scripts and their bindings;
- routes;
- KV and D1;
- tunnels and their ingress;
- Access applications;
- DNS names.

Cloister's own production placement is Workers, and a Worker's service
bindings are the same capability edges cloister declares as `wires`. So the
comparison is exact, not approximate. Under ADR-0072 this supplies the
`workerd` realizer's facts.

## What exists today

| Part | State |
|---|---|
| §1 the fact type and its refusal | built |
| §2 `show -json` reader (state and plan) | built |
| §3 allowlists and sensitivity handling, Cloudflare types | built |
| §4 tracked-file refusal, synthetic-fixture test | built |
| §5 `cloister inspect` report | built; wires only |
| Declared connections (ADR-0069) in the comparison | not built |
| Other providers (Google, per the research note) | not built |
| Target resolution from facts; emitting a policy fragment | not built; each needs its own decision |

## Out of scope

- Running any infrastructure tool, or reading a backend.
- Turning a fact into a declaration, even as a suggestion written to a file.
- Raising or lowering a computed channel strength from a fact (ADR-0070 §3).
  Evidence is reported next to strength. It doesn't change it.
