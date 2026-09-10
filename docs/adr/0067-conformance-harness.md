---
title: "ADR-0067: Test the artifacts we emit, not the source we wrote — a conformance harness"
status: Proposed
date: 2026-08-06
tags: [testing, conformance, rails, ci, tooling]
tracking-bead: cloister-d65c11
---

## Context

cloister has 26 lint scripts and 72 script-test files. Over one working session
they caught **none** of the nine real defects found in that session.

| Defect | What caught it |
|---|---|
| `credentialSource: "vault://"` — a scheme §5 does not close over | LLO's parser, run by hand |
| `fs.allow` bare relative paths | LLO's parser, run by hand |
| Origin sets: silence outranked honesty | probing the real code path |
| Asked nono for a bidirectional grant, needed one-way | reading nono's emitter |
| `leyline-runtime` reopened threat model §17.1 | `cargo deny` |
| `leyline-sign/host-extras` has never built on Linux | CI, on a Linux runner |
| `lint:sibling-bead-refs` documented a clearance path it did not implement | a real case needing that path |
| README and RUNNING.md described deleted code | a human reading them |
| `task verify` ran a stale harness binary | `task verify` running the real thing |

n=9 from one session is a small sample and this ADR should not pretend
otherwise. But the pattern is not subtle: **everything was caught by executing
against something real, or by a person.** Nothing was caught by cloister
inspecting its own source text.

### The category error

The rails assert properties of **the source we wrote**. The defects live in
**the artifacts we emit** — confinement documents, execution requests, receipts,
capability manifests, dependency closures — which other systems parse and
refuse. Those are different objects, and the checks point at the wrong one.

Two of the defects above make this concrete. `d2ba07` and `bd6399` were both
in the same emitted document, and the second was *hiding behind the first*:
fixing the §5 scheme let the parse advance far enough to reach the §2 refusal.
A conformance check would have reported both at once. Per-dimension source
inspection reported neither, for a year.

### Three problems wearing one mechanism

| Problem | Example | Mechanism it wants | Mechanism it has |
|---|---|---|---|
| **Conformance** — does what we emit satisfy the consumer? | `vault://`, bare paths, the keyring closure | run it through the consumer | none |
| **Consistency** — do two hand-copies agree? | mirror version, binding parity, `cluster-types.ts` | regenerate and diff | about half |
| **Discipline** — is a pattern followed? | derived-not-declared, secret locality | analysis over the AST | grep |

14 of 26 lint scripts match text rather than parse anything. That is a ceiling,
not a stage: `lint:origin-derivation` catches 0 of 3 one-line evasions
(`"origin-" + "attested"`, a template literal, `Array.join`), and the
mirror-version rail needed three regex attempts to see two declarations in the
one file it was written for. A grep cannot be made into a proof by adding
clauses to it.

### What comparable projects do instead

- **workerd** runs **Web Platform Tests** — the specification's own corpus.
  Conformance is inherited rather than authored, so it cannot drift from the
  spec by being restated incorrectly.
- **Kubernetes** `hack/verify-*.sh` is **regenerate-and-diff**, never
  assert-about; `apimachinery` adds **round-trip fuzzing**
  (`decode(encode(x)) == x` over generated values); and the conformance suite is
  written to be passed by *a different implementation*.
- **rustc's compiletest**: a test is an input plus an expected-output file, so a
  behaviour change surfaces as a **golden diff in review** rather than as a
  passing or failing boolean.
- **go vet** operates on the AST. Never on text.

The transferable core is three words: **derive, execute, golden.**

## Decision

A conformance harness in three layers, plus two structural fixes.

### L0 — An artifact registry

One declaration of every artifact cloister emits that another system consumes:
what produces it, which schema governs it, who consumes it.

This is the load-bearing layer even though it is the smallest. Nothing today
enumerates these artifacts, which is exactly how two refusals in one document
hid behind each other — there was no list on which the document appeared, so
there was no place for its coverage to be missing from.

### L1 — Golden + schema. Portable; always runs

For each registered artifact: emit it, validate against the **vendored** schema,
and diff against a **committed golden**.

Portable is the point. cloister's CI has no sibling checkout, and the strongest
check we currently have — the schema-driven confinement test — is local-only and
therefore absent from the runner where a stale mirror would sit unnoticed.

The golden is what converts a silent change into a reviewed one. `d2ba07` and
`bd6399` both changed the `confinementDigest` committed into every minted cert;
under L1 each would have appeared as a diff a human approves, rather than as an
§8 commitment mismatch at exec time, far from its cause.

### L2 — Counterparty conformance. When the sibling is present, and nightly

Drive the golden through the real consumer's parser.

This is the layer that actually found the defects, and it currently exists only
as something a person constructs by hand and then deletes: the throwaway crate
built against LLO integration head `b9b800c`, which answered `FOLD-REFUSED` and
named the dimension. Making it permanent and cheap is most of the value in this
ADR.

### Discipline checks move to the AST

`tsc` already runs in the gate, so the compiler API costs nothing new. Checking a
*type* rather than a *string* removes the evasion class entirely: the question
"is this value a `Confidence` that came from somewhere other than
`deriveConfidence`" is answerable from the AST and unanswerable from grep.

### Path-filtered gates get a schedule

`verify (strict)` was skipped by a path filter on successive PRs, and the first
run that matched it found a Linux break latent since v0.15.1. **Skipped must not
be able to mean never.** Tiering by path is correct — a gate that always runs
gets disabled — but it needs a periodic job behind it, which is how Kubernetes
handles the same tension.

### The harness reports its own coverage

Which registered artifacts have L1, which have L2, which have neither. Nothing
today can answer that, which is how "26 rails" became a comfortable number
rather than a measured one.

## Scope: prove it on one artifact first

The confinement document, because it is the one that already broke twice and
because both its schema and a real consumer are reachable. Generalising before
one artifact works end to end would produce a registry of things nobody checks.

## Alternatives considered

**Keep adding lint scripts.** The status quo, and its yield over the sample
above is zero. It also has a failure mode worse than missing a defect: a rail
asserting stale text *holds a document in a false state*, because deleting the
stale line fails the test. That happened to `docs/RUNNING.md`, which kept
describing a deleted execution path because a rail required the phrase.

**L2 only.** It is where the value was, but it cannot run in CI without a
sibling checkout, and a check that only runs on developer machines is a check
that runs where everything already works — the shape that hid the keyring break.

**Round-trip fuzzing instead.** Worth having and orthogonal: it proves a codec
is self-consistent, not that a counterparty accepts it. `confinement_digest.rs`
already proves cloister and LLO agree on canonical bytes, and both refusals
sailed past it, because it never read a document cloister produced.

**Adopt a framework.** Nothing off-the-shelf models "artifact, schema,
counterparty". The registry is ~50 lines; the layers are ordinary tests.

## Consequences

- Adding a new emitted artifact becomes one registry entry plus a golden,
  instead of a bespoke lint script written in whatever shape occurred to its
  author.
- Golden diffs make wire and digest changes visible in review. This is a real
  cost: changing an emitted artifact will require updating a checked-in file,
  deliberately.
- The existing 26 lint scripts do not disappear. The text-matching ones stay
  useful as tripwires for the honest mistake; what changes is that they stop
  being described as though they close a class.
- Coverage becomes reportable, which means it also becomes visibly incomplete.
  That is the intended outcome.

## What this does not fix

- **Adversarial evasion.** A determined author defeats any of this. These
  checks are for honest mistakes, which is what all nine defects were.
- **Model-level behaviour.** cloister observes what enters and leaves an
  isolate, never what happened inside — see ADR-0065's same limit.
- **Anything needing a real kernel.** Linux enforcement cannot be verified from
  a macOS host; that stays CI's job, which is the argument for the schedule
  above rather than against it.
