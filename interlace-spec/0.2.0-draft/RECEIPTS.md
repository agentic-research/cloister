# interlace-spec 0.2.0 amendment: Signed Receipts (closes §13.2 non-repudiation gap)

> **Status**: Draft, pending math-friend review of
> [`PROBLEM-STATEMENT-NON-REPUDIATION.md`](PROBLEM-STATEMENT-NON-REPUDIATION.md).
> **Target version**: interlace-spec 0.2.0 (breaking change from 0.1.0).
> **Tracking bead**: `cloister-ae713f`.

## 1. Background

interlace-spec/0.1.0 §13.2 claims:

> If peer P interacted with actor A and P's request was admitted (any
> HTTP 2xx from A), then P's chain MUST contain an entry. If P later
> queries and finds no such entry, that absence is cryptographic proof
> A admitted the request off-record.

This claim does not hold under standard TLS, because TLS provides no
non-repudiation. P cannot prove to a third-party auditor that A
returned a 2xx response — the TLS transcript is forgeable post-session
by either party.

The detailed adversarial argument is in
[`PROBLEM-STATEMENT-NON-REPUDIATION.md`](PROBLEM-STATEMENT-NON-REPUDIATION.md).

This amendment adds a signed-receipt requirement so the §13.2 claim
becomes mathematically defensible: A signs each 2xx response under its
master key; P retains the receipt; a missing chain entry combined with
a valid receipt is proof of off-record admission.

## 2. Specification (proposed normative text for §13.5)

### 2.1 Receipt construction

When Actor A returns an HTTP 2xx status code to Peer P in response to
an authenticated interlace request, A **MUST** include an
`X-Interlace-Receipt` header in the response.

The receipt is computed as follows:

```
commitment_cbor = canonical_cbor({
  "nonce":        <bytes; the request nonce from P's lease envelope>,
  "status":       <uint; HTTP status code, 200..299>,
  "body_hash":    <bytes-32; SHA-256 of response body, empty if no body>,
  "timestamp_ms": <uint; unix milliseconds at admission>,
  "actor_fp":     <bytes-32; SHA-256 of A's master pubkey>,
  "epoch":        <uint; A's current key epoch from .well-known/interlace/index.json>,
})

signature = Ed25519_Sign(A.master_sk, commitment_cbor)

receipt_envelope = canonical_cbor({
  "commitment": commitment_cbor,
  "signature":  signature,
})

X-Interlace-Receipt: <base64url(receipt_envelope)>
```

Where `canonical_cbor()` follows RFC 8949 §4.2 Core Deterministic
Encoding (definite-length maps with keys sorted by bytewise
lexicographic order).

### 2.2 Receipt verification

Peer P **MUST** verify each received receipt:

1. Decode the base64url header value into bytes.
2. Parse as CBOR; reject if not a valid map with keys
   `{"commitment", "signature"}`.
3. Parse `commitment` as CBOR with the keys named in §2.1.
4. Verify `nonce` matches the nonce P sent in the request's lease
   envelope. (Mismatch ⇒ reject as invalid.)
5. Verify `actor_fp` matches the fingerprint P pinned for A.
6. Verify `epoch` matches the epoch in A's current
   `.well-known/interlace/index.json` or the immediately previous epoch
   (to tolerate key rotation in flight).
7. Fetch A's pubkey for the named epoch (from the CA bundle).
8. Verify `Ed25519_Verify(pubkey, commitment_cbor, signature)`.
9. Verify `body_hash` matches `SHA-256(response_body)`.
10. Verify `timestamp_ms` is within ±300s of P's clock (clock-skew
    bound from §6.2.7).

A receipt that fails any step **MUST** be rejected; P **MUST** treat
the response as if A returned 5xx (because A did not provide
non-repudiable admission).

### 2.3 Receipt retention

P **MUST** retain receipts for at least the duration of the next
§13.4 audit cycle (configurable per deployment; default 90 days).

P **MAY** discard receipts after that window, but **SHOULD** archive
them indefinitely if storage cost permits.

A **MUST NOT** rely on P discarding receipts for security. The
disclosure chain in $D_A$ must be complete regardless of P's retention
policy.

### 2.4 Audit invariant (updated §13.2)

> If peer P holds a valid receipt `receipt(r, resp)` — i.e., a
> signature under A's master key over the canonical commitment to
> request r and response resp, satisfying all checks in §2.2 — and
> A's disclosure chain $D_A$ at any subsequent time T contains no entry
> for `nonce(r)`, then with overwhelming probability (under
> EUF-CMA security of Ed25519) A admitted r off-record.
>
> The verification procedure for an auditor V is:
>
> 1. Verify the receipt's signature under A's pubkey for the named epoch.
> 2. Fetch $D_A$ at time T.
> 3. Search $D_A$ for an entry with matching nonce.
> 4. If no entry found, the receipt is proof of off-record admission.

### 2.5 Mandatory emission

A's implementation **MUST** emit a valid receipt on every 2xx
authenticated response. Failure to emit (no header, malformed header,
invalid signature) is itself a spec violation and SHOULD be treated by
P as a failed request.

A **MAY** omit receipts on 4xx/5xx responses (admission did not occur,
nothing to commit to).

A **MAY** omit receipts on unauthenticated endpoints (e.g., `/health`,
`/.well-known/interlace/index.json`) — those operations are public and
non-stateful; the §13.2 invariant does not apply.

## 3. Receipt format details

### 3.1 Why CBOR canonical encoding?

We need byte-stable encoding so signature verification is
deterministic. Two valid serializations of the same JSON object would
produce different signatures and break verification.

RFC 8949 §4.2 Core Deterministic Encoding gives us:

* Definite-length maps + arrays.
* Keys sorted bytewise.
* Shortest length form for integers.
* No NaN, no -0.0, no indefinite-length.

This is consistent with the rest of interlace-spec already using
canonical CBOR for the lease envelope and disclosure entries.

### 3.2 Why base64url for the header?

HTTP headers are 7-bit ASCII. Base64url (URL-safe, no padding) is the
shortest standard ASCII encoding of binary bytes. Roughly 1.33x size
expansion.

Receipt envelope is ~120 bytes raw; ~160 bytes base64url. Acceptable
header overhead.

### 3.3 Why not response trailers?

HTTP/1.1 trailers exist but are poorly supported by gateways (Envoy,
nginx, Cloudflare all strip them by default). Header is the safe
choice.

## 4. Performance

### 4.1 Per-request signing cost

Ed25519 sign is ~50µs on M1 (workerd benchmark, single-threaded). At
1000 QPS that's 5% of one CPU; at 10000 QPS that's 50%. Acceptable for
most deployments.

For deployments where this is too expensive (high-QPS, low-latency
SLAs), §6 below describes a batched-Merkle-root alternative.

### 4.2 Per-request size cost

Receipt header is ~160 bytes base64url. Negligible for HTTP responses
that already carry tens-of-KB bodies.

For trivial-body responses (e.g., a 2xx with a one-line "ok"), the
receipt is comparable to the body size. Still acceptable; HTTP overhead
already includes hundreds of bytes of standard headers.

### 4.3 Verification cost (peer-side)

Ed25519 verify is ~100µs. Same order as TLS handshake cost; not the
bottleneck.

## 5. Migration from 0.1.0

This is a **breaking change**. interlace-spec/0.1.0 peers and actors
that don't speak 0.2.0 cannot verify or emit receipts.

Deployment strategy:

1. **Phase 0** (current 0.1.0 deployments): no receipts; §13.2 holds
   only under honest-actor assumption. Documented as such.
2. **Phase 1** (0.2.0 release): all actors emit receipts. Peers ignore
   the header if they don't yet implement verification. Receipts are
   "best effort" — actors signal upgrade capability, peers opt in to
   strict verification.
3. **Phase 2** (one release window after 0.2.0): peers begin enforcing
   receipts. Any 2xx without a valid receipt is treated as a failed
   request. The §13.2 invariant becomes load-bearing.

Until Phase 2, peers MAY enforce receipts unilaterally if they trust
their deployed actor set.

## 6. Alternative: Merkle-root batched receipts

For high-QPS deployments where per-request signing is too expensive, a
batched alternative exists. Defined here as informative, not normative;
actors **MAY** offer this as an optional protocol extension.

### 6.1 Construction

A maintains an in-memory Merkle tree of commitments (per §2.1 but
unsigned). Every $\Delta$ seconds (operator-configurable; default 60s),
A signs the root:

```
root_signature = Ed25519_Sign(A.master_sk, canonical_cbor({
  "merkle_root": <bytes-32>,
  "epoch":       <uint>,
  "actor_fp":    <bytes-32>,
  "timestamp_ms": <uint>,
  "leaf_count":  <uint>,
}))
```

A publishes the signed root + the full set of leaves at the disclosure
endpoint. P, on receiving a 2xx response, also receives an inclusion
proof:

```
X-Interlace-Receipt-Inclusion: <base64url(canonical_cbor({
  "leaf": <commitment from §2.1>,
  "path": <array of sibling hashes>,
  "root_epoch": <uint>,
}))>
```

P can verify inclusion against the published root.

### 6.2 Trade-offs

* **Cheaper at scale**: one sign per batch instead of one per request.
* **Coarser-grained**: A can drop a leaf up to $\Delta$ seconds before
  P notices. For most deployments this is acceptable; the spec
  recommends $\Delta \leq 60$ seconds.
* **More complex**: requires Merkle-tree implementation, batch
  publishing, inclusion-proof verification. Adds spec surface.
* **Audit-time vs receipt-time discrepancy**: V can only audit after
  the batch closes and the root is published.

The per-request approach in §2 is the canonical form. Batching is an
optimization, not a substitute.

## 7. Test vectors

Five new test vectors will be added to `interlace-spec/0.2.0/test-vectors/`:

1. `receipt-canonical-bytes.json` — given a fixed (nonce, status,
   body, timestamp, actor_fp, epoch), assert the canonical CBOR
   bytes are exactly the expected sequence. (Pins
   canonical-encoding interpretation.)
2. `receipt-signature.json` — given a fixed test keypair, assert the
   Ed25519 signature over the canonical bytes is exactly the expected
   value. (Pins signing algorithm.)
3. `receipt-base64url-header.json` — assert the header value's
   base64url encoding round-trips.
4. `receipt-rejection-cases.json` — receipts that MUST be rejected:
   wrong actor_fp, wrong epoch, expired timestamp, wrong nonce,
   invalid signature. Each case has an expected rejection reason.
5. `receipt-merkle-inclusion.json` (if §6 lands as normative) —
   Merkle inclusion proofs for a fixed batch.

These vectors will be generated from the Python reference
implementation and asserted byte-equal by all conformant implementations.

## 8. Cloister-side implementation plan

(For tracking, not normative.)

1. **TrustStore.applyAttestation** already records the chain entry on
   each authenticated call. Receipt emission is a new step in
   `McpEdgeRoute.handlePost` after the call completes successfully.
2. The receipt signature uses the same master-key-via-NOTME-binding
   that already mints leases. No new key infrastructure.
3. Receipt retention on the peer side: TrustStore gets a new
   `peer_receipts` table or extends `peer_attestations`.
4. Disclosure endpoint extends to expose published receipts in
   batched-Merkle form (for §6).

Filed as follow-up bead to `cloister-ae713f` after this spec text is
ratified.

## 9. Open questions

These need resolution before this draft becomes the normative §13.5.

1. **Should response headers be in the commitment?** Today only body is
   hashed; cache-control / location / content-encoding ride
   unauthenticated. Operators may want them committed; cost is a
   header-canonicalization spec.
2. **Cross-implementation header naming.** `X-Interlace-Receipt` is
   our pick; the `X-` prefix is RFC 6648-deprecated. Consider just
   `Interlace-Receipt` since this is a new header.
3. **Per-request vs Merkle-root as the default.** Currently §2 is
   normative (per-request) and §6 is informative. Should they swap
   based on expected deployment scale?
4. **Receipt-on-streaming responses.** What's the receipt for a
   server-sent-events response? Sign over the *initial* status, with
   `body_hash` over an empty body? Or commit to a stream-completion
   manifest? Affects MCP `/mcp` SSE responses specifically.
