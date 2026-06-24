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
| **leyline-sign-helper binary** (ADR-0019, post-cloister-99165e) | Signs payloads using OS-keystore-resident keys; never returns key bytes | Host filesystem at operator-owned path; supervisor-managed (launchd / systemd user unit); loopback-bound at `127.0.0.1:8786` |

A compromise of the master key, a compromise of the notme worker, or a
compromise of the build pipeline (modifying `cloister.capnp` or the env
bindings before deploy) all defeat the model. None are addressed here.

**leyline-sign-helper trust boundary (per ADR-0019):** anyone with
access to UID:port on the host is in the trust base. Mitigations:
loopback-only bind; sign-only protocol (no key bytes traverse the
wire); rate-limit default 1000 sigs/sec; per-call keystore re-read
with parsed-key cache invalidated by byte-hash mismatch (automatic
rotation propagation); `/healthz` does not expose per-entry presence
(no oracle); constant-time error shape for 404/500 (`not_found` and
`internal` byte-identical). Compromise of the helper binary defeats
the heap-isolation property ADR-0018 leans on; mitigation is
supervisor-unit hardening (sandbox-exec on macOS, systemd `ProtectHome=
ProtectSystem= NoNewPrivileges= PrivateNetwork=...` on Linux).

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
| 7.7.e | An implementor's `CertClaims` canonical-JSON serialization differs from cloister's (key order, whitespace, trailing newline, number formatting) | Several spec test vectors carry a `claims_canonical_json` field — that's not a wire format, it's a *canonical input* the spec's identity payload uses. `cert_fp` itself is `sha256_hex(cert_der)` (the cert DER bytes, NOT the canonical JSON — see spec §3.4 step 9 + threat-model §7.7.b); `claims_canonical_json` is a separate canonical encoding used inside the cert payload. The exact serialization rules: **declaration order** (`epk, nb, na, ep, pf, sc` per spec §2.1, NOT alphabetical), NO whitespace, NO trailing newline, integer fields rendered as bare decimal (no `+`, no leading `0`, no `.0`), string fields wrapped in double quotes with minimal JSON escaping (RFC 8259). A second implementor whose JSON serializer emits `{"a":1, "b":2}` (with the space) or sorts keys alphabetically gets a different canonical payload and §13.2 false-positives across the cluster boundary. | Spec §2.1 + test vectors; cloister-side reference at `src/wire/cert-canonical.ts` (or wherever canonical-claims live) |

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

### Status update 2026-05-10 (cloister-492c08): **load-bearing in production**

The four-step pipeline above is now the production code path for
`bead_create` when the lease gate is active (`INTERLACE_ROOT_PUBKEY`
set). Source of truth: [`src/routes/bead-create-orchestrator.ts`](../../src/routes/bead-create-orchestrator.ts).
Wiring: `src/routes/mcp.ts` `McpEdgeRoute.callTool` intercepts
`tools/call bead_create` and delegates to `runBeadCreateOrchestrator`,
which pays all four steps before returning a JSON-RPC success body.

Prior to cloister-492c08, the four-step shape existed only in a
TEST-ONLY orchestrator inside `test/security/cross-do-recovery.test.ts`;
production `bead_create` was a single intra-DO INSERT. The §13.2
"silence is evidence" invariant was defended at the design level
(ADR-0012) and the test level (cloister-3dd355) but not in production.
This is now closed: every authenticated `bead_create` writes a row to
all three DOs (or enqueues the attestation for retry when step 4 fails).

End-to-end smoke test: `test/security/disclosure-attestation-smoke.test.ts`
drives `POST /mcp tools/call bead_create` through the production
McpEdgeRoute pipeline and then reads `GET /interlace/peers/<actor_fp>`
to assert that:

  - the disclosure chain contains a row whose `content_hash` matches the
    BlobStore digest returned by the orchestrator
  - hex-decoding the digest + fetching from BlobStore yields the
    canonical bead bytes (which re-hash to the same digest)
  - the bead row in BeadStore carries the same `content_hash`

Three rows, one digest, end-to-end visible from the public face.

Dev-mode exception: when `INTERLACE_ROOT_PUBKEY` is unset (test /
local-dev deployments), there is no verified cert to write an
attestation against, so `bead_create` falls back to the generic
backend's intra-DO INSERT path (no BlobStore put, no peer_attestations
row, no `content_hash` on the bead row). This is the same
deployment-binding-presence pattern the rest of the lease surface uses
— it is NOT a per-request bypass. Production deployments MUST set
`INTERLACE_ROOT_PUBKEY` per ADR-0007.

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

> **STATUS UPDATE 2026-05-17**: shipped. `cloister-bdef0c` + its
> prerequisites `cloister-bdcbe7` + `cloister-bd7770` all closed.
> Implementation at [`src/routes/disclosure.ts`](../../src/routes/disclosure.ts).
> The "Not yet implemented … blocked on" paragraph below is preserved
> for audit trail of how the seam was originally specified; the
> table that follows is the live contract (verified by
> `test/routes/disclosure.test.ts`).

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
| H.5 | **CLOSED** — §13.2 invariant is runtime-load-bearing for `bead_create` | `cloister-492c08` (closed). The ADR-0012 four-step pipeline (BlobStore.put → BeadStore.bead_create → TrustStore.applyAttestation → optional pending enqueue) is the production code path at `src/routes/bead-create-orchestrator.ts`, wired into `McpEdgeRoute.callTool`. Before this, the pipeline lived only in test scaffolding while production was a single intra-DO INSERT. End-to-end smoke: `test/security/disclosure-attestation-smoke.test.ts` confirms BlobStore digest = BeadStore.content_hash = peer_attestations.content_hash visible via `GET /interlace/peers/<fp>`. Fault-injection tests at `test/security/cross-do-recovery.test.ts` now exercise the production orchestrator (not a test-only inline pipeline) for all three hop-fault cases. |

### V. Vault cross-bundle isolation (cloister-26546a)

| ID | Invariant | Class | Mitigation | Test |
|---|---|---|---|---|
| V.1 | **CLOSED** — Intra-DO write-collision in a shared vault binding cannot let bundle A clobber bundle B's credential row | low-likelihood, high-impact (requires a manifest mistake to put two bundles on one vault DO; consequence is silent credential-grant overwrite) | **Layered**: (a) binding-layer — cluster.capnp grants each bundle a distinct `env.VAULT_STORE` namespace via `idFromName()` (ADR-0013 primary gate); (b) SQL-layer — composite PK `(subject_fp, service)` on the `credentials` table inside the DO, where `subject_fp = VerifiedLease.peerFp` is threaded from post-verify lease state and never accepted from caller input (cloister-26546a defense-in-depth). | `test/vault/multi-tenant-isolation.test.ts` covers both layers (distinct `idFromName()` produces distinct row-spaces; shared `idFromName()` still scopes rows by `subject_fp`; forged-`subject_fp` composite scenario verifies the `allowedSubs` + `buildErrorResponse` gates downstream of the row lookup). `test/vault-store.test.ts` covers the SQL-layer subject_fp filter directly. |

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
   counter chain.** It was **WEAKENED for the per-attestation chain**
   because a missing `peer_attestations` row could be indistinguishable
   from a network-blip mid-handoff. **2026-05-10 (`cloister-492c08`):
   the four-step ADR-0012 pipeline is now load-bearing in production for
   `bead_create`** — see §8 status update + §11 row H.5. Attestation-
   silence is no longer ambiguous: the production orchestrator either
   writes the `peer_attestations` row OR enqueues to `pending_attestations`
   (visible at the disclosure endpoint as PENDING). A truly missing row
   for an authenticated `bead_create` IS now §13.2 evidence rather than
   a benign network-blip. The retry policy (`cloister-c6d378`) +
   disclosure endpoint (`cloister-bdef0c`) supply the durability +
   visibility halves; the orchestrator supplies the production write
   path that connects them.

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
| **Peer attestations** (`peer_attestations` row write keyed by content digest from BlobStore) | Designed for cross-DO failure: idempotent BlobStore `put`, retry queue via `pending_attestations` (per cloister-c6d378). The §8 dangerous-case ("3 succeeds, 4 fails") is acknowledged + has the retry path. | **CLOSED 2026-05-10** — `cloister-492c08`. The ADR-0012 four-step handoff is now load-bearing in production at `src/routes/bead-create-orchestrator.ts`, wired into `McpEdgeRoute.callTool` for `tools/call bead_create`. Pre-cloister-492c08 the orchestrator was test-only; production was a single intra-DO INSERT. End-to-end smoke at `test/security/disclosure-attestation-smoke.test.ts` confirms BlobStore digest = BeadStore.content_hash = peer_attestations.content_hash. |
| **Disclosure endpoint** (`GET /interlace/peers/{fp}`) | Read-only. No writes; atomicity n/a. | n/a |
| **CredentialVault** (`putCredential`, `proxyRequest`) | Intra-DO writes only (the vault DO writes its own SQLite). The vault → upstream HTTP fetch is downstream of the read but not a state mutation in cloister. | n/a |
| **BlobStore** (`put`) | Single intra-DO write; idempotent by content addressing per ADR-0003. | n/a |

**Every cross-DO state-mutating hop in the inventory above is
fault-injection-tested** at `test/security/cross-do-recovery.test.ts`,
which since cloister-492c08 drives the PRODUCTION orchestrator
(`src/routes/bead-create-orchestrator.ts`) rather than a test-only
inline pipeline. New cross-DO sequences MUST add a corresponding test
case before landing. The seam (`globalThis.__cloisterTestFaults` Map)
is documented in the per-DO headers (`src/blob-store.ts`,
`src/beads.ts`, `src/trust-store.ts`) and is production-inert (the Map
is `undefined` outside of test runs).

Coverage today (cloister-fff647 + cloister-3dd355 + cloister-492c08):

| Hop faulted | Test case | Asserts |
|---|---|---|
| `TrustStore.applyAttestation` (step 3, last hop) | "full pipeline: step-3 fault → pending row → drain → attestation lands" | §8 dangerous-case state (bead row committed, no attestation, pending enqueued); retry drains; chain integrity preserved (no fork) |
| `BlobStore.put` (step 1, first hop) | "fault-at-BlobStore.put: no downstream writes; retry recovers full pipeline" | NO writes anywhere on fault; retry of bead_create lands a fresh end-to-end pipeline |
| `BeadStore.bead_create` (step 2, middle hop) | "fault-at-BeadStore.write: idempotent BlobStore landed; no TrustStore write; retry recovers" | No bead row; **orchestrator did NOT attempt step 3** (short-circuit invariant); retry produces a fresh bead row + attestation |
| end-to-end happy path | `test/security/disclosure-attestation-smoke.test.ts` "bead_create writes a chain row visible from GET /interlace/peers/<fp>" | Disclosure chain contains an attestation referencing the orchestrator's BlobStore digest; BlobStore.get(digest) round-trips to the canonical bead bytes; BeadStore row carries the same content_hash |

**Net**: the audit found exactly one missed case (the lease pipeline,
now closed). The structural pattern for new cross-DO writes is
ADR-0012's content-addressed handoff; future code should default to
that pattern rather than introducing new "two sequential RPCs without
shared transaction" sites.

## 13.5 Sessionless protocol (SEP-2575 + SEP-2567)

ADR-0015 Phase 2 (`cloister-a35fdb`) added support for the MCP
sessionless protocol: clients sending the `MCP-Protocol-Version` HTTP
header bypass the `initialize` handshake entirely, declare their
`clientInfo` / `clientCapabilities` / `protocolVersion` inline in a
`_meta` block on every request, and discover server capabilities via
`server/discover` rather than `initialize`.

SEP-2575 §"Security Implications" warns:

> Without a session handshake, every request must be independently
> authenticated and authorized. Implementations MUST ensure that
> authentication is not bypassed by the removal of the initialization
> phase.

### Disposition: **no change required at the auth layer**

The cloister lease pipeline (§6 above) was designed independently of the
MCP protocol-version concept. Every `POST /mcp` request carries its own
lease envelope (cert + sig + ts + nonce in the Authorization-family
headers) and is verified end-to-end against the pinned master pubkey
before the request reaches `dispatch()`. Specifically:

| Property | Legacy path | Sessionless path | Same? |
|---|---|---|---|
| Cert chain verify (§6.1) | Per-request | Per-request | yes |
| Request signature verify (§6.2) | Per-request | Per-request | yes |
| Scope enforcement (§6.3) | Per-request | Per-request | yes |
| Replay defense via `seen_nonces` (§6.2.8) | Per-request | Per-request | yes |
| Counter chain advance (§7) | Per-request | Per-request | yes |

The `initialize` handshake was never load-bearing for auth — it carried
no cryptographic state (no session key derivation, no MAC), only the
protocol-version negotiation and a server-issued `Mcp-Session-Id` used
for transport bookkeeping. Removing it changes nothing in the threat
model's seam diagram (§3).

The `handlePost` flow in `src/routes/mcp.ts` reflects this by running
the same lease pipeline before *any* dispatch, regardless of whether
`MCP-Protocol-Version` is present. The sessionless branch enters
`dispatch()` with the same `VerifiedLease` the legacy branch produces;
the `bead_create` orchestrator (§8) operates identically across both
paths.

### What changed (informationally)

- The `Mcp-Session-Id` header is no longer used in sessionless mode and
  is explicitly recorded as a violation by the Phase 0 fixture's
  `mode: "next"` if a client sends it (SEP-2567 removed sessions). This
  has no auth consequence — the header was never authenticated.
- `server/discover` and `subscriptions/listen` are new RPCs. Both are
  routed through the same `handlePost` lease gate; the latter is a
  stub-and-ack today (cloister has no change-bearing primitives yet),
  meaning a sessionless client subscribing to nothing receives an
  acknowledgment but no notifications. No new seam.
- A protocol-version mismatch between the `MCP-Protocol-Version` HTTP
  header and an optional `_meta.io.modelcontextprotocol/protocolVersion`
  body field produces an HTTP-400 JSON-RPC error per SEP-2243. This is
  a wire-format check, not an auth check.

### Adversary model deltas

| Adversary capability | Legacy mitigation | Sessionless mitigation | Delta |
|---|---|---|---|
| Skip auth by skipping `initialize` | n/a — every request is checked | n/a — every request is checked | none |
| Spoof an `Mcp-Session-Id` to impersonate a peer | Session id was a transport bookkeeping value; auth was the per-request signature | n/a — sessions removed | sessionless path is strictly simpler (one fewer header to consider) |
| Downgrade a sessionless client to legacy to bypass new auth bits | n/a — auth bits are identical across paths | n/a — auth bits are identical across paths | none |

The conclusion above also implies: any future auth-tightening landed on
the legacy path (e.g. a replay window narrowing) automatically applies
to the sessionless path because both share `handlePost`.

### Outstanding: protocol-version oracle

A pedantic concern: cloister advertises its `supportedProtocolVersions`
in the `server/discover` response, which is reachable pre-auth in dev
mode (no `INTERLACE_ROOT_PUBKEY`) and post-auth otherwise. In production
the advertisement is gated by the lease pipeline. No oracle leak.

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

## 13.6 Cross-DO backup/restore atomicity

Surfaced by math-friend #2's ADR-0018 review (`_agent_log/theoretical-foundations-analyst_2026-05-12_reviewer-operational_agent_log.md`). Tracking: `cloister-c1317c`.

**Adversary capability:** operator restores cloister-router's `/data/do`
volume in an inconsistent state — for example, identity DO state from
snapshot T1 alongside bead DO state from snapshot T2.

**Concrete failure mode:** post-ADR-0018 implementation, `SigningAuthority`
DO storage lives in cloister-router's `/data/do` volume alongside
BeadStore + TrustStore + BlobStore. An inconsistent restore produces a
cluster that advertises the T1 master pubkey in `.well-known/interlace/index.json`
while `peer_attestations` rows reference certs signed under a T2 master.
External verifiers fail. Identity continuity breaks.

**Defensive invariant the substrate currently provides:** ADR-0012's
content-addressed handoff guarantees atomicity inside a **single live
cluster** (`bead_create` orchestrator: BlobStore.put → BeadStore.bead_create
→ TrustStore.applyAttestation, each step linked by content-hash). **It
does NOT guarantee atomicity across snapshots.** A consistent backup
captures the cluster at one moment; selective restore breaks the
content-hash linkages.

**Substrate cannot enforce.** Backup/restore happens at the operator's
discretion via filesystem snapshots, volume-manager tools, or
cloud-provider primitives. Cloister can't intercept those.

**Operator playbook (documentation-only):**

1. Backup `/data/do` as a single atomic filesystem snapshot. APFS / ZFS /
   btrfs / EBS / GCS-pd all provide atomic-snapshot primitives. Use them.
2. NEVER restore selectively. If recovery requires going back to a prior
   snapshot, restore the ENTIRE `/data/do` volume, not a subset.
3. If selective restore is operationally unavoidable (e.g., disk
   corruption on one DO's SQLite file but not others), the only
   defensible path is **identity rotation** afterward: rotate master_sk,
   publish new epoch in `.well-known/interlace/index.json`, accept that
   any prior peer_attestations rows referencing the old master are no
   longer verifiable. Document this in the operator runbook.
4. Backup verification: periodically restore a backup to a staging
   cluster + run `task verify` end-to-end. This catches drift before
   it matters in prod.

**Status:** This §13.6 row satisfies ADR-0018 prerequisite gate #7.
The mitigation is operator discipline + documentation, not a substrate
property. ADR-0018 implementation proceeds with this disposition
documented.

**Related:**
- ADR-0018 §"Threats and mitigations" — Recovery section cites this
- ADR-0012 — content-addressed handoff that this section qualifies
- Bead `cloister-c1317c` — closes when this section lands


## 13.7 Multi-workerd substrate (ADR-0030 / cloister-f289c8)

Added 2026-06-22 to capture the threat-model invariants the ADR-0030
multi-workerd direction extends — five new entries scoped to the
substrate that workerd-process-per-tenant adds OUTSIDE V8's
slice-grant boundary (ADR-0013 stays load-bearing INSIDE each
per-tenant workerd).

The §13.7 entries are the **contract** the implementation sub-beads
test against:

- vault-1 (`cloister-0ffb3f`) — tests against §13.7.1 + §13.7.2 +
  §13.7.4
- router-table (`cloister-0f144c`) — tests against §13.7.1 + §13.7.5
- secrets-three-tier (`cloister-0f60a8`) — tests against §13.7.3
- compose-emitter (`cloister-0ecb6c`) — tests against §13.7.4
- app-protocol-validator (`cloister-0fa3d7`) — tests against §13.7.5

### 13.7.1 Per-tenant disclosure dispatch

The disclosure endpoint (`GET /interlace/peers/{fp}` per §9) becomes
per-tenant routed under ADR-0030. A request for tenant T1's
disclosure MUST NOT reveal tenant T2's attestation chain.

| Aspect | Detail |
|---|---|
| **Attack** | Cross-tenant peer enumeration: attacker probes `/interlace/peers/<fp>` against tenant T1's router endpoint hoping to learn T2's peer set or attestation state. |
| **Mitigation** | Router dispatches by `route_mode` + `route_value` (SNI or path-prefix) per `[[tenants]]` to the target tenant's workerd. **Lease verification runs INSIDE the target workerd, not at the router** — this means the router is a pre-auth dispatcher: it absorbs body bytes and forwards before any signature check. Pre-auth surface explicitly captured in §13.7.6. Each tenant's workerd has its OWN TrustStore DO; the disclosure handler inside the dispatched-to workerd can only see its own tenant's `peer_attestations` table. **Constant-time 404**: tenant-dispatch's no-match / no-binding response body MUST be byte-identical to disclosure's `constantTimeErrorResponse("not_found")` — see `cloister-92e846` (fixed in `1d03ed9`); previously a 10-byte vs 256-byte enumeration oracle. Pinned by golden test in `test/routes/tenant-dispatch.test.ts`. |
| **Constant-time** | Cross-tenant lookups + unknown-tenant lookups both collapse to the same 404 response shape (constant-time per §9.2 / §9.4); no peer-existence oracle across tenants. |
| **Residual risk** | A misconfigured router (operator declares tenant T1 with SNI `t1.example` but the workerd serving T1's TrustStore actually has T2's storage attached) defeats the boundary. Caught by `cloister-104199` (lint-1) workerd-boundary property check. |
| **Test ref** | router-table tests in `test/routes/tenant-dispatch.test.ts`; vault-1's `test/security/cross-tenant-vault.test.ts` exercises the cross-tenant 404 path |

### 13.7.2 Silence-is-evidence holds per-tenant

§13.2's "silence on the chain = misbehavior" invariant must hold
INSIDE each tenant's chain. Tenant T1's workerd terminating MUST NOT
silence T1's attestation ledger, because T1's TrustStore DO lives in
T1's workerd.

| Aspect | Detail |
|---|---|
| **Attack** | Attacker compromises the cluster supervisor (or operates one) and selectively terminates tenant T1's workerd to "rewind" its attestation chain (drop counter advances, hide bead_create entries). |
| **Mitigation** | TrustStore state is **persistent on disk** (DO storage = SQLite per ADR-0021). A workerd termination doesn't lose committed state; restart picks up where the previous instance left off. A peer auditing T1's disclosure post-restart sees the same chain. |
| **Adversary capabilities** | A privileged operator who CAN both (a) kill T1's workerd AND (b) tamper with T1's DO storage on disk can rewrite history. This is the explicit threat boundary in §13.7.4. |
| **Residual risk** | Supervisor compromise + disk write IS a catastrophic compromise of one tenant. The substrate does NOT defend against the supervisor itself; it scopes the blast radius to ONE tenant's chain (vs all-tenants pre-ADR-0030). |
| **Test ref** | vault-1's `test/security/cross-tenant-vault.test.ts` — boot 2 tenants, write to each, kill tenant-A's workerd mid-write, verify tenant-B's chain unaffected on read; restart tenant-A's workerd, verify chain rejoin |

### 13.7.3 Cluster master compromise = explicit threat boundary

Per ADR-0030 §A3, cluster-tier KEKs derive from one cluster master
root via HKDF. Compromise of that root compromises **all cluster-tier
tenants**. This is explicit, not implicit.

| Aspect | Detail |
|---|---|
| **Attack** | Attacker exfiltrates the cluster master KEK source (Keychain entry, file, sign-helper key, etc.). With the root, attacker derives every cluster-tier tenant's KEK via HKDF + the public tenant_name list. |
| **Mitigation** | Cluster master source is operator-controlled via ADR-0014 URL-spec resolver. Operator picks the protection level (Keychain / libsecret / age-encrypted file / hardware-key-backed sign-helper). The substrate makes no claims about the operator's choice. |
| **Independent surface** | **Service-tier KEKs survive cluster-master compromise — DESIGN, not yet PROOF.** Per ADR-0030 §A3, service-tier secrets are operator-provisioned per service (separate URL-spec resolver target). An attacker with the cluster master CANNOT derive a service-tier KEK without ALSO compromising that service's separate source. **Empirical caveat (cloister-93d674 / C7-b):** as of 2026-06-22 there are NO service-tier consumers shipped in tree. The independent-surface property is structural-by-construction (HKDF input domains are different) but UNPROVEN against a deployed cross-tier read attempt because nothing tries to read across. First service-tier consumer to land MUST ship a property test that asserts cross-tier RPC returns "tier_mismatch" — see `vault/src/__tests__/kek-source.test.ts:"cross-tier reads rejected by type"` for the type-level pattern; the runtime-level pattern is open. |
| **Adversary capabilities** | The substrate explicitly does NOT defend against operator-master compromise. The defense is operator opsec on the chosen URL-spec source. |
| **Residual risk** | A deployment that uses cluster-tier for ALL secrets (no service-tier separation declared) has cluster-master-compromise = full-compromise. Operators who want service-tier separation MUST declare it. **Also:** until a service-tier consumer ships, the §A3 cross-tier defense is design-only — operators reading this section should NOT yet treat service-tier separation as a deployed mitigation. |
| **Test ref** | secrets-three-tier `vault/src/__tests__/kek-source.test.ts` — same tenant_name → same KEK; different tenant_name → independent KEK; cross-tier reads rejected by type. Threat-model entry asserts but does NOT test the master-compromise → tenant-compromise property (it's structural by HKDF). |

### 13.7.4 Workerd-process termination is a denial vector

A compromised tenant CANNOT terminate sibling tenants' workerds
(kernel-enforced). A compromised supervisor CAN, and IS the explicit
threat boundary.

| Aspect | Detail |
|---|---|
| **Attack 1 (cross-tenant denial)** | Attacker inside tenant T1's workerd attempts to SIGTERM tenant T2's workerd, drain T2's disk, or starve T2 of CPU/memory. |
| **Mitigation 1** | Process boundary is kernel-enforced. T1's workerd has no signal capability over T2's PID, no write access to T2's storage volume (per-tenant volume per A1 compose), no shared resource limits (compose `cpus:` + `mem_limit:` per-service). |
| **Attack 2 (supervisor compromise)** | Attacker gains arbitrary code execution AS the compose runtime (Docker Desktop, colima, podman, nerdctl, docker) — kills, restarts, rebuilds any workerd. |
| **Mitigation 2** | **The substrate does NOT defend against supervisor compromise.** This is the explicit threat boundary the ADR-0030 §A1 supervisor choice trades on: a compose-shape supervisor inherits the operator's runtime-trust model. The substrate's claim is "per-tenant workerd boundary scopes BLAST RADIUS"; it is not "supervisor cannot be compromised." |
| **Adversary capabilities** | The substrate trusts the supervisor. Reducing supervisor trust is a v2 concern (cloister-owned supervisor, signed-bundle-only loads, etc.) — out of scope for ADR-0030. |
| **Residual risk** | A compromised supervisor IS a cluster-wide compromise. Operators MUST harden the supervisor surface (rootless containers, supervisord with limited privilege, etc.) per their deployment. |
| **Test ref** | compose-emitter integration test boots N tenants; integration-test.sh extension kills one workerd via the compose runtime and asserts siblings survive (mitigation 1). No test for mitigation 2 — it's an explicit non-property. |

### 13.7.5 Cross-tenant edge labels are NOT authorization

The `app_protocol` labels on `[[edges]]` (ADR-0030 §A4) classify
traffic shape; they do NOT grant access. Cross-tenant authorization
still flows through Signet leases + per-tenant scopes (ADR-0007).

| Aspect | Detail |
|---|---|
| **Attack** | Attacker declares an `[[edges]]` row from tenant T1 to tenant T2 with `app_protocol = "art.mcp-jsonrpc"`, expecting the label to grant T1 access to T2's tools. |
| **Mitigation** | Labels are operator-declared traffic shape metadata. The substrate uses them for routing + observability + future policy enforcement. The `app_protocol` value does NOT bypass lease verification: any cross-tenant call STILL requires a Signet lease covering the destination's scope per ADR-0007. |
| **Validator** | `lint-app-protocol` (`cloister-0fa3d7`) enforces the namespace shape (`art.*` blessed + `x-<v>-*` extensible; other shapes rejected) but does NOT make any access-control claim. A well-formed label is a NECESSARY but NOT SUFFICIENT condition for the edge to function. |
| **Adversary capabilities** | A misconfigured operator who omits per-tenant Signet lease scope declarations would have only `app_protocol` labels as the cross-tenant boundary — which is no boundary at all. Substrate cannot detect this; it's an operator misconfiguration. |
| **Residual risk** | Operators who treat `app_protocol` as a security boundary will be surprised. Doc states the property explicitly in ADR-0030 §A4 "What this is NOT" + this section. |
| **Test ref** | app-protocol-validator's `scripts/test/lint-app-protocol.test.mjs` validates the NAMESPACE only; vault-1 integration tests assert that cross-tenant calls without a valid lease return 401 regardless of `app_protocol` value |

### 13.7.6 Pre-auth pipeline surface (router DoS + timing)

**Added 2026-06-22 from adversarial cycle** (cloister-92e846,
cloister-9339c0). The router is a PRE-AUTH dispatcher: it forwards
the request to the target tenant's workerd before any lease
verification runs. This makes the router a body-bytes-absorption DoS
surface and (because dispatch matching itself has structural timing
characteristics) a tenant-enumeration surface.

| Aspect | Detail |
|---|---|
| **Attack** | Unauthenticated probe enumerates the tenant table via (a) constant-time 404 body-length differential (CLOSED in `1d03ed9`); (b) path-prefix O(N) linear-scan timing; (c) match()-then-handle() double-scan timing amplification; (d) unwired-binding `console.warn` log-channel leakage of tenant names; (e) tenant-existence DoS via unauthenticated body forwarding to target workerd. |
| **Mitigation (shipped)** | (a) tenant-dispatch 404 uses `constantTimeErrorResponse("not_found")` — byte-equivalent with disclosure's 404 (`cloister-92e846`, `1d03ed9`). (b) path-prefix scan is now FULL-WALK with first-match-precedence recorded — no early-break, so an attacker can't probe row position via latency (`cloister-92e846`, `src/routes/tenant-dispatch.ts:matchTenant`). (c) `match()` and `handle()` share a per-request `WeakMap` cache so `handle()` no longer re-scans the table — matched requests now cost exactly one scan, same as unmatched (`cloister-92e846`, `src/routes/tenant-dispatch.ts:resolveMatch`). (d) unwired-binding warn is throttled to one emit per binding per route lifetime + tenant name elided (`cloister-9339c0`, `0f3f8ba`). |
| **Mitigation (pending)** | (e) **explicit residual non-mitigation**: body-bytes DoS persists until lease verification moves to the router or a per-tenant rate-bucket lands at the dispatch tier. Operators MUST front-end the router with their own rate limiter (CF WAF, cloudflared, etc.) if the deployment is exposed to untrusted peers. **Sub-residual:** per-row path-prefix work still depends on the prefix string's length (`startsWith` + `slice` cost scales with prefix length). For realistic deployments (single-digit tenants, prefix lengths <50 chars) this micro-variance is below HTTP-level detection threshold. A truly constant-time string compare requires constant-padded comparisons against a max-prefix-length buffer — deferred until a deployment with adversarial-tier probing requires it. |
| **Adversary capabilities** | Anyone who can speak HTTP to the router can probe. Asymmetry: probe cost is O(1); target-tenant absorption is O(body-bytes). |
| **Residual risk** | Body-bytes DoS + path-prefix timing oracle remain until follow-up beads land. Operators MUST front-end the router with their own rate limiter (CF WAF, cloudflared, etc.) if the deployment is exposed to untrusted peers. |
| **Test ref** | Golden 404 byte-equivalence test at `test/routes/tenant-dispatch.test.ts` (covers (a)); path-prefix timing histogram test deferred to (b) follow-up. |

### 13.7.7 Hybrid-tier alignment (Inv 6 resolution gap)

**Added 2026-06-22 from adversarial cycle** (cloister-93132f). The
`scripts/lint-bundle-isolation.mjs` Invariant 6 (workerd-boundary
property) had a bypass: it only checked the explicit-workerdId-on-
hypervisor case, not the transitively-resolved case via
`sharesWorkerdWith` or the rung-3 gateway fallback.

| Aspect | Detail |
|---|---|
| **Attack** | Operator declares `sharesWorkerdWith=["notme"]` (notme resolves to hypervisor) without explicit `workerdId` + without `trustedTier=true`. Pre-fix: Inv 6 passed because the explicit-workerdId branch was skipped. Cluster-tier tool code lands inside the trusted hypervisor workerd via the back-compat rung. |
| **Mitigation (shipped)** | Inv 6 now runs the trustedTier-alignment check against the RESOLVED `workerd_id` from the three-rung resolver (explicit / same-name / sharesWorkerdWith-transitive). The narrow back-compat exemption is preserved ONLY for pure rung-3 gateway-fallback (empty workerdId + no same-name bundle + no sharesWorkerdWith) — that's the path pre-ADR-0030 cluster.toml used legitimately. Error message names the resolution rung so operators see WHICH lookup path led to the trust grant. Closed in `1d03ed9`. |
| **Residual risk** | Pre-ADR-0030 deployments with empty `inputs[]` get no Inv 6 protection — acceptable, no cross-workerd dispatch is present in that shape, so there's no resolution-rung to bypass in the first place. **Made explicit per cloister-93d674 / C7-c:** the lint is a NO-OP on `cluster.inputs == []`, which is the correct behavior (nothing to check), but operators migrating an existing zero-input cluster.toml to ADR-0030 multi-workerd MUST re-run Inv 6 after adding the first `[inputs.*]` row. CI tracks this implicitly via `task lint` running on every PR; there is no manual reminder. |
| **Test ref** | `scripts/test/lint-bundle-isolation.test.mjs` "Inv 6 (cloister-93132f / C2) — sharesWorkerdWith cluster-tier-on-hypervisor bypass is rejected" |

### 13.7.8 Boot-time operator-config error channel (SNI dup-name + similar)

**Added 2026-06-22 from adversarial cycle** (cloister-93d674 / C7-a). The
manifest compiler in `src/routes/tenant-dispatch.ts:106-109`
(`compileDispatchTable`) throws on operator config errors with a message
that names BOTH conflicting tenant rows. That throw is a fail-fast boot
gate — exactly what we want for misconfiguration — but the error
*message* is a structured-log-tier surface: it carries both tenant names
in plaintext.

| Aspect | Detail |
|---|---|
| **Attack** | An observer with read access to the operator's boot logs (process supervisor stderr, CI job output, container logs aggregated to a third-party tier) learns tenant names from a duplicate-SNI compile failure. The compile-time errors that name both tenants today: duplicate `name` across rows; duplicate `matchValue` under `mode=sni` (`tenant-dispatch.ts:88-89` + `:106-109`); analogous `compose-emitter` validators. |
| **Adversary model** | Boot-log-reader. Strictly inside the operator's trust boundary by definition — the operator *wrote* the names — but the trust boundary leaks if logs are aggregated to a coarser observer tier (centralized log SaaS, infra ops vendor, CI artifact archive). |
| **Mitigation** | **Explicit non-mitigation.** Operator-facing config errors NEED both names for diagnosis — a redacted "duplicate SNI on two tenants" would force an unnecessary `git log -p cluster.toml` dive. The substrate refuses to weaken the diagnostic signal. The threat is the log-tier-boundary, not the error message: operators with a log-aggregator-tier threat model MUST scrub or scope these logs at the supervisor layer. |
| **Residual risk** | Documented and explicit. The substrate trusts the operator's boot-log discipline. This applies to every fail-fast validator: `compileDispatchTable`, `buildKekScopeSource`'s mode collisions, the toml-to-cluster pipeline's `[[bundles]]` schema errors. **Not exhaustive list:** any new compile-time validator that names tenant rows in its error message inherits this residual; new validators do NOT need their own §13.7.8.x sub-entry, but their reviewer should sanity-check the error wording against the same threat model. |
| **Test ref** | None — the property is "we keep both names in the error" which is asserted by the existing compile-error tests (`test/routes/tenant-dispatch.test.ts:"rejects duplicate SNI matchValue"`); the residual is doc-only. |

### 13.7 Summary

| Property | Threat scope | Adversary boundary | Defense |
|---|---|---|---|
| §13.7.1 disclosure-per-tenant | One tenant's attestation chain | Cross-tenant peer enumeration | Router-table dispatch + per-tenant TrustStore DO + byte-equivalent 404 |
| §13.7.2 silence-per-tenant | One tenant's chain integrity | Workerd termination as silencing | DO storage persistence + per-tenant chain ownership |
| §13.7.3 cluster-master = all-cluster-tier | All cluster-tier tenants | Operator-master compromise | Service-tier separation (operator-declared, **design-only — no consumer shipped, cross-tier reject is structural-not-empirical**) |
| §13.7.4 supervisor = catastrophic | All tenants on that supervisor | Supervisor compromise | Explicit non-defense; operator opsec |
| §13.7.5 app_protocol ≠ auth | Cross-tenant access control | Operator misconfiguration | Signet leases + per-tenant scopes (ADR-0007) |
| §13.7.6 pre-auth pipeline | Tenant enumeration + body-bytes DoS | Pre-lease-verify dispatch surface | Byte-equivalent 404 + full-walk path-prefix scan + match/handle WeakMap dedup (cloister-92e846) + unwired-binding warn throttle/redact (cloister-9339c0); body-bytes DoS explicit residual |
| §13.7.7 hybrid-tier alignment | Cluster-tier-on-hypervisor escalation | Lint resolution-rung bypass | Inv 6 runs against resolved workerd_id (cloister-93132f); no-op on empty `inputs[]` by design |
| §13.7.8 boot-time config errors | Tenant-name leak via supervisor stderr | Log-aggregator-tier observer reading boot logs | Explicit non-mitigation; operator scrubs at log-supervisor layer |

**Related:**
- ADR-0030 — the substrate decision this defends
- ADR-0030 §A1-A5 — the five-property decision tree
- ADR-0013 — V8 slice-grant inner ring this preserves
- ADR-0021 — per-bundle vault DO instances inside each per-tenant workerd
- §13.2 — original silence-is-evidence invariant (now scoped per-tenant)
- §9 — disclosure endpoint (now per-tenant dispatched)
- Beads: `cloister-f289c8` (epic), `cloister-0ffb3f` (vault-1 tests against §13.7.1+.2+.4), `cloister-0f144c` (router-table tests against §13.7.1+.5), `cloister-0f60a8` (secrets tests against §13.7.3), `cloister-0ecb6c` (compose-emitter tests against §13.7.4), `cloister-0fa3d7` (app-protocol-validator tests against §13.7.5)


## 13.8 bd substrate binding (ADR-0033 / cloister-c2bd47)

Added 2026-06-24 from the ADR-0033 Phase 1 wiring (`rsry_*` mcpProxy
backend → ROSARY_BUNDLE service binding → rsry MCP server → bd's Dolt
sql-server). Each subsection captures one attacker-facing seam the
binding adds.

### 13.8.1 Cloister-Worker → rsry: UDS perimeter, no wire auth in Phase 1

| Aspect | Detail |
|---|---|
| **Attack** | Same-user process on the cluster host (or co-tenant inside the workerd-process-shared substrate, ADR-0030 hybrid model) connects to `/run/cloister-uds/rosary.sock` and issues `rsry_bead_*` MCP calls without an attestation. |
| **Mitigation (shipped Phase 1)** | UDS filesystem ACL is the perimeter — same posture as the existing `mache` + `lsp_*` backends (per `docs/tenants/rsry-mcp.md`). Inside the cluster trust boundary (post-V8-isolate per ADR-0013); no cross-tenant exposure in single-workerd deployments. |
| **Mitigation (Phase 2, deferred)** | Bearer-token auth mediated by vault per ADR-0024 cred-iso/v1. Token injected by Vault DO at dispatch time; opaque to cloister; rotatable at deploy boundary. Triggers when a deployment shape needs cross-tenant rsry consumption (e.g. ADR-0030 multi-workerd-per-tenant with shared rsry; or external-network-reachable rsry). |
| **Residual risk** | Phase 1 is unauthenticated. A bundle in the same workerd that compromises the V8 sandbox can read rsry's MCP surface. The threat boundary mirrors mache + llo — accepted as a substrate-default, not specific to bd. Phase 2 closes the gap when threat surfaces. |
| **Test ref** | `test/manifest/rsry-backend.test.ts` (7 cases, structural pin); `test/integration/rsry-backend-e2e.test.ts` (9 cases, claim routing + tools/list passthrough); `test/integration/recipe-multi-tenant-instantiate.test.ts` (5 cases, end-to-end pipeline). |

### 13.8.2 rsry → bd Dolt: storage trust boundary

| Aspect | Detail |
|---|---|
| **Attack** | A compromised bundle (or a same-user process on the host) writes directly to `.beads/dolt/<repo>/`'s noms files, bypassing rsry's MCP validation and bd's Dolt commit graph. |
| **Mitigation** | rsry's storage is content-addressed via `refs/dolt/data` (per bd's storage model). A direct-noms tampering attempt either (a) breaks Dolt's merkle invariants and surfaces at next `bd dolt push/pull` as a chain divergence, or (b) becomes visible to any cloner who fetches the bead refs. **Silence-is-evidence does NOT hold** for direct-storage tampering at the single-host layer — Dolt's history-rewrite primitive lets a privileged attacker rewrite local history without immediate signal. **It DOES hold across distributed consumers**: once a `bd dolt push` lands on a remote, divergent histories fork on every subsequent pull. |
| **Adversary model** | Privileged operator on the host (`uid` of the rsry/bd process) — explicitly outside the substrate's threat model. The substrate trusts the operator's host hardening, mirroring ADR-0030 §A4's supervisor-trust posture. |
| **Residual risk** | Single-host operator-tier attackers can rewrite local bead history. Multi-host deployments inherit Dolt's distributed-history-merkle-tree audit trail. |
| **Test ref** | None — Dolt's merkle invariants are upstream-tested. The substrate-level assertion is that rsry + bd both use the same storage primitive (Dolt). |

### 13.8.3 Two MCP surfaces (`bead_*` BeadStore DO + `rsry_*` rosary): coexistence is intentional

| Aspect | Detail |
|---|---|
| **Attack** | An operator confuses the two surfaces and writes to one expecting the other to see it. Or: a cluster-tier bundle accesses one expecting cred-iso/v1 scope checks from the other. |
| **Mitigation** | Documented intentionally as ADR-0033 D5. `docs/tenants/rsry-mcp.md` explicitly enumerates the difference (DO SQLite tables vs `.beads/dolt/<repo>/`); `test/manifest/rsry-backend.test.ts` pins the `bead_*` routing-to-BeadStore-DO invariant (NEVER routes to rsry). The two surfaces have different threat models — BeadStore DO carries trust-mediation semantics per ADR-0012 (per-bundle scope, lease-gated, attestation chain); rsry/bd's wire is UDS-internal with no per-bundle scope yet. |
| **Adversary model** | Misconfigured operator confusing the surfaces. Not adversarial; substrate documentation surfaces the difference. |
| **Residual risk** | An operator who treats `rsry_*` as if it carried the `bead_*` DO's per-bundle scope guarantees would be surprised. Doc + tenant page explicit; no other defense. |

### 13.8.4 Coexistence with multi-tenant substrate (ADR-0030)

| Aspect | Detail |
|---|---|
| **Attack** | A per-tenant workerd in the ADR-0030 multi-workerd direction reaches the cluster-wide rsry MCP via its `ROSARY_BUNDLE` service binding and read/writes another tenant's beads. |
| **Mitigation** | Today: not addressed. Phase 1 ships one cluster-wide rsry instance with no per-tenant scope on the wire. The threat surfaces ONLY when ADR-0030 multi-workerd ships AND rsry's wire becomes cross-tenant. Until then, rsry is single-tenant by deployment. |
| **Mitigation (future, Phase 2)** | Per-tenant rsry instances (each tenant has its own `ROSARY_BUNDLE` service binding pointing at a tenant-scoped rsry sidecar), OR per-tenant scope on bd's storage (`BEADS_DIR=<tenant>` or similar), with bearer-token auth enforcing the tenant boundary. Lands when first multi-tenant bd consumer ships. |
| **Residual risk** | Single-tenant only today; multi-tenant requires Phase 2 work. Documented as future-residual; tracked under `cloister-c2bd47` for the Phase 2 sub-bead. |
| **Test ref** | None today (single-tenant deployments). When Phase 2 lands, add a cross-tenant property test against `cloister-c2bd47` Phase 2 wire. |

### 13.8 Summary

| Property | Threat scope | Adversary boundary | Defense |
|---|---|---|---|
| §13.8.1 cloister↔rsry UDS | Same-host process / co-tenant in shared workerd | UDS filesystem ACL | Mirror mache/llo posture; Phase 2 bearer token deferred |
| §13.8.2 rsry↔bd Dolt | Single-host operator-tier attacker | Operator-trust boundary (per ADR-0030 §A4) | Dolt merkle invariants for distributed audit; single-host outside scope |
| §13.8.3 two MCP surfaces | Misconfigured operator | Doc + test invariant | Documented coexistence; bead_* never routes to rsry |
| §13.8.4 multi-tenant coexistence | Cross-tenant bead read/write | Single-tenant by deployment today | Phase 2 per-tenant rsry instances + bearer-token (deferred) |

**Related:**
- ADR-0033 — bd substrate binding decision (rsry IS the MCP server; bd is storage)
- ADR-0024 — cred-iso/v1 capability (Phase 2 auth hook)
- ADR-0021 — per-bundle vault DOs (Phase 2 multi-tenant pattern)
- ADR-0030 — multi-workerd substrate (the future this Phase 2 work composes with)
- `docs/tenants/rsry-mcp.md` — operator-facing tenant doc
- Beads: `cloister-9d19e3` (design), `cloister-c2bd47` (impl Phase 1 shipped; Phase 2 deferred)


## 15. Trust-anchor-helper attack surface (cloister-99165e / ADR-0019)

Added 2026-05-12 by adversarial-cycle 2026-05-12 (see
[`docs/security/adversarial-cycles/2026-05-12.md`](adversarial-cycles/2026-05-12.md)).
trust-root-friend's pre-merge review of PR #1 surfaced seven findings
against the leyline-sign-helper implementation. Three independent P1s
together regressed the substrate's trust-root posture below the
predecessor (`scripts/kek-helper.mjs`). PR #1 is held pending fixes.

The helper's design is correct per ADR-0019. The findings are
implementation gaps where the substrate does not yet enforce what the
spec promises. Each row below names the adversary capability, the
defensive invariant the spec claims, the implementation status today,
and the closing playbook.

### Row 15.1 — `GET /resolve` exfiltrates signing-key bytes

| | |
|---|---|
| **Adversary capability** | Any local TCP caller on the helper's loopback port. |
| **Invariant** (ADR-0019 normative req. 13) | Signing-key consumers MUST use `POST /sign`. Signing-key bytes MUST NOT leave the helper. |
| **Status** | **OPEN** — the helper carries over the `kek-helper.mjs` `/resolve` endpoint with no path / scheme allow-list. `curl http://127.0.0.1:8786/resolve?url=keychain://com.cloister/master-sk` returns the raw 32-byte master signing seed. |
| **Detection** | None today. Helper logs URL scheme only, not URL remainder. |
| **Recovery** | Master rotation. Blast radius cluster-wide (master_sk forges every lease). |
| **Closing playbook** | Delete `/resolve` outright, OR allow-list to non-signing-key URLs via a deploy-time `--allow-resolve=<scheme:keystore-prefix>` list, OR partition the keystore namespace such that `/resolve` cannot address the signing-key namespace. Test pinned at `rs/crates/sign/tests/host_adversarial.rs::resolve_must_reject_signing_key_urls`. |
| **Tracking** | Bead `cloister-7aaab1` (P1). |

### Row 15.2 — Loopback bind is not UID-scoped

| | |
|---|---|
| **Adversary capability** | Any local UID; any container co-tenant in host netns; any malicious page the operator visits (via simple-POST CSRF — see 15.5). |
| **Invariant** (ADR-0019 §"Implementation pins" + helper module comment) | Cross-UID access blocked by OS process scoping when the helper runs as the user. |
| **Status** | **OPEN** — claim is false on Linux and macOS. Loopback TCP has no UID scoping. The helper's own `ratelimit.rs:13-23` comment asserts the protection; the implementation provides none. |
| **Detection** | None. |
| **Recovery** | Master rotation. |
| **Closing playbook** | One of: (a) UDS + peer-credential check (`SO_PEERCRED` on Linux, `getpeereid()` on macOS); (b) bearer-token auth where router and helper share a deploy-time secret; (c) mTLS. (a) is strongest; (b) is cheapest; (c) is over-engineered for same-host transport. Test pinned at `rs/crates/sign/tests/host_adversarial.rs::sign_must_require_authentication`. |
| **Tracking** | Bead `cloister-7afedc` (P1). |

### Row 15.3 — Rate-limit identity is wrong

| | |
|---|---|
| **Adversary capability** | Any caller reaching `/sign` (see 15.2). |
| **Invariant** (ADR-0019 normative req. 10) | Rate-limit is per source UID. |
| **Status** | **OPEN** — implementation keys the limiter HashMap on `current_uid()` of the helper's own process, not the caller. One global bucket. A single hostile caller saturates it and DoSes legitimate signing for everyone. |
| **Detection** | Structured emit fires on rate-limit reject, but doesn't disambiguate caller identity (because there isn't one). |
| **Recovery** | None during the attack — wait for the bucket to refill. |
| **Closing playbook** | Add per-caller identity (lands with 15.2's auth fix) AND key the limiter on that identity. Test pinned at `rs/crates/sign/tests/host_adversarial.rs::rate_limit_must_be_per_caller`. |
| **Tracking** | Bead `cloister-7b5b9d` (P1). |

### Row 15.4 — Supervisor does not verify binary at launch

| | |
|---|---|
| **Adversary capability** | Same-UID write to the helper binary's path (`~/.cargo/bin/leyline-sign-helper` on Linux, `/usr/local/bin/leyline-sign-helper` on macOS — both user-writable). |
| **Invariant** | Supervisor MUST refuse to launch a binary whose hash drifts from a pinned attestation. |
| **Status** | **OPEN** — launchd plist + systemd unit launch the binary unconditionally. Same-UID-write attacker swaps the binary, supervisor relaunches it on next start (or after SIGHUP), keystore ACL extends to the impostor. Compounds with 15.1 (impostor uses `/resolve` to exfil). |
| **Detection** | None unless operator manually `shasum`s the binary. |
| **Recovery** | Reinstall + master rotation. |
| **Closing playbook** | Supervisor-side `ExecCondition=` (systemd) / pre-launch script (launchd) that verifies a signed manifest. Or use the OS package manager's signing chain. Or add a `--require-build-sha=<sha>` flag the supervisor passes. Test pinned at the deploy layer, not the helper unit — note as "documented gap; supervisor-side test, not unit test." |
| **Tracking** | Bead `cloister-7bb456` (P2). |

### Row 15.5 — Localhost CSRF via simple-POST

| | |
|---|---|
| **Adversary capability** | A page the operator visits in a browser. No special access needed. |
| **Invariant** | The helper rejects requests not originating from cloister-router. |
| **Status** | **OPEN** — `/sign` accepts any `Content-Type`. `text/plain` is CORS-safelisted → no preflight → cross-origin `fetch` from a malicious page POSTs JSON, helper parses regardless of declared content-type, master_sk signs attacker-chosen payload. Attacker doesn't need to *read* the response; the signature is the side effect. |
| **Detection** | None. |
| **Recovery** | Master rotation (the attacker can hold a valid signature on any payload of their choosing). |
| **Closing playbook** | Strict `Content-Type: application/json` enforcement (returns 415 otherwise), OR a custom header (`X-Helper-Auth: ...`) that forces CORS preflight. Composes with 15.2's auth fix. Test pinned at `rs/crates/sign/tests/host_adversarial.rs::sign_must_reject_csrf_content_types`. |
| **Tracking** | Bead `cloister-7c2179` (P2). |

### Row 15.6 — Content-Length cap bypassable

| | |
|---|---|
| **Adversary capability** | Any authenticated caller (or any caller, today, given 15.2). |
| **Invariant** (ADR-0019 normative req. 3) | Request body MUST be ≤ 64 KiB. |
| **Status** | **CLOSED** (2026-06-17, cloister-d0f0f3) — `tower_http::limit::RequestBodyLimitLayer::new(64 * 1024)` installed in `host::server::build_router`, layered around `content_length_guard`. The guard fast-paths the with-CL case to the spec'd `{"error":"payload_too_large", ...}` 413 JSON body; the layer is the safety net for the no-CL / chunked-transfer case. Original status (preserved for audit trail): "**OPEN** — `content_length_guard` enforces the cap when a `Content-Length` header is present, but the fallthrough on missing CL lets the request through to axum's 2 MiB default (30× the spec'd ceiling). Helper's own source comment admits the gap and points at the unhandled fix." |
| **Detection** | None. |
| **Recovery** | None needed (no key compromise), but allows amplifying request memory cost during DoS. |
| **Closing playbook** | One-line fix: install `tower_http::limit::RequestBodyLimitLayer::new(64 * 1024)`. Test pinned at `rs/crates/sign/tests/host_adversarial.rs::sign_must_enforce_body_size_cap` (no-CL chunked path) and `::sign_body_size_cap_boundary` (with-CL 63/64/65 KiB boundary triple). **Rejection-signal note (cloister-d0f0f3):** the test accepts EITHER HTTP 413 (preferred — both the layer and the guard produce this) OR a connection-reset / empty response, because hyper's chunked-transfer abort path can RST the stream before the layer's IntoResponse runs. Both signals are equivalent for the invariant: the body never reaches the handler. The original "expect 413, exactly" assertion was the source of the parallel-test-load flake closed by cloister-d0f0f3. |
| **Tracking** | Bead `cloister-7c737a` (P2, original); closed by `cloister-d0f0f3` (test de-flake + boundary test + layer install confirmation, 2026-06-17). |

### Row 15.7 — ed25519-dalek pin drift

| | |
|---|---|
| **Adversary capability** | None directly exploitable today. The defense being eroded is a defense-in-depth claim, not a load-bearing invariant. |
| **Invariant** (ADR-0019 §"Implementation pins") | `ed25519-dalek` pinned at `2.1.x` for the constant-time guarantees + algorithmic-substitution defense documented in the math-friend dual review. |
| **Status** | **OPEN** — `rs/crates/sign/Cargo.toml:15` declares `version = "2.1"` (caret-pin = `^2.1` = `>= 2.1.0, < 3.0.0`). `rs/Cargo.lock:142` resolves to `2.2.0`. Documented promise diverges from shipping artifact. |
| **Detection** | Manual `cargo audit` / `cargo tree`. No CI gate today. |
| **Recovery** | Bump to `2.2.x` and amend the ADR with a math-friend re-review, OR tighten the pin to `~2.1` / `=2.1.x` and let CI block 2.2 entries. |
| **Closing playbook** | Two-line `Cargo.toml` fix (pin tightening) OR an ADR amendment. Pair with a CI check that asserts Cargo.lock's `ed25519-dalek` entry matches the ADR's documented version. Also wire `LEYLINE_SIGN_BUILD_SHA` (currently `option_env!` → `"unknown"` at `host/health.rs:35-38`) so `/healthz` exposes the binary identity for operator audit. |
| **Tracking** | Bead `cloister-7cd202` (P2). |

### Vectors checked and cleared (audit trail)

trust-root-friend's cycle checked the following and found no exploitable
vector under the documented threat model. Recording here so the next
cycle doesn't re-discover them as "open":

- **kid (SHA-256(pubkey)[:8]) collision.** 64-bit kid is used only as a
  response field and rotation-detection signal, NOT as a cache lookup
  key (cache is keyed by `(URL spec, SHA-256(bytes))`). Birthday-attack
  irrelevant under this design.
- **Cache poisoning race.** Concurrent requests that observe different
  keystore bytes serialize correctly through the `Mutex<SigningKey>`;
  each request signs with the bytes it observed at read time.
- **Keystore-source switch via env mutation.** No env-var indirection
  in the spec carrier; URL is in the request body at call time. The
  attack surface is "who controls request bodies" (covered by 15.2 +
  15.5), not "who controls env."
- **macOS Keychain TTY-prompt blocking.** Helper uses the `keyring`
  crate (not `security` CLI); first-use prompts go through the user
  session under `SessionCreate`. Spec'd OK via supervisor README's
  macOS partition-list section.
- **Symlink-TOCTOU on `file://`.** `read_file_bytes` checks
  `is_symlink()` then `std::fs::read`. A directory-write attacker
  could in principle race. Practical exploitability is low (write to
  the keystore directory is already in the trust-root surface).
  Documented; not filed.

### Status

PR #1 (`cloister-99165e-leyline-sign-helper`) is held pending fixes for
rows 15.1, 15.2, 15.3 (P1) at minimum. Row 15.6's fix is one line and
trivially bundled. Row 15.5's fix is one line and trivially bundled.
Row 15.4 and Row 15.7 are acceptable as immediate follow-ups (not
merge-blocking) once the helper's `/sign` surface is locked down.

**Related:**
- ADR-0019 — the spec these rows hold accountable to
- ADR-0020 — the adversarial-team charter that surfaced these
- `docs/security/adversarial-cycles/2026-05-12.md` — the cycle report
- Beads: `cloister-7aaab1`, `cloister-7afedc`, `cloister-7b5b9d`,
  `cloister-7bb456`, `cloister-7c2179`, `cloister-7c737a`,
  `cloister-7cd202` — one per row
- Parent: `cloister-1f249f` (adversarial team rotation)

## 15.A. Verification cycle 2026-05-12 (cycle 2)

trust-root-friend's second cycle on PR #1 verified the cycle-1 fixes
landed in commit `de51d86`. Six rows (15.1, 15.2, 15.3, 15.5, 15.6,
15.7) checked; five closed code-side, one deferred (15.4), three new
findings filed. NEW-1 was a P1 deployment-shape regression that
re-opened §15.2 verbatim for any operator following the supervisor
templates verbatim — closed in commit `af794fb`.

### Per-row status

| Row | Cycle-2 verdict | Notes |
|---|---|---|
| 15.1 | **VERIFIED CLOSED** (code-side) + **NEW-2** (P2, follow-up) | Allow-list deny-all works; string-prefix match has the operator-naming-hygiene caveat → NEW-2. |
| 15.2 | **VERIFIED CLOSED** (cycle-1 code + cycle-2 deploy) | Cycle-1 added bearer-token auth. Cycle-2 added `--require-auth` flag + supervisor templates pin the env (`cloister-9bd96c`). Operators get fail-stop at startup if env is unset. |
| 15.3 | **VERIFIED CLOSED** | Per-caller rate-limit working at both unit-test and integration layer. |
| 15.4 | **DEFERRED** (P2; cloister-7bb456) | Supervisor binary integrity remains as documented follow-up. Phase-D binary-attestation design is the proper closing playbook. |
| 15.5 | **VERIFIED CLOSED** | Strict Content-Type rejects all variants of CSRF simple-POST (text/plain, form-urlencoded, multipart, mismatched case). |
| 15.6 | **VERIFIED CLOSED** | Chunked-transfer 128 KiB body returns 413 via `RequestBodyLimitLayer`. |
| 15.7 | **PARTIALLY CLOSED** + **NEW-3** (P3) | Cargo.toml pinned `~2.1`, Cargo.lock at `2.1.1`. CI lint to prevent drift not added → NEW-3 follow-up bead. |

### New findings (filed this cycle)

| # | Severity | Status | Bead | Summary |
|---|---|---|---|---|
| NEW-1 | P1 | **SHIPPED 2026-05-12** | `cloister-9bd96c` | Supervisor templates wired `--require-auth` + env-file. Operator-skip-token path now fail-stops at startup with a structured error pointing at the env var. |
| NEW-2 | P2 | DOCUMENTED; code follow-up filed | `cloister-9bee1f` | `/resolve` allow-list is string-prefix match. Loud warning in supervisor template headers; code-side namespace-partition is the proper close, deferred. |
| NEW-3 | P3 | FILED | `cloister-9bfbf6` | No CI lint for ed25519-dalek pin drift. `scripts/lint-ed25519-pin.sh` + wire into `task verify` is the close. |

### Pre-merge disposition

PR #1 is now **MERGE OK** for the security surface trust-root-friend
covers. Final pre-merge checklist before squash-merge:

- [x] All 5 cycle-1 P1/P2 code findings closed (15.1, 15.2, 15.3, 15.5, 15.6, 15.7).
- [x] Cycle-2 NEW-1 (deployment shape) closed.
- [x] Adversarial test suite (`tests/host_adversarial.rs`) green.
- [x] Existing host integration suite green.
- [ ] NEW-2 + NEW-3 land as follow-up beads (not merge-blocking).
- [ ] §15.4 supervisor binary-attestation remains follow-up.
- [ ] Other red-team specialists (oracle, isolation, replay, silence)
  not yet dispatched on this PR — their findings, if any, can land in
  follow-up cycles.

Lifecycle going forward: when the helper rotates to add features or
when keystore-source schemes change, re-dispatch trust-root-friend.
Other specialists rotate per the ADR-0020 cadence.

**Related:**
- `docs/security/adversarial-cycles/2026-05-12.md` — full cycle report
- Beads: `cloister-7aaab1` `cloister-7afedc` `cloister-7b5b9d`
  `cloister-7c2179` `cloister-7c737a` `cloister-7cd202` (cycle 1) +
  `cloister-9bd96c` `cloister-9bee1f` `cloister-9bfbf6` (cycle 2).
- Parent: `cloister-1f249f` (adversarial-team rotation).

## 16. Oracle audit (oracle-friend cycle 2026-05-12)

oracle-friend's first dispatch. Targets: vault DO 403/404 distinguishability
(noted in passing by dos-friend's pilot; never formally filed) +
disclosure endpoint §9.4.b CLOSED-claim re-verification.

### Row 16.1 — Vault DO 403/404 status-code enumeration oracle (DORMANT today)

| | |
|---|---|
| **Adversary capability** | A bundle that can call vault via DO RPC with a valid `subjectFp` (i.e., the gateway-internal contract). DORMANT today because only `cloister-router` calls vault. ACTIVATES with the first non-router bundle (ADR-0021 implementation). |
| **Invariant** | The vault RPC surface MUST NOT distinguish "credential row exists but caller_sub does not match `allowedSubs`" from "no credential row." Both cases collapse to a single 404 with a constant-shape body. Mirrors §9.4.b's disclosure-endpoint playbook. |
| **Status** | **OPEN** (dormant — status-code distinguishability is in code today but unreachable from any current caller). Tests `test/vault-store.test.ts:140-156` pin the 404-vs-403 split as "intentional because vault is gateway-internal"; the same file's header anticipates the contract-flip when bundle Workers ship. |
| **Detection** | Probe enumeration would saturate the F1 rate-limit budget (cost 5/proxy → ~12 probes/sec) and emit `vault.rate_limit_reject` events. Silent until cumulative-RPS-anomaly alerts wire (`red-team:silence` queue). |
| **Recovery** | None needed if closed before bundle Workers ship. If shipped with the oracle live: rotate any credential a compromised bundle could enumerate (bundle-namespace-wide). |
| **Closing playbook** | Collapse 403 → 404 in `src/vault-store.ts` `#proxyRequestInner`. Always run the same SELECT + parse + `checkAccess` work regardless of outcome (no early-return on no-row). Structured logs preserve the reason; wire response is byte-identical. ~30 LOC + reversed assertion in `test/vault-store.test.ts:140-156`. |
| **Tracking** | Bead `cloister-aa9376` (P2; escalates to P1 with bundle Worker rollout). |

### Row 16.2 — `checkAccess` glob-loop timing sub-oracle (DEFERRED)

| | |
|---|---|
| **Adversary capability** | Same as 16.1; sub-oracle becomes the dominant variance once 16.1's status-code distinguishability is closed. |
| **Invariant** | Glob-match wall-clock cost MUST NOT leak `allowedSubs` structure. |
| **Status** | DEFERRED. Sub-ms variance below workerd's 1ms `performance.now()` quantization floor; not standalone-exploitable today. Re-evaluate after 16.1 closes. |
| **Closing playbook** | Constant-time glob-match (run all patterns to completion regardless of any early `return true`). Same shape as the byte-equality scan in `host/auth.rs::ct_eq`. |
| **Tracking** | Paragraphed in `cloister-aa9376`; not separately filed. |

### §9.4.b verification — REMAINS CLOSED

oracle-friend's code-path audit on `src/routes/disclosure.ts` confirmed
every 404-emitting branch flows through:

  - `peerHasChain` at line 219 (constant-cost SELECT 1 ... LIMIT 1)
  - `constantTimeErrorResponse` (fixed 256-byte body, three-header set)

Pinned by `test/routes/disclosure.test.ts:312-368` (byte-identity across
`not_found` / `denied` / `bad_cursor`) + `test/storage/disclosure-cursor.test.ts:108-134`
+ `test/trust-store.test.ts:425-480` (peerHasChain row-count
independence). Empirical bench at `docs/perf/2026-05-10-disclosure-endpoint.md`
records delta = 0.060 ms inside workerd's 1ms quantization floor.

**§9.4.b REMAINS CLOSED.** No response-shape, header, or pagination
side-channel surfaced that the bench misses.

### Vectors checked and cleared (oracle-friend audit trail)

For the next cycle's reviewer:

- **Disclosure response-size leak.** Constant 256-byte body via
  `constantTimeErrorResponse`. Cleared.
- **Disclosure header leak.** Fixed three-header set on 404. Cleared.
- **Disclosure pagination past-end-of-chain oracle.** `from_seq = N`
  past chain end falls through to the same 404 as no-peer
  (`src/routes/disclosure.ts:251-253`). Cleared.
- **Disclosure auth-fail vs no-peer.** Lease gate's `rejectReason`
  merges into the constant-time path after `peerHasChain` runs on
  every branch. Cleared.
- **Disclosure bad-cursor vs no-peer.** Same `rejectReason` merge.
  Cleared.
- **`peerHasChain` row-count proportionality.** Two `SELECT 1 ... LIMIT 1`
  queries; SQLite short-circuits. Constant RPC marshaling cost. Cleared.
- **Vault response body credential leak across 403 path.** `buildErrorResponse`
  suppresses `_cred`; pinned by `test/vault-store.test.ts:115-138`.
  Cleared.

**Related:**
- ADR-0020 — adversarial-team charter
- `docs/security/adversarial-cycles/2026-05-12.md` — cycle 1 + cycle 2 + oracle-friend cycle report
- Beads: `cloister-aa9376` (16.1), parent `cloister-1f249f`


## 17. Nono swap supply-chain expansion (2026-05-13 cycle)

Inline (not weekly-cadence) adversarial cycle gated the merge of
`cloister-2a0faa`. The initial commit swapped `keyring = "3"` for
`nono = "0.54"` for unified scheme dispatch. Six specialists dispatched
in parallel surfaced 17 findings across 5 cross-cuts; the cycle's
heaviest finding (supply-chain expansion, §17.1) escalated to a
follow-up that **feature-gated the heavy backends** under
`host-extras`. Default `host` deploys now bind directly to
`keyring = "3"` for `keychain://` / `secret-tool://` / `keyring://`
and avoid the sigstore-verify / aws-lc-rs / landlock closure. Operators
who need `op://` (1Password) or `apple-password://` integration opt in
via `--features host,host-extras`. Full cycle artifact:
`docs/security/adversarial-cycles/2026-05-13-nono-swap.md`.

### Row 17.1 — Supply-chain expansion via sigstore-verify / aws-lc-rs / landlock (CLOSED this cycle — feature-gated under host-extras)

| | |
|---|---|
| **Adversary capability** | Compromise of any of 12+ transitive crates that become reachable from `leyline-sign-helper` when nono is in the dep graph: sigstore-verify, sigstore-trust-root, sigstore-crypto, sigstore-rekor, sigstore-bundle, sigstore-tsa, sigstore-merkle, sigstore-types, aws-lc-rs (+ aws-lc-sys bindgen C), rustls-webpki, x509-cert, landlock. |
| **Invariant** | ADR-0019 §"Implementation pins" must enumerate the transitive trust base. Operators MUST be able to deploy without the heavy closure when they don't need 1P / Apple Passwords. |
| **Status** | **CLOSED — feature-gated.** Cargo features split into `host` (baseline: keychain/secret-tool/keyring/file via direct `keyring = "3"`; no nono in the dep graph) and `host-extras` (additive: adds nono + enables `op://` / `apple-password://` schemes). Default `host` deploys have ~245 lines in `cargo tree`; opt-in `host,host-extras` deploys have ~559 lines. The sigstore-verify / aws-lc-rs / landlock closure is reachable ONLY when an operator explicitly opts in. The 1Password / Apple Passwords schemes (which need nono's URI validators) cfg out cleanly without affecting the wire shape or any other scheme. **Defense-in-depth:** `task rs:audit` Taskfile target added (`cargo audit --deny warnings` + `cargo deny check` against `rs/deny.toml`); folded into `task verify` (strict CI gate). Long-tail attestation tracked by `cloister-8df072`. **Linux build env:** the `host` feature's `keyring` dep activates `sync-secret-service` on `cfg(target_os = "linux")`, which transitively links libdbus-sys → requires `libdbus-1-dev` + `pkg-config` at build time. CI (`.github/workflows/ci.yml` lint + verify jobs) installs both. macOS uses `apple-native` (Security framework) and has no system-package prereq. |
| **Detection** | CI fails on new advisory against any reachable crate; PR review surfaces any new `dep:` line added to the `host` feature (vs. `host-extras`) because that's the gate operators rely on. |
| **Recovery** | If a CVE drops against a host-extras-only crate, operators can rebuild with default `host` only and lose 1P/Apple Passwords integration until the upstream is patched. |
| **Closing playbook** | Done. Run `task rs:audit` in CI on every PR; quarterly `cargo-vet`-style attestation via `cloister-8df072`. Future schemes that need a fat dep should land under a similar opt-in feature, never under default `host`. |
| **Tracking** | `cloister-2a0faa` (this commit) + `cloister-8df072` (long-tail attestation). |

### Row 17.2 — POST /sign has no per-caller URL allow-list (CLOSED this cycle)

| | |
|---|---|
| **Adversary capability** | A bearer-token holder (e.g., compromised `caller_name=router`) sends `POST /sign {url: "op://attacker-vault/their-key/field", payload_b64: "..."}`. Helper resolves the URL through nono, dispatches to subprocess (or via PATH-hijack if 17.3 also open) and signs the caller's payload under attacker-supplied bytes. Defeats ADR-0019's "signing-key bytes never leave the helper" load-bearing premise. |
| **Invariant** | `/sign` MUST consult a per-caller URL allow-list. Default deny-all when `--require-sign-allow` is set. Mirror of `/resolve`'s `LEYLINE_SIGN_RESOLVE_ALLOW` discipline. |
| **Status** | **CLOSED** — `host::allowlist::SignAllowList` + `LEYLINE_SIGN_SIGN_ALLOW` env var + `--require-sign-allow` flag + adversarial test `sign_must_reject_url_not_in_allow_list`. Per-caller binding enforced (`sign_allow_is_per_caller_not_global`). |
| **Detection** | Adversarial test pin; supervisor template requires both `--require-auth` AND `--require-sign-allow`. |
| **Closing playbook** | Done on `fix/cloister-2a0faa`. |
| **Tracking** | `cloister-2a0faa` (closed). |

### Row 17.3 — `op` / `security` shell-out via $PATH (CLOSED this cycle)

| | |
|---|---|
| **Adversary capability** | An attacker with same-UID filesystem write drops `~/bin/op` (or any path that precedes `/usr/local/bin` in the helper's `PATH`). Nono's `Command::new("op")` uses Rust's `$PATH` lookup; the hostile `op` shim receives the URI as argv, returns 32 attacker-chosen bytes, helper signs with them. Same for `security` on macOS. |
| **Invariant** | `op://` and `apple-password://` schemes MUST use an operator-pinned absolute path to the CLI binary. Subprocess env MUST be `env_clear`-ed with an explicit allow-list (HOME, OP_SERVICE_ACCOUNT_TOKEN, OP_SESSION_*, OP_ACCOUNT, OP_DEVICE for `op`; HOME only for `security`). |
| **Status** | **CLOSED** — `keystore::read_op_bytes` / `read_apple_password_bytes` bypass nono's `Command::new("op")` bare-name lookup; require `LEYLINE_SIGN_OP_BIN` / `LEYLINE_SIGN_SECURITY_BIN` env to be set to an absolute path to an extant file. Refuses with 404 (constant-time) otherwise. Env is `env_clear`-ed; minimal PATH (`/usr/bin:/bin:/usr/local/bin`) + allow-list var inheritance. Subprocess wall-clock cap 4500ms (under helper's 5s SIGN_TIMEOUT). |
| **Detection** | Startup info log surfaces whether each scheme has a usable pinned binary; supervisor unit pin can be grepped. |
| **Closing playbook** | Done. Note: nono upstream issue filed (`cloister-nono-upstream-env-clear`) requesting an `env_clear` API at the nono dispatch layer so other consumers benefit. |
| **Tracking** | `cloister-2a0faa` (closed) + `cloister-nono-upstream-env-clear` (follow-up). |

### Row 17.4 — Toolchain pin not enforced in CI (CLOSED this cycle)

| | |
|---|---|
| **Adversary capability** | A PR deletes `rs/rust-toolchain.toml` or bumps `channel`; CI's `dtolnay/rust-toolchain@stable` silently falls back. Reproducible-build provenance breaks. |
| **Invariant** | The pinned toolchain in `rs/rust-toolchain.toml` MUST match the documented version in ADR-0019. CI MUST refuse to build if the file is missing or its channel diverges. |
| **Status** | **CLOSED** — `task rs:audit` Taskfile target asserts the channel pin via grep. Folded into `task verify`. CI step pins `dtolnay/rust-toolchain` to the documented version explicitly. |
| **Closing playbook** | Done. Future: `cargo-vet` integration tracked under `cloister-8df072`. |
| **Tracking** | `cloister-2a0faa` (closed). |

### Row 17.5 — `?decode=` query-string passthrough on signing schemes (CLOSED this cycle)

| | |
|---|---|
| **Adversary capability** | Cloister's prior `parse_spec` passed `?decode=go-keyring` and any future `?decode=*` value verbatim into nono's `keyring://` dispatcher, which invokes `apply_keyring_decode` → reaches `nono::trust::base64::base64_decode` → entry point to nono's trust module (which links sigstore-verify et al). Compounds with 17.1 (supply-chain expansion). Also creates a latent kid-aliasing surface (replay F1). |
| **Invariant** | Signing-scheme URIs MUST NOT contain query strings or fragments. `parse_spec` rejects at the cloister boundary. |
| **Status** | **CLOSED** — `parse_spec` rejects `?` and `#` for all schemes with `BadRequest`. Tests: `parse_spec_rejects_query_strings`, `parse_spec_rejects_fragments`, `sign_rejects_url_with_query_string`. |
| **Closing playbook** | Done. |
| **Tracking** | `cloister-2a0faa` (closed). |

### Row 17.6 — Blocking nono call pins tokio worker threads (CLOSED this cycle)

| | |
|---|---|
| **Adversary capability** | N+1 concurrent `POST /sign` against `op://` (or any nono subprocess scheme), where N = `2 * num_cpus` (default tokio worker count). Each request: synchronous `nono::keystore::load_secret_by_ref` runs on a tokio worker, `wait_with_timeout` uses blocking `std::thread::sleep(100ms)` polling for up to 30s. Axum's 5s outer timeout abandons the future but doesn't yield the thread. Worker threads stay pinned 30s; orphaned subprocesses accumulate. Effective DoS using legal token-bucket allotment. |
| **Invariant** | `/sign` (and `/resolve`) keystore dispatch MUST run on the spawn_blocking pool, not the tokio worker pool. Subprocess wall-clock MUST be capped under helper's `SIGN_TIMEOUT` and the child killed on timeout. |
| **Status** | **CLOSED** — `keystore::resolve_bytes` is `async fn`; wraps `resolve_bytes_blocking` in `tokio::task::spawn_blocking`. Custom `run_subprocess_with_trim` uses `SUBPROCESS_TIMEOUT = 4500ms` and kills the child on timeout (vs. nono's internal 30s which we bypass). Adversarial test `keystore_call_does_not_pin_worker_threads` pins the invariant. |
| **Closing playbook** | Done. Long-tail recommendation in cycle synthesis: add `clippy::await_holding_lock` + custom blocking-on-tokio lints. |
| **Tracking** | `cloister-2a0faa` (closed). |

### Row 17.7 — Concurrent same-URL keystore reads (CLOSED for coalescing this cycle; TTL-cache FOLLOW-UP)

| | |
|---|---|
| **Adversary capability** | N concurrent `/sign` or `/resolve` against the same URL (any backend: `keychain://`, `apple-password://`, `op://`, `keyring://`). Each request spawns an independent keystore read. macOS `securityd` re-evaluates per-thread authorization on parallel access, causing some callers to hang (real keychain dogfood observed 4 concurrent /resolve hanging indefinitely). For `apple-password://` specifically: FaceID prompt fires per call. Effective DoS via legal traffic volume. |
| **Invariant** | Concurrent requests for the same URL MUST coalesce into one in-flight keystore read (singleflight). All callers share the result, success or failure. |
| **Status** | **FULLY CLOSED.** `keystore::resolve_bytes` uses a `ResolveCache` built on `tokio::sync::watch::channel` + `std::sync::Mutex<HashMap/VecDeque>` that combines (a) singleflight (concurrent same-spec readers all subscribe to the leader's `watch::Receiver`; leader cancellation drops the sender → followers see `Err(_)` and bail with `HelperError::Internal`, no panic) and (b) TTL caching (cache the result for `LEYLINE_SIGN_RESOLVE_TTL_MS` ms, default 60s for `op://` / `apple-password://`, 0s for cheap-read schemes). Cache is FIFO-bounded by `LEYLINE_SIGN_RESOLVE_CACHE_MAX` (default 1024). Pinned by `keystore::tests::resolve_with_coalesces_concurrent_same_spec_to_one_work_call` (AtomicUsize call-count assertion), `resolve_with_leader_cancellation_bails_followers_without_panic`, `resolve_cache_bounded_under_unique_spec_flood`, plus the HTTP-layer `concurrent_resolve_for_same_spec_smoke` + `resolve_ttl_cache_serves_cached_bytes_within_window`. Real-keychain dogfood: 8 concurrent /resolve against one Keychain entry completes in 5.18s (dominated by ONE Touch ID prompt — all 8 callers coalesced + got byte-identical bytes). |
| **Closing playbook** | Done. ADR-0019 amended with the "Subprocess-scheme TTL cache amendment" section documenting the rotation-latency trade-off; PR #2 (`cloister-d95f0d`, `cloister-d9a3c6`) rewrote the cache to close the leader-cancellation panic risk + bound the cache under unique-spec flood. |
| **Tracking** | `cloister-8d4dd7` (CLOSED) + `cloister-d95f0d` + `cloister-d9a3c6` (CLOSED via PR #2 2026-05-13). |

### Row 17.8 — Keychain daemon serialization (CLOSED via opt-in cache)

| | |
|---|---|
| **Adversary capability** | At rate-limit ceiling (1000 sigs/sec per caller × 2 callers = 2000 req/sec), macOS `securityd` IPC becomes the bottleneck (~500-1000 req/sec ceiling per the keyring crate's bench data). The §15.3 per-caller rate-limit holds at the token-bucket layer but is bottlenecked downstream. |
| **Invariant** | Per-caller rate-limit MUST be meaningful, not bottlenecked on a shared resource that re-introduces global serialization. |
| **Status** | **CLOSED (operator-opt-in mitigation).** ADR-0019 amended with §"Subprocess-scheme TTL cache amendment". For `keychain://`/`secret-tool://`/`keyring://` (the schemes that hit `securityd`), the **default** policy remains "re-read every call" (TTL=0) to preserve zero-latency rotation detection. Operators who hit the `securityd` ceiling can set `LEYLINE_SIGN_RESOLVE_TTL_MS=<ms>` to cache reads across all schemes uniformly — this trades rotation latency (≤TTL) for `securityd` throughput. The mechanism is implemented + tested (see §17.7 close); §17.8 is closed in the sense that the mitigation now EXISTS and is configurable, not that the default behavior changed. |
| **Closing playbook** | Done. Operators wanting `securityd` throughput beyond the bench ceiling set the env var explicitly with a documented rotation-latency budget. |
| **Tracking** | `cloister-8d675a` (CLOSED). |

### Row 17.9 — /resolve allow-list iteration before rate-limit (CLOSED this cycle)

| | |
|---|---|
| **Adversary capability** | A 64 KiB URL in `?url=...` triggers `state.resolve_allow.iter().any(|p| q.url.starts_with(p))` — O(N · prefix_len) per probe before the rate-limit check fires. Cost amplification. |
| **Invariant** | Cheap rejects (rate-limit) before expensive checks (allow-list iteration). |
| **Status** | **CLOSED** — `get_resolve` reordered: auth → rate-limit → allow-list → keystore. |
| **Tracking** | `cloister-2a0faa` (closed). |

### Row 17.10 — Wire collapse to 404 across keystore failure shapes (CLOSED this cycle)

| | |
|---|---|
| **Adversary capability** | An attacker probing `keychain://victim-vault-kek-1` vs `keychain://does-not-exist-9999` could distinguish "present-but-locked" (503 `keystore_locked`) from "absent" (404 `not_found`) from "malformed URI" (400 `bad_request`). One bit per probe → full service-name enumeration in linear time. Compounded by nono's `tracing::debug!` leakage of redacted-but-correlatable URIs under `RUST_LOG=debug`. |
| **Invariant** | All keystore-side failures MUST produce the byte-identical 404 body per §9.4. Diagnostic detail goes to tracing, not the wire. nono's `tracing::debug!` lines MUST be filtered to INFO so operator log pipelines don't inherit nono's URI leakage. |
| **Status** | **CLOSED** — `classify_nono_err` collapses `SecretNotFound`, `KeystoreAccess`, `ConfigParse`, and `_` all to `HelperError::NotFound`. `map_nono_err_logged` emits a `warn`-level diagnostic with the outcome label + nono's already-redacted error string before the wire collapse. `host::keystore::tests::classify_nono_err_collapses_to_not_found` + `nono_dispatch_collapses_to_constant_time_404` integration test pin the invariant. `init_tracing` adds `nono::keystore=info` + `nono=info` directives unconditionally (oracle F4). |
| **Closing playbook** | Done. |
| **Tracking** | `cloister-2a0faa` (closed). |

### Row 17.11 — /healthz deep probe missing + unauthenticated platform leak (FOLLOW-UP)

| | |
|---|---|
| **Adversary capability** | `/healthz` returns 200 ok=true if the Worker boots, regardless of whether nono can actually reach `op` / `security` / keychain. Decouples liveness signal from user-visible behavior. Separately: `/healthz` is unauthenticated and exposes the `platform` field, narrowing scheme-probe targeting. |
| **Invariant** | `/healthz?deep=1` must exercise the load-bearing keystore path. `/healthz` (liveness) MUST NOT leak OS family to unauthenticated callers. |
| **Status** | **ACTIVE follow-up bead `cloister-8d933d`.** Cycle synthesis chose not to land deep-probe inline because the design needs a probe-URL convention (must not signal scheme existence to unauthenticated callers) and operator pre-seeding ergonomics. |
| **Closing playbook** | (a) `GET /healthz?deep=1` runs a synthetic resolve against `LEYLINE_SIGN_HEALTHZ_PROBE_URL`; returns `ok=false` + per-scheme status object on failure. (b) Auth-gate `/healthz` (or strip the `platform` field) when `AuthConfig::Required`. |
| **Tracking** | `cloister-8d933d`. |

### Row 17.12 — caller_name is rate-limit key, not access-control principal (DOC-ONLY)

| | |
|---|---|
| **Adversary capability** | An operator misreads the per-caller rate-limit + per-caller sign-allow-list as a per-tenant access-control fabric. Actually the helper has ONE trust root; both `router` and `notme` callers reach the same keystore. The new `keyring://service/account` explicit form makes the namespace fully caller-controlled, increasing the operator-error surface. |
| **Invariant** | Cloister documents that `caller_name` is a rate-limit + allow-list key, NOT a tenant principal. Per-caller URL pinning (17.2) is the access-control axis. |
| **Status** | **CLOSED (doc-only)** — `host/keystore.rs` module preamble + `host/auth.rs` rustdoc + ADR-0019 §"Trust roots and tenancy" all clarify. |
| **Tracking** | `cloister-2a0faa` (closed). |

### Row 17.13 — Supervisor template hygiene for new schemes (DOC-ONLY)

| | |
|---|---|
| **Adversary capability** | An operator with an old `LEYLINE_SIGN_RESOLVE_ALLOW=keychain://...` allow-list migrates `VAULT_KEK_SOURCE` to the explicit `keyring://com.cloister/...` form. The /resolve gate fails-closed (good), but the operator may then add `keyring://` to the allow-list with insufficient specificity and permit unintended URLs. |
| **Invariant** | Supervisor templates document each scheme's hygiene shape (full prefix down to the service/account, not just the scheme prefix). |
| **Status** | **CLOSED (doc-only)** — `GETTING-STARTED.md` §"For self-host / production" lists the new schemes with concrete example prefixes; supervisor template comments updated in the same commit. |
| **Tracking** | `cloister-2a0faa` (closed). |

### Vectors checked and cleared (audit trail — 2026-05-13 nono swap cycle)

Combined from all six specialists' clear lists. The next reviewer can skip these:

- kid + pubkey determinism through nono — preserved.
- 64-bit kid collision birthday cost — unchanged.
- macOS Keychain prompt blocking — preserved (same `keyring` crate semantics underneath nono).
- `file://` path-traversal + symlink + perm checks — unchanged (cloister keeps its own reader, not routed through nono).
- `trim_trailing_newlines` golden-vector parity with `kek-helper.mjs` — preserved.
- nono module-init side effects — none.
- Argument injection on `op` / `security` shell-out — cleared (we use `args([...])`, no shell; `FORBIDDEN_URI_CHARS` rejects metacharacters; `op read --` ends option parsing).
- wasm32 verifier byte-identity — preserved (sha256 `653eae67e682cb816649c2308d2b4c7819354d710c65e304b3b0d10fe5d120f0`, 305945 bytes).
- Bundle-side service-binding to helper — none present in `cluster.capnp`/`config.capnp`.
- Subprocess output as replay surface — confirmed clean (op + security return trimmed bare secret; nono parses the same way; we kill on timeout so no half-written state).
- Helper restart kid stability — preserved (stateless helper, keystore is source of truth).
- Wire protocol / nonces / leases / epochs / receipt chains — untouched by the swap.
- Per-caller rate-limit independence at token-bucket layer — preserved.
- `/resolve` allow-list applies to all six schemes (not just the original three) — preserved.

**Related:**
- ADR-0020 — adversarial-team charter
- `docs/security/adversarial-cycles/2026-05-13-nono-swap.md` — full cycle report
- `docs/adr/0019-sign-only-helper-protocol.md` — §"Implementation pins" updated for the supply-chain expansion
- Beads: `cloister-2a0faa` (this swap) + `cloister-1f249f` (rotation parent) + follow-ups listed in §17.7 / §17.8 / §17.11

## 18. Credential-isolation production-readiness (2026-05-18 cycle)

Cycle report: `docs/security/adversarial-cycles/2026-05-18.md`.

Four specialists ran in parallel against `main` @ `ae917f2` against
the just-shipped DO saga (PRs #40–#42 + #44 + #47). 31 findings;
synthesis identified three load-bearing cross-cuts (X-1, X-2, X-3)
that broke / eroded three of cred-iso/v1's five master claims (#3
audit-by-receipt FALSE; #4 constant-time-404 eroded; #5 per-bundle
isolation held only by accident of single-bundle deploy).

**All three cross-cuts shipped in this cycle's follow-up PRs:**
PR #50 + #51 + #52 + #53 + #54 + #55 + #56.

### Row 18.1 — X-1: forward path emits zero receipts/metrics/logs (CLOSED this cycle)

**Pre-fix:** `VaultProxyRoute.handle`'s forward branch returned vault
DO's Response verbatim, bypassing the only `ProxyCallReceipt` emit
site. `runtime.ts` also instantiated the route with NO emitters at
all, so even the resolve+inject path was silent. Six emit obligations
collapsed onto a single bypassed return statement.

**Master-claim impact:** #3 ("audit by receipt") was FALSE in
production. Disclosure endpoint returned empty receipt sets for every
peer for every outcome — silence ceased to be evidence, became the
default.

**Closed by:** PR #52 `forwardWithReceipt` shim mirrors
`proxyWithReceipt`'s start-clock + capture-sizes + emit-in-finally
shape. `runtime.ts` wires `consoleReceiptEmitter` + `consoleMetricEmitter`
defaults. PR #53 fails closed on missing `env.VAULT_STORE` binding
(Obs O-OBS-3). PR #54 structured catch-log on RPC throw (Obs O-OBS-4).

**Closed source findings:** Obs O-OBS-1, O-OBS-2, O-OBS-3, O-OBS-4;
Oracle O7; DoS F1 (signal portion only — per-peer denial counter
remains a follow-up design-pass at `cloister-6e6bfb`).

**Conformance test:** `test/routes/vault-proxy.test.ts` § "forwardWithReceipt"
+ § "consoleReceiptEmitter / consoleMetricEmitter" (10 tests).
`test/routes/vault-proxy-route.test.ts` "fails CLOSED" + bundleIdName
defaults tests. `test/routes/vault-do-credential-store.test.ts`
structured catch-log tests.

### Row 18.2 — X-2: error shapes silently encode substrate (CLOSED this cycle)

**Pre-fix:** Three different body shapes + four different status
codes + zero shared header policy across 7 error-emission sites
fractured the constant-time-404 contract. Encoded three secrets onto
the wire: substrate identity (Oracle O1), service-registry
membership (Oracle O4), vault-binding state (Oracle O2 — undocumented
503 `vault_unavailable` shape).

**Master-claim impact:** #4 ("§9.4.b constant-time 404") eroded.
Caching intermediary could amortize any of the three oracles across
millions of probes for zero attacker cost (zero error sites set
`Cache-Control: no-store` despite spec MUST).

**Closed by:** PR #50 `Cache-Control: no-store` + `X-Content-Type-Options:
nosniff` on every error site via shared `errorResponse()` helper.
PR #51 wire-shape collapse at route boundary via `collapseWireShape`:
401/403/404/429 → `CONSTANT_TIME_ERROR_BODY` (Shape R); 502/503 →
`SHAPE_U_ERROR_BODY` (Shape U). Vault DO still emits structured
shapes internally for direct callers; the route boundary rewraps.

**Closed source findings:** Oracle O1, O2, O4, O5; Bundle F2, F5; DoS F4.

**Conformance test:** `test/routes/vault-proxy.test.ts`
§ "errorResponse — required headers" (7 tests) + § "collapseWireShape"
(10 tests). `cloister-spec/credential-isolation/v1/wire/error-responses.md`
rewritten as "Two canonical wire shapes" + "Internal shapes" sections.

### Row 18.3 — X-3: bundleIdName hardcoded defeats per-bundle isolation (CLOSED this cycle)

**Pre-fix:** Literal `bundleIdName: "router"` in `VaultProxyRoute`
(`vault-proxy-route.ts:130`). Any second `vaultProxy` route declared
in the manifest collapsed to the same vault DO instance, defeating
ADR-0021's binding-layer isolation seam AND inheriting the shared
MAX_INFLIGHT cap.

**Master-claim impact:** #5 ("per-bundle isolation via `idFromName`")
held only by accident of single-bundle deploy. Severity escalated to
P1 the moment a second cluster-tier bundle declares a `vaultProxy`
route (e.g. notme-as-bundle per cloister-db99cd).

**Closed by:** PR #55 schema bump — new `VaultProxySpec` struct;
`vaultProxy @11 :Void` → `vaultProxy @11 :VaultProxySpec` with
`bundleIdName @0 :Text` field. `runtime.ts` reads + threads through
to route deps. Empty / unset defaults to `DEFAULT_BUNDLE_ID_NAME =
"router"` for back-compat. PR #56 per-peer sharded inflight cap
(DoS F2) — even within a single bundle, one slow-upstream peer can
no longer deny others.

**Closed source findings:** Bundle F4; DoS F2, F6; Obs O-OBS-7;
Oracle O8.

**Conformance test:** `test/routes/vault-proxy-route.test.ts`
manifest-supplied / empty / omitted bundleIdName paths.
`test/vault-store.test.ts` § "per-peer inflight isolation" (2 tests).

### Cycle close-out

**Master claims status post-cycle:**
- #1 (plaintext never crosses response boundary) — preserved ✓
- #2 (identity-scoped access via allowedSubs) — preserved ✓
- #3 (audit by receipt) — **restored** via X-1 ✓
- #4 (§9.4.b constant-time 404) — **restored** via X-2 ✓
- #5 (per-bundle isolation via idFromName) — **restored at the schema layer** via X-3 (operational when notme-as-bundle ships) ✓

**Remaining open as follow-up:**
- DoS F1 per-peer denial counter — design-pass (`cloister-6e6bfb`
  parent tracker stays open until the storage decision lands)
- DoS F5 lease-verify cache — design-pass (`cloister-6f4284`)

Bundle F1 (manifest `defaultAllowedSubs` gate dead on forward path) —
`cloister-6ed9ae` shipped via commit `3093044` / PR #58. The gate now
fires at the route boundary (`src/routes/vault-proxy-route.ts:229-244`)
for BOTH the resolve+inject branch AND the forward branch.

**Related:**
- Cycle report: `docs/security/adversarial-cycles/2026-05-18.md`
- ADR-0020 — adversarial-team charter
- ADRs touched: ADR-0013 (slice-grant), ADR-0021 (per-bundle vault DO),
  ADR-0024 (cred-iso capability)
- Beads (closed this cycle): `cloister-6eba0a`, `cloister-6e888b`,
  `cloister-6f06cc`, `cloister-6f21dc`, `cloister-6ed9ae` (Bundle F1
  forward-path gate)
- Beads (open follow-ups): `cloister-6e6bfb` (X-1 tracker — DoS F1
  counter), `cloister-6f4284` (DoS F5 lease-verify cache design-pass)
