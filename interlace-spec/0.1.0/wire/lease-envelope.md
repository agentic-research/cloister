# Wire: lease envelope

Headers + canonical signing bytes for an authenticated request.

## Headers

```
Authorization:  Signet <cert_der_b64url>
X-Signet-Sig:   <signature_b64url>
X-Signet-Ts:    <unix_ms_decimal>
X-Signet-Nonce: <nonce_b64url>
```

- All `b64url` encodings are base64url (RFC 4648 §5, `-` `_`), **no
  padding**.
- `cert_der_b64url` is the raw DER bytes of the X.509v3 certificate
  (§wire/cert-extensions.md).
- `signature_b64url` is the 64-byte raw Ed25519 signature.
- `unix_ms_decimal` is the timestamp at signing time, decimal,
  milliseconds.
- `nonce_b64url` encodes at least 16 raw bytes drawn from a CSPRNG. The
  recipient indexes the seen-nonces ledger by `(cert_fp, nonce_b64url)`,
  so distinct nonces per request are required.

The `Signet` scheme name is case-sensitive.

## Canonical request bytes

The recipient verifies:

```
Ed25519.verify(
  ephemeral_pubkey,   # from cert SPKI
  signature,          # from X-Signet-Sig
  canonical_bytes,    # below
)
```

where `canonical_bytes` is the UTF-8 encoding of the string:

```
<method>
<url>
<ts>
<nonce_b64url>
<body>
```

with **exactly one LF (`0x0A`) byte** between each field. No CRLF. No
trailing newline.

| Field         | Source |
|---|---|
| `method`      | HTTP method literal (`POST`, `GET`, etc.) |
| `url`         | The request URL the caller signed |
| `ts`          | Decimal Unix-ms, same value as `X-Signet-Ts` |
| `nonce_b64url`| base64url no-pad of the raw nonce bytes |
| `body`        | Raw request body bytes, or empty string for GET |

The signature only verifies if the recipient observes the same URL the
caller signed. Reverse proxies that rewrite URLs between caller and
recipient break the signature. Implementations SHOULD document which
URL form (public-facing vs internal) is the canonical signed URL.

LF (`0x0A`) inside `body` is allowed because `body` is the final field
— a signature consumer reads fixed-position fields first and treats
the remainder as body.

## Reference encoder (pseudocode)

```
fn canonical_request_bytes(method, url, ts_ms, nonce_bytes, body) -> bytes:
    nonce_b64 = b64url_no_pad(nonce_bytes)
    return UTF8(f"{method}\n{url}\n{ts_ms}\n{nonce_b64}\n{body}")
```

See [`../test-vectors/lease-envelope.json`](../test-vectors/lease-envelope.json)
for fixed inputs and the expected canonical-bytes hex + signature.

## seen_nonces ledger

Recipients MUST track every `(cert_fp, nonce_b64url)` they accept.
Recipients SHOULD evict ledger entries older than the maximum cert
TTL so unbounded growth is bounded by cert lifetime + clock skew.

A replayed envelope (same cert_fp, same nonce) is rejected as
`replay` regardless of whether the rest of the pipeline would have
passed. This is checked BEFORE the lease counter UPSERT so a replay
does not advance the chain.
