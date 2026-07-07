# Wire — injection strategies

The strategies a `cloister/credential-isolation/v1` proxy MUST support,
with their wire shapes — five that inject a stored credential, plus
`passthrough` (ADR-0040 amendment) which injects **none** and forwards the
caller's own auth for audit. Pinned by the route handler's discriminated-union
`InjectionStrategy` type (`src/routes/vault-proxy.ts:19`).

The strategy is declared per-service in the substrate's manifest. The
caller does NOT pick the strategy; the operator binds one per service
at deploy time. The credential bytes are stored separately
(`putCredential` time) and never appear in the request body or URL.

## Discriminated union shape

Each strategy is one variant of:

```
InjectionStrategy =
  | { kind: "authorizationBearer" }
  | { kind: "authorizationBasic" }
  | { kind: "headerNamed", name: string }
  | { kind: "queryParam",  name: string }
  | { kind: "bodyField",   path:  string }
  | { kind: "passthrough" }
```

A second implementation MUST emit byte-equal upstream requests for
every (strategy, input request) pair.

## Strategy details

### `authorizationBearer`

Sets `Authorization: Bearer <credential>` on the upstream request.
Any existing `Authorization` header on the incoming request is
**dropped**. Most common for modern API-key shapes.

```
Upstream-Authorization: Bearer <credential-bytes-verbatim>
```

The credential bytes are appended after a single ASCII space; no
encoding, no quoting. Operators MUST ensure the stored credential
does not contain CR/LF.

### `authorizationBasic`

Sets `Authorization: Basic base64(<username>:<credential>)` on the
upstream request. Username defaults to the service name when the
stored credential lacks an explicit `storedUsername`.

```
Upstream-Authorization: Basic <base64(username + ":" + credential)>
```

Base64 is RFC 4648 §4 (standard alphabet, padded). Empty usernames
are permitted (`base64(":" + credential)`); operators may use this
for token-only Basic auth.

### `headerNamed`

Sets an arbitrary named header to the credential bytes verbatim. The
header name is declared in the manifest config (`name`).

```
Upstream-<name>: <credential-bytes-verbatim>
```

Header name MUST match RFC 7230 `tchar` grammar
(`/^[!#$%&'*+\-.^_\`|~0-9A-Za-z]+$/`) — enforced at manifest-load
time. Examples: `X-API-Key`, `Apikey`, `X-Anthropic-Api-Key`.

### `queryParam`

Appends the credential as a query parameter to the upstream URL. The
parameter name is declared in the manifest config (`name`).

```
Upstream-URL: <base>/<path>?<existing-query>&<name>=<urlencode(credential)>
```

URL encoding is RFC 3986 `pchar` minus `=` and `&`. If the existing
query already contains the named parameter, the credential value
**overrides** it (operator's stored value wins). Operators MUST NOT
use `queryParam` for services where the skill itself sets query
strings under the same name — behavior is implementation-defined.

### `bodyField`

Injects the credential into a JSON body field. The path is a
dot-separated path into the JSON document (e.g. `"auth.api_key"`).
Only applies when the incoming request's `Content-Type` is
`application/json`; non-JSON bodies are rejected with a 400 at the
route layer.

```
Upstream body: parse JSON → set path to credential → re-serialize
```

Path traversal:
- `"api_key"` → top-level field
- `"auth.api_key"` → nested object; intermediate objects are created if missing
- Empty path segments (`"auth..api_key"`) are rejected at manifest-load time

The re-serialized body MUST preserve the rest of the JSON document
verbatim (ordering of unrelated keys, whitespace inside string
values, numeric precision). Implementations MAY canonicalize
whitespace between keys, but two implementations MUST emit
byte-equal bodies given the same input JSON + path + credential.

### `passthrough` (ADR-0040 amendment — audit, not custody)

The odd one out: it injects **nothing**. The proxy forwards the caller's
**own** request + auth headers to the upstream and emits the receipt, looking
up no stored credential. It runs after the lease + service-declaration +
`allowedSubs` gates, so cloister's access control still applies, but the
upstream credential is the caller's, not the vault's.

- **Use case:** OAuth-subscription harnesses (Claude Code Max) where there is
  no key to vault. cloister provides **audit** (receipts), not custody.
- **Lease hygiene (MUST):** the proxy MUST strip the cloister lease headers
  (`Authorization: Signet`, `x-signet-*`, `x-interlace-*`) so they never reach
  the upstream. Where a harness's own `Authorization` would collide with the
  lease on the inbound hop, it is carried in `X-Harness-Authorization` and
  restored to `Authorization` before forwarding.
- **No credential-required 404:** the `storedCredential === null → 404` gate is
  skipped for this kind (there is intentionally no stored credential).

## Closed-by-design

Adding a further strategy is a spec extension (new v1.x or v2). v1
implementations MUST reject manifests declaring unknown strategy
kinds at load time, not at request time. `passthrough` was added by the
ADR-0040 amendment (2026-07-07) as the audit/no-injection variant.

## What strategies do NOT cover

- **Multi-credential injection** — one strategy, one credential, one
  service. A service needing two credentials (e.g. API key + secret)
  declares two services and the skill calls both.
- **OAuth flows** — strategies inject a credential the proxy already
  holds. Acquiring tokens (refresh, exchange, device-flow) is the
  responsibility of whichever process populated the vault. v1 does
  not define a refresh hook.
- **Per-request mutation** — the credential is the same for every
  request to a given `(peerFp, service)` row. Per-request signatures
  (e.g. AWS SigV4) are a v2 surface.
