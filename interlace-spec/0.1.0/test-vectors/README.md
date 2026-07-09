# Interlace test vectors

Canonical inputs + expected digests. A second implementation is
byte-compatible iff it reproduces every `expected_*` value from the
inputs in this directory.

## Fixed seeds

All vectors use the same Ed25519 keypairs and timing constants as
the `gen-fixture` example historically shipped at cloister's
`rs/crates/sign/examples/gen-fixture.rs` (retired 2026-07-09 with the
LLO consolidation, bead `cloister-8f4d3f`; the generator will re-land
upstream in LLO's `rs/ll-open/sign/`):

| Input | Value |
|---|---|
| `master_seed` (32 raw bytes, hex) | `0102030405060708090a0b0c0d0e0f10111213141516171819 1a1b1c1d1e1f20` (drop the space) |
| `master_pubkey_b64url_no_pad` | `ebVWLo_mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ` |
| `master_pubkey_b64_standard`  | `ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ=` |
| `ephemeral_seed` (32 raw bytes, hex) | `8081828384858687888988a8b8c8d8e8f90919293949596 9798999a9b9c9d9e9f` (cleaned: `8081828384858687888a8b8c8d8e8f909192939495969798999a9b9c9d9e9f`) |
| `ephemeral_pubkey_b64url_no_pad` | `zRSzf5VulTGU_3-3Oz2B3MVh1hp1OAlLfD4aZD7l86o` |
| `not_before` (unix sec) | `1700000000` |
| `not_after`  (unix sec) | `2524607999` (2049-12-31T23:59:59Z, end of UTCTime range) |

(For the authoritative seed bytes see `gen-fixture.rs` (moved upstream
to LLO's `rs/ll-open/sign/examples/` per bead `cloister-8f4d3f`).
The seeds above are split visually for readability; concatenate without spaces.)

The fixture also pins:

- `cert_full_b64url` — X.509 DER, base64url no-pad. See [cert-vectors.json](cert-vectors.json).
- A sample signed request (method=POST, url=http://x/mcp, ts=1700000100000, fixed nonce, fixed body) for envelope/canonical-bytes tests.

## File map

| File | Covers |
|---|---|
| [`cert-vectors.json`](cert-vectors.json) | Cert DER fixtures (full/minimal/wrong-master/critical-unknown/non-critical-unknown), expected `CertClaims` after verification, and the canonical claims-JSON output. |
| [`lease-envelope.json`](lease-envelope.json) | Canonical request bytes + sha256, signature bytes for the SAMPLE envelope and the two NEAR_NB/NEAR_NA edge-of-window envelopes. |
| [`ca-bundle.json`](ca-bundle.json) | CABundle inputs (with and without prev key) + expected CBOR canonical bytes hex + sha256 of the signing input. |
| [`lease-counter.json`](lease-counter.json) | Three-step chain hash worked example (genesis + two follow-ons) using the SAMPLE cert + nonces + timestamps. |
| [`peer-attestation.json`](peer-attestation.json) | A three-row attestation chain showing genesis (NULL prev_self_ref) and two follow-on rows linking via `prev_self_ref = previous.content_hash`. |
| [`disclosure.json`](disclosure.json) | A worked disclosure response: HeaderRecord + two AttestationRecords + one PendingRecord, with the exact JSONL bytes and the cursor token shape. |

## Cryptography references

- Ed25519: [RFC 8032](https://www.rfc-editor.org/rfc/rfc8032).
- X.509 v3: [RFC 5280](https://www.rfc-editor.org/rfc/rfc5280).
- Ed25519 in X.509: [RFC 8410](https://www.rfc-editor.org/rfc/rfc8410), OID `1.3.101.112`.
- DER: [X.690](https://www.itu.int/rec/T-REC-X.690).
- CBOR canonical: [RFC 8949 §4.2](https://www.rfc-editor.org/rfc/rfc8949#section-4.2).
- HMAC-SHA256: [RFC 2104](https://www.rfc-editor.org/rfc/rfc2104).
- base64url: [RFC 4648 §5](https://www.rfc-editor.org/rfc/rfc4648#section-5).
- JSON string escaping: [RFC 8259 §7](https://www.rfc-editor.org/rfc/rfc8259#section-7).
