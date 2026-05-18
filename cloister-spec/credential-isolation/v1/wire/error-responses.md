# Wire — error responses

Error shapes a `cloister/credential-isolation/v1` proxy returns on
the `POST /vault/proxy/<service>/<upstream-path>` surface. Pinned by
the route handler at `src/routes/vault-proxy.ts:488` (constant-shape
errors) and `vault/src/vault.ts:187` (vault-DO-emitted errors).

The load-bearing property: **a probing client cannot distinguish
authorization failures from credential-existence failures**. Status
codes and body bytes collapse to byte-equal shapes across the
"you don't have access" outcomes. This preserves the §9.4.b
enumeration-oracle closure from `cloister-aa9376` (also documented
in the disclosure endpoint at `src/routes/disclosure.ts`).

## Two distinct shapes

Both are JSON with `Content-Type: application/json`. Implementations
MUST emit byte-equal bodies for each shape.

### Shape R — route-level rejection

Emitted by the route handler before vault DO is consulted. Covers
lease verification failures, CA-bundle unavailability, and
manifest-missing-service.

```json
{"error":"unauthorized","reason":"credential not available or caller not authorized"}
```

| HTTP status | Trigger |
|---|---|
| 401 | Lease verifier returned `{ok:false, status:401}` (no `INTERLACE_ROOT_PUBKEY`, expired cert, signature mismatch, etc.) |
| 503 | Lease verifier returned `{ok:false, status:503}` (CA bundle unavailable; treat as transient) |
| 404 | Service name not declared in the manifest's `vaultProxyServices` registry |

The 404 in this shape fires **before** the vault DO is consulted —
vault DO never sees a request for an undeclared service. This is
the route-boundary collapse.

### Shape V — vault-DO rejection

Emitted by vault DO's `proxyRequest` when the credential row is
missing OR the verified `peerFp` is not in the stored credential's
`allowedSubs` glob list. Both branches collapse to byte-identical
bodies; only structured logs at the DO call-site distinguish them
internally.

```json
{"error":"not_found","service":"<service-name>"}
```

| HTTP status | Trigger |
|---|---|
| 404 | No credential row at `(subjectFp, service)` |
| 404 | Row exists but `peerFp ∉ allowedSubs` (collapsed from 403 per cloister-aa9376) |

The `<service-name>` is the literal service name from the request
path. It IS in the response — this is intentional: the caller knows
which service they asked for, and including it lets multi-service
clients route the error correctly. A client observing many 404s for
many services cannot infer which had credentials and which didn't.

## Rate limiting

```json
{"error":"rate_limited","service":"<service-name>"}
```

| HTTP status | Trigger |
|---|---|
| 429 | Per-(peerFp, service) sustained rate budget exhausted (`vault/src/rate-bucket.ts`) |
| 429 | Per-DO concurrent in-flight cap reached (F1 burst gate from cloister-211b68) |

Both emit a `Retry-After` header in seconds. Conformant implementations
MUST set `Retry-After` to a sensible value (not 0, not negative). The
default emitter uses the token-bucket's computed `retryAfterSec`.

## Upstream errors

Upstream-emitted statuses (the upstream service the credential lets
the proxy talk to) pass through verbatim. The proxy does NOT rewrite
them. So:

- Upstream 401 → proxy 401, body = upstream's body
- Upstream 429 → proxy 429, body = upstream's body
- Upstream 500 → proxy 500, body = upstream's body
- Upstream connection failure → proxy 502 (shape U, see below)

### Shape U — upstream unavailable

```json
{"error":"upstream_unavailable"}
```

| HTTP status | Trigger |
|---|---|
| 502 | The vault DO's `fetch(proxyReq)` threw OR returned a non-Response error before any upstream byte was seen |
| 502 | `VaultDoCredentialStore.forward()` caught an error from the DO RPC (e.g. DO eviction, binding missing at runtime) |

No internal error details leak — the body is the literal four-key
object above. Implementations MUST NOT include exception messages,
stack traces, internal URLs, or upstream-host fingerprints.

## Shape V vs Shape U distinguishability

By design:
- **Shape R + Shape V** collapse the "you don't have access" outcomes
  to two byte-equal shapes (one per layer of the proxy). A correlator
  watching status + body cannot enumerate which (peerFp, service)
  tuples exist.
- **Shape U** distinguishes "we tried and the upstream failed" from
  the access-failure outcomes. This is acceptable because the
  attacker already knows they have access (they got past R + V).

## What error responses MUST NOT include

- The credential value (any encoding, any field)
- The `allowedSubs` glob list
- The `upstream` URL from the stored credential
- Internal DO IDs, instance IDs, or stack traces
- Per-request timing data that would reveal cache-vs-cold-path
  differences beyond the workerd 1ms quantization floor

## Header invariants on error paths

All error responses MUST set:

- `Content-Type: application/json`
- `Cache-Control: no-store` (prevents intermediaries from caching
  oracle-shaped responses)

Implementations SHOULD set:

- `X-Content-Type-Options: nosniff`

Implementations MUST NOT set any header that varies with the
credential's existence or the caller's authorization state beyond
the status code itself.

## Conformance

A second implementation is conformant on error responses iff:
- Every R-shape error emits byte-equal R body bytes
- Every V-shape error emits the same `{"error":"not_found","service":"<svc>"}` byte sequence (with `<svc>` substituted)
- Every U-shape error emits byte-equal U body bytes
- Status codes match the trigger matrix above

Test vectors at `cloister-954f21` (pending).
