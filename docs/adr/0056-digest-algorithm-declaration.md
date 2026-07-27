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

### The label is re-emitted outward, not merely accepted inward

An audit of every `sha256:` site in `src/` found the algorithm lie is isolated
to the `build-cache/v1` path — no second dishonest constructor exists, and
`deriveSubjectFp` is genuinely SHA-256. But the path it sits on leads outward:

```ts
// src/routes/oci-registry.ts
storageKey = verified.key;                    // may be BLAKE3 hex
const storageRef = `sha256:${storageKey}`;    // relabelled sha256:
…
"docker-content-digest": `sha256:${digest}`,  // to arbitrary OCI clients
"etag":                  `"sha256:${digest}"`,
```

So content pushed under the build-cache/v1 convention is **served back over
standard OCI read paths** carrying a `sha256:` label over BLAKE3 bytes, in both
`Docker-Content-Digest` and `ETag`.

This breaks the containment argument. "Nothing recomputes the digest" holds
*inside* cloister. It does not hold for external clients, who are entitled to
verify `Docker-Content-Digest` and whose tooling commonly does. Such a client
computes SHA-256 over the body, gets a mismatch, and concludes **content
corruption** — the failure is attributed to the wrong cause, and the
remediation it suggests (re-pull, distrust the registry) is unrelated to the
actual defect.

It also means the dual-verify protects the **write** while the **read** path
re-asserts an algorithm nothing verified on the way out.

This looks like an irreconcilable tension — we cannot honestly label BLAKE3
content on a surface whose clients only understand `sha256` — but the tension is
false, and the shape of the answer already exists in this ecosystem.

### The bridge: envelope, don't relabel

notme faces the structurally identical problem. workerd cannot present X.509
client certificates; upstreams require mTLS and will not negotiate. Rather than
bend either side, notme **bridges**: a Rust forward proxy holds the identity and
attaches the client cert during the TLS handshake, with the bridge cert's
private key living only in that process's memory
(`notme/ARCHITECTURE.md`, `proxy/src/main.rs`). Each domain keeps speaking its
own native, honest format; the translation happens at the boundary.

Framed that way, the current digest code is doing neither honest thing. It is
**asserting domain B's format over domain A's content** — which is not a bridge
but a forged credential, and it is why the failure surfaces as "corruption"
rather than "unsupported algorithm".

The OCI equivalent of the bridge is an **envelope**, and OCI already has the
mechanism: every descriptor carries its **own** `digest` field, and `blake3` is
a registered identifier. So a manifest can be

- **honestly SHA-256 on the outside** — `Docker-Content-Digest: sha256:<real
  sha256 of the manifest bytes>`, verifiable by any client that checks it, and
- **honestly BLAKE3 on the inside** — the layer descriptor reads
  `blake3:<hex>`, which is what the bytes actually are.

Nobody lies at any layer. A client that cannot do BLAKE3 now fails at the
*layer fetch*, with the correct cause and a remediation that follows from it —
instead of computing SHA-256 over a manifest, getting a mismatch, and concluding
the registry corrupted its content.

Honest caveat on the evidence: the descriptor spec defines the grammar
per-descriptor, registers `blake3`, and directs implementations to tolerate
unrecognized algorithms; the manifest spec confirms each descriptor carries an
independent `digest` but is **silent** on mixing algorithms within one manifest.
So the envelope is spec-*compatible* by construction rather than spec-blessed by
documented practice. That distinction should survive into implementation and be
validated against a real client before we rely on it.

### Why the current containment is thin

Two properties keep this benign today, and neither is a property of the format:

1. **`BlobStore.put` dual-verifies** against both algorithms. That is one call
   site. Any second consumer — a new backend, an external auditor, a future
   verifier — inherits none of it.
2. **Nothing re-derives the digest.** It is used as an address, never
   recomputed. The moment something *does* recompute it, the label tells it to
   compute the wrong function.

### The standard is already in our hands

The OCI image-spec descriptor `digest` field is **self-describing by
construction**:

```
digest    ::= algorithm ":" encoded
algorithm ::= algorithm-component (algorithm-separator algorithm-component)*
encoded   ::= [a-zA-Z0-9=_-]+
```

and the spec registers three algorithm identifiers — `sha256`, `sha512`, and
**`blake3`** — while directing that "Implementations SHOULD allow digests with
unrecognized algorithms to pass validation if they comply with the above
grammar."

So both halves of the obvious objection dissolve. We do not need to invent a
representation, and we do not need to overload `sha256:`: **the format we are
already using has an algorithm field, and it has a registered name for the exact
algorithm we are using.** `blake3:<hex>` is a legal OCI descriptor digest.

That reframes the defect precisely. This is not a format that lacks a place to
say which algorithm produced the bytes. It is a **self-describing format whose
self-description we filled in with something false.**

It also corrects a constraint that looked binding: `sha256` is REQUIRED for
implementations to *support*, not the only algorithm permitted. What actually
binds the `/v2/` route is **client capability** — third-party registry clients
in the wild handle `sha256` and mostly nothing else — which is a narrower and
more honest constraint than spec prohibition, and it does not extend to a
substrate wire that no third-party client consumes.

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

1. **Adopt OCI's `algorithm ":" encoded` form. Invent nothing.** The
   representation question is already answered by a spec we implement, whose
   registered identifiers include the two algorithms we run. No multihash, no
   bespoke struct, no new prefix vocabulary.

2. **`Digest` becomes algorithm-qualified.** The branded type carries the
   algorithm, not just 64 hex characters. `isDigest` stops accepting a bare hex
   string as sufficient. A SHA-256 digest and a BLAKE3-256 digest are not
   assignable to one another.

3. **The OCI registry surface keeps emitting `sha256:` — for client capability,
   not because the spec forbids otherwise.** `src/routes/oci-registry.ts` serves
   third-party clients that in practice handle `sha256` and little else, so the
   content it addresses stays SHA-256. Stating the real reason matters: it means
   the constraint is scoped to that route, and does not silently propagate to
   wires no external client reads.

4. **`build-cache/v1` says `blake3:` where the bytes are BLAKE3.** It is a
   substrate wire with no third-party consumer, so the client-capability
   constraint above does not reach it, and the identifier it needs is already
   registered. Until that wire changes, cloister **rejects at its own boundary**
   rather than propagating an unverifiable label inward — a mislabeled digest
   fails closed instead of being silently dual-verified into acceptance.

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

**Deliberately not decided here.** Whether `build-cache/v1` itself changes is
LLO's call under ADR-0035; this ADR commits only cloister's side of the
boundary. Worth noting that the cross-repo ask is now much smaller than it
first appeared — not "change your wire format" but "use the algorithm field
your format already has, with an identifier the spec already registers."

## Alternatives considered

**Leave it; dual-verification works.** Rejected: it is a property of one call
site, not of the format, and the whole point of the wire is to be consumed by
things that are not that call site. It also leaves offline verification
impossible, which contradicts a closed threat-model decision (D.4).

**Document the overload more loudly.** Rejected: it is already documented, in
CLAUDE.md and ARCHITECTURE.md and the schema spec. Documentation is what we
have; it did not prevent the label from being wrong, and cannot make it
checkable by a third party who has only the bytes.

**Make everything BLAKE3.** Rejected, but note the reason is *not* that OCI
forbids it — `blake3` is a registered identifier, and an earlier draft of this
ADR was wrong to claim the surface was "spec-bound to `sha256:`". The real
reasons are narrower: third-party registry clients handle `sha256` in practice,
and the two algorithms are distinct on purpose (SHA-256 the application digest,
BLAKE3 the substrate digest). The problem is the missing declaration, not the
plurality.

**Multihash.** Rejected: it solves exactly the problem we have, but we would be
adopting a second self-describing digest encoding alongside the one we already
implement, and then owning the mapping between them at every boundary. OCI's
`algorithm:encoded` already carries the algorithm and already registers both of
ours. Reaching for multihash here would be inventing a translation layer to
avoid using a field we ship.
