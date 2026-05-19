# Wire — error responses

Error shapes a `cloister/credential-isolation/v1` proxy returns on
the `POST /vault/proxy/<service>/<upstream-path>` surface. Pinned by
the route handler at `src/routes/vault-proxy.ts:488` (`CONSTANT_TIME_ERROR_BODY`)
+ the wire-shape collapse at `src/routes/vault-proxy.ts:collapseWireShape`
(unifies vault-DO-emitted bodies at the route boundary).

The load-bearing property: **a probing client cannot distinguish
authorization failures from credential-existence failures, nor
substrate identity, nor service-registry membership**. Status codes
remain the legitimate operator signal; body bytes collapse to
byte-equal shapes within each failure class. This preserves the
§9.4.b enumeration-oracle closure from `cloister-aa9376` (also
documented in the disclosure endpoint at `src/routes/disclosure.ts`)
**plus** closes Oracle O1/O2/O4 from the 2026-05-18 adversarial cycle
(cross-cut X-2 / `cloister-6eba0a`).

## Two canonical wire shapes

The route layer owns the wire contract. Vault DO emits its own
debug-friendly bodies internally (Shape V*, see "internal shapes"
below) which are appropriate for direct DO callers; the route
boundary rewraps them through `collapseWireShape` before returning
to the wire. Two output shapes survive:

Both are JSON with `Content-Type: application/json` +
`Cache-Control: no-store` + `X-Content-Type-Options: nosniff` (per
"Header invariants on error paths" below).

### Shape R — access failure (401 / 403 / 404 / 429)

```json
{"error":"unauthorized","reason":"credential not available or caller not authorized"}
```

| HTTP status | Trigger |
|---|---|
| 401 | Lease verifier returned `{ok:false, status:401}` (no `INTERLACE_ROOT_PUBKEY`, expired cert, signature mismatch, etc.) |
| 404 | Service name not declared in the manifest's `vaultProxyServices` registry |
| 404 | No credential row at `(subjectFp, service)` — vault DO 404 collapsed by the route |
| 404 | Row exists but `peerFp ∉ allowedSubs` (already collapsed from 403 per cloister-aa9376 inside the DO; the route collapse preserves) |
| 403 | (Reserved — currently no path emits 403 on the wire; both vault DO + route collapse 403→404) |
| 429 | Per-(peerFp, service) sustained rate budget exhausted, or per-DO concurrent in-flight cap reached. **`Retry-After` header preserved.** |

**Byte-equal across all triggers within this class.** An attacker
observing 401/403/404/429 responses on `/vault/proxy/*` learns the
status code class but cannot distinguish which failure gate fired,
which substrate served the response, or which services are
registered. The 503 trigger from the original Shape R formulation
moves to Shape U (it's an upstream/substrate-class failure, not an
access-class one).

### Shape U — upstream failure (502 / 503)

```json
{"error":"upstream_unavailable"}
```

| HTTP status | Trigger |
|---|---|
| 502 | The vault DO's `fetch(proxyReq)` threw OR returned a non-Response error before any upstream byte was seen |
| 502 | `VaultDoCredentialStore.forward()` caught an error from the DO RPC (e.g. DO eviction, binding missing at runtime) |
| 503 | Lease verifier returned `{ok:false, status:503}` (CA bundle unavailable; treat as transient) |
| 503 | `VaultDoCredentialStore` constructed with no `env.VAULT_STORE` binding (formerly leaked as `{error:"vault_unavailable"}` per Oracle O2; now collapsed) |

**Byte-equal across all triggers within this class.** Crucially:
by the time a U-shape is observed, the caller has either passed
access checks (502 paths) OR is hitting a substrate transient
(503 paths). Status code differentiates the operator signal; body
doesn't leak which sub-class fired.

**Other 5xx (500, 504, etc.) pass through verbatim** — those are
upstream-authored bodies the proxy is just relaying.

## Internal shapes (NOT on the wire)

Vault DO emits these for direct DO callers + structured logs. The
route layer **always rewraps them** before returning to the wire,
so a client never sees them on the `/vault/proxy/*` surface.

### Shape V* — vault-DO internal rejection

```json
{"error":"not_found","service":"<service-name>"}
```

The `<service-name>` lets direct DO callers (today: only the
cred-iso/v1 route) route the error correctly. The route layer
collapses this to Shape R before emitting to the wire. Future
direct-DO callers (other than the cred-iso/v1 route) MUST apply
the same collapse pattern or the substrate-internal shape leaks.

## Upstream pass-through

Upstream-emitted **non-error** statuses (2xx + 3xx) pass through
verbatim. The upstream service's response body is the wire body.
Upstream **error** statuses (4xx + 5xx **other than** 502/503) also
pass through verbatim — those are the upstream's authored errors,
not the proxy's; collapsing them would lose information the caller
genuinely needs (e.g. an OpenAI rate-limit body that documents
which model + which limit hit).

The collapse therefore applies ONLY to statuses the proxy itself
emits: 401/403/404/429/502/503. Any other status the proxy returns
came from upstream verbatim.

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
