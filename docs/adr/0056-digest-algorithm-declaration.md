---
title: "ADR-0056: Digests declare their algorithm — no untagged 32 bytes on a cloister wire"
status: Proposed (2026-07-27)
date: 2026-07-27
tags: [digest, cas, blake3, sha256, oci, build-cache, verification, algorithm-agility]
threat_model: docs/security/threat-model.md
relates_to:
  - 0003-content-addressed-bead-store.md
  - 0029-oci-per-repo-membership-boundary.md
  - 0035-cloister-llo-boundary.md
  - 0041-image-publish-contract.md
---

# ADR-0056: Digests declare their algorithm

Tracking bead: `cloister-24c13a`. Sibling: `cloister-8dabd8` (the same wire's
*mechanism* misnaming, which resolves separately).

## Context

Cloister runs two hash algorithms on purpose (ARCHITECTURE.md §"Two CAS hash
algorithms, intentionally distinct"):

- **SHA-256** — the application-layer digest: bead `content_hash`, attestation
  references, default BlobStore keying.
- **BLAKE3-256** — the substrate digest: blob identity in `build-cache/v1`,
  arena roots.

Both emit 32 bytes. Rendered as hex, both are 64 characters. Nothing in the
current representation distinguishes them:

```ts
// src/storage/types.ts
export type Digest = string & { readonly __digest: unique symbol };
export function isDigest(value: string): value is Digest {
  return /^[0-9a-f]{64}$/.test(value);          // shape only — no algorithm
}
```

The branded type carries no algorithm, and the validator accepts either
algorithm's output identically.

On top of that, `build-cache/v1` **overloads the OCI `sha256:` prefix with
BLAKE3 hex** (CLAUDE.md §"Two CAS hash algorithms"; ARCHITECTURE.md §364; full
rule in `leyline-schema-spec/build-cache/v1/wire/digest-encoding.md`). So a
value on that wire asserts an algorithm its bytes did not come from.

The label is not merely unchecked — it is **structurally uncheckable**, because
every consumer discards it before it could be verified:

```ts
// src/routes/oci-registry.ts
if (reference.startsWith("sha256:")) {
  const hex = reference.slice("sha256:".length);   // prefix stripped, dropped
  if (!isDigest(hex)) { /* 404 */ }                // shape check only
  manifestDigest = asDigest(hex);                  // opaque address from here on
}
```

The prefix is parsed, asserted, and thrown away. Downstream, the digest is an
opaque key. This is why a wrong label has never produced a visible failure.

### Why the current containment is thin

Two properties keep this benign today, and neither is a property of the format:

1. **`BlobStore.put` dual-verifies** against both algorithms. That is one call
   site. Any second consumer — a new backend, an external auditor, a future
   verifier — inherits none of it.
2. **Nothing re-derives the digest.** It is used as an address, never
   recomputed. The moment something *does* recompute it, the label tells it to
   compute the wrong function.

### Why this is worth an ADR rather than a patch

Cloister's trust surface rests on a claim that a third party can verify
attestations **independently and offline**: threat-model §11 requires we
"include enough material that a third-party auditor can verify the chain
offline", and decision D.4 was closed (`cloister-bdef0c`) by putting the cluster
master pubkey in the disclosure header so an auditor needs nothing external.
`src/blob-store.ts` makes the same promise for blobs — it "does NOT canonicalize
… hashes exactly the bytes it was handed … and lets callers verify offline."

A digest whose label lies is the one artifact that **cannot** be independently
verified, because the verifier cannot know what function to recompute. It does
not degrade verification; it makes it impossible while appearing to succeed.

This is also not an isolated slip. Two orthogonal mislabels were found on this
one wire, independently and hours apart: the algorithm label (this ADR) and the
mechanism name — `build-cache/v1` is content-addressed, so it is a *memoize*
named "cache" (`cloister-8dabd8`). Sibling repos reached the same class of
failure from unrelated directions. One mislabel is a bug; two orthogonal ones on
the same wire, neither noticed for the wire's lifetime, indicate a missing
step: **nothing in the pipeline ever required a value to declare what it is.**

## Decision

**A digest crossing any cloister boundary declares the algorithm that produced
it, and that declaration is verified rather than assumed.**

Three parts:

1. **`Digest` becomes algorithm-qualified.** The branded type carries the
   algorithm, not just 64 hex characters. `isDigest` stops accepting a bare hex
   string as sufficient. A SHA-256 digest and a BLAKE3-256 digest are not
   assignable to one another.

2. **The OCI registry surface keeps genuine `sha256:`.** This is not a place to
   innovate: `sha256:` is OCI-spec-mandated on `/v2/` routes, and real clients
   parse it. `src/routes/oci-registry.ts` continues to speak OCI exactly, and
   the digests it handles are *actually* SHA-256.

3. **`build-cache/v1` stops borrowing the OCI prefix.** The substrate wire
   declares BLAKE3 honestly rather than wearing `sha256:`. Until that wire
   changes, cloister **rejects at its own boundary** rather than propagating an
   unverifiable label inward — a mislabeled digest fails closed instead of
   being silently dual-verified into acceptance.

Part 3 has a boundary constraint: the `build-cache/v1` encoding rule is
specified in `leyline-schema-spec`, which per **ADR-0035** is LLO's to own.
Cloister does not get to redefine it unilaterally. What cloister owns is its own
acceptance: it can require a self-describing digest at its ingress and refuse
what it cannot verify, which is enforceable here and now and does not wait on a
cross-repo schema change.

### The rail

Per this repo's standing rule — *an invariant with no rail is a comment* — the
decision lands with a `lint:digest-algorithm` gate asserting that no call site
constructs a `Digest` from a bare hex string without an algorithm, and that the
`sha256:` literal appears only on the OCI-spec surface. Same shape as
`lint:lease-gate-source` and `lint:trust-env-locality`: a grep-able invariant
with a companion test asserting the shipped tree satisfies it, so the rail
cannot pass vacuously.

## Consequences

**Gained.** Offline third-party verification becomes possible for
`build-cache/v1` artifacts — a verifier can tell what to recompute. Algorithm
confusion becomes a type error rather than a silent wrong answer. The safety
that today depends on `BlobStore.put` remembering to dual-verify becomes a
property of the format, inherited by every future consumer.

**Cost.** `Digest` is load-bearing across storage, registry, trust-store, and
attestation code; qualifying it touches many call sites even though each change
is mechanical. Existing persisted digests were written under the old
representation and need a read path that does not reject them — the migration is
the real work, not the type change.

**Deliberately not decided here.** Whether the qualified form is a prefix
(`blake3:<hex>`), a struct field, or multihash is left to implementation; the
requirement is that the algorithm is *present and checked*, not that it takes a
particular shape. Whether `build-cache/v1` itself changes is LLO's call under
ADR-0035; this ADR commits only cloister's side of the boundary.

## Alternatives considered

**Leave it; dual-verification works.** Rejected: it is a property of one call
site, not of the format, and the whole point of the wire is to be consumed by
things that are not that call site. It also leaves offline verification
impossible, which contradicts a closed threat-model decision (D.4).

**Document the overload more loudly.** Rejected: it is already documented, in
CLAUDE.md and ARCHITECTURE.md and the schema spec. Documentation is what we
have; it did not prevent the label from being wrong, and cannot make it
checkable by a third party who has only the bytes.

**Make everything BLAKE3.** Rejected: the OCI surface is spec-bound to
`sha256:`, and the two algorithms are distinct on purpose per ADR-0035 — SHA-256
is the application digest, BLAKE3 the substrate digest. The problem is the
missing declaration, not the plurality.
