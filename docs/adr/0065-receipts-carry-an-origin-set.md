---
title: "ADR-0065: Receipts carry an origin set — confidence is derived from provenance, not declared"
status: Proposed
date: 2026-08-05
tags: [receipts, provenance, attestation, trust-boundary, apas, wire-format]
threat_model: docs/security/threat-model.md
tracking-bead: cloister-16f81c
---

## Context

`ReceiptCommitment` (`src/wire/receipts.ts:140`) commits to `nonce`,
`requestHash`, `status`, `bodyHash`, `headersHash`, `timestampMs`, `actorFp`,
`epoch`.

That is a complete account of **which bytes moved and who moved them**. It is
silent on **where the content came from**. A body cloister composed itself and a
body containing a README fetched from a hostile host hash identically well;
`bodyHash` is true of both and distinguishes neither.

So the receipt is the right artifact in the wrong vocabulary. It attests
transport integrity. It does not attest content provenance, and nothing else in
cloister does either.

### The asymmetry, stated exactly

cloister has trust labels — for **executors**:

- `trustedTier @2 :Bool` (`manifest/cluster.capnp:611`) — a workerd instance is
  trusted or not, enforced by lint Inv 6 against `input.workerdId`.
- `provenance @9 :Text` (`manifest/cluster.capnp:1045`) — where a harness target
  came from.

It has **none for data**. Grepping `provenance|origin|untrusted|trustLabel`
across `src/wire/receipts.ts` and `src/routes/bead-create-orchestrator.ts`
returns exactly one hit, and it is the string `"access-control-allow-origin"` in
a header denylist.

That asymmetry **is** the trusted-tool-loads-untrusted-input problem. Every
mechanism cloister has built bounds what a *compromised* tool can reach:
ADR-0013 slice grants, `confinement/v1` default-DENY dimensions, Inv 1's
no-egress rule, the vault proxy's credential custody. None of them say anything
about what a *correctly behaving* tool was told. A confined, attested,
correctly-functioning agent that reads a poisoned issue description and writes a
bead is operating entirely within its declared boundary, and every receipt on
that path verifies.

### Why this is exactly the APAS L3 → L4 line

`signet/docs/apas/agent-provenance-standard.md` §2 puts it in the same terms.
L3 (Isolated Execution) proves "the dispatch operated within declared
boundaries" and states in as many words what it does **not** prove: "The
dispatch's inputs were not poisoned." That is L4 (Verified Inputs).

Measured against L4's five requirements, cloister is closer than the spec's
`[TARGET — future]` label suggests, because cloister already sits on the seam
every input crosses:

| L4 requirement | cloister today |
|---|---|
| Work-item descriptions immutable, content-hashed | **Shipped** — `beads.content_hash`, BlobStore canonical bytes, ADR-0012 handoff. APAS names `BeadSpec::content_hash` as its reference implementation. |
| MCP server responses logged and hashed | Mechanism present (`bodyHash`); cloister *is* the proxy. Origin absent. |
| Model provider responses logged | Mechanism present — the vault proxy sees all of it. |
| System prompts / skills content-hashed and attested | Partial — ADR-0043 delivers them with load-event receipts, but does not distinguish them as *prompt inputs*. |
| Agent definition + runtime attested | Partial — `confinementDigest`, ADR-0041 image pins, ADR-0062 `executionMode`. No runtime SBOM. |

Three of five have the mechanism and lack only the vocabulary. The distance to
L4 is not five features; it is **one missing concept, absent in five places**.

## Decision

### 1. A receipt payload carries an origin set

An **origin set** is the set of sources the committed content derives from. It
travels with content through the pipeline and is committed in the receipt, so a
receipt says *content used*, not merely *bytes moved*.

### 2. An origin names a vouching authority, not a boolean

An entry is `(uri, vouchedBy)` — not `(uri, trusted: Bool)`.

`manifest/cluster.capnp:534` already argues this for a sibling field: *"A
REASON, not a boolean, for the same cause as `HarnessTarget.provenance`."* The
same cause applies with more force here, for a reason specific to provenance:

**Trust is deployment-relative and the ingest point does not know it.** A host
an internal deployment trusts is one a federated peer does not. A boolean baked
in at fetch time freezes one deployment's answer into bytes that outlive it and
travel to peers who would answer differently. Naming the authority defers the
trust decision to whoever evaluates the receipt, against *their* trust set —
which is how `resolveLeaseGate` already treats CA authority, and how the
disclosure endpoint already treats peer attestations.

An origin with no vouching authority is representable and means exactly that:
ingested, unvouched. It is not an error. It is the common case for anything an
agent fetched off the open web, and being able to *say so* is the point.

### 3. Confidence is DERIVED from the origin set, never declared

This is the enforcement answer, and it is deliberately not a new field to set.

A `confidence` an author writes is a **claim**. A confidence computed from the
origin set is a **fact**. Nothing may assert full confidence in a fact whose
origin set is unvouched-only; that is not a rule applied to the value, it is a
consequence of how the value is obtained.

Every other authority question in cloister already resolves this way and
fail-closed: `resolveLeaseGate` treats *no authority at all* as enforce-then-fail
rather than off (ADR-0053); confinement dimensions are default-DENY with no
unrestricted mode; the capability matchmaker fails the build on unsatisfied,
ambiguous, self-provided or cyclic declarations rather than resolving one
arbitrarily (ADR-0027/0054). An unvouched-only origin set is the same shape as
an empty authority, and gets the same answer.

### 4. Mint at ingest, union at compose — and rail it

- A stage that **ingests** external content mints an origin entry for it.
- A stage that **composes** content unions its inputs' origin sets.
- A stage that emits content with an empty origin set, when its inputs' were
  non-empty, is a bug.

That last line is the rail, and it is the load-bearing half of this ADR. **A
field set at one hop and dropped at the next is strictly worse than no field**:
it reads as verified provenance while being a guess, and a consumer that trusts
it is worse off than one that knew nothing. This is the identical failure to
`cloister-d2ba07`, where a digest was computed faithfully — correct BLAKE3 over
correct canonical bytes — of a document that was never schema-valid. The
mechanism was sound and the meaning was false.

Per CLAUDE.md's standing rule, the rail lands in the same change as the field.

### 5. Enforcement at write time

The check belongs where the substrate decides, not where a consumer reads.
Write time is a boundary; attestation time and read time are labels. ADR-0054's
"the model parses, the substrate decides" settles this.

Concretely: `src/routes/bead-create-orchestrator.ts` already runs the ADR-0012
four-step handoff and writes `peer_attestations` rows against the authorizing
cert, and `beads.content_hash` already links a bead row to its canonical bytes.
Origin travels on that existing path.

Writing a bead whose origin set is unvouched-only is **not refused** — an agent
summarising a fetched page is a legitimate workflow and refusing it would push
users to strip provenance to get work done, which is the worst possible outcome.
What is refused is *attesting it as though it were vouched*. The row records
what it is.

## Scope — phased, smallest load-bearing slice first

1. **`bead_create`.** The one state-boundary write already participating in the
   §13.4 audit chain. Smallest slice that is end-to-end real rather than
   decorative.
2. **MCP proxy responses.** Where cloister sees the most untrusted content and
   already computes `bodyHash`.
3. **Skills and system prompts** (ADR-0043 load-event receipts), which closes
   L4's fourth requirement.

Phase 1 alone does not reach L4. It is chosen because a provenance mechanism
proven on one real path is worth more than one declared across three.

## What this does NOT claim

Stated explicitly, because a provenance feature invites all three overclaims.

**Origin is not safety.** A vouched host serving attacker-controlled content
yields a vouched origin. Origin sets bound *accountability* — who vouched, so
who is answerable — not content safety. Anyone reading this ADR as "poisoned
input is now solved" has read it wrong. L4 is "Verified Inputs", and verified
means attributable, not benign.

**Origin sets are disclosure surface.** Source URIs in a receipt are metadata
about what an agent read. The disclosure endpoint's constant-time 404 and
HMAC-signed cursors exist because peer-existence was an oracle (threat model
§9); origin sets are a richer oracle on the same surface. Extending the threat
model is a prerequisite for phase 2, not a follow-up — per CLAUDE.md, a new seam
means the model is extended first.

**This does not make cloister L4-conformant.** It supplies the missing concept.
Two of the five requirements stay partial afterwards, and APAS L4 also wants a
runtime SBOM that ADR-0041's image pins only approximate.

## Alternatives considered

**Do nothing; document the gap.** The status quo, and it is what makes L4
unreachable rather than merely unimplemented. Receipts already look like
provenance to a reader — they are signed, they are chained, they name an actor —
so the gap is actively misleading, not just absent.

**A boolean trust label at ingest.** Cheaper, and wrong for the reason in
Decision 2: it freezes one deployment's trust answer into bytes that travel to
peers with different answers. It also cannot express "ingested, unvouched" as
distinct from "ingested, judged untrustworthy", and those are different facts.

**Reuse `trustedTier`.** Wrong axis. It labels executors; this labels data. The
whole finding is that cloister conflated having the former with having the
latter.

**Label at read time — let consumers decide.** Preserves flexibility and
provides no boundary. A consumer that forgets to check is indistinguishable from
one that checked and passed, which is the property `lint:silent-swallow` and the
gate-integrity rails exist to deny elsewhere.

**Full information-flow typing.** The rigorous answer, and not available:
cloister proxies opaque content it cannot type, and a mechanism that only works
on content cloister parses would miss the MCP responses that matter most.

## Consequences

- **The signed commitment changes shape.** Adding a key to the canonical-CBOR
  map changes the bytes under the signature, so this is a receipt-version
  concern: verifiers must accept both, and pre-origin receipts stay verifiable
  as what they are — receipts that make no provenance claim. Absent must not be
  readable as vouched. That is the same fail-closed reading `resolveCABundle`
  gives an absent CA.
- Origin propagation becomes a property every content-composing stage owes,
  enforced by rail rather than discipline.
- `bead_create`'s attestation rows gain a provenance dimension the §13.4 audit
  can use, and the threat model gains a seam to cover.
- The receipt stops being a transport artifact and becomes a provenance one,
  which is the vocabulary L4 is written in.

## Notes

This is the third instance in one session of a single defect class: an artifact
asserting a property of its own provenance that nothing verified. `notme-ebc9af`
— a cert hardcoding `authMethod: "passkey"` for an invite-authenticated session.
`cloister-d2ba07` — a digest over a document that was never schema-valid. Here —
a receipt that reads as provenance while committing only to transport. In each
case the substrate recorded what it was handed and presented it as what it had
established.

Decision 3 is the general fix for that class, which is why it is stated as
*derived, never declared* rather than as a validation rule. A validation rule
can be forgotten at one call site. A derivation has no call site to forget.
