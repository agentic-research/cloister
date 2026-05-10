# Interlace v0.1.0 — vendor-neutral specification

**Status:** Draft (extracted 2026-05-10 from cloister's internal ADR-0007
substrate; reference implementation is cloister but the wire is intentionally
implementation-neutral).

**Audience:** anyone building a second Interlace implementation in Rust,
Python, Go, etc. and verifying their bytes match cloister's. If you reach
the same digests on the test vectors in `test-vectors/`, you're conformant.

**Non-goals:** Interlace v0.1.0 does NOT cover load-balancing, vault scoping,
compute-substrate portability, multi-party Session Lead, or `.well-known/`
discovery body schema. Those are cloister-side concerns layered on top of
this substrate (cloister ADR-0008/0009/0010/0011), not part of the
interoperable wire.

## What Interlace is

A trust substrate with three layers, all bound to a single Ed25519
master keypair per **cluster**:

1. **Lease** — per-call authorization, ephemeral Ed25519 cert minted by
   the cluster's master CA, verified offline by the recipient. Cheap,
   high-rate.
2. **State** — per-state-boundary write, recorded as a per-peer
   hash-chained `peer_attestations` entry, plus a per-peer
   `peer_lease_counters` row updated on every authenticated request
   (so that **silence is evidence** — §13.2).
3. **Disclosure** — a peer can request its own chain back from the
   actor via a constant-time, cursor-paginated read endpoint. A third
   party with the master pubkey can verify the chain offline.

The threat-model invariant that load-bears the whole design is §13.2
("silence is evidence"): if a peer never sees a counter or attestation
for a request it made, that absence is **cryptographic proof** the
actor admitted the request off-record. The protocol must therefore
record *every authenticated call*, not just state-mutating ones.

## Document map

- [`README.md`](README.md) — this file. The spec proper.
- [`wire/cert-extensions.md`](wire/cert-extensions.md) — Interlace X.509
  extension OID arc + DER encoding.
- [`wire/ca-bundle.cddl`](wire/ca-bundle.cddl) — CDDL schema for the
  CBOR-canonical CA bundle signing input.
- [`wire/lease-envelope.md`](wire/lease-envelope.md) — HTTP headers +
  canonical request bytes for a Signet-signed request.
- [`wire/disclosure-jsonl.md`](wire/disclosure-jsonl.md) — JSONL line
  shapes for the disclosure endpoint.
- [`test-vectors/`](test-vectors/) — canonical inputs + expected digests.

### Note on test-vector format (JSON-as-carrier, NOT JSON-as-spec)

The test-vector files are JSON because every target implementation
language (Python, Rust, Go, JS) parses it with zero tooling burden —
**but JSON is not the spec wire format**. Each test-vector file
carries:

- **canonical bytes hex-encoded** in a field like `canonical_hex` or
  `cbor_canonical_hex` or `cert_der_hex` — these are the actual wire
  bytes the spec defines.
- **expected digests hex-encoded** in a field like `sha256` or
  `chain_hash` — what your implementation must compute over the
  canonical bytes.
- **human-readable field labels** describing which canonical-bytes
  byte-range is which (`prev_chain_hash`, `cert_fp`, `nonce_b64`,
  `ts_str`, etc.) — these are documentation, not protocol fields.

A conformant implementation:

1. Reads the test-vector JSON in any convenient language.
2. Hex-decodes the canonical-bytes field.
3. Runs its own canonical-encoder against the named inputs.
4. Asserts byte-equality with the hex-decoded canonical bytes AND with
   the expected digest after hashing.

The actual wire encodings the spec ratifies:

| Surface | Canonical encoding |
|---|---|
| CA bundle | RFC 8949 deterministic CBOR |
| Cert + extensions | X.509 DER (RFC 5280) |
| Chain-hash input | UTF-8 byte concatenation, no separators (see §4.1) |
| Cert claims (for `cert_fp`) | Canonical JSON: alphabetical keys, no whitespace, no trailing newline, minimal escaping (see §3 + threat-model §7.7.e) |
| Lease envelope | UTF-8 byte concatenation of canonical request fields (see `wire/lease-envelope.md`) |
| Disclosure response lines | JSONL with constrained schema (see `wire/disclosure-jsonl.md`) |

None of these is "test-vector JSON." Implementors who treat the
test-vector JSON shapes as the wire format will silently diverge —
threat-model §7.7 (a-e) catalogs how each divergence breaks the
§13.2 "silence is evidence" property. Reach byte-equality against
the canonical-bytes fields, not the surrounding JSON envelope.

## 1. Identity

### 1.1 Master keypair

Each cluster owns one **master Ed25519 keypair**. The public key is the
cluster's stable identity; the private key never leaves the cluster's
trust boundary (in cloister: a Durable Object that mints certs and
never exfiltrates the seed).

- **Algorithm:** Ed25519 ([RFC 8032](https://www.rfc-editor.org/rfc/rfc8032)).
- **Pubkey wire:** 32 raw bytes. When transported textually,
  base64-standard (`+`/`/`/`=`) per RFC 4648 §4 unless a specific surface
  pins base64url (the cert-claims JSON uses base64url no-padding; the
  CA bundle's `keys` map uses base64-standard).

### 1.2 Cluster CA bundle

The master publishes a versioned **CA bundle** describing the active
master key plus an optional previous key during a rotation window. The
bundle is signed by the master and re-published on each rotation.

Bundle fields (JSON on the wire, CBOR for signing — see §1.3):

| Field       | Type           | Notes |
|---|---|---|
| `epoch`     | uint64         | Monotonically increasing; certs carry this in extension OID `1.3.6.1.4.1.99999.1.4`. |
| `seqno`     | uint64         | Monotonically increasing within an epoch. |
| `keys`      | map<string, base64-std bytes> | `kid` → 32-byte raw Ed25519 pubkey. |
| `keyId`     | string         | Currently-active `kid`. |
| `prevKeyId` | string (opt)   | Previous `kid` during a half-open rotation window. Empty string when absent. |
| `issuedAt`  | int64          | Unix seconds at which the bundle was issued. |
| `signature` | base64-std bytes | Ed25519 signature over `bundleCanonical(bundle)` by `keys[keyId]`. |

Implementations MUST refresh the bundle at an interval shorter than
their staleness tolerance. cloister's tolerance is 5 minutes and it
refreshes every 4 minutes; a conforming implementation MAY pick its
own numbers but MUST fail closed if the cached bundle is older than
the staleness tolerance and the source is unreachable.

### 1.3 Bundle canonical signing input

The signature MUST be computed over the **CBOR canonical encoding**
([RFC 8949 §4.2](https://www.rfc-editor.org/rfc/rfc8949#section-4.2))
of an integer-keyed map. Key order (`1..6`) is already canonical
because CBOR sorts integer keys numerically; the inner `keys` map
needs explicit RFC 8949 §4.2 ordering on its string keys (shorter
first, then bytewise lex on equal lengths).

```
message := {
  1: epoch,       # uint64
  2: seqno,       # uint64
  3: keys,        # map<text, bytes>   ← inner sort: RFC 8949 §4.2
  4: keyId,       # text
  5: prevKeyId,   # text (empty string if absent)
  6: issuedAt,    # int64
}
```

Encoding rules (RFC 8949 §4.2, "Core Deterministic Encoding"):

- Integers use the shortest form (major type 0/1).
- Bytes use major type 2 (NOT the typed-array tag RFC 8746).
- Text uses major type 3.
- Maps use major type 5; keys MUST be sorted per §4.2.

Verifiers MUST recompute `bundleCanonical(bundle)` and verify
`Ed25519.verify(keys[keyId], signature, bundleCanonical(bundle))`. See
[`wire/ca-bundle.cddl`](wire/ca-bundle.cddl) for the formal schema and
[`test-vectors/ca-bundle.json`](test-vectors/ca-bundle.json) for a
fixed input + expected CBOR digest.

### 1.4 Ephemeral cert ("lease")

An actor presents an **ephemeral Ed25519 cert** to authenticate every
request. The cert is a standard X.509v3 certificate with three required
Interlace extensions and Ed25519 signature throughout. Minting is the
cluster CA's job; verification is the recipient's job.

**Required cert shape** (see [`wire/cert-extensions.md`](wire/cert-extensions.md)
for full DER details):

- X.509v3 certificate
- `signatureAlgorithm.oid` = `1.3.101.112` (id-Ed25519)
- `subjectPublicKeyInfo.algorithm.oid` = `1.3.101.112`
- `subjectPublicKeyInfo.subject_public_key` = 32-byte raw ephemeral pubkey
- `validity.not_before` / `validity.not_after` as UTCTime or GeneralizedTime
- Signature: Ed25519 over the DER encoding of `tbs_certificate`

**Interlace extensions** (Phase 1 verifier REQUIRES all three on every
authenticating cert; missing any one → `unauthenticated`):

| OID                       | Name             | DER type         | Value |
|---|---|---|---|
| `1.3.6.1.4.1.99999.1.4`   | `interlace-epoch` | INTEGER         | uint32 matching the bundle's `epoch`. |
| `1.3.6.1.4.1.99999.1.5`   | `interlace-peer`  | UTF8String      | Peer fingerprint (UTF-8 free text — cloister uses `sha256:<hex>`). |
| `1.3.6.1.4.1.99999.1.6`   | `interlace-scope` | UTF8String      | Scope expression (see §3.3). |

**Critical-extension policy.** Per [RFC 5280
§4.2](https://www.rfc-editor.org/rfc/rfc5280#section-4.2) the verifier
MUST reject any cert carrying a critical-flagged extension the
verifier does not recognize. Implementations MUST treat the three
known Interlace OIDs above as the *only* recognized set unless they
extend the spec. Non-critical unknowns MAY be ignored.

**`signingTime` is NOT used.** v0.1.0 explicitly omits CMS
`signingTime` (the WASM-portability problem ADR-0007 amendment 4
flagged). Temporal binding is enforced via `validity.not_before` /
`validity.not_after` plus the recipient's server-side timestamp at
verify time.

## 2. Cert verification

Given `cert_der` + `master_pubkey` (32 bytes):

1. DER-decode the certificate. Reject on malformed input.
2. Check `signatureAlgorithm.oid == id-Ed25519`. Else reject.
3. Re-encode `tbs_certificate` to DER. (The signature is over this
   canonical re-encoding; implementations relying on the parser's
   "remember the input bytes" feature are non-conformant.)
4. Verify `Ed25519.verify(master_pubkey, signature, tbs_der)`. Reject
   on failure.
5. Extract ephemeral pubkey from SPKI. Reject if algorithm OID is not
   id-Ed25519 or pubkey is not 32 bytes.
6. Convert `validity.not_before` / `validity.not_after` to Unix seconds.
7. Walk `tbs_certificate.extensions`:
   - For OID `1.3.6.1.4.1.99999.1.4` (epoch): DER-decode INTEGER,
     coerce to u32 (reject if >4 bytes after stripping leading 0x00).
   - For OID `1.3.6.1.4.1.99999.1.5` (peer_fp): DER-decode UTF8String.
   - For OID `1.3.6.1.4.1.99999.1.6` (scope): DER-decode UTF8String.
   - Any other extension that is `critical: true` → reject as
     `unknown_critical_extension`. Non-critical unknowns: ignore.

On success the verifier returns:

```
CertClaims {
  ephemeral_pubkey: [u8; 32],
  not_before: i64,
  not_after:  i64,
  epoch:      Option<u32>,    // Some(_) required for Phase 1
  peer_fp:    Option<String>, // Some(_) required for Phase 1
  scope:      Option<String>, // Some(_) required for Phase 1
}
```

Phase 1 deployments (cloister today) MUST fail closed when any of
`epoch / peer_fp / scope` is absent.

### 2.1 Claims JSON (interop format)

When a verifier wants to hand claims across a language boundary (e.g.
WASM → JS), the canonical wire is the following minimal JSON:

```
{"epk":"<base64url-no-pad-32-byte-pubkey>","nb":<int>,"na":<int>[,"ep":<int>][,"pf":"..."][,"sc":"..."]}
```

Field order is fixed: `epk, nb, na, ep, pf, sc`. Optional fields are
omitted when absent. Strings are escaped per [RFC 8259
§7](https://www.rfc-editor.org/rfc/rfc8259#section-7). See
[`test-vectors/cert-claims-json.json`](test-vectors/cert-claims-json.json)
for the canonical encoding of every test cert.

## 3. Lease envelope

Every authenticated request carries four HTTP headers + a request body.
The recipient verifies the cert (§2), then verifies a request signature
over canonical bytes derived from the request line + headers + body.

### 3.1 Headers

| Header           | Format |
|---|---|
| `Authorization`  | `Signet <base64url-no-pad cert DER>` |
| `X-Signet-Sig`   | `<base64url-no-pad Ed25519 signature, 64 bytes>` |
| `X-Signet-Ts`    | `<unix-milliseconds, decimal>` |
| `X-Signet-Nonce` | `<base64url-no-pad, ≥16 raw bytes>` |

The `Signet` scheme name is fixed. Implementations that emit `signet`
or `SIGNET` are non-conformant. Base64url uses `-` and `_`, no padding.

### 3.2 Canonical request bytes

The signature is computed over UTF-8 bytes of a fixed-format string:

```
<method>\n<url>\n<ts>\n<nonce-b64url-no-pad>\n<body>
```

- Separator: a single LF (`0x0A`) byte. **No CRLF**. LF in the body is
  allowed because body is the final field.
- `<method>`: the HTTP method as sent (`POST`, `GET`, etc.).
- `<url>`: the full request URL as the caller signed it. The recipient
  uses the URL it observes; if a reverse proxy rewrote the URL between
  the caller and the recipient, the signature will fail. Implementations
  SHOULD agree on whether to sign the public URL or the back-end URL
  per deployment; cloister signs whatever appears in the worker's
  `request.url`.
- `<ts>`: decimal Unix-milliseconds, identical to the `X-Signet-Ts`
  header value.
- `<nonce-b64url-no-pad>`: base64url no-padding encoding of the raw
  nonce bytes (NOT the header value itself — equivalent because the
  header encoding is the same, but the canonical bytes are computed
  from the raw nonce).
- `<body>`: the raw request body. For `GET` requests, the empty string.

The signature MUST be valid Ed25519 under the cert's `ephemeral_pubkey`.

### 3.3 Scope grammar

Scope is a UTF-8 string with the grammar:

```
scope    := "*" | tool ":" target | "tools:list"
tool     := <ascii alphanumeric + underscore>
target   := "*" | <opaque-utf8>
```

Recipient derivation:

- JSON-RPC `tools/list`           → `tools:list`
- JSON-RPC `tools/call name=X` (no args) → `X:*`
- JSON-RPC `tools/call name=X args.repo=R` → `X:R`
- Disclosure endpoint `GET /interlace/peers/{fp}` → `disclosure:<fp>`

Cert scope **grants** request scope iff:

- `cert.scope == "*"` (admin; SHOULD NOT be minted in production), OR
- `cert.scope == requested_scope` (exact), OR
- `cert.scope` ends in `:*` AND `requested_scope` starts with the
  cert's prefix (the `:*` is the only wildcard form in v0.1.0).

No multi-component wildcards. No glob syntax. No regex.

### 3.4 Verification pipeline (recipient)

In order, all conjunctive:

1. **Header parse.** Reject malformed/missing as `unauthenticated`.
2. **Clock-skew bound.** `|server_now_ms - X-Signet-Ts| ≤ 60_000`.
   Reject as `clock_skew`. (Defense in depth against time-shifted
   replays beyond the seen-nonces window.)
3. **Cert chain verify** (§2) against the active bundle key. If the
   bundle has a `prevKeyId` and the active verify failed, retry
   against the previous key (rotation window).
4. **Required claims.** `epoch`, `peer_fp`, `scope` all present.
5. **Epoch currency.** `cert.epoch ∈ {bundle.epoch, bundle.epoch-1}`
   (the rotation window).
6. **Validity window.** `floor(server_now_ms/1000) ∈ [not_before, not_after]`.
7. **Request signature** (§3.2). Ed25519 under `ephemeral_pubkey`.
8. **Scope check** (§3.3).
9. **Replay defense.** Record `(cert_fp, nonce)` as seen; reject if
   already present. `cert_fp = sha256_hex(cert_der)`.
10. **Lease counter update** (§4.1). UPSERT the peer's row.

Failures are reported with stable error codes (JSON-RPC error code
ranges are cloister-specific; a conformant implementation MAY use its
own transport-appropriate equivalents but MUST distinguish:
`unauthenticated`, `scope_denied`, `bad_request_sig`, `replay`,
`ca_unavailable`, `epoch_mismatch`, `clock_skew`).

## 4. State chains

Each `(actor, peer)` pair has two parallel chains in the actor's
storage:

- A **lease counter** (one row per peer, updated per request).
- An **attestation log** (one row per state-boundary write).

### 4.1 Lease counter chain

For each peer, the actor maintains:

```
peer_lease_counters {
  peer_fingerprint: text  PRIMARY KEY,
  seq:              int   monotonically increasing,
  last_chain_hash:  text  sha256_hex(prev || cert_fp || nonce || ts),
  last_cert_fp:     text  sha256_hex(cert_der),
  updated_at:       int   server unix-ms,
}
```

The chain step is:

```
next_chain_hash = sha256_hex(UTF8(prev_chain_hash || cert_fp || nonce_b64 || ts_str))
```

Concretely the SHA-256 input is the **UTF-8 byte concatenation** of
four ASCII fields, *no separator*:

- `prev_chain_hash` — 64 lowercase hex chars (the prior `last_chain_hash`,
  or 64 zeros at genesis).
- `cert_fp` — 64 lowercase hex chars (`sha256_hex` of cert DER).
- `nonce_b64` — base64url no-padding (same value as in the header).
- `ts_str` — decimal Unix-ms (no padding, no separator).

Genesis: when no row exists for the peer, treat `prev_chain_hash` as
`"00...0"` (64 zeros) and `prev_seq` as `0`. The first observation
becomes `seq = 1`. See [`test-vectors/lease-counter.json`](test-vectors/lease-counter.json)
for the canonical genesis-and-step expected digests.

**Monotonicity invariant.** `next_seq == prev_seq + 1`. Implementations
SHOULD assert this at write time as defense-in-depth.

### 4.2 Attestation chain

For each peer, the actor appends one row per state-boundary write
(cloister defines this as `bead_create / bead_update / bead_close /
bead_comment`; other implementations choose their own boundary):

```
peer_attestations {
  PRIMARY KEY (peer_fingerprint, seq),
  prev_self_ref: text NULL,   -- previous attestation's content_hash, per-peer
  prev_peer_ref: text NULL,   -- counter-chain link claimed by the peer at write time
  content_hash:  text NOT NULL,  -- sha256_hex of the canonical bytes of the state-write
  content_type:  text NOT NULL,
  scope:         text NOT NULL,
  cert:          blob NOT NULL,  -- raw cert DER (so disclosure is self-contained)
  sig:           blob NOT NULL,  -- Ed25519 over (canonical_bytes || prev_self_ref)
  created_at:    int  NOT NULL,  -- server unix-ms
}
```

- `prev_self_ref` is **per-peer**, not global (§9.2 disclosure privacy:
  a globally-chained ref would leak the existence of other peers when
  selectively disclosed).
- Genesis row: `prev_self_ref = NULL`, `seq = 1`.
- Subsequent rows: `prev_self_ref = previous_row.content_hash`,
  `seq = previous_row.seq + 1`.

### 4.3 Pending / GAP states

For state writes only, the cross-store handoff (write canonical bytes →
write actor's primary record → write attestation row) can fail at the
last step. Implementations SHOULD distinguish three observable states
for a peer's chain when surfacing via disclosure (§5):

- **COMPLETE** — every state-write has a `peer_attestations` row.
- **PENDING** — the actor knows about the write and is retrying.
  Disclosed as a separate record type so the peer can see the actor
  has acknowledged the write but not yet committed an attestation.
- **GAP** — neither a `peer_attestations` row nor a pending entry.
  This is the §13.2 evidence of misbehavior.

## 5. Disclosure

The actor exposes a read endpoint at `GET /interlace/peers/{fp}`
(implementations choose the prefix; cloister uses `/interlace/peers/`).
The endpoint streams the peer's chain so the peer (or a third-party
auditor with the master pubkey) can verify offline.

### 5.1 Wire format: JSONL

The response body is **newline-delimited JSON** (`application/jsonl`),
one record per line, with three record types in order:

1. **Header record** (always first):
   ```json
   {"type":"header","version":"v1","peer_fingerprint":"<fp>","master_public_key":"<b64-std>","next_cursor":"<opt>"}
   ```
2. **Attestation records** (zero or more, ordered by ascending `seq`):
   ```json
   {"type":"attestation","seq":N,"prev_self_ref":"<hex|null>","prev_peer_ref":"<hex|null>","content_hash":"<hex>","content_type":"<utf8>","scope":"<utf8>","cert_b64":"<b64-std>","sig_b64":"<b64-std>","created_at":<unix-ms>}
   ```
3. **Pending records** (zero or more, after all attestations):
   ```json
   {"type":"pending","content_hash":"<hex>","scope":"<utf8>","attempts":<int>,"next_retry_at":<unix-ms>,"exhausted":<bool>,"created_at":<unix-ms>,"last_attempt_at":<unix-ms|null>}
   ```

A final `\n` terminator is included after the last line.

### 5.2 Pagination cursor

When the attestation log exceeds the page size (cloister: 100), the
header record carries `next_cursor`. Cursors are HMAC-signed tokens to
prevent the endpoint from acting as a fingerprint-existence oracle for
sequence ranges (§5.4).

Cursor format (compact, JWT-shaped):

```
v1.<base64url-no-pad payload-json>.<base64url-no-pad HMAC-SHA256>
```

Payload (canonical JSON: sorted keys, no whitespace):

```json
{"fromSeq":N,"peerFp":"<fp>","ts":<unix-ms>}
```

HMAC is computed over the dot-concatenated `v1.<payload-b64u>` portion
(NOT the full token). Key: a 32+ byte secret shared across all replicas
of the actor; opaque to outsiders.

Verifiers MUST reject:
- Wrong segment count.
- Wrong version prefix.
- HMAC mismatch.
- `peerFp` mismatch against the URL path.
- Malformed payload JSON.

### 5.3 Constant-time error response

The disclosure endpoint MUST NOT expose distinguishable error classes
that would let an attacker learn relationship state by probing
fingerprints. All failure modes (unknown peer, auth denied, malformed
cursor) collapse into one response:

- HTTP status: `404`.
- Body: 256 ASCII `'0'` bytes.
- Headers: `content-type: application/octet-stream`,
  `content-length: 256`, `cache-control: no-store`.

The body length is a fixed constant (`CONSTANT_TIME_ERROR_BODY_LEN =
256`) so response size is byte-identical across failure classes.
Implementations that emit additional headers MUST ensure those headers
do not distinguish failure classes either.

### 5.4 Auth gating

When the actor is configured with a cluster master pubkey, the
disclosure endpoint is itself lease-gated:

- Scope: `disclosure:<peerFp>` (NOT the cert's `peerFp` claim — the
  scope says "this lease may read peer X's chain").
- Signed body: empty string (GET).
- Auth failure: returns the constant-time 404, indistinguishable from
  "no such peer."

The (cert.peer_fp, requested peer_fp) relationship is implementation
policy. cloister allows a holder of a `disclosure:<X>` lease to read
peer X's chain regardless of the holder's own peer_fp — i.e. third-
party audit is enabled by minting an audit-scoped lease.

## 6. Threat model (§13.2 invariant)

The Interlace v0.1.0 threat model rests on one cryptographic claim:

> **Silence is evidence.** If peer P interacted with actor A and P's
> request was admitted (any HTTP 2xx from A on a Signet-bearing
> request), then P's `peer_lease_counters` chain in A's storage MUST
> contain an entry covering that interaction. If P later queries A's
> disclosure endpoint and finds no such entry, that absence is
> cryptographic proof A admitted the request off-record.

This claim holds for the **lease counter** chain cleanly: every
authenticated request writes a counter row *before* dispatch, in the
same single-DO transaction as the seen-nonces insert.

It is **qualified** for the **attestation chain** (§4.3): a missing
attestation row can be benign (the cross-store handoff failed in step
4) or evidence. Implementations surface this ambiguity via the
PENDING state.

A second implementation conforming to this spec inherits the §13.2
property iff:

- Every authenticated request results in a lease-counter chain write
  that the peer can later observe via disclosure.
- The chain step is deterministic per §4.1 (same prev_hash + cert_fp +
  nonce + ts → same next_hash).
- The disclosure endpoint surfaces the full counter chain for the
  requesting peer.

## 7. Versioning + compatibility

v0.1.0 is the first frozen point. Backwards-compatible changes
permitted in v0.1.x:

- Adding new optional record types to the disclosure JSONL stream
  (consumers MUST ignore unknown `type` values).
- Adding new non-critical X.509 extensions in the Interlace OID arc.
- Adding new optional bundle fields beyond integer key `6` (CBOR
  decoders MUST tolerate unknown integer keys).

Breaking changes require a major bump:

- Changing the canonical bytes for any signed surface.
- Renumbering existing extension OIDs.
- Changing the scope grammar.

## 8. Reference implementation

cloister (this repository) is the reference implementation:

- Cert mint + claims extraction: `rs/crates/sign/src/cert_chain.rs`
- Lease verification pipeline: `src/routes/lease-middleware.ts`
- Bundle canonical encoder: `src/storage/bundle-canonical.ts`
- Lease counter chain: `src/storage/peer-lease-counters.ts`
- Attestation chain: `src/storage/peer-attestations.ts`
- Disclosure endpoint: `src/routes/disclosure.ts`
- Disclosure cursor + constant-time error: `src/storage/disclosure-cursor.ts`

A second implementation passing all `test-vectors/` digests is, by
definition, byte-compatible at every signed surface.

## 9. Open questions deferred from cloister ADR-0007

These are tracked in the cloister-side ADR but NOT pinned by this
spec. Implementations are free to take their own positions:

- **Cross-epoch interlock.** When the master rotates an epoch, peer
  chains referencing the old epoch need a migration story. cloister
  defers; second implementors should pick a position before deploying.
- **Push-based revocation propagation.** cloister polls the bundle
  every 4 minutes; SSE or webhook delivery is implementation-optional.
- **Multi-party Session Lead** (Interlace draft v0.2 §13.1). Not in
  v0.1.0; revisit when a concrete N-party use case appears.

## 10. License + provenance

This spec was extracted from cloister's internal ADR-0007 substrate on
2026-05-10. cloister is AGPL-3.0-or-later; the spec itself is intended
to be permissively licensed so a second implementor can adopt it
without copyleft entanglement. License finalization tracked alongside
the ref-impl follow-up.
