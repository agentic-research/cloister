# interlace-spec 0.2.0 amendment: Signed Receipts (closes §13.2 non-repudiation gap)

> **Status**: Draft, revised per math-friend review 2026-05-11
> (see bead `cloister-ae713f` for the full adversarial analysis).
> **Target version**: interlace-spec 0.2.0 (breaking change from 0.1.0).
> **Tracking bead**: `cloister-ae713f`.

## 1. Background

interlace-spec/0.1.0 §13.2 claims:

> If peer P interacted with actor A and P's request was admitted (any
> HTTP 2xx from A), then P's chain MUST contain an entry. If P later
> queries and finds no such entry, that absence is cryptographic proof
> A admitted the request off-record.

This claim does not hold under standard TLS, because TLS provides no
post-session non-repudiation on application records — the symmetric
AEAD keys derived from the handshake are held by both endpoints, so
either side can synthesize transcripts post-session.

Note an asymmetry the original §13.2 framing obscured: in 0.1.0, the
**request side** is already non-repudiable. Per
[`wire/lease-envelope.md`](../0.1.0/wire/lease-envelope.md), P signs
`(method, url, ts, nonce, body)` under Ed25519 with its lease cert
(Signet-issued, chain-resolvable). Actor A can therefore prove to V
that P sent the request. The gap is purely the **response side**:
nothing in 0.1.0 binds A's response bytes to A's long-term key, so P
cannot prove to V that A returned 2xx. This amendment closes the
response-side gap so the full bidirectional §13.2 claim becomes
mathematically defensible.

The detailed adversarial argument is in
[`PROBLEM-STATEMENT-NON-REPUDIATION.md`](PROBLEM-STATEMENT-NON-REPUDIATION.md).

## 2. Specification (proposed normative text for §13.5)

### 2.1 Receipt construction

When Actor A returns an HTTP 2xx status code to Peer P in response to
an authenticated interlace request, A **MUST** include an
`Interlace-Receipt` header in the response. (Header name follows
RFC 6648; the `X-` prefix has been deprecated for over a decade and
we don't reintroduce it.)

The receipt commits to the *full* request and the consumer-visible
response surface — not just the body. Math-friend review identified
that committing to body alone leaves `content-type`, `content-encoding`,
`location`, etc. unattested, which retains repudiation latitude on
parts of the response that materially change consumer behavior.

```
# Inputs available at receipt-emission time
request_canon       := canonical bytes per wire/lease-envelope.md §3.2
                       (method LF url LF ts LF nonce_b64 LF body)
response_body_bytes := the bytes A returns as response body (empty for 204)
response_headers    := A's response header map

# Allowlisted response headers committed by the receipt (lowercase names,
# sorted bytewise lexicographic, length-prefixed canonical encoding).
# Headers not in this list are NOT attested; A can rewrite them at will.
HEADER_ALLOWLIST := [
  "content-type",
  "content-encoding",
  "content-language",
  "cache-control",
  "location",
  "link",
  "www-authenticate",
  "retry-after",
]

headers_canon := canonical_cbor(map_sorted({
  h: <bytes; the value of header `h` in A's response>
  for h in HEADER_ALLOWLIST
  if h in response_headers
}))

# Commitment CBOR
commitment_cbor = canonical_cbor({
  "nonce":         <bytes-16+; request nonce from P's lease envelope>,
  "request_hash":  <bytes-32; SHA-256(request_canon)>,
  "status":        <uint; HTTP status code, 200..299>,
  "body_hash":     <bytes-32; SHA-256(response_body_bytes), SHA-256("") if empty>,
  "headers_hash":  <bytes-32; SHA-256(headers_canon)>,
  "timestamp_ms":  <uint; unix milliseconds at admission>,
  "actor_fp":      <bytes-32; SHA-256 of A's master pubkey>,
  "epoch":         <uint; A's current key epoch from .well-known/interlace/index.json>,
})

signature = Ed25519_Sign(A.master_sk, commitment_cbor)

receipt_envelope = canonical_cbor({
  "commitment": commitment_cbor,
  "signature":  signature,
})

Interlace-Receipt: <base64url(receipt_envelope)>
```

Where `canonical_cbor()` follows RFC 8949 §4.2 Core Deterministic
Encoding (definite-length maps + arrays, keys sorted by bytewise
lexicographic order over the serialized key, shortest length form for
integers, no NaN, no -0.0, no indefinite-length). See §3.1 for
canonicalization landmines that implementations must avoid.

The `request_hash` makes the receipt-to-request binding cryptographic
rather than implicit. V verifying a receipt presented by P
**MUST** independently compute SHA-256(P's request_canon) and compare;
a receipt whose `request_hash` does not match the request P claims it
covers is invalid and **MUST** be rejected.

The `actor_fp` field is intentionally redundant with the
epoch-resolved pubkey verification in §2.2. It provides cross-actor
disambiguation when V holds receipts from multiple actors and bounds
the receipt's claim to a specific master identity even before pubkey
resolution.

### 2.2 Receipt verification — split by audience

The verification procedure differs for live verification (P at receive
time) and historical audit (V at audit time). Both procedures use the
same primitive cryptography but differ in their tolerance for key
rotation.

#### 2.2.1 P live verification (at response receipt)

Peer P **MUST** verify each received receipt before treating the
response as admitted:

1. Decode the base64url header value into bytes.
2. Parse as CBOR; reject if not a valid map with exactly the keys
   `{"commitment", "signature"}`.
3. Parse `commitment` as CBOR with the keys named in §2.1.
4. Verify `nonce` matches the nonce P sent in the request's lease
   envelope. (Mismatch ⇒ reject.)
5. Verify `request_hash` matches SHA-256(P's outgoing request_canon).
   (Mismatch ⇒ reject; this also catches URL-canonicalization drift —
   see §5.)
6. Verify `actor_fp` matches the fingerprint P pinned for A.
7. Verify `epoch` matches the current epoch in A's
   `.well-known/interlace/index.json` **or** the immediately previous
   epoch (tolerance window for in-flight rotation).
8. Fetch A's pubkey for the named epoch from the current CA bundle.
9. Verify `Ed25519_Verify(pubkey, commitment_cbor, signature)`.
10. Verify `body_hash` matches `SHA-256(observed_response_body_bytes)`.
11. Verify `headers_hash` matches `SHA-256(canonical headers from
    A's actual response, restricted to HEADER_ALLOWLIST)`.
12. Verify `timestamp_ms` is within ±300s of P's clock (clock-skew
    bound per 0.1.0 §6.2.7).

A receipt that fails any step **MUST** be rejected; P **MUST** treat
the response as if A returned 5xx (because A did not provide
non-repudiable admission).

#### 2.2.2 V historical audit (at arbitrary later time T)

Auditor V receiving a receipt + claimed request at time T:

1. Steps 1–6 and 9–12 of §2.2.1 (skip step 7 — the current/previous
   epoch tolerance does not apply at audit time).
2. **Step 7 (audit form)**: resolve the pubkey for the receipt's
   `epoch` from the **archival** CA bundle (see §2.3). Audit may
   succeed against a long-retired epoch as long as the bundle still
   serves the historical pubkey.
3. Fetch A's disclosure chain $D_A$ at time T.
4. Search $D_A$ for an entry with the receipt's `nonce`.
5. If no entry is found *and* all preceding checks passed, the receipt
   is proof of off-record admission per §2.5.

Step 2 is the key change from P's procedure. It requires the CA bundle
to remain resolvable for past epochs indefinitely (§2.3); without
that, A can defeat audits by aggressive key rotation.

### 2.3 Archival CA bundle requirement

Actor A's `.well-known/interlace/index.json` **MUST** retain entries
for all retired epochs, each marked with `status: "retired"` and the
retirement timestamp. The current-epoch entry is marked
`status: "active"`. Historical pubkeys remain resolvable by epoch
number until A's CA bundle is decommissioned entirely.

A **MAY** archive retired entries to a separate
`.well-known/interlace/archive.json` for size management, provided
`index.json` continues to enumerate at least the active and
immediately-previous epochs and the archive endpoint is referenced
from `index.json`.

A **MUST NOT** delete retired entries while any receipt signed under
that epoch could plausibly still be in audit. A SHOULD retain entries
for at least 7 years (typical compliance horizon); operators with
shorter retention policies SHOULD publish their CA-decommission
timeline in `index.json`.

### 2.4 Streaming / SSE responses

Cloister's MCP face uses Streamable HTTP (`text/event-stream`)
responses. Math-friend review identified that deferring SSE receipt
construction means the receipt mechanism does not cover the substrate's
primary surface. This subsection makes SSE handling normative.

For a streaming response, A constructs a **stream commitment chain**:

```
# At stream open: A signs an initial commitment to the stream identity.
stream_open_commitment = canonical_cbor({
  "nonce":         <bytes; from request envelope>,
  "request_hash":  <bytes-32; SHA-256(request_canon)>,
  "status":        200,
  "stream_mode":   "sse" | "ndjson",
  "stream_id":     <bytes-16; A's per-stream random identifier>,
  "timestamp_ms":  <uint; unix milliseconds at admission>,
  "actor_fp":      <bytes-32>,
  "epoch":         <uint>,
})

stream_open_sig = Ed25519_Sign(A.master_sk, stream_open_commitment)

Interlace-Receipt: <base64url(canonical_cbor({
  "kind":       "stream-open",
  "commitment": stream_open_commitment,
  "signature":  stream_open_sig,
}))>

# For each SSE event A emits, A also emits an event hash anchored to the
# previous link (or stream_open_commitment hash for the first event):
event_hash[n] = SHA-256(canonical_cbor({
  "prev":       <bytes-32; event_hash[n-1] or SHA-256(stream_open_commitment) if n=0>,
  "event_data": <bytes; the event payload bytes>,
  "seq":        <uint; n>,
}))

# At stream close, A signs the final commitment to the full chain:
stream_close_commitment = canonical_cbor({
  "stream_id":     <bytes-16; matches stream_open>,
  "tip_hash":      <bytes-32; event_hash[last]>,
  "event_count":   <uint; n+1>,
  "close_status":  "ok" | "client-disconnect" | "server-shutdown",
  "timestamp_ms":  <uint>,
})

stream_close_sig = Ed25519_Sign(A.master_sk, stream_close_commitment)

# A emits this as a final SSE event before stream close:
event: interlace-stream-close
data: <base64url(canonical_cbor({
  "commitment": stream_close_commitment,
  "signature":  stream_close_sig,
}))>
```

P verifying a stream **MUST** maintain a rolling event_hash as events
arrive, and **MUST** verify the close commitment's `tip_hash` matches
its own computed rolling hash before treating the stream as
non-repudiably admitted. A mid-stream tip-hash mismatch (P's rolling
hash diverges from what A would later sign) indicates A dropped or
tampered with events; P **MUST** treat this as a chain break.

V auditing a stream **MUST** be presented with the stream-open
commitment, the stream-close commitment, and the full event chain. V
verifies both signatures, walks the event chain from `prev` of the
first event to `tip_hash` of the close, and confirms the chain
matches.

The open + close pair is mandatory; per-event signatures are NOT
required (each event's place in the chain is established by the
cryptographic linkage, not by a per-event signature). This keeps the
per-event overhead at one SHA-256 hash chain step rather than a full
Ed25519 sign.

### 2.5 Audit invariant (revised §13.2)

> If peer P holds a valid receipt `receipt(r, resp)` — i.e., a
> signature under A's master key over the canonical commitment to
> request r and the response P observed, satisfying all checks in
> §2.2.1 (P live) or §2.2.2 (V audit) — and A's disclosure chain $D_A$
> at any subsequent time T contains no entry for `nonce(r)`, then with
> overwhelming probability (under EUF-CMA security of Ed25519) A
> admitted r off-record.
>
> For streaming responses, the streams's open commitment is the
> non-repudiable admission; the close commitment plus event chain
> establishes the response content.

### 2.6 Mandatory emission

A's implementation **MUST** emit a valid receipt on every 2xx
authenticated response. Failure to emit (no header, malformed header,
invalid signature, missing required commitment fields, ...) is itself
a spec violation and P **MUST** treat the response as failed.

A **MAY** omit receipts on 4xx/5xx responses (admission did not occur,
nothing to commit to).

A **MAY** omit receipts on unauthenticated endpoints (e.g., `/health`,
`/.well-known/interlace/index.json`, `/.well-known/mcp-registry/*`) —
those operations are public and non-stateful; the §13.2 invariant does
not apply.

Authenticated reads (e.g., authenticated `GET /interlace/peers/<fp>`)
**MUST** still emit receipts — V auditing such reads relies on the
same chain-completeness property.

## 3. Receipt format details

### 3.1 CBOR canonicalization landmines

RFC 8949 §4.2 Core Deterministic Encoding gives byte-stable encoding
**only if** implementations are strict. The following edge cases are
known to break signature-stable encoding across conformant encoders;
test vectors (§7) **MUST** exercise each:

- **Integer key vs text key ordering**. RFC 8949 says sort by bytewise
  lexicographic over the serialized key. `5` (uint, 1 byte) sorts
  before `"5"` (text, 2 bytes), which differs from JSON-style
  alphabetic-then-numeric ordering. Schemas in this spec use only
  text keys to avoid this; future extensions adding integer keys
  must take care.

- **Byte-string vs text-string of the same content**. Major type 2
  (bytes) vs major type 3 (text) are distinct CBOR types. A JSON-style
  encoder that confuses them produces different bytes. All
  hash/signature/nonce fields in this spec are byte strings; all enum
  labels and field names are text strings. Implementations **MUST**
  use the correct major type.

- **Integer canonicalization at boundaries**. uint 0 must be encoded
  as a single 0-byte major-type-0 (1-byte total); 1-byte
  representations of larger values must use the shortest form. RFC
  8949 §4.2.1 is the authoritative reference.

- **Empty container encoding**. Definite-length empty maps and arrays
  have a canonical 1-byte encoding (`0xA0` or `0x80`); indefinite-length
  forms are forbidden under §4.2.

### 3.2 Header naming

The receipt rides on the `Interlace-Receipt` HTTP header. No `X-`
prefix per RFC 6648.

### 3.3 Size cost

Receipt envelope is ~200 bytes raw with the expanded schema; ~270
bytes base64url. Acceptable header overhead. For streaming responses,
the close commitment is ~150 bytes; per-event chain steps are 32
bytes inline.

## 4. Performance

Per-request signing cost: Ed25519 sign is ~50µs on M1. At 1000 QPS
that's 5% of one CPU; at 10000 QPS, 50%. For deployments where
per-request signing is too expensive, see §6 (Merkle-batched receipts)
as a normative-optional alternative.

Verification cost: Ed25519 verify is ~100µs. Hash chain walk for SSE
is O(events) but each step is sub-microsecond.

## 5. Interaction with URL canonicalization (`cloister-aecd26`)

The `request_hash` field is computed by P over P's outgoing
`request_canon`. If reverse proxies rewrite the URL between P and A,
P's hash and A's hash diverge, breaking verification.

This spec mandates that `request_hash` is computed over the **URL P
signed** (pre-rewrite), and that proxies preserve a way for A to
reconstruct the original URL form (e.g., via `X-Forwarded-Uri` or
equivalent — A's deployment is responsible for this).

If A receives a request via a reverse proxy that does not preserve the
original URL, A **MUST** reject the request as
"un-canonicalizable" rather than emit a receipt over the rewritten URL
that P cannot verify. This forces operators to configure URL
preservation correctly, rather than silently producing receipts P
cannot verify.

The interlace-spec 0.2.0 release ratifies this requirement alongside
`cloister-aecd26`'s URL-canonicalization fix.

## 6. Merkle-batched receipts (normative-optional)

Per-request signing scales to ~10k QPS per worker. For deployments
operating above that — and for audit-time consistency guarantees
beyond per-receipt — Merkle-batched receipts are an
**optional-but-normative** alternative. Math-friend review identified
that per-request and batched modes are not strictly comparable; they
trade detection latency for cross-receipt consistency. Both ship.

| Axis | Per-request (§2) | Merkle-batched (§6) |
|---|---|---|
| Detection latency | immediate | up to Δ (batch interval) |
| Audit cost per receipt | 1 Ed25519 verify | 1 verify + log(N) Merkle steps |
| Cross-receipt consistency | none | Merkle-consistency proofs (CT-style log integrity) |
| Schema complexity | smaller | larger (Merkle proof envelope) |
| Signing rate cost | N × 0.05ms | 1 × 0.05ms + tree ops |
| Failure mode if A drops | P sees missing receipt | P sees missing inclusion proof at batch close |

### 6.1 Construction

A maintains an in-memory Merkle tree of unsigned commitments. Every
Δ seconds (operator-configurable; default 60s), A signs the root:

```
root_commitment = canonical_cbor({
  "merkle_root":  <bytes-32; root hash>,
  "epoch":        <uint>,
  "actor_fp":     <bytes-32>,
  "batch_id":     <bytes-16; A's per-batch identifier>,
  "leaf_count":   <uint>,
  "timestamp_ms": <uint>,
  "prev_batch":   <bytes-32; signature of the previous batch's root_commitment>,
})
```

The `prev_batch` field chains batches together, providing CT-style log
consistency: V can verify A maintains a single consistent view of the
log across time, not divergent views to different verifiers.

Each receipt arrives as an **inclusion proof** rather than a full
signature:

```
Interlace-Receipt-Inclusion: <base64url(canonical_cbor({
  "kind":       "inclusion",
  "leaf":       <commitment_cbor per §2.1>,
  "path":       <array of sibling hashes from leaf to root>,
  "batch_id":   <bytes-16; matches root>,
  "leaf_index": <uint>,
}))>
```

P retains the inclusion proof plus the root commitment for the batch
that includes the leaf.

### 6.2 Batch publication

A **MUST** publish each signed `root_commitment` to its disclosure
endpoint within Δ + 1 second of batch close. V can fetch the full
sequence of batch roots from the disclosure endpoint and verify
consistency.

### 6.3 Capability negotiation

P and A negotiate receipt mode during connection. A's
`.well-known/interlace/index.json` declares supported modes:

```jsonc
{
  "receipt_modes": ["per-request", "merkle-batched"],
  "merkle_batch_interval_ms": 60000  // only if "merkle-batched" supported
}
```

P chooses based on its requirements (per-request for low-detection-
latency, batched for high-throughput-with-consistency).

## 7. Test vectors

The following test vectors are required in
`interlace-spec/0.2.0/test-vectors/`. Each implementation **MUST**
reproduce them byte-equal.

1. `receipt-canonical-bytes.json` — given fixed inputs (nonce, request_hash,
   status, body_hash, headers_hash, timestamp_ms, actor_fp, epoch),
   assert the canonical CBOR bytes are exactly the expected sequence.
   Includes the CBOR-canonicalization landmines from §3.1:
   - `timestamp_ms` near uint8/uint16/uint32 boundaries.
   - body_hash with high-bit-set first byte (tests byte-string encoding).
   - empty headers_hash (tests empty-map encoding).
2. `receipt-signature.json` — given a fixed test keypair, assert the
   Ed25519 signature over the canonical bytes is exactly the expected
   value.
3. `receipt-base64url-header.json` — base64url round-trip stability.
4. `receipt-rejection-cases.json` — receipts that **MUST** be rejected,
   each with an expected rejection reason: wrong actor_fp, wrong epoch
   (live vs audit modes), expired timestamp, wrong nonce, wrong
   request_hash, wrong body_hash, wrong headers_hash, invalid signature.
5. `receipt-streaming-chain.json` — a synthetic SSE stream with N events,
   the rolling event_hash sequence, the stream-open and stream-close
   commitments, both signatures. Implementations must reach byte-equal
   chain state.
6. `receipt-merkle-inclusion.json` — a synthetic batch with N leaves,
   sample inclusion proofs for leaves at positions 0, N/2, N-1.
7. `receipt-archive-resolution.json` — sample CA bundle with retired
   epochs; verification against a retired epoch must succeed.

## 8. Migration from 0.1.0

This is a **breaking change** in mandatory receipt emission. The
honest framing of the migration: until peers enforce receipts (Phase 2
below), the §13.2 property does not hold — emission alone is not
enough.

### 8.1 Phase 0 — 0.1.0 (current state)

No receipts. §13.2 holds only under honest-actor-at-admission
assumption. README.md load-bearing claims table reflects this honestly.

### 8.2 Phase 1 — 0.2.0 emit-but-don't-enforce

All actors emit receipts. Peers may ignore the header or verify
opportunistically. **The §13.2 property is NOT load-bearing in this
phase** — an actor that selectively drops receipts on some requests
can still admit off-record without P noticing.

This phase exists only to allow operators to deploy actor updates
ahead of peer updates. Operators that control both sides of every
deployment SHOULD skip this phase entirely and go directly to Phase 2.

### 8.3 Phase 2 — 0.2.0 enforce-on-peer

Peers reject any 2xx without a valid receipt as a failed request. The
§13.2 property becomes load-bearing because selective drop becomes a
detected failure rather than a silent admission.

Each cluster operator chooses when to flip its peers from Phase 1 to
Phase 2 based on its actor-update completion. The spec does not
mandate a global cutover date.

## 9. Cloister-side implementation plan

(Informative — for tracking, not normative.)

1. `TrustStore.applyAttestation` records the chain entry on each
   authenticated call. Receipt emission is a new step in
   `McpEdgeRoute.handlePost` after the call completes successfully.
2. The receipt signature uses the same master-key-via-NOTME-binding
   that already mints leases. No new key infrastructure.
3. Receipt retention on the peer side: TrustStore gets a new
   `peer_receipts` table or extends `peer_attestations`.
4. SSE stream commitments are emitted as part of the existing SSE
   handler in `McpEdgeRoute`. The event_hash rolling state is per-
   request, stored alongside the response builder.
5. Disclosure endpoint extends to expose published receipt-batch
   roots (for §6) and the archival CA-bundle entries (for §2.3).
6. README load-bearing claims table is updated when Phase 2 cutover
   completes for the deployment.

Filed as follow-up bead to `cloister-ae713f` after this spec text is
ratified.

## 10. Resolved questions (from math-friend review)

The following questions raised during review have been resolved in
this revision:

- **Should response headers be in the commitment?** Yes — `headers_hash`
  over a defined allowlist (§2.1). Listed in critical 1 of the review.
- **Receipt-to-request binding cryptographic, not implicit.** Yes —
  `request_hash` over the existing lease-envelope canonical bytes (§2.1).
  Listed in critical 2.
- **SSE / streaming response semantics.** Resolved normatively as
  open + chain + close construction (§2.4). Listed in critical 3.
- **Key rotation for historical audit.** Archival CA bundle requirement
  (§2.3). Listed in critical 4.
- **CBOR canonicalization edge cases.** Test vectors required to
  exercise them (§3.1, §7). Listed in important 5.
- **Per-request vs Merkle-batched.** Both normative; §2 mandatory,
  §6 optional (§6). Listed in important 6.
- **Phase 1 migration semantics.** §13.2 not load-bearing in Phase 1
  (§8.2). Listed in important 7.
- **Header naming.** `Interlace-Receipt`, no `X-` prefix (§3.2). From
  the review's minor items.
- **Receipt-replay clarification.** Not a capability (§2.5 footnote).
  From the review's minor items.

## 11. Open questions for further review

Math-friend's review surfaced several questions that remain open and
should be resolved before this draft is submitted upstream:

1. **Scope of receipts on authenticated reads** (§2.6) — confirmed
   they're required; relevant for cloister's disclosure endpoint
   circularity (receipts about reads of the receipt chain). Verify
   this doesn't create infinite recursion in audit.
2. **`actor_fp` redundancy** — kept in the commitment as cross-actor
   disambiguator. Drop to save 32 bytes per receipt? Trade-off
   undecided.
3. **COSE_Sign1 envelope vs custom envelope** — RFC 9052 provides a
   standardized CBOR signature envelope with off-the-shelf library
   support. Considered, rejected as more bytes for less benefit in
   this draft. Worth revisiting if implementations push back.
4. **Stream commitment for client-disconnect cases** — does P need to
   sign its own close acknowledgment to make stream-close mutual?
   Probably not (this is non-repudiation of *A's* response, not
   of *P's* receipt); deferred.

## 12. Comparison to literature

- **ISO/IEC 13888-3:2009** — *Non-repudiation, Part 3: Mechanisms
  using asymmetric techniques.* The receipt is exactly **NRO of
  response** in this framework. We're not in the fair-exchange
  category; reference for taxonomy.
- **RFC 6962 (Certificate Transparency)** — SCT is the closest
  deployed analog. CT shipped per-cert SCTs first, added STH +
  Merkle-consistency proofs for log integrity. Our §6 follows the
  same evolution.
- **RFC 9052 (COSE)** — CBOR signature envelope, evaluated and not
  used (§11.3 open).
- **TLSNotary / DECO (Zhang et al., CCS 2020)** — third-party-witnessed
  TLS transcripts via MPC/ZKP. Massively overkill when A cooperates
  by signing; flagged for completeness.
- **RFC 8446 §7.1 + §4.4.3** — TLS 1.3 handshake-key derivation
  (symmetric AEAD over application records) and the
  `CertificateVerify` message (signs handshake transcript, not
  application data). Establishes why the gap exists.
