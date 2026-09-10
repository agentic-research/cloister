---
title: "ADR-0063: `execution/v1` is LLO-owned, and it is three structs — not one"
status: Accepted (2026-08-03)
date: 2026-08-03
tags: [execution, boundary, schema, authority, attestation, apas, interlace, leyline]
threat_model: docs/security/threat-model.md
relates_to:
  - 0035-cloister-llo-boundary.md
  - 0059-attested-ephemeral-run.md
  - 0046-mediated-capability-core.md
  - 0044-compute-isolation-substrate.md
  - 0057-declaration-model.md
  - 0036-schema-bridge-multi-output-ir.md
external_refs:
  - ley-line-open:rs/ll-core/schema-spec/execution/v1/execution.capnp
  - signet:docs/apas/agent-provenance-standard.md
  - signet:docs/design/004-bridge-certs.md
---

# ADR-0063 — `execution/v1` is LLO-owned, and it is three structs

## Context

ADR-0059 decided *that* cloister runs attested ephemeral jobs, and its Phase 2
relocates the run into the compute substrate. ADR-0035 decided that contracts
whose canonical home is ley-line-open stay there and cloister bridges them.
Neither states the concrete shape of the run request, because when they were
written it did not exist.

It exists now. LLO carries `rs/ll-core/schema-spec/execution/v1/execution.capnp`
(287 lines, `58fe767`, on `feature/ley-line-open-f7d6cd` and the integration
branches — not yet on `main`). Its opening comment states the posture:

> `execution/v1` is a substrate contract. Product policy is resolved into a
> RunGrant before this boundary; backend implementations remain private.

The contract identifier is **`cloister/execution/v1`** — cloister names the
interface, LLO owns the schema. That split is easy to misread in the direction
that costs the most, and PR #260 misread it: it hand-wrote a ten-field RunSpec
in `cli/lib/runtime/llo-execution-adapter.mjs` without consulting the capnp.
Zero of its ten field names appear in the canonical struct. This ADR exists so
the next implementation does not repeat that, and because the misreading was
not careless — it was *structural*, and worth naming.

## Decision

### 1. LLO owns the schema. Cloister generates, never enumerates.

`execution/v1` is a leyline schema like `confinement/v1`, `leyline-net`, and
`build-cache/v1`. Cloister consumes it through `schema-bridge` — the same path
that produces `src/generated/cluster.zod.ts` — and reads its field list from
the generated artifact.

A hand-written field list mirroring `execution.capnp` is the manumation failure
CLAUDE.md already names ("a field list that mirrors the schema is a bug waiting
to happen"), with one aggravating factor: `execution/v1` is *concurrently under
design on another repo's branch*. A mirror of a moving schema is not merely
prone to drift; it starts wrong, and nothing in cloister's gate can tell.

Until the schema lands on LLO `main` and `schema-bridge` emits it, cloister's
adapter carries no field list at all. Not being able to speak the contract yet
is an honest state. Guessing it is not.

Once it lands, prose references use the declared `leyline-schema-spec/…` alias
root so `lint:spec-citation` (`cloister-e83a33`) polices the pointer.

This ADR deliberately does **not** yet — and the reason is evidence for the
decision above. The first draft cited the aliased path, and `lint:spec-citation`
failed the gate: the alias must resolve to a real file in the LLO checkout, and
`execution/v1` resolves nowhere because it is not on `main`. The rail
independently confirmed the dependency this ADR asserts. Until LLO publishes,
the contract is named in `external_refs` as a branch-local artifact, which is
what it is.

### 2. The contract is three structs, and the split is the security property

This is the part a single "RunSpec" flattens away.

| Struct | capnp doc | What it is |
|---|---|---|
| `RunSpec` | *"Content-addressed execution intent. **It is not authority.**"* | What the caller wants. Untrusted. |
| `RunGrant` | *"Authenticated, resolved execution authority bound to one RunSpec digest."* | What was actually authorized. Trusted, and bound to a specific spec by `runSpecDigest`. |
| `RunReceipt` | *"Terminal substrate evidence; may be embedded by a separate APAS attester."* | What actually happened. Evidence. |

`start` takes **both** spec and grant (`StartInput{spec, grant}`), because the
substrate's job is to enforce that the intent never exceeds the authority:
`RunGrant.backendClass` is documented *"callers cannot weaken it"*, and
`requestedLimits` is *"the grant may only narrow them."*

Cloister therefore must **never** fold authority fields into a RunSpec. PR #260
put `workspaceGrant` — a grant — inside the spec. That is not a naming slip; it
collapses the exact boundary the three-struct split exists to hold, in the one
direction that fails open.

This is ADR-0046's core contract in schema form. `(subject-lease, verb,
resource-ref, args) → (decision, projection, receipt)` maps to grant, spec, and
receipt respectively.

### 3. The verifier seam is `EvidenceRef` resolution — Interlace *and* Signet

`RunGrant` and `RunReceipt` each carry two evidence references, and they are
different authorities answering different questions:

| Field | Question | Authority |
|---|---|---|
| `workloadIdentityEvidence` | *What is running?* | Interlace / WIMSE workload identity — cloister's existing lease pipeline |
| `actorProvenanceEvidence` | *On whose behalf?* | Signet bridge cert — APAS's *"delegated identity for dispatches"* |

Both are `EvidenceRef{mediaType, digest}`: content-addressed pointers, not
inline blobs. Verifying a receipt means resolving those digests and checking
them against the issuing authority — **not** re-deriving a signature in
cloister.

This is where ADR-0059's amendment lands concretely. That amendment established
that the "who" was already answered: notme mints a bridge cert from GHA OIDC,
cloister already runs `verifyCertChain`, and `CertScope` already includes
`bridgeCert`. `actorProvenanceEvidence` is the field those meet in.

It is also why `RunReceipt` says *"may be embedded by a separate APAS
attester"*: the substrate receipt is **not** an APAS attestation. It is the L3
evidence — APAS L3 being *"Isolated Execution … the dispatch operated within
declared boundaries"* — that an attester later wraps in a DSSE/in-toto
envelope. Cloister produces L3 evidence; it does not produce the attestation.
Conflating them would put cloister in the business of being both the audited
and the auditor, which APAS §1.1 names as the Trivy lesson: *"the auditor must
not be the audited."*

### 4. Cloister never builds a parallel verifier

Restating ADR-0035 for this seam because it is the specific thing most likely
to be reinvented under deadline: the Signet/Interlace verifier is **injected**.
A verifier written inside cloister — even a "temporary" one — is a second
implementation of a trust decision, and the two will disagree exactly once, in
production, in the direction of accepting something.

The corollary, learned the expensive way in PR #260 and worth stating as a
rule: **a stub that fails closed is fine; a stub that can be talked into
succeeding is not.** A relaxation on this seam must be anchored on
`CLOISTER_MODE=dev` so `lint:no-dev-mode` covers it, per ADR-0042 and ADR-0053.
A relaxation reachable by a caller passing an argument is the per-request
bypass ADR-0007 removed.

## Consequences

- `cli/lib/runtime/llo-execution-adapter.mjs` as shipped in PR #260 does not
  speak `cloister/execution/v1` and cannot be incrementally corrected into it —
  the field set, the struct count, and the authority model all differ. It is a
  placeholder whose *tests* encode the right instincts (fail closed, reject
  undeclared fields, inject the verifier) and whose *contract* is invented.
  Tracked as `cloister-3e86e8`.
- One of those tests asserts the opposite of the contract: it pins
  `Object.hasOwn(spec, "executable") === false`, treating `executable` as a
  host-shaped escape. `executable` is RunSpec field `@1` — a required
  `ArtifactRef`, i.e. already content-addressed. The instinct (no host paths in
  a run request) was right; the schema had satisfied it a different way.
- Cloister gains a dependency on LLO landing `execution/v1` on `main` before
  the adapter can be generated. That is the correct dependency direction and
  should not be routed around.
- `RunGrant.confinementDigest` is *"the confinement/v1 digest that enforcement
  must match"* — the execution seam and cloister's existing confinement facet
  (`lint:bundle-isolation` Inv 11) are the same policy, digested. Reconciling
  them is follow-up work, not a new decision.

## Alternatives considered

**Hand-mirror the schema now, generate later.** Rejected — this is what PR #260
did, and the result had zero field overlap with the contract while passing a
green gate. The failure was silent, which is the disqualifying property.

**Flatten grant into spec for a simpler adapter API.** Rejected. The
substrate's enforcement job is comparing them; a caller that supplies one
merged object supplies its own authority.

**Have cloister emit APAS attestations directly from run receipts.** Rejected —
APAS §1.1's split-trust requirement, and `RunReceipt`'s own doc comment
deferring to *"a separate APAS attester."*

## The general lesson

ADR-0059's amendment closed with *"Check whether a sibling already implements
it before designing it here."* PR #260 is the fourth instance in that series,
and the first where the check would have taken one `find`. The pattern is
sharper than "look before you build": the sibling contract was not merely
*present*, it was **more thought-through than the local guess** — three structs
where cloister assumed one, a stated non-authority posture, and an explicit
hand-off point for APAS. Guessing did not just duplicate work; it produced a
weaker model.
