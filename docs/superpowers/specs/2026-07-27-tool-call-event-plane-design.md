# Tool-call event plane — v1 design (memoize)

**Date:** 2026-07-27
**Status:** Design settled; not implemented.
**Beads:** `cloister-8f6bd6` (resolution rule), `cloister-8dabd8` (mechanism
misnaming), `cloister-24c13a` (digest label — ADR-0056).
**Origin:** cross-repo design thread with ley-line-open, 2026-07-27.

## Why this document exists

The design below was worked out in conversation and is settled enough to build
from. It is written down because the reasoning is the valuable part and it lived
nowhere durable — the beads carry the defects, not the decisions.

Nothing here is implemented. This is the spec that precedes a plan.

## The problem

Three separate asks, which turned out to be one substrate gap:

1. **Observation** — derive tool calls generically, including from producers that
   never traverse cloister.
2. **Fan-out** — one event, many sinks, without each sink re-triggering work.
3. **Non-repetition** — don't redo expensive work; don't repeat side effects.

Cloister already has the pieces: `McpEdgeRoute.callTool` (`src/routes/mcp.ts`)
is a single chokepoint every `tools/call` passes through, and
`ReceiptEmitter` / `MetricEmitter` (`src/routes/vault-proxy.ts`) is an existing
emitter seam. But the emitter is scoped to the vault-proxy path and is
single-sink (`consoleReceiptEmitter()`), so neither generalises as-is.

## Decisions

### 1. Attestable, not telemetry — and sampling is a property of the export

Events are appended unconditionally to an attestable record; sinks then sample,
filter and fan out *from* that record. Sampling at the point of record would
destroy the audit property; sampling at export does not.

The obvious objection — that unconditional append puts the chain on the hot path
of a singleton DO with known contention — was **measured and refuted**.
`task bench:trust-store` against `verifyLeaseAndAdvanceChain`:

| N concurrent | wall (ms) | per-req (ms) | throughput (req/s) |
|---:|---:|---:|---:|
| 1 | 0.40 | 0.400 | 2500 |
| 10 | 1.85 | 0.185 | 5405 |
| 50 | 9.10 | 0.182 | 5495 |
| 100 | 18.45 | 0.184 | 5420 |

Per-request latency is flat and sub-millisecond from N=10 to N=100; wall time
grows linearly because that is N requests at constant throughput, not
per-request degradation. Steady state with 10,000 `seen_nonces` rows prefilled
moved the mean *down* 0.018ms with p99 unchanged, so row growth does not drift
latency either.

**Consequence: per-call append is viable and Merkle batching is premature.** The
schema is versioned (`cloister/<thing>/v1`, the house convention), which is
sufficient forward-compat; reserving inclusion-proof fields for a design we have
no evidence we need would be speculation.

Caveats, recorded because they bound the result: this measures the *lease* chain
append, not a tool-call event with its own payload and table growth; it is
workerd-via-vitest on a laptop, not production CF; N=100 is the ceiling tested.
Re-measure if event rows land materially heavier.

### 2. A skip must itself emit evidence

Cloister's threat model runs on **§13.2 "silence is evidence"** — cited in
`src/obs/log.ts` as the reason its schema exists. Introducing skipping breaks
that invariant: a call that was skipped and emitted nothing is indistinguishable
from a call that never happened.

So the skip is an event. This is not a hygiene preference; it is what keeps
§13.2 true in the presence of reuse. It also yields the LLM-legible signal the
whole exercise started from — *"skipped, unchanged since `<digest>`, prior
result at `<ref>`"* — as a consequence rather than a feature.

The cost is real and is the point. An earlier draft of this reasoning called the
signal "free"; it is not, and the expense is precisely what makes it checkable.

### 3. A skip is where attestation is *most* load-bearing

For executed work, an attestation always has a fallback cross-check: re-run it
and compare. **For a skip there is no artifact — the attestation is the entire
evidence.** That inverts the usual intuition that tagging matters most for
expensive signed artifacts. It matters most for the cheapest event in the
system, because that is the one where re-execution is unavailable as a
cross-check.

### 4. Event shape

```
{ scheme, spec_digest, input_digest, prior_result_ref }
```

- **`scheme`** rides inline as a short string. It buys LLM-legibility with no
  fetch, domain separation, and a fast-reject path — wrong scheme, reject
  without fetching anything.
- **`spec_digest`** references the derivation spec (what was folded, under what
  canonicalization, under what resolution rule), stored once in CAS.
- **`input_digest`** is the fold over the declared input closure.
- **`prior_result_ref`** points at the result being inherited.

**The scheme must be folded *into* the digest, not merely adjacent to it.** If it
rides alongside, the scheme can be relabelled without perturbing the digest and
the event still verifies. This is not hypothetical: `build-cache/v1` already
carries a `sha256:` label over BLAKE3 bytes (ADR-0056), which is exactly a label
that is not bound to what it describes.

`spec_digest` must be an instance of LLO's `leyline-core::partition` tagged fold
— keyed via BLAKE3 `new_derive_key`, every variable-length field length-prefixed
so the address commits to the decomposition rather than the concatenation.
**ADR-0035 makes bridging mandatory, not merely preferable**: `leyline-*` lives
in LLO and cloister bridges it, precedent `src/wire/cas-hash.ts` →
`rs/crates/cas/`. Reimplementing a tagged fold here would violate that boundary.

#### Why `input_digest` alone is insufficient

`input_digest` proves *these inputs are unchanged*. It does **not** prove *these
are the right inputs*. A producer that omits a dependency from its closure
computes a perfectly valid hash over an invalid closure, and the skip verifies.
The spec is what lets a verifier re-derive the closure and check the producer
gathered the right rows — the difference between *unchanged* and *correctly
determined to be unchanged*. Only the second is worth attesting.

### 5. Specs travel per-export, not per-event

The spec is referenced by digest, not inlined. Skips are the highest-volume,
lowest-value-each event in the system; inlining identical bytes N times is what
content addressing exists to eliminate. Spec families are low-cardinality — a
handful, not one per event.

Offline verification is preserved at the **transport** layer instead: the
disclosure/export stream bundles the referenced specs, exactly as decision
**D.4** (`cloister-bdef0c`) bundles `master_public_key` in the JSONL header so a
third-party auditor needs nothing external. **The stream header declares which
spec digests it carries**, so a verifier knows at header-read time whether the
stream is self-sufficient rather than discovering it per-event partway through.

This reuses a closed precedent rather than inventing a pattern, and costs one
copy per export rather than N per event.

### 6. Verification is three-valued, and local-only

The verifier must not return a boolean:

- `Verified` — spec resolved, closure re-derived, scheme matched
- `Unresolved(spec_digest)` — scheme matched, closure **unchecked**
- `Rejected(reason)` — scheme or digest mismatch

A boolean verifier will eventually collapse `Unresolved` into `Verified` no
matter how carefully callers are written. That is a **type** problem, not a
transport problem, and making the degradation unrepresentable beats making it
discouraged. It also lets a raw log ship do useful work — catching scheme
mismatches and digest corruption — without ever claiming full verification.

Note the symmetry: making the skip attestable turned *"I didn't do work"* from an
absence into an event; three-valued verification turns *"I couldn't fully check"*
from an absence into a result. Same move as §13.2, one level up. Silence is the
failure mode in all three.

#### The §9 boundary rule

Cloister deliberately destroys information in one response shape: the disclosure
endpoint collapses auth failure into the same constant-time 404 as a genuine
miss, to avoid peer-existence and cert-validity oracles. That is the inverse of
what tri-state wants, and the two reconcile into one rule:

> **The response shape must match the caller's entitlement.**

`Unresolved(spec_digest)` computed **locally, over bytes the auditor already
holds** reports *their own* completeness and reveals nothing about cloister. The
same value from a **server-side** verifier reports which specs cloister cannot
resolve — a fingerprint, and squarely §9.

**Tri-state is a property of local verification, never remote.** Crosses a trust
boundary → collapses. Terminates in the same process as the bytes → does not.

#### Enforcement

The type must be **non-serializable**, with the sole route to the wire an
explicit `collapseForWire()` that is the §9 audit point — one function to
review instead of every handler.

In TypeScript this needs care, because the naive port is unsafe. Verified
empirically:

```
plain object:        {"state":"Unresolved","spec_digest":"abc123"}   ← leaks by default
#private fields:     {}                                             ← silently empty
throwing toJSON:     THROWS → "not serializable; call collapseForWire()"
nested in response:  THROWS (caught at seam)
```

JS serialises plain objects **by default**, so "don't implement `toJSON`" is the
*leaking* state, not the closed one — the opposite of Rust's default. `#private`
fields are worse than useless: `{}` is fail-quiet. The correct analogue is a
**throwing `toJSON()`**, which also fires when the value is nested in a response
body — the accidental case that would actually happen.

A rail beats the type trick, because a type-level guard is defeated by any
refactor that reshapes the value while a rail survives it:
**`lint:tristate-collapse`** asserts `collapseForWire()` is the only path from
the verifier type to a response body. Same shape as `lint:lease-gate-source` and
`lint:trust-env-locality`, per *"an invariant with no rail is a comment"* — and
it makes the §9 audit a grep rather than a review.

## The three mechanisms

"Skipped" is one word covering three different kinds of claim — respectively
mathematical, temporal and authorizational. Shipping one event shape for all
three would bake that conflation into a wire format.

| | Key | Output | Extra claim needed |
|---|---|---|---|
| **memoize** | derived from content | the value | none — equality is entailed |
| **cache** | assigned (name, path, time) | a value | freshness |
| **guard** | predicate over context | a decision | authorization |

**Discriminator: does the key determine the value?** Checked by reading the *key
derivation*, not by reasoning about policy. Content-derived key → key entails
value → memoize. Assigned key → a retained entry can disagree with
recomputation → cache, needs freshness.

**Eviction is not a signal.** A memoize that evicts merely recomputes — eviction
produces a *miss*, never a different value. Retention policy reclassifies
nothing.

Underneath: **memoize is content-addressed; cache is location-addressed.** A
memoize key is an *address*; a cache key is a *name*.

### Inventory (cloister, 2026-07-27)

| Mechanism | Key derivation | Class | Note |
|---|---|---|---|
| `build-cache/v1` (BlobStore) | content digest, dual-verified | **memoize** | misnamed "cache" — `cloister-8dabd8` |
| Task `method: checksum` | checksum over `sources:` globs | **memoize** | resolution rule implicit — `cloister-8f6bd6` |
| `ca-bundle-cache` | clock only; module singleton | **cache** | correctly named; explicit bounded freshness |
| `seen_nonces` / lease scope | predicate over context | **guard** | already on the §13.4 denial plane |

The taxonomy discriminates rather than reclassifying everything, which is the
sign it is real. `src/storage/ca-bundle-cache.ts` is the exemplar of a cache
carrying its freshness claim properly: refresh at 4 min against notme's 5 min
staleness bound, fail-closed when stale, with both constants validated by
`lint:timing` against a real notme checkout.

**The gap is not missing concepts.** Cloister already attaches a freshness claim
where one is owed and already keeps denial attestation off the log plane. It
does so **by hand, one site at a time**. Nothing ever required a value to
declare what it is.

## v1 scope: memoize only

Memoize is the one whose attestation is a **mathematical** claim rather than a
policy claim, so it needs no trust in the producer's discipline beyond the
digest itself. It also has a working referent already in-tree — Task's
`method: checksum` over declared `sources:` — so v1 specifies something that
exists and is measured rather than designing forward.

Cache and guard are added later as declared variants whose extra claims are
explicit, rather than discovered inside a shape that assumed equality.

**Guard stays out of v1 and keeps its existing §13.4 lineage.** Its "skip" is a
*denial*, which is where §9's oracle discipline bites hardest, and
`src/obs/log.ts` already scopes itself out of the denial-audit plane
(`buildDenialAuditEntry`). Cloister separated those planes independently, before
this design existed; attesting denials in memoize shape would reverse a shipped
separation, which needs a much better argument than event-shape convenience.

## Resolution rules version

Name the **resolution rule** each mechanism depends on, not just its inputs.
Whatever "unchanged" is computed over is a rule, and rules version.

Cloister's instance: Task `sources:` are globs, deliberately over-inclusive —
the Taskfile says so outright. Correct and conservative, and recorded only in a
comment. Tighten one glob and every existing key silently changes meaning, with
nothing recording that the rule moved. Under per-skip attestation that is worse
than a cache-invalidation bug: an auditor re-deriving a key has no way to know
which rule to re-derive it under, so the attestation is unverifiable rather than
merely stale.

The rule belongs in the scheme tag — `…/glob-closure/v1` — not in a comment.
Tracked as `cloister-8f6bd6`, and it must land **before** any `sources:`-derived
key reaches a third party.

## Not decided here

- Boundaries for **cache** and **guard** beyond the discriminator above.
- Whether the event plane rides canonical CBOR (the receipts incumbent,
  `src/wire/receipts-cbor.ts`) or capnp (the manifest/IPC wire). Note for
  whoever decides: that encoder's "no tags" means RFC 8949 *tag numbers*,
  excluded deliberately to keep bytes canonical for signing. That is a different
  sense of "tag" from the algorithm/derivation tag above — adding a derivation
  spec means adding **fields**, and re-enabling CBOR tags would break the
  signature scheme.
- Ingest for external producers. The schema and context model are designed for
  both in-band and out-of-band from day one; only the surface area is phased.
- Whether `build-cache/v1` itself changes — LLO's call under ADR-0035.

## Open risk

If a verifier ever receives skip events through a channel that is *not* the
disclosure stream — a raw log ship, a sidecar tail — it gets events without
specs. The three-valued result type is what makes that safe: such a consumer can
reach `Unresolved` but never `Verified`. Fail-closed per event was considered
and rejected: it tries to solve a delivery problem at the event layer, which is
unenforceable by the event itself, and it discards the useful work a
spec-less consumer can still do.
