# URL canonicalization test vectors (interlace-spec 0.2.0 draft)

Test vectors for the URL canonicalization rule defined in
[`../../URL-CANONICALIZATION.md`](../../URL-CANONICALIZATION.md).

## Reading the vectors

Each file pins a single canonicalization scenario:

- **`p_signed_url`** — the URL Peer P emitted and signed.
- **`a_received_url`** — the URL Actor A's verifier sees after proxy
  rewriting (may equal `p_signed_url` for direct-deployment cases).
- **`prefix`** — A's declared `url_canonicalization.prefix` from
  `.well-known/interlace/index.json`.
- **`expected_path_suffix`** — the canonical path-suffix per
  `URL-CANONICALIZATION.md` §3.3 (`path-suffix` derivation).
- **`canonical_bytes_template`** — the canonical signing input string,
  shown with literal `\n` escapes for documentation.
- **`canonical_bytes_hex`** — the UTF-8 byte hex of the canonical
  signing input. Implementations MUST reach byte-equality with this
  field.
- **`canonical_bytes_sha256_hex`** — SHA-256 of the canonical bytes.
  Used by [`RECEIPTS.md`](../../RECEIPTS.md) §2.1 as the `request_hash`
  field; implementations MUST compute the same digest.
- **`verifier_outcome`** — `"accept"` if the signature verifies under
  the path-suffix; `"reject"` with a reason code if the request is
  un-canonicalizable per §3.3.5.

## Fixed inputs across all vectors

Vectors reuse the same keypair as
[`../../../0.1.0/test-vectors/lease-envelope.json`](../../../0.1.0/test-vectors/lease-envelope.json):

| Field | Value |
|---|---|
| `ephemeral_pubkey_b64url_no_pad` | `zRSzf5VulTGU_3-3Oz2B3MVh1hp1OAlLfD4aZD7l86o` |
| `ephemeral_priv_seed_b64url_no_pad` | `gIGCg4SFhoeIiYqLjI2Oj5CRkpOUlZaXmJmam5ydnp8` |
| `ts_ms` | `1700000100000` (decimal) |
| `nonce_b64url_no_pad` | `oaKjpKWmp6ipqqusra6vsA` |

Conformant implementations should produce identical canonical-bytes
hex AND identical Ed25519 signatures (Ed25519 is deterministic per
RFC 8032).

## File map

| File | Case |
|---|---|
| [`prefix-strip.json`](prefix-strip.json) | Primary canonicalizable case: Kong/Envoy/NGINX-style prefix stripping. |
| [`host-rewrite.json`](host-rewrite.json) | ALB-style host rewriting; path preserved. |
| [`trailing-slash.json`](trailing-slash.json) | Trailing slash normalized to no-trailing-slash. |
| [`query-reorder.json`](query-reorder.json) | Query parameters sorted bytewise lex by key. |
| [`percent-encoding-case.json`](percent-encoding-case.json) | `%2f` → `%2F` (uppercase hex). |
| [`unreserved-decoded.json`](unreserved-decoded.json) | `%41` → `A` (decode unreserved chars). |
| [`uncanonicalizable-reject.json`](uncanonicalizable-reject.json) | Path doesn't match declared prefix; verifier MUST reject. |
| [`empty-prefix.json`](empty-prefix.json) | `prefix = ""` (default, direct deployment). |
| [`root-of-route.json`](root-of-route.json) | Request path exactly equals prefix → path-suffix is `/`. |
| [`dot-segments.json`](dot-segments.json) | `./` and `../` segment resolution per RFC 3986 §5.2.4. |
| [`prefix-rotation.json`](prefix-rotation.json) | A's verifier accepts both current and previous prefix during a rotation window. |
