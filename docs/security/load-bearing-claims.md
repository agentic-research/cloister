# Load-bearing claims (and how they're defended)

The security properties cloister publishes are defended by running
code + tests + cross-implementation byte-equality, not just stated
in ADRs. README's "Load-bearing claims" table summarizes these as
one-line claims; this file holds the long-form versions with the
status, scope, and test pointers.

The gate at [`threat-model.md`](threat-model.md) §11 is where
test-vs-claim accounting lives. Anything in `threat-model.md` is
under-test; anything not in `threat-model.md` is not defended.

---

## §13.2 — "Silence is evidence" (chain-completeness)

**Claim.** Every authenticated request advances a hash-chained counter
in TrustStore; every state-boundary write advances a per-peer
attestation chain. A third party with the master pubkey can verify the
chain offline; a missing row indicates the actor admitted the request
off-record.

### Status today

The property holds **in two halves with different load-bearing posture:**

- **Request side** — non-repudiable as of `interlace-spec 0.1.0`.
  Peer P signs the canonical request bytes under its lease cert; the
  TrustStore stores the signature alongside the counter. A third-party
  auditor reading the chain can verify each row's sig against the
  pinned master pubkey offline.

- **Response side** — load-bearing **only at Phase 2 cutover** of
  `interlace-spec 0.2.0`. TLS provides no post-session non-repudiation
  on application records, so without receipts a peer cannot
  mathematically prove to a third-party auditor that the actor
  returned 2xx. The 0.2.0 amendment closes this with mandatory signed
  receipts.

### `interlace-spec 0.2.0` receipts (Phase 1 shipped)

**Phase 1 shipped 2026-05-12** (bead `cloister-ae713f`, commit `a0d3fd3`).
Full TypeScript implementation in **emit-but-don't-enforce mode** —
the wire bytes are correct, peers receive receipts, but peers don't
yet refuse responses lacking receipts. `RECEIPT_SIGNING_KEY` unset
(the default) disables emission entirely; tests and dev set it.

Commitment shape: `(request_hash, body_hash, allowlisted_headers,
timestamp_ms, actor_fp, epoch)`. SSE streams use cryptographically-
paired open/close commitments via `open_commitment_hash` — the close
commitment can't be forged with a different scope than the open
advertised. Archival CA-bundle resolution via the
`/interlace/ca-bundle` endpoint lets V-archival verifiers replay
receipts after key rotation. Compromise-notice mechanism (§2.7)
flags receipts signed after a master key is known-compromised.

Spec: [`interlace-spec/0.2.0-draft/RECEIPTS.md`](../../interlace-spec/0.2.0-draft/RECEIPTS.md)
(revised three times per math-friend review). Code:
[`src/wire/receipts.ts`](../../src/wire/receipts.ts) (encode/decode/sign),
[`src/routes/receipt-emitter.ts`](../../src/routes/receipt-emitter.ts) (emit on every authenticated 2xx),
[`src/routes/receipt-stream.ts`](../../src/routes/receipt-stream.ts) (SSE chain pairing),
[`src/routes/ca-bundle.ts`](../../src/routes/ca-bundle.ts) (archival surface).

### Tests defending §13.2

- End-to-end smoke at
  [`test/security/disclosure-attestation-smoke.test.ts`](../../test/security/disclosure-attestation-smoke.test.ts)
  proves `BlobStore.digest == BeadStore.content_hash == peer_attestations.content_hash`
  (cross-DO content-addressed handoff per ADR-0012).
- 104 receipts tests across `test/wire/`, `test/storage/`,
  `test/routes/`, `test/spec/interlace-receipts.test.ts`.
- Lease counter chain pinned by
  [`test/storage/peer-lease-counters.test.ts`](../../test/storage/peer-lease-counters.test.ts);
  seen_nonces replay defense at
  [`test/storage/seen-nonces.test.ts`](../../test/storage/seen-nonces.test.ts).

### Cross-implementation cross-check

The Python reference impl in
[`interlace-spec/0.1.0/ref-impl-py/`](../../interlace-spec/0.1.0/ref-impl-py/)
passes the same 27 conformance vectors as cloister's TypeScript runtime.
0.2.0 conformance vectors are future work.

### Honest caveats

- **The chain-completeness claim becomes load-bearing only at Phase 2
  cutover** (operator flips `RECEIPT_SIGNING_KEY` env + peers
  fail-closed on missing receipts). Phase 1 emits but doesn't enforce,
  so selective-drop attacks remain undetectable in that phase.
- ADR-0021 per-bundle vault DO instances (Proposed not Implemented)
  means cross-bundle vault isolation is paper claim until ADR-0018's
  internal-bundle portion lands. Today only `cloister-router` reaches
  vault, so the single-caller invariant holds.

---

## §9.4.b — Constant-time 404 (disclosure endpoint not a peer-existence oracle)

**Claim.** `GET /interlace/peers/{fp}` cannot be used to enumerate
peers. Auth-fail, bad-cursor, and unknown-peer all return byte-
identical 404s in within-clock-grain time.

### Mechanism

`src/routes/disclosure.ts` routes every 404-emitting branch through:

1. `TrustStore.peerHasChain` — a `SELECT 1 ... LIMIT 1` query that
   short-circuits regardless of the chain's row count. Constant
   marshaling cost (boolean) regardless of payload.
2. `constantTimeErrorResponse` — fixed 256-byte response body,
   three-header set (`content-type`, `cache-control`, `content-length`).
   No padding placeholders; the byte-identity is structural.

### Pinned by

- [`test/routes/disclosure.test.ts:312-368`](../../test/routes/disclosure.test.ts) —
  byte-identity across `not_found` / `denied` / `bad_cursor`.
- [`test/storage/disclosure-cursor.test.ts:108-134`](../../test/storage/disclosure-cursor.test.ts) —
  status + body-text equality.
- [`test/trust-store.test.ts:425-480`](../../test/trust-store.test.ts) —
  `peerHasChain` constant-shape contract.
- [`docs/perf/2026-05-10-disclosure-endpoint.md`](../perf/2026-05-10-disclosure-endpoint.md) —
  empirical bench. Pre-fix delta was **17× across paths**; post-fix is
  **0.060 ms**, inside workerd's `performance.now()` quantization floor.

**§9.4.b status: CLOSED** (verified again 2026-05-12 by oracle-friend
adversarial cycle; see threat-model §16).

---

## ADR-0013 — Slice-grant via V8 isolate + service-binding-as-syscall

**Claim.** A compromised tool bundle cannot exfiltrate credentials
outside its `allowedSubs`. Plaintext credential bytes never cross the
RPC boundary.

### Mechanism

- **V8 isolate** sandbox: each bundle runs in its own isolate; no
  shared memory, no syscall access except via declared service
  bindings.
- **Service-binding-as-syscall**: the only way a bundle reaches state
  or upstream is via a binding declared in `cluster.capnp` /
  `config.capnp`. The manifest is the access-control list.
- **`CredentialVault` DO** holds credentials envelope-encrypted
  (HKDF + AES-256-GCM). The DO's `proxyRequest` RPC decrypts inside
  the DO, performs the upstream fetch, returns the response. The
  decrypted bytes never leave the DO; the bundle never sees them.
- Per-credential `allowedSubs` glob list filters against the caller's
  identity; mismatched callers get rejected before the decrypt.

### Pinned by

- [`test/security/prompt-injection.test.ts`](../../test/security/prompt-injection.test.ts) —
  19 cases including glob-boundary edge cases, sealed-at-rest
  verification, cross-slice denial without leak.
- [`vault/src/__tests__/vault-adversarial.test.ts`](../../vault/src/__tests__/vault-adversarial.test.ts) —
  9 attack scenarios including header-extraction probes, error-
  message leaks, credential-payload DoS (§15.6).
- Bundle-isolation lint at
  [`scripts/lint-bundle-isolation.mjs`](../../scripts/lint-bundle-isolation.mjs) —
  5 substrate-property invariants on `cluster.capnp` + `config.capnp`.

### Honest caveats

- **Vault is currently singleton-per-cluster** (`idFromName("cluster")`).
  ADR-0013's per-bundle-DO design is documented but not implemented;
  ADR-0021 ratifies that implementation. Today the single-caller
  invariant (only cloister-router reaches vault) is what makes the
  enforcement load-bearing.
- **Vault 403/404 enumeration oracle** (DORMANT today, P1 when bundles
  ship): threat-model §16.1, bead `cloister-aa9376`. Closing playbook =
  collapse 403→404 mirroring §9.4.b's disclosure playbook.

---

## Substrate overhead bounded + measured

**Claim.** The lease pipeline is <1 ms p50 / 1 ms p99 / 3 ms p99
(post-batching). 85% of cost is DO RPCs; crypto is cheap.

### Bench-pinned

- [`docs/perf/2026-05-10-lease-pipeline.md`](../perf/2026-05-10-lease-pipeline.md) —
  lease pipeline microbench.
- Reproducible via [`test/perf/lease-pipeline.test.ts`](../../test/perf/lease-pipeline.test.ts)
  (opt-in: `task bench:lease`).
- Five surface benches total: lease, dispatch, TrustStore contention,
  disclosure endpoint, cold start. See
  [`docs/perf/README.md`](../perf/README.md).

### Honest caveats

- Benches run on local workerd; CF prod has different RTT
  characteristics. The 1ms p99 figure is the substrate's processing
  cost, NOT the wire-to-response budget for a real client.
- DO RPC cost dominates; ADR-0007 §13 batches counter+sig writes to
  amortize.

---

## Trust-anchor-helper attack surface (threat-model §15 + §15.A)

The `leyline-sign-helper` Rust binary (ADR-0019, merged 2026-05-12)
holds the substrate's master signing key. Threat-model §15 documents
the attack surface in 7 rows. trust-root-friend's two adversarial
cycles on 2026-05-12 closed 5 of the 7 code-side:

- §15.1 `/resolve` allow-list gate
- §15.2 bearer-token auth (`LEYLINE_SIGN_CALLER_TOKENS`)
- §15.3 per-caller rate-limit (independent buckets per token)
- §15.5 strict Content-Type rejection (closes CSRF simple-POST)
- §15.6 `RequestBodyLimitLayer` (closes no-Content-Length bypass)
- §15.7 `ed25519-dalek` tilde-pin (matches ADR-0019 declaration)

§15.4 (supervisor binary integrity) deferred to phase-D binary
attestation. NEW-1 from the cycle-2 verification (supervisor templates
were dropping operators into `AuthConfig::Disabled`) closed via
`--require-auth` fail-stop flag + EnvironmentFile wiring.

Adversarial-test surface: [`rs/crates/sign/tests/host_adversarial.rs`](../../rs/crates/sign/tests/host_adversarial.rs) —
5 tests, all green, gated into `task lint` via `rs:sign:host`.

---

## How to verify these claims yourself

1. **Read the threat model:** [`threat-model.md`](threat-model.md). Every
   load-bearing claim has a row with status, test pointer, and bead.
2. **Run the tests:** `task lint` exercises the full unit + integration
   surface (953 tests). `task verify` adds substrate-equivalence + smoke.
3. **Read the adversarial cycle reports:** [`adversarial-cycles/`](adversarial-cycles/).
   Per-cycle findings + verification verdicts from the 7-role rotation
   (ADR-0020).
4. **Run the helper end-to-end:** see [`docs/launch/PRE-LAUNCH-VERIFICATION.md`](../archive/launch/PRE-LAUNCH-VERIFICATION.md)
   for the curl-demonstrable invariants on the trust-anchor-helper.
5. **Cross-implementation byte-equality:** the Python reference impl
   in `interlace-spec/0.1.0/ref-impl-py/` shares 27 test vectors with
   cloister's TypeScript runtime. Both must pass; drift is a CI failure.
