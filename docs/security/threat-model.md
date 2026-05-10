---
title: "Threat model — Interlace lease + attestation surface"
status: Living (drafted 2026-05-09; status-update 2026-05-10 — see callout below)
scope: cloister-bd7770 (lease middleware, shipped), cloister-9d49eb (cert chain verifier, shipped), cloister-bd5241 (TS wrapper, shipped), cloister-bdcbe7 (peer_attestations, shipped), cloister-bdef0c (disclosure endpoint, shipped)
related_adrs:
  - 0007-interlace-substrate.md
  - 0011-hypervisor-bundle-boundary.md
  - 0012-truststore-vs-beadstore.md
audit_log: _agent_log/theoretical-foundations-analyst_2026-05-09_agent_log.md (gitignored)
---

> Audience: the careful reviewer in six months who has forgotten everything
> and needs to know whether to trust this surface. The order is per-seam
> from outside in. The honest disposition of each invariant — covered, gap,
> or known-weak — is recorded in §11 *Test contract*. Do not skip §11; that
> is where the tests-vs-claims accounting lives.

## Status update 2026-05-10 — most GAPs closed

When this model was drafted (2026-05-09), §11's test contract listed
**14 GAPs** alongside the named tests. **12 of those have since shipped**
as closed beads with backing tests. The remaining 2 are parked
low-priority edge cases (L.15, C.11). The body text below preserves the
original analysis for the audit trail; **§11 is the authoritative
current state**.

| Original GAP | Resolution | Bead | Test file |
|---|---|---|---|
| M.1, M.2, M.3 (replay defense) | INSERT … ON CONFLICT `seen_nonces` ledger | `cloister-c5c846` (closed) | `test/storage/seen-nonces.test.ts`, `test/routes/lease-middleware.test.ts` |
| T.10 (counter-race) | `blockConcurrencyWhile` across read-then-write | `cloister-c66fea` (closed) | `test/storage/peer-lease-counters.test.ts`, `test/trust-store.test.ts` |
| C.5 (bundle signature verify) | `verifyBundleSignature` wired into `getCABundle` | `cloister-c614ae` (closed) | `test/storage/bundle-canonical.test.ts`, `test/storage/ca-bundle-cache.test.ts` |
| C.6 (critical unknown ext rejected) | `cert_chain.rs` rejects per RFC 5280 §4.2 | `cloister-c71977` (closed) | `rs/crates/sign/src/cert_chain.rs` (24 native), `test/wire/signet-verify.test.ts` |
| T.1 (clock-skew bound) | `MAX_CLOCK_SKEW_MS = 60s` check in `verifyAndUpsertLease` | `cloister-c7e3e3` (closed) | `test/routes/lease-middleware.test.ts` |
| T.3, T.4 (counter monotonicity + chain integrity) | `assertChainStep()` defense in `applyLeaseCounter` | `cloister-c75da6` (closed) | `test/storage/peer-lease-counters.test.ts` |
| H.2, H.3, H.4 (cross-DO handoff retry) | `pending_attestations` table + retry pump RPC | `cloister-c6d378` (closed) | `test/storage/pending-attestations.test.ts`, `test/trust-store.test.ts` |
| D.3 (constant-time error path) | `constantTimeErrorResponse` with fixed-length body | `cloister-c7a184` (closed) | `test/storage/disclosure-cursor.test.ts`, `test/routes/disclosure.test.ts` |
| D.1, D.2, D.4, D.5 (disclosure endpoint) | `DisclosureRoute` registered + HMAC cursor + auth gate | `cloister-bdef0c` (closed) | `test/routes/disclosure.test.ts` (24 tests) |

**Still GAP** (low-priority, parked):

- **L.15** — Tool name with embedded colon (scope-grammar edge case). No bead filed; would be a single regression test in `test/routes/lease-middleware.test.ts`.
- **C.11** — TBS re-encoding round-trip test (defensive coverage for an x509-cert parser bug that has not surfaced). No bead filed; would be a single test against a hand-minted cert with non-canonical TBS.

The body sections below (§4-§10) preserve their original "GAP" /
"POTENTIAL GAP" labels for the audit trail — **read §11 for the current
truth**. Future material updates: edit §11 first, then add a new
status-update callout above describing the change.

## 1. Scope

This model covers the path a request travels from a remote peer through
cloister's `POST /mcp` to a state-changing tool call and back, including
the trust-state machinery that enforces §13.2 of the Interlace spec
("silence is evidence"). It does NOT cover:

- Tool implementations themselves (e.g. the SQL inside `bead_create`).
- Internal IPC (cloister ↔ companion) — ADR-0005 amendment puts that
  hop inside the trust boundary.
- The companion ↔ backend wire (covered by ADR-0005, leyline-net AEAD).
- workerd / Cloudflare platform compromise (out of scope; threat model
  assumes the substrate is honest).

## 2. Trust roots

| Root | What it grants | Where pinned |
|---|---|---|
| Master Ed25519 keypair | Mints any ephemeral cert with any scope | `notme` `SigningAuthority` DO; private half "born and dies in CF" |
| `INTERLACE_MASTER_PUBKEY` env binding | Used as initial pin for verifier bootstrap | wrangler / config.capnp |
| Notme CA bundle | Identifies the live `(epoch, keyId)` pair plus rotation prevKey | `env.NOTME` service binding (intra-platform, unforgeable) |
| Cloister actor fingerprint in `cloister.capnp` | What we publish in `.well-known/interlace/index.json` | The build-pinned manifest |

A compromise of the master key, a compromise of the notme worker, or a
compromise of the build pipeline (modifying `cloister.capnp` or the env
bindings before deploy) all defeat the model. None are addressed here.

## 3. Pipeline (current and planned)

```
client → POST /mcp                     ← cert + sig + ts + nonce in headers
  │
  ├─[ MIDDLEWARE  cloister-bd7770 ]    (currently NOT wired; cloister-b89fdb)
  │   1. parseAuthHeaders               (header decode)
  │   2. verifyCertChain                (wasm Ed25519 vs master pubkey)
  │   3. require {epoch, peer_fp, scope} on the cert
  │   4. isCertEpochCurrent             (CA bundle freshness)
  │   5. server clock ∈ [not_before, not_after]
  │   6. verifyRequestSignature         (Web Crypto Ed25519 over canonical bytes)
  │   7. scopeAllows                    (cert.scope ⊇ derived request scope)
  │   8. trustStore.upsertLeaseCounter  (UPSERT chain)
  │
  ├─[ DISPATCH ]   McpEdgeRoute → backend.invoke(...)
  │
  └─[ BACKEND ]    e.g. BeadStore.create()
                   (planned) BlobStore.put → BeadStore.write → TrustStore.insertAttestation
```

The pipeline as a whole has the property that **steps 1-7 are pure-CPU
and offline**; only step 8 hits a cluster-singleton DO over the cloudflare
fabric. Any compromise of the inbound pipeline must break either the
pinned master key, the bundle-freshness guarantee, or one of the in-process
crypto primitives.

## 4. Seam: cert mint (notme `SigningAuthority`)

| # | Adversary capability | Defensive invariant | Status |
|---|---|---|---|
| 4.1 | Master key theft from the SigningAuthority DO | Key is "born and dies in CF" — unwrappable; private half never leaves the DO | Out of scope (notme repo) |
| 4.2 | Compromised mint endpoint mints over-broad scope | Each cert pins `scope` in custom-OID extension `1.3.6.1.4.1.99999.1.6`; verifier rejects scope mismatch | §11 row L.7 |
| 4.3 | Compromised mint endpoint mints with wrong `peer_fp` claim | `peer_fp` is in custom-OID extension `1.3.6.1.4.1.99999.1.5` and the actor presenting the cert can't change it without re-signing | §11 row L.3 |
| 4.4 | Compromised mint endpoint issues a cert with a future epoch claim (oracle for upcoming rotation) | `isCertEpochCurrent` REJECTS `cert.epoch > bundle.epoch` (cloister can never accept a cert from the future) | §11 row C.2 |
| 4.5 | Ephemeral private key theft from the actor's process | Cert validity is bounded by `not_before/not_after` (~5 min); attacker can act for ≤ TTL until cert expires | §11 row L.10 |
| 4.6 | Replay of a stolen cert during its TTL | **GAP — see §6.2** | §11 row M.1 (proposed) |
| 4.7 | Master signs a cert with a critical X.509 extension cloister doesn't recognize | Today: cloister silently accepts. Standard says reject. | §11 row C.6 (proposed) |

**Honest disposition.** §4.6 is the load-bearing gap. The current pipeline
treats nonce as an input to the chain hash but does not enforce nonce
*uniqueness*. A captured cert+sig+nonce envelope replays cleanly until
`not_after`. See `cloister-rt-replay` (filed) for the fix.

## 5. Seam: bundle distribution (notme → cloister CA bundle cache)

| # | Adversary capability | Defensive invariant | Status |
|---|---|---|---|
| 5.1 | Stale bundle accepted (revoked cert still verifies) | Cache TTL = 4 min, fail-closed beyond. Bound on revocation propagation = bundle_max_age. | §11 row C.1 |
| 5.2 | Bundle replay (older bundle re-served by an attacker between cloister and notme) | Bundle is signed; `signature` field is over `bundleCanonical(bundle)` | **GAP — see §11 row C.5** — `cabundle.signature` is NOT verified inside `getCABundle`. The current implementation trusts whatever `BundleFetcher` returns. |
| 5.3 | Bundle tampered (epoch/keyId swapped) | Same as 5.2 — depends on the missing signature check | §11 row C.5 |
| 5.4 | notme down for ≤ 4 min | Cache serves stale-but-known bundle within TTL | §11 row C.3 |
| 5.5 | notme down for > 4 min | Fail-closed, `CaUnavailableError`, 503 to clients | §11 row C.4 |

**Honest disposition.** The 4-minute cache window is the fundamental
revocation-propagation bound — any reader claiming "notme is not on the
hot path" must qualify with "for ≤4 min after a revocation, a revoked
cert is still accepted." The audit amendment to ADR-0007 is explicit about
this; the threat model preserves it.

The signature-not-checked gap (§5.2/5.3) is real. Today the
service-binding hop to notme is an unforgeable intra-platform RPC, so a
network adversary can't substitute bundles. But the moment the fetcher
reaches over plain HTTP, this becomes critical. Filed as
`cloister-tm-bundle-sig-verify`.

## 6. Seam: lease verify pipeline

The pipeline is a sequence of conjunctive checks; failure at any step
short-circuits to a typed JSON-RPC error. Each step is independently
testable.

### 6.1 Cert chain verification (step 2)

| # | Adversary capability | Defensive invariant | Status |
|---|---|---|---|
| 6.1.1 | Garbage / non-DER bytes in Authorization | `Certificate::from_der` returns `BadDer` | §11 row L.1, C.7 |
| 6.1.2 | Cert minted by a different master | Ed25519 verify fails; `BadSignature` | §11 row L.2, C.8, S.4 |
| 6.1.3 | Cert with non-Ed25519 signature algorithm | OID mismatch returns `NotEd25519` | §11 row C.9 |
| 6.1.4 | Cert with non-Ed25519 SPKI | `BadSpki` | §11 row C.10 |
| 6.1.5 | Cert TBS re-encoding round-trip mismatch | The verifier re-encodes `tbs_certificate` to derive what the master signed; if the parser is non-canonical, signature verification fails (closed) | §11 row C.11 (proposed) |
| 6.1.6 | Cert with a critical unknown extension | Ignored (silent accept) | **§11 row C.6 (proposed) — known gap** |

### 6.2 Replay defense (steps 6 + 8)

The current shape:

- Request signature is Ed25519 over canonical-bytes (method | url | ts | nonce | body).
- Nonce is decoded into the counter chain via `applyLeaseCounter`.
- Server clock is compared against cert validity window — NOT against `ts`.

| # | Adversary capability | Defensive invariant | Status |
|---|---|---|---|
| 6.2.1 | Bit-flip in the body | Canonical bytes change → sig fails | §11 row L.13 |
| 6.2.2 | Bit-flip in the timestamp header | Canonical bytes change → sig fails | §11 row L.14 |
| 6.2.3 | Replay the entire signed envelope before cert expiry | **GAP** — nonce is folded into the counter chain hash but no uniqueness check rejects a duplicate (cert_fp, nonce) | **`cloister-rt-replay`** (filed) |
| 6.2.4 | Partial replay: same envelope, different body | Caught by canonical-bytes mismatch | §11 row L.13 |
| 6.2.5 | Partial replay: same body, different timestamp | The signature was over the *original* ts; a new ts would not match canonical bytes → sig fails | §11 row L.14 |
| 6.2.6 | Server clock skew exceeds cert TTL | Cert is rejected as outside validity window | §11 row L.10, L.11 |
| 6.2.7 | Server clock skew is between 0 and cert TTL (small skew) | Currently accepted — the implementation does not bound `nowSec - ts` | §11 row T.1 (proposed) |
| 6.2.8 | Crash between seen_nonces INSERT and peer_lease_counters UPSERT leaves nonce consumed but chain un-advanced — §13.2 off-by-one (disclosure endpoint reads the missing counter advance as a malicious-cloister signal even though the cluster did nothing wrong) | The two writes are now wrapped in ONE `ctx.storage.transactionSync` inside `TrustStore.verifyLeaseAndAdvanceChain`. Either both land or neither does. Replay rejection throws to roll back the txn so the counter UPSERT never commits when the nonce was a duplicate. | **CLOSED 2026-05-10** — `cloister-ee51b8`. See ADR-0007 + `docs/perf/2026-05-10-lease-pipeline.md` "After batching." |

**Honest disposition.** §6.2.3 is the most important gap in this model.
The middleware comment (`src/routes/lease-middleware.ts:4`) advertises
"replay defense via nonce window" but no such window is implemented.
Until `cloister-rt-replay` lands, an attacker who captures any
authenticated envelope can replay it for the remaining cert TTL (~5 min
worst case) against the same scope.

### 6.3 Scope enforcement (step 7)

| # | Adversary capability | Defensive invariant | Status |
|---|---|---|---|
| 6.3.1 | Cert with `scope=*` (admin) | Allowed by `scopeAllows`. Note: ADR-0007 says `*` should never be minted in production. | §11 row L.6 |
| 6.3.2 | Cert with `scope=tool:*`, request to a different tool | Rejected by trailing-glob match | §11 row L.7 |
| 6.3.3 | Cert with `scope=tool:repoA`, request to `repoB` | Rejected | §11 row L.4 |
| 6.3.4 | Tool name with embedded colon | The grammar is `<name>:<repo>` literal-only; a name like `bead_create:foo` would be interpreted as scope `bead_create:foo:something` and `scopeAllows` matches by prefix. Edge case worth a regression test. | **GAP** — §11 row L.15 (proposed) |
| 6.3.5 | Multi-component wildcard like `tool:repo/*` | Not supported; only trailing `:*`. | Documented in `scopeAllows` JSDoc |
| 6.3.6 | `tools/list` with no scope on cert | `tools/list` always derives `tools:list` and is acceptable for any cert; this is by design | §11 row L.5 |

### 6.4 Timing oracles

The pipeline short-circuits step-by-step. The cost of each step is
order-of-magnitude different (wasm Ed25519 ≈ 1ms; string compare ≈ ns;
DO RPC ≈ ms). An attacker can distinguish "auth header missing" from
"cert chain failed" from "scope denied" timing-wise even before reading
the JSON-RPC error code.

This is acceptable because the JSON-RPC error code already discloses the
failure category. Timing matches code disclosure; nothing extra leaks.
The hardening that *would* matter — masking which-master-key-used
between active and prev — is a non-issue because both are public.

## 7. Seam: counter writes (TrustStore.applyLeaseCounter)

This is where §13.2 lives. Every authenticated request mutates the chain.

| # | Adversary capability | Defensive invariant | Status |
|---|---|---|---|
| 7.1 | Forge a counter row from outside the cluster | Service-binding-as-capability — the DO has no public HTTP entry point (`fetch` returns 405); only `env.TRUST_STORE` holders can call methods | §11 row T.2 (covered by `trust-store.ts:fetch` test) |
| 7.2 | Compromised middleware writes a row without verifying the cert | Trust boundary is the lease middleware itself; if it's compromised the model fails. Mitigation: middleware is hypervisor-layer, single deploy unit, all checks are conjunctive. | n/a (architectural) |
| 7.3 | Race: concurrent requests for the same peer over-write each other's counter row | **POTENTIAL GAP** — `applyLeaseCounter` does an async read-then-write spanning `await crypto.subtle.digest(...)`. Workerd DO input gates serialize RPC entries, but if the input gate releases across the await (default behavior unless `blockConcurrencyWhile` is held), two RPC handlers may interleave. Both compute `nextChainHash(prevHash=..., ...)` from the same prevHash. The ON CONFLICT UPSERT then races: seq becomes `prevSeq+1` in BOTH branches, hash chain forks silently, and a peer-side replay diverges from cloister-side. | **`cloister-tm-counter-race`** (filed) |
| 7.4 | Backwards seq write (counter rewinds) | The UPSERT writes `excluded.seq` unconditionally; nothing enforces monotonicity. A buggy caller could pass a smaller seq. Today the only caller is `applyLeaseCounter`, which always increments. | §11 row T.3 (proposed) |
| 7.5 | Hash-chain skip (write a row whose `last_chain_hash ≠ nextChainHash(prev)`) | Same as 7.4 — no validation. Mitigation: the only writer is the helper. | §11 row T.4 (proposed) |
| 7.6 | "Missing row" (peer never writes counter for a request) | This IS the §13.2 evidence — silence on the counter chain proves a request was admitted off-record. | §11 row D.1 (proposed; needs disclosure endpoint) |

**Honest disposition.** §7.3 is the operationally most likely failure
mode under load. The DO's storage SQL is synchronous (`sql.exec` does
not return a promise), but the helper interleaves an async hash-digest
between the read and the write. Workerd's input gate on a DO does serialize
inbound RPC delivery, but does *not* by default hold across awaits inside
a handler — that requires `ctx.storage.transactionSync()` or
`ctx.blockConcurrencyWhile(...)`. We need to verify behavior under
contention and either tighten the helper or document the assumption.

### 7.7 Cross-implementation chain-hash gotcha (load-bearing for spec)

The chain-step formula is

```
next_chain_hash = sha256_hex(UTF8(prev_chain_hash || cert_fp || nonce_b64 || ts_str))
```

with the inputs **byte-concatenated, no separators, no length prefixes**.
This is documented in
[`interlace-spec/0.1.0/README.md`](../../interlace-spec/0.1.0/README.md)
§4.1 and pinned by the worked-example digests in
[`test-vectors/lease-counter.json`](../../interlace-spec/0.1.0/test-vectors/lease-counter.json).

| # | Adversary / implementation hazard | Defensive invariant | Status |
|---|---|---|---|
| 7.7.a | A second implementor adds a separator (e.g. `\|\|`, `:`, or a length prefix) between concatenated fields | Their chain digests diverge from cloister's, the disclosure cross-check fails, and §13.2 ("silence is evidence") generates false positives — both parties' chains "should" match but don't. The fix is the byte-exact concat described above. | `interlace-spec/0.1.0` ratifies the exact bytes; test vectors are the load-bearing assertion |
| 7.7.b | An implementor changes the **encoding** of any field (hex case, base64 padding, ts representation) | `prev_chain_hash` MUST be 64 *lowercase* hex; `cert_fp` MUST be 64 *lowercase* hex; `nonce_b64` MUST be base64url *no padding* (RFC 4648 §5); `ts_str` MUST be decimal Unix-ms with no padding. Each invariant is pinned by a test-vector row. | Spec §4.1 + test vectors |
| 7.7.c | An implementor uses sha256 *raw bytes* rather than sha256_hex for the next-iteration input | The cloister implementation chains over the **hex string** of the previous digest, not the 32-byte raw output. Using raw bytes would silently produce different digests. The recursion is over UTF-8 of the hex string. | Spec §4.1 spells this out; cloister-side reference at `src/storage/peer-lease-counters.ts:computeNextLeaseStep` |
| 7.7.d | An implementor's `peer_attestations` chain diverges from the spec on row layout (per-peer seq, prev_self_ref invariant, content_hash preservation, null-genesis) | Cloister's `applyAttestation` is parity-tested against `interlace-spec/0.1.0/test-vectors/peer-attestation.json` at `test/storage/peer-attestation-parity.test.ts` (cloister-fff647). The three-row chain (genesis → middle → late) is replayed byte-for-byte; rejection-case `wrong_prev_self_ref` is also pinned. | Spec test vectors; cloister-side reference at `src/storage/peer-attestations.ts:applyAttestation` |
| 7.7.e | An implementor's `CertClaims` canonical-JSON serialization differs from cloister's (key order, whitespace, trailing newline, number formatting) | Several spec test vectors carry a `claims_canonical_json` field — that's not a wire format, it's a *canonical input* to `cert_fp = sha256(claims_canonical_json)`. The exact serialization rules: alphabetical key order, NO whitespace, NO trailing newline, integer fields rendered as bare decimal (no `+`, no leading `0`, no `.0`), string fields wrapped in double quotes with minimal JSON escaping (RFC 8259). A second implementor whose JSON serializer emits `{"a":1, "b":2}` (with the space) gets a different cert_fp and §13.2 false-positives across the cluster boundary. | Spec §3 + test vectors; cloister-side reference at `src/wire/cert-canonical.ts` (or wherever canonical-claims live) |

**The JSON files in `test-vectors/` are NOT the spec wire format.** They
carry the spec's byte-level claims — canonical-bytes-as-hex,
expected-digest-as-hex, and human-readable descriptions of what each
field represents. A second implementor reads the JSON, hex-decodes the
canonical bytes, and asserts they reach the same digest. JSON was
chosen for the carrier because universal parsers in every target
language (Python, Rust, Go, JS) consume it with zero tooling burden;
the actual canonical encoding is CBOR (CA bundle), DER (cert), or
UTF-8-byte-concat (chain hash). See
[`interlace-spec/0.1.0/README.md`](../../interlace-spec/0.1.0/README.md)
§intro for the carrier-vs-wire distinction; this section catalogs the
ways a misread of that distinction breaks the security claim.

**Why this is in §7 of the threat model and not just the spec.** A
chain-hash divergence between two implementations is **operationally
indistinguishable from §13.2 evidence of misbehavior**: a peer's
disclosure endpoint would show a counter chain that doesn't reconcile
with the requester's own derived chain. Without this section, a benign
implementation bug looks identical to a malicious cloister rewriting
history. The spec is the protocol; this section is the *security
consequence of getting the spec subtly wrong*.

## 8. Seam: cross-DO handoff BlobStore → BeadStore → TrustStore

This is the centerpiece. ADR-0007:154 stated attestation rows are written
*"inside the same SQL transaction as the underlying state change."*
After ADR-0012's split, that literal claim is FALSE — bead state lives
in the per-repo `BeadStore` DO, attestation state lives in the singleton
`TrustStore` DO, and workerd's ACID is per-DO.

ADR-0012 substitutes a **content-addressed, idempotent, recoverable**
handoff:

```
1. bead_create writes canonical bytes to BlobStore     (CAS; idempotent)
2. BlobStore returns digest                            (deterministic)
3. BeadStore writes row referencing digest              (per-repo DO; ACID)
4. TrustStore writes peer_attestations referencing digest (singleton; ACID)
```

Below is the failure tree with audit-signal disposition for each leaf.
The signal column says: from the disclosure endpoint, what evidence is
left, and is it distinguishable from misbehavior vs. a benign blip?

| Failure between | State of BlobStore | State of BeadStore | State of TrustStore | Counter chain | Audit signal |
|---|---|---|---|---|---|
| Step 1 fails | empty | empty | empty | counter advanced | "Auth was attempted, no state followed." Distinguishable from misbehavior — a network blip would also produce this. **Ambiguous.** |
| 1→2 | digest written | empty | empty | counter advanced | Same as above. The blob is orphan-recoverable but invisible to the chain. Looks identical to "step 1 fails." |
| 2→3 | digest written | empty | empty | counter advanced | Indistinguishable from previous. |
| 3 fails | digest written | empty | empty | counter advanced | Recoverable on retry: BlobStore.put is idempotent. Same audit signal as previous. |
| 3 succeeds, 4 fails | digest written | bead row exists | NO attestation | counter advanced | **This is the dangerous case.** A `bead_create` succeeded (visible to all readers of BeadStore) but the attestation chain has no row. §13.2 reading: "missing row = misbehavior." But here, the missing row is a network blip — the actor and the cluster did NOT collude to skip attestation; the cluster's own write to its own TrustStore failed mid-pipeline. From the disclosure endpoint, this is INDISTINGUISHABLE from a malicious actor that wrote a bead and refused to record an attestation. |
| 4 succeeds | digest written | bead row exists | attestation row exists | counter advanced | Happy path. |

**Honest disposition.** The §13.2 invariant is preserved cleanly for the
**counter chain** — every authenticated call writes to TrustStore *before*
dispatch. A missing counter row IS dispositive evidence that a request
either never arrived or was admitted off-record. That's strong.

The **per-attestation chain** loses this property. A missing
`peer_attestations` row could be benign (TrustStore write failed in step 4)
or evidence (the cluster admitted a state-change without recording it).
ADR-0012 says "recoverable on retry" but does not specify:

- Who retries?
- What's the retry budget?
- Where is the retry-pending state?
- What does the disclosure endpoint show during the retry window?

These are **gaps in the substitute invariant**. They're not flaws in the
design — they're missing detail that needs to land before ADR-0007's §13.2
mapping can be re-asserted as a cryptographic claim for state-writes (as
opposed to lease-only auth).

`cloister-tm-handoff-retry-policy` (filed) tracks this.

A second, sharper observation: ADR-0012 §"Cross-DO consistency" puts
TrustStore write LAST. Reversing the order — counter UPSERT, then BlobStore.put,
then TrustStore attestation INSERT, then BeadStore write — would put the
state-write at the end so that "BeadStore has a row but TrustStore doesn't"
becomes impossible. This is worth considering. Filed as
`cloister-tm-handoff-order` for design discussion.

## 9. Seam: disclosure endpoint (`GET /interlace/peers/{fp}`)

Not yet implemented (cloister-bdef0c, blocked on bdcbe7 and bd7770). The
threat model requires the endpoint expose:

| Required behavior | Why |
|---|---|
| Return both `peer_lease_counters[fp]` and `peer_attestations[fp,*]` for the requested fingerprint | A peer-side verifier needs both chains to detect §13.2 silence |
| Return 404 for an unknown peer (no rows in either table) | Distinguishable from "we know nothing" vs "we deny knowing" |
| Sign the response with the cluster's master key OR include enough material that a third-party auditor can verify the chain offline | Spec §11 third-party verification |
| Stream the tail when the row count is high, with a cursor that's tamper-evident (signed) | Avoid paginated-tail oracles |

The threat surface this opens:

| # | Adversary capability | Defensive invariant | Status |
|---|---|---|---|
| 9.1 | Read another peer's chain by enumerating fingerprints | The endpoint MUST scope strictly by fp; ADR-0007 amendment 3 specifically renames `prev_self_hash → prev_self_ref` to make per-peer scoping safe. | §11 row D.2 (proposed) |
| 9.2 | Selective oracle — request multiple fingerprints, learn the existence of a third-party relationship | Return shapes must be identical for "absent" and "present-but-rejected" responses (constant-time error path) | §11 row D.3 (proposed) |
| 9.3 | Divergence-detection bypass — peer claims a different chain head; cloister can lie | The disclosure response is signed; a third-party auditor with both peers' versions plus the cluster master pubkey can independently verify which is canonical | §11 row D.4 (proposed) |
| 9.4 | Paginated-tail oracle — attacker requests `?from_seq=N` and learns whether the chain has reached N | Cursor is a signed token over `(fp, from_seq, ts)`; cloister rejects unsigned cursors | §11 row D.5 (proposed) |
| 9.4.b | **Cross-peer timing oracle** — attacker times multiple 404 responses (auth-fail / bad-cursor / unknown-peer) and distinguishes them by the wall-clock cost of the DO read. Originally the no-peer path early-returned (~0.03 ms), the peer-exists-but-rejected path returned only after fetching the full chain (~0.53 ms) — a 17× signal. | **CLOSED 2026-05-10** — `cloister-1c42ae`. Every 404 path runs the same constant-cost existence probe (`TrustStore.peerHasChain`, `SELECT 1 ... LIMIT 1` on both `peer_attestations` and `pending_attestations`), and rows themselves are fetched ONLY on the happy path. Post-fix bench (`docs/perf/2026-05-10-disclosure-endpoint.md`): no-peer-404 = 0.345 ms, bad-cursor-404 = 0.285 ms, delta = 0.060 ms (~17% of mean, well inside workerd's 1ms `performance.now()` quantization floor). The pre-fix path (`listAttestationsForPeer` returning row-count-proportional bytes) is the row-count-marshaling oracle this fix retires; using the existence probe makes the DO RPC return a single boolean of constant marshaling cost regardless of chain length. | **CLOSED** — `cloister-1c42ae`; pinned by `test/trust-store.test.ts` (peerHasChain constant-shape contract) + `test/perf/disclosure-endpoint.test.ts` (empirical timing parity). |

**Honest disposition.** This is all paper today. The endpoint is the
load-bearing seam for §13.2's third-party verifiability. Until the
implementation lands AND a verifier-against-malicious-cloister test
passes, the §13.2 claim has not been validated end-to-end.

## 10. Seam: compute substrate (workerd today; Firecracker / WASI per ADR-0009)

The verifier crate (`leyline-sign`) compiles to wasm32 and is intended to
run in any host. What changes per substrate:

| Property | workerd | Firecracker | Native (WASI) |
|---|---|---|---|
| Master pubkey storage | env binding (TS literal at compile) | guest-kernel ENV | host-injected env or vault read |
| CA bundle fetcher | service binding to notme (unforgeable) | HTTP (must verify bundle signature) | HTTP or shared FS |
| Web Crypto Ed25519 (request sig step) | provided | needs ring/dalek shim | needs ring/dalek shim |
| DO-style ACID for counter | provided | needs SQLite or equivalent | needs SQLite or equivalent |
| DO singleton-per-cluster guarantee | platform-provided | guest-must-enforce (single VM) | guest-must-enforce |
| Time source | `Date.now()` | guest clock; vulnerable to drift if no NTP | host clock |

**Honest disposition.** ADR-0009 says "the same crypto bytes" port; this
is true for the verifier kernel. But the *trust assumptions* around it
(unforgeable service binding to notme; one-DO-per-cluster; tamper-resistant
env bindings) are workerd-specific. A naive port to Firecracker that
HTTP-fetches the bundle and runs N replicas of the counter store would
break the model in ways the math wouldn't catch. The bundle-signature
gap (§5.2) is the smoking-gun example: today it doesn't matter because
service binding is unforgeable; on a Firecracker port over HTTP it
matters immediately.

This is the least-tested axis of the design and should be revisited
before any non-workerd substrate ships.

## 11. Test contract

Each row maps a defensive invariant to the test that would catch its
violation. **GAP** = the invariant is claimed in this model but no
existing test exercises the mode. **proposed** = the test should exist
under the current bead (cloister-bd32b1) or a derivative bead.

### L. Lease-middleware tests (46 existing in `test/routes/lease-middleware.test.ts`)

| ID | Invariant | Test |
|---|---|---|
| L.1 | Garbage cert bytes rejected | "rejects bad base64 in Authorization" + verifyCertChain garbage rejection |
| L.2 | Wrong-master cert rejected | "rejects cert minted by a different master" |
| L.3 | Missing Interlace claims rejected | "rejects cert missing required Interlace claims" |
| L.4 | Scope mismatch on repo arg rejected | "rejects scope mismatch — cert grants ... different repo" |
| L.5 | tools/list scope derivation | "tools/list → tools:list" |
| L.6 | Admin `*` scope allows | "admin '*' allows anything" (scopeAllows) |
| L.7 | `tool:*` glob coverage | "X:* grants any X:something" |
| L.8 | Epoch mismatch (cert ahead of bundle) | "rejects cert with epoch ahead of bundle" |
| L.9 | Epoch mismatch (cert too far behind) | "rejects cert revoked (bundle.epoch > cert.epoch by more than rotation window)" |
| L.10 | Cert pre-validity rejected | "rejects request before cert.not_before" |
| L.11 | Cert post-validity rejected | "rejects request after cert.not_after" |
| L.12 | Bundle missing active key rejected | "rejects when bundle has empty active key" |
| L.13 | Body tamper rejected via canonical bytes | "rejects when canonical bytes don't match (different body)" |
| L.14 | Timestamp tamper rejected via canonical bytes | "rejects when timestamp header doesn't match the signed canonical" |
| L.15 | **GAP** — Tool name with embedded colon | **parked** (no bead filed; low-priority edge case) |
| L.16 | Counter row written on happy path | "happy path writes a lease counter row to TrustStore" |

### C. Cert-chain tests (21 native Rust + 19 TS wasm-wrapper)

| ID | Invariant | Test |
|---|---|---|
| C.1 | Bundle TTL = 4 min cache | `getCABundle` "returns cached bundle inside refresh window without re-fetching" |
| C.2 | Reject cert.epoch > bundle.epoch | `isCertEpochCurrent` "rejects cert.epoch > bundle.epoch" |
| C.3 | notme down ≤ TTL accepts cached | `getCABundle` "respects custom refresh window" + cache test |
| C.4 | notme down > TTL fails closed | `getCABundle` "throws CaUnavailableError when fetcher returns null and cache is stale" |
| C.5 | **CLOSED** — Bundle signature verified | `cloister-c614ae` (closed). `test/storage/bundle-canonical.test.ts` (15 tests), `test/storage/ca-bundle-cache.test.ts` |
| C.6 | **CLOSED** — Critical unknown extension rejected | `cloister-c71977` (closed). `rs/crates/sign/src/cert_chain.rs` (3 tests), `test/wire/signet-verify.test.ts` (2 tests) |
| C.7 | Truncated cert DER rejected | `cert_chain.rs` "truncated_cert_rejects" + TS "rejects truncated cert" |
| C.8 | Wrong master pubkey rejects | `cert_chain.rs` "wrong_master_pubkey_rejects" + TS "rejects cert when master pubkey doesn't match" |
| C.9 | Non-Ed25519 sig algorithm rejected | Rust: covered by `NotEd25519` variant. TS: not directly tested. |
| C.10 | Non-Ed25519 SPKI rejected | Rust: covered by `BadSpki`. TS: not directly tested. |
| C.11 | **GAP** — TBS round-trip canonicalization holds | **parked** (no bead filed; defensive coverage for an unsurfaced parser bug) |

### S. Signet wasm wrapper tests

| ID | Invariant | Test |
|---|---|---|
| S.1 | wasm exports load | "loads the wasm module and exposes lsign_alloc / lsign_free / leyline_verify" |
| S.2 | alloc/copy round-trip exact | "alloc + copy-in + read-back round-trips bytes exactly" |
| S.3 | No memory leak across 25-50 calls | "multiple verify calls in sequence don't leak" + cert-chain variant |
| S.4 | Garbage CMS rejected | "verifyCmsSignature rejects garbage input" |
| S.5 | Master pubkey wrong length rejected (TS-side guard) | "rejects master pubkey of wrong length" |
| S.6 | Output-buffer-too-small rejected | "rejects when claims output buffer is too small" |
| S.7 | Tampered cert (single byte flipped in sig region) rejected | "rejects tampered cert (single byte flipped in signature region)" |
| S.8 | Garbage / truncated / empty cert DER rejected | three separate tests |

### T. TrustStore tests (12 in `peer-lease-counters.test.ts`, integration via lease-middleware)

| ID | Invariant | Test |
|---|---|---|
| T.1 | **CLOSED** — Server clock skew bound | `cloister-c7e3e3` (closed). `test/routes/lease-middleware.test.ts` (4 tests under "clock-skew bound") |
| T.2 | TrustStore has no public HTTP entry | proposed simple test: GET/POST `fetch()` returns 405. (currently covered only by lack of inbound surface in code review) |
| T.3 | **CLOSED** — Counter monotonicity (seq must strictly increase) | `cloister-c75da6` (closed). `test/storage/peer-lease-counters.test.ts` ("assertChainStep" describe block) |
| T.4 | **CLOSED** — Hash-chain integrity (server-side validation) | `cloister-c75da6` (closed). Same suite as T.3 |
| T.5 | nextChainHash deterministic | "is deterministic for the same inputs" |
| T.6 | nextChainHash collision-free under input perturbation | "changes when any input changes" |
| T.7 | Genesis from ZERO_HASH on first observation | "creates a counter on first call (genesis from ZERO_HASH)" |
| T.8 | seq increments on each call | "increments seq on each call" |
| T.9 | Per-peer isolation | "isolates counter per peer" |
| T.10 | **CLOSED** — Concurrent same-peer upserts don't fork the chain | `cloister-c66fea` (closed). `blockConcurrencyWhile` wraps the read-then-write in `TrustStore.upsertLeaseCounter`; integrity defense in `applyAttestation` catches forks. `test/trust-store.test.ts` ("integrity check rejects stale-prev-ref fork") |

### M. Replay defense

| ID | Invariant | Test |
|---|---|---|
| M.1 | **CLOSED** — Same envelope replayed within cert TTL is rejected | `cloister-c5c846` (closed). `test/routes/lease-middleware.test.ts` ("replay defense" describe block, 2 tests) |
| M.2 | **CLOSED** — Nonce reuse with different ts is rejected | `cloister-c5c846` (closed). `(cert_fp, nonce)` PK in `seen_nonces` table; `test/storage/seen-nonces.test.ts` ("duplicate (cert_fp, nonce)" + "triple-replay") |
| M.3 | **CLOSED** — `(cert_fp, nonce)` table eviction matches cert TTL | `cloister-c5c846` (closed). `pruneSeenNoncesBefore()` helper; `test/storage/seen-nonces.test.ts` ("prune deletes < cutoff") |

### D. Disclosure endpoint (planned, cloister-bdef0c)

| ID | Invariant | Test |
|---|---|---|
| D.1 | **CLOSED** — Missing counter row visible at the endpoint | `cloister-bdef0c` (closed). Disclosure JSONL surfaces 3 states: COMPLETE / PENDING / GAP. `test/routes/disclosure.test.ts` |
| D.2 | **CLOSED** — Per-fp scoping (cannot read another peer's chain) | `cloister-bdef0c` (closed). URLPattern `/interlace/peers/:fp` extracts the param; `test/routes/disclosure.test.ts` ("scopes strictly: PEER's data is not leaked through PEER2's URL") |
| D.3 | **CLOSED** — Constant-time error path for "absent" vs "rejected" | `cloister-c7a184` (closed). `constantTimeErrorResponse` returns fixed-length body, same status, same content-type across all error classes. `test/routes/disclosure.test.ts` ("indistinguishability: gate-on auth-fail body == gate-off not-found body") |
| D.4 | **CLOSED** — Response includes cluster master pubkey for offline verification | `cloister-bdef0c` (closed). JSONL header record carries `master_public_key` (base64-std). `test/routes/disclosure.test.ts` |
| D.5 | **CLOSED** — Cursor is signed; unsigned cursors rejected | `cloister-bdef0c` + `cloister-c7a184` (closed). HMAC-SHA256 over canonical JSON `{peerFp, fromSeq, ts}`. `test/routes/disclosure.test.ts` ("rejects unsigned cursor", "rejects cursor signed for different peer", "rejects cursor signed by different HMAC key") |

### H. Cross-DO handoff (planned, cloister-bdcbe7)

| ID | Invariant | Test |
|---|---|---|
| H.1 | BlobStore.put idempotent under retry | covered by ADR-0003 phase 1 tests; reaffirm under ADR-0007 path |
| H.2 | **CLOSED** — BeadStore-success / TrustStore-fail recovery | `cloister-c6d378` (closed). `pending_attestations` table + retry pump RPC; lifecycle test in `test/trust-store.test.ts` ("complete bdcbe7 lifecycle: failed write → enqueue → retry success → commit") |
| H.3 | **CLOSED** — Retry-pending marker is explicit + visible | `cloister-c6d378` (closed). `pending_attestations` row IS the marker; `listPendingForPeer` exposes it. Surfaced in disclosure JSONL as `{ type: "pending" }`. `test/routes/disclosure.test.ts` |
| H.4 | **CLOSED** — Disclosure distinguishes 3 chain states (COMPLETE / PENDING / GAP) | `cloister-bdef0c` + `cloister-c6d378` (closed). Records: `type: attestation` (COMPLETE), `type: pending` (PENDING), endpoint returns constant-time 404 (GAP). Pending rows flag `exhausted: true` after MAX_RETRY_ATTEMPTS. `test/routes/disclosure.test.ts` (pending tests + lifecycle test) |

## 12. Doubt-but-not-disproval check

For the careful reviewer who scans the ADRs and the code and walks
away with confidence, the following statements appear true at first
read but require qualification:

1. **"Replay defense via nonce window."** The lease-middleware module
   header states this. **The implementation does not enforce nonce
   uniqueness.** The nonce is a deterministic input to the counter chain
   hash, but a captured envelope (cert + sig + same nonce + same ts)
   replays cleanly until cert expiry. Filed: `cloister-rt-replay`.

2. **"Attestation rows written inside the same SQL transaction as the
   underlying state change."** ADR-0007:154 (bolded). **Literally false
   post-ADR-0012-split.** ADR-0012 substitutes a content-addressed
   handoff. The substitute invariant is recoverable, not atomic — these
   are different cryptographic claims. ADR-0012 acknowledges this; the
   threat model preserves the qualification.

3. **"Silence is evidence" (§13.2).** The amendment text reads as if this
   is a global property of the trust state. **It holds CLEANLY for the
   counter chain.** It is **WEAKENED for the per-attestation chain**
   because a missing `peer_attestations` row is indistinguishable from
   a network-blip mid-handoff. Until the cross-DO retry policy lands
   (`cloister-tm-handoff-retry-policy`) and the disclosure endpoint
   exposes retry-pending state, attestation-silence remains ambiguous.

4. **"notme is on the cool path, not the hot path."** True for cert
   *signature* verification (offline, pure crypto). **For revocation,
   notme is on a 4-minute hot path.** A revoked cert is accepted for
   up to 4 minutes after revocation. The amendment is explicit; readers
   skipping the amendment get a wrong picture from the original prose.

5. **"The same crypto artifact ports across substrates" (ADR-0009).**
   True for the verifier kernel. **The trust assumptions around it are
   workerd-specific.** Service-binding-as-capability, DO singleton,
   env-binding integrity all change off-platform. The bundle-signature
   gap (§5.2) is currently masked by the unforgeable service binding;
   on a non-workerd substrate it becomes a P0 immediately.

6. **"BeadStore is bundle-layer; TrustStore is hypervisor-layer."**
   Correct per ADR-0011's three-criterion test. **The cross-DO write
   pattern is therefore a hypervisor-to-bundle write** (TrustStore
   writes do NOT depend on BeadStore success today; only the planned
   attestation flow does). A reader inferring "bundle-layer code can
   write to hypervisor state" from ADR-0012's diagram would be wrong —
   the lease middleware (hypervisor) is the only writer to TrustStore;
   the bundle invokes `bead_create` and a (planned) hypervisor-layer
   post-dispatch hook does the attestation write.

7. **"Phase 1 is in place" (ADR-0012 — re BlobStore).** ADR-0012
   *promotes* Phase 1 from "landed" to "load-bearing for ADR-0007"
   and notes a hardening pass may be needed. **The hardening pass
   (cloister-960f68) is open and gates cloister-bdcbe7.** A reader
   inferring "BlobStore is ready" from ADR-0012's diagram should
   instead read it as "BlobStore is the planned mechanism; ship blocked
   on 960f68."

## 13. What this model does NOT yet defend

Updated 2026-05-10. The original list (drafted 2026-05-09) ranked 9
items; 8 of them have since shipped. See the [status-update callout at
the top of this doc](#status-update-2026-05-10--most-gaps-closed) for
the closed→bead mapping, and [§11](#11-test-contract) for per-row
detail.

### Still not defended (current list)

In descending priority:

1. **Prompt-injection vs vault-slice failure mode (NOT YET DEMONSTRATED).**
   ADR-0010 claims a compromised bundle can only exfil what its slice
   token grants. The substrate exists at the design level; no working
   demo proves the claim. Filed as `cloister-74ce00` (P2; blocked on
   ADR-0010 implementation).

2. **Second Interlace implementor (NO ALTERNATIVE EXISTS).** §13.2's
   "silence is evidence" claim is a cryptographic invariant. Today
   cloister is the only implementation; a second implementation would
   either reach the same chain at the same hash (claim confirmed) or
   diverge (claim falsified). Without it, the invariant is a unilateral
   assertion. Spec extraction tracked as `cloister-765132`
   (not yet filed; see beads).

3. **L.15 — Tool name with embedded colon.** §6.3.4. The scope grammar
   `<name>:<repo>` doesn't validate tool names against `:` characters.
   A tool named `bead:create` would parse as scope `bead:create:foo`
   and `scopeAllows` matches by prefix. Edge case; tool names are
   compile-time strings, not user input. **Parked**, no bead filed.

4. **C.11 — TBS re-encoding round-trip mismatch.** §6.1.5. The
   verifier re-encodes `tbs_certificate` to derive what the master
   signed; defensive coverage for a hypothetical x509-cert parser bug
   that has not surfaced. Would be one regression test against a
   hand-minted cert with non-canonical TBS. **Parked**, no bead filed.

5. **Performance characterization.** The model says nothing about
   latency/throughput; threat surface considered, but operational
   cost not measured. Filed as `cloister-747d98` (P3).

### Closed since the original list (for the audit trail)

For posterity, the original §13 items 1-8 — all closed by 2026-05-10:

| Original item | Bead | §11 rows |
|---|---|---|
| 1. Replay defense | `cloister-c5c846` | M.1, M.2, M.3 |
| 2. Bundle signature verification | `cloister-c614ae` | C.5 |
| 3. Cross-DO retry policy | `cloister-c6d378` | H.2, H.3, H.4 |
| 4. Counter-write race | `cloister-c66fea` | T.10 |
| 5. Critical unknown extension | `cloister-c71977` | C.6 |
| 6. Constant-time error path | `cloister-c7a184` + `cloister-bdef0c` | D.3 + D.1/D.2/D.4/D.5 |
| 7. Counter monotonicity + chain integrity | `cloister-c75da6` | T.3, T.4 |
| 8. Server clock skew bound | `cloister-c7e3e3` | T.1 |
| 9. seen_nonces / lease_counter atomicity gap (§6.2.8) | `cloister-ee51b8` | (composed inside `TrustStore.verifyLeaseAndAdvanceChain`; parity tested against `interlace-spec/0.1.0/test-vectors/lease-counter.json`) |
| 10. Disclosure 404 cross-peer timing oracle (§9.4.b) | `cloister-1c42ae` | `TrustStore.peerHasChain` (constant-cost SELECT 1...LIMIT 1 across both attestation tables); pre-fix 17× delta → post-fix delta ≤ workerd `performance.now()` quantization. Test: `test/trust-store.test.ts` (shape contract) + `test/perf/disclosure-endpoint.test.ts` (empirical timing). |

### 13.4 Cross-DO atomicity audit (2026-05-10)

After §6.2.8's gap was discovered, an audit walked every place in the
codebase where two state-mutating writes could span DOs. Findings:

| Site | Pattern | Status |
|---|---|---|
| **Lease pipeline** (`lease-middleware.ts` → `seen_nonces` + `peer_lease_counters`) | Two cross-DO RPCs (singleton `TrustStore`, sequential). **HAD the gap.** | **CLOSED** — `cloister-ee51b8`, one transactional RPC. |
| **Bead writes** (`bead_create | update | close | comment`) | Intra-DO only (BeadStore); a single SQL statement per write. No cross-DO concern. | n/a |
| **Peer attestations** (`peer_attestations` row write keyed by content digest from BlobStore) | Designed for cross-DO failure: idempotent BlobStore `put`, retry queue via `pending_attestations` (per cloister-c6d378). The §8 dangerous-case ("3 succeeds, 4 fails") is acknowledged + has the retry path. | **Mitigated by design** — ADR-0012 content-addressed handoff + `pending_attestations` retry queue |
| **Disclosure endpoint** (`GET /interlace/peers/{fp}`) | Read-only. No writes; atomicity n/a. | n/a |
| **CredentialVault** (`putCredential`, `proxyRequest`) | Intra-DO writes only (the vault DO writes its own SQLite). The vault → upstream HTTP fetch is downstream of the read but not a state mutation in cloister. | n/a |
| **BlobStore** (`put`) | Single intra-DO write; idempotent by content addressing per ADR-0003. | n/a |

**Cross-DO recovery is now e2e-tested** at
`test/security/cross-do-recovery.test.ts` (cloister-fff647): the test
installs a test-only fault-injection seam on
`TrustStore.applyAttestation`, drives a `bead_create` through the full
BlobStore → BeadStore → TrustStore pipeline, asserts the §8
"dangerous case" state (bead row committed, no attestation row,
pending row enqueued), then drains the retry queue and asserts the
late attestation lands with `prev_self_ref` referencing the chain head
before the fault (no fork).

**Net**: the audit found exactly one missed case (the lease pipeline,
now closed). The structural pattern for new cross-DO writes is
ADR-0012's content-addressed handoff; future code should default to
that pattern rather than introducing new "two sequential RPCs without
shared transaction" sites.

## 14. Cross-references

- ADR-0007 §154 (bolded transactional rule) — preserved-via-substitute by
  ADR-0012; see §8 above.
- ADR-0007 §13.2 mapping (audit amendment, line 358-383) — qualified;
  see §12 item 3.
- ADR-0011 — boundary criteria for BeadStore (bundle) vs TrustStore
  (hypervisor); applied correctly per ADR-0012.
- ADR-0012 — content-addressed handoff design; the substitute invariant
  this model audits.
- `_agent_log/theoretical-foundations-analyst_2026-05-09_agent_log.md`
  (gitignored) — full reasoning transcript.

