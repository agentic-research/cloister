# `cloister/credential-isolation/v1` — vendor-neutral specification

**Status:** Draft (2026-05-17, paired with ADR-0024 in cloister; conformance vectors landed 2026-05-18 via `cloister-954f21`; vectors reconciled 2026-05-18 with the X-2 wire-shape collapse via `cloister-505bf1` — `error-responses.json`'s allowedSubs-mismatch vector now expects the canonical Shape R 404 body, matching `wire/error-responses.md` post-cycle)
**Audience:** anyone building a second implementation of this
capability — whether in Rust, Python, Go, or as a different
substrate-side cloister bundle. If you reach the same digests on the
test vectors in `vectors/`, you're conformant.

**Non-goals:** v1 does NOT cover credential rotation policy,
multi-region replication, HSM-backed key escrow, BYO-key delegation,
or webhook-style notification. Those are v2+ surfaces.

## What this capability is

A wire-protocol contract for a **credential proxy**: a substrate
service that holds credentials (API keys, OAuth tokens, signing keys)
on behalf of identified callers and exposes upstream APIs by proxying
the caller's request with the credential injected server-side. The
caller never sees the credential value.

Three loadbearing properties this v1 publishes:

1. **Plaintext credentials never cross the response boundary.** The
   proxy makes the upstream call and returns only the upstream's
   response. A caller observing every request, response, error, log,
   and metric MUST NOT be able to reconstruct the credential value.
2. **Identity-scoped access.** Each stored credential carries an
   `allowedSubs` glob list. The proxy refuses to use a credential
   unless the verified caller identity matches an entry in that list.
3. **Audit by receipt.** Every proxy call commits to a per-peer
   `peer_receipts` row with `(peerFp, service, upstream_status,
   upstream_url_path, …)` — but NOT the credential value. A third
   party with the master pubkey can verify a peer's history offline.

## Relationship to other specs

```
                   cloister-spec/credential-isolation/v1
                                  ▲
                                  │ consumes
                                  │
              ┌───────────────────┴───────────────────┐
              │                                       │
   interlace-spec/0.1.0                  @notme/contract
   (identity bytes)                      (scope names, OIDC algs,
                                         error codes, CONTRACT_VERSION)
```

This v1 **CONSUMES**:

- `interlace-spec/0.1.0/` — for the lease envelope, cert chain, and
  request signature shape. Identity is Interlace; this v1 does not
  re-specify it.
- `@notme/contract` — for the scope vocabulary (`cred:read`,
  `cred:write`, `cred:proxy`, `cred:list`), OIDC alg policy, and
  error status mapping. This v1 references the constants by name; it
  does not duplicate them.

This v1 **DEFINES** (new content not in either upstream spec):

- The `/vault/proxy/<service>/<upstream-path>` request/response wire
  shape.
- Five injection strategies: `authorizationBearer`,
  `authorizationBasic`, `headerNamed`, `queryParam`, `bodyField`.
- The audit receipt commitment shape for proxy calls.

## Document map

- `README.md` (this file) — the spec proper.
- `wire/proxy-envelope.md` — HTTP request + response shape for `POST
  /vault/proxy/<service>/<path>`, including how Interlace lease
  headers flow through.
- `wire/injection-strategies.md` — the five strategies, each with a
  worked input → output example.
- `wire/receipt-commitment.md` — the receipt fields, the canonical
  signing input, and the explicit "MUST NOT commit" list.
- `wire/error-responses.md` — error shapes specific to the proxy
  capability; references `@notme/contract`'s `ERROR_STATUS` for the
  shared set.
- `vectors/` — canonical inputs + expected digests. JSON-as-carrier
  per `interlace-spec/0.1.0/` convention (hex-encoded bytes + named
  byte-ranges).
- `ref-impl-py/` — Python reference implementation. If your bytes
  match these vectors via `python conformance/run.py`, you're
  conformant.
- `conformance/` — test runner any implementation drives against a
  running cloister/credential-isolation/v1 service to validate
  byte-equality.

## The proxy wire shape (summary; see `wire/proxy-envelope.md`)

```
POST /vault/proxy/<service>/<upstream-path>
Interlace-Cert: <der-base64url>
Interlace-Cert-Chain: <chain-base64url>
Interlace-Sig: <signature-base64url>
Interlace-Nonce: <nonce-base64url>
Interlace-Ts: <unix-ms-decimal>
Content-Type: <upstream-content-type>
<body>

→ verify Interlace lease per interlace-spec/0.1.0 §3 (lease envelope)
→ resolve (verifiedLease.peerFp, service) → CredentialRecord
→ check verifiedLease.peerFp matches credential.allowedSubs (glob)
→ resolve service's injection strategy from manifest
→ build upstream request: <upstream-base-url>/<upstream-path> + body,
  with credential injected per strategy
→ stream upstream response back unchanged (status, headers, body)
→ emit Interlace receipt committing to:
    peerFp, service, upstream_status, upstream_url_path,
    request_size_bytes, response_size_bytes, wall_clock_ms
  but NOT credential value
```

## Injection strategies (summary; see `wire/injection-strategies.md`)

| Strategy | Manifest tag | Wire transformation |
|---|---|---|
| `authorizationBearer` | `injection = ( authorizationBearer = () )` | adds `Authorization: Bearer <secret>` to outbound |
| `authorizationBasic` | `injection = ( authorizationBasic = () )` | adds `Authorization: Basic <b64(user:secret)>` (user from cred metadata) |
| `headerNamed` | `injection = ( headerNamed = "x-api-key" )` | adds named header with `<secret>` value |
| `queryParam` | `injection = ( queryParam = "api_key" )` | appends `?api_key=<secret>` (URL-encoded) |
| `bodyField` | `injection = ( bodyField = "client_secret" )` | merges JSON body field (JSONPath supported for nested) |

The union is **closed by design** in v1. New strategies require a
spec extension + a new conformance vector. **No raw shell-out or
arbitrary template strategy ever.**

## Receipt commitment (summary; see `wire/receipt-commitment.md`)

```
canonical_receipt_input = UTF-8 concat, separator '\n', of:
  "cloister/credential-isolation/v1"
  peerFp_hex
  service
  upstream_status_decimal
  upstream_url_path
  request_size_bytes_decimal
  response_size_bytes_decimal
  wall_clock_ms_decimal
  ts_ms_decimal
  nonce_hex
```

The receipt signature commits to `sha256(canonical_receipt_input)`.
The credential value is NOT part of `canonical_receipt_input`.

**MUST NOT commit (security-load-bearing):**
- The credential value, in any form (raw, hashed, partial, length).
- The upstream's request body (may contain user PII).
- The upstream's response body (may contain user PII).
- Any query string component (may contain user PII or signed URLs).
- The credential's `allowedSubs` policy.

A conformant implementation that commits to any of the above fails
the conformance suite.

## Errata + clarifications

(None yet — this is the initial draft.)

## Versioning

This is v1. Breaking changes require a new directory
(`cloister-spec/credential-isolation/v2/`) and a new capability name
in the manifest (`cloister/credential-isolation/v2`). Within v1,
errata-only changes that don't break test vectors are clarifications;
they update the README/wire docs but leave `vectors/` byte-stable.

## Tracking

- ADR: `docs/adr/0024-credential-isolation-capability.md` in cloister.
- Bead: `cloister-8f57f0`.
- Framing: `cloister-1b59a2` (substrate-as-kernel — this is the first
  concrete capability under that umbrella).
