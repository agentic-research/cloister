# Wire — proxy envelope

The `POST /vault/proxy/<service>/<upstream-path>` request and response
shape for `cloister/credential-isolation/v1`.

## Request

```
POST /vault/proxy/<service>/<upstream-path>[?<query>]
Host: <cloister-host>
Interlace-Cert: <der-base64url-no-pad>
Interlace-Cert-Chain: <chain-cbor-base64url-no-pad>
Interlace-Sig: <ed25519-sig-base64url-no-pad>
Interlace-Nonce: <22-byte-nonce-base64url-no-pad>
Interlace-Ts: <unix-ms-decimal>
Content-Type: <inferred-from-skill>
[other client headers]

<request body bytes>
```

**Header semantics** are inherited verbatim from `interlace-spec/0.1.0/
wire/lease-envelope.md` §3.2 — this v1 does NOT re-specify the lease
envelope. The four Interlace-* headers + canonical request signing
input MUST match interlace-spec/0.1.0 byte-for-byte.

**`<service>`** is the logical service name declared in the
substrate's manifest (e.g. `openai`, `anthropic`, `github`). It does
NOT include slashes; the path component after `<service>/` is
forwarded to the upstream verbatim (URL-encoded segments preserved).

**`<upstream-path>`** is everything after the `<service>/` boundary,
including the leading slash if any. Example:

```
POST /vault/proxy/openai/v1/chat/completions
                  └─────┘ └─────────────────┘
                  service   upstream-path
```

Forwarded upstream as `POST https://api.openai.com/v1/chat/completions`
(upstream base URL from manifest).

**`[?<query>]`** is preserved verbatim onto the upstream URL UNLESS
the injection strategy is `queryParam`, in which case the named
parameter is appended (after URL encoding). Operators MUST NOT use
`queryParam` for services where the skill itself sets query strings
(behavior in that case is implementation-defined).

## Request canonicalization (for signing)

The request signature in `Interlace-Sig` is computed over the
canonical request bytes per `interlace-spec/0.1.0/ wire/lease-envelope.md`
§3.4:

```
canonical = METHOD + "\n" + URL + "\n" + TS_MS + "\n" + NONCE_B64URL + "\n" + BODY
```

For this capability, **URL is the full `/vault/proxy/<service>/...`
path as observed by cloister-router**, NOT the upstream URL. This is
the path the caller signed against; the proxy's URL rewriting to
upstream happens AFTER signature verification.

## Response

The proxy streams the upstream response back **unchanged**:

```
<upstream-status-code> <upstream-status-message>
<all upstream response headers, except those reserved below>
Interlace-Receipt: <signed-receipt-base64url>

<upstream response body, streamed unchanged>
```

**Reserved response headers** (set/overwritten by the proxy, not
copied from upstream):

- `Interlace-Receipt` — required, the signed audit receipt for this
  call (see `receipt-commitment.md`).
- `Server` — set to `cloister/credential-isolation/v1`.

**All other upstream response headers MUST pass through unchanged**,
including `Content-Type`, `Content-Length`, `Transfer-Encoding`,
`Set-Cookie`, etc. The proxy is wire-transparent.

## Error responses

Errors specific to credential-isolation/v1 use the shared
`@notme/contract` `ERROR_STATUS` mapping where applicable; this v1
adds capability-specific reasons. See `error-codes.md`.

Three error classes worth calling out:

### 401 Unauthorized — Interlace lease invalid

The lease failed verification per `interlace-spec/0.1.0/` §3.2.
Body: `{"error":"unauthorized","reason":"interlace lease verification failed"}`.

### 403 Forbidden — allowedSubs mismatch

The lease was valid but its `peerFp` does not match the credential's
`allowedSubs` glob.
Body: `{"error":"forbidden","reason":"caller not authorized for this credential"}`.

The error message **MUST NOT distinguish** between "credential exists
but peerFp not allowed" and "no credential for this service" — both
return 403 with the same body (constant-time-shape — prevents the
proxy from being used to enumerate which credentials are stored).

### 404 Not Found — service not declared in manifest

The `<service>` path component is not a `vaultProxyService` declared
in the manifest. Returns 404 with the same body as the unauthorized
case (constant-time shape across 401/403/404 — see error-codes.md).

## What MUST NOT appear in the response

- The credential value (in any form: raw, hashed, partial,
  URL-encoded, base64'd, in a header, in a body, in an error message).
- The credential's `allowedSubs` list (caller-visible enumeration of
  who else can use this credential is a separate enumeration oracle).
- The upstream base URL (caller already knows the service name; the
  upstream URL is the substrate's choice and changing it must not
  break callers).
- The KEK source URL (where the credential is encrypted; reveals
  substrate-internal infrastructure).

A conformant implementation that leaks any of the above in any wire
path (success, error, header, body, log emitted in-band) fails the
conformance suite.
