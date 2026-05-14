# interlace-spec 0.2.0 amendment: URL canonicalization (closes §3.2 reverse-proxy gap)

> **Status**: Draft, design proposal 2026-05-11.
> **Target version**: interlace-spec 0.2.0 (breaking change from 0.1.0).
> **Tracking bead**: `cloister-aecd26`.
> **Pairs with**: [`RECEIPTS.md`](RECEIPTS.md) — receipts inherit the
> canonical-bytes definition this document ratifies. The two land in 0.2.0
> together. RECEIPTS.md §5 ("Interaction with URL canonicalization")
> references this amendment for the authoritative `request_hash` byte
> source.

## 1. Background

[interlace-spec/0.1.0 §3.2](../0.1.0/wire/lease-envelope.md) defines the
canonical signing input for an authenticated request as:

```
<method>\n<url>\n<ts>\n<nonce-b64url-no-pad>\n<body>
```

where `<url>` is "the full request URL as the caller signed it." The
spec then acknowledges:

> The recipient uses the URL it observes; if a reverse proxy rewrote
> the URL between the caller and the recipient, the signature will
> fail. Implementations SHOULD agree on whether to sign the public URL
> or the back-end URL per deployment; cloister signs whatever appears
> in the worker's `request.url`.

The "SHOULD agree" framing is operationally inadequate. Every
production deployment Interlace targets sits behind a reverse proxy
that rewrites URLs by default:

| Proxy / gateway          | Default rewrite behavior                                          |
|---|---|
| **Cloudflare Workers**   | Sees the public URL; mostly stable, but `cf.tunnel` rewrites host. |
| **AWS API Gateway**      | Strips the stage name (`/prod/foo` → `/foo` at the integration target). |
| **AWS ALB**              | Rewrites host header; path passes through. |
| **Kong**                 | Strips the route's `paths` prefix by default (`strip_path: true`). |
| **Envoy / Istio**        | `prefix_rewrite` is a stock route filter; widely used in service-mesh deployments. |
| **NGINX ingress**        | `nginx.ingress.kubernetes.io/rewrite-target` is the canonical way to expose backends. |
| **HAProxy**              | `http-request set-path` / `regsub` paths are first-class config. |
| **Caddy**                | `handle_path` strips a matched prefix before forwarding. |
| **Traefik**              | `StripPrefix` and `ReplacePathRegex` are standard middlewares. |

Empirical assertion: there is no plausible production deployment in
which the URL the **caller** signed and the URL the **verifier** sees
are byte-identical without explicit operator configuration to ensure
preservation. The 0.1.0 framing punts this configuration to "you'll
figure it out," and in practice every operator who deploys behind
even one layer of proxy will hit a 100% signature-fail rate on the
first real request.

This is a **production-blocking** issue for v0.1.0 deployments behind
any standard ingress. v0.2.0 must replace the punt with a normative
canonicalization rule that survives common rewrites.

The canonicalization rule additionally constrains
[`RECEIPTS.md`](RECEIPTS.md) §2.1's `request_hash` — A's receipt
commits to `SHA-256(request_canon)`, and `request_canon` is the bytes
this document defines. If the two specifications disagreed on what
URL bytes are signed, the 0.2.0 spec would be internally inconsistent
and receipts would be unverifiable in exactly the deployments they
target. See §6 for the cross-spec invariant.

## 2. Problem statement

Concretely, the request lifecycle is:

```
   P (caller)              Reverse proxy              A (verifier)
   ───────────             ─────────────             ──────────────
   signs over              receives                   sees
   url = U_P               url = U_P                  url = U_A
                           rewrites U_P → U_A
                           forwards
```

P signs over `canonical(method, U_P, ts, nonce, body)`. A verifies
`Ed25519.verify(epk, sig, canonical(method, U_A, ts, nonce, body))`.

When `U_P ≠ U_A` the signature check fails. Standard rewrite cases:

### 2.1 Prefix stripping (most common)

Operator routes `https://api.example.com/v1/cluster/mcp` to a backend
at `https://internal/mcp` by stripping `/v1/cluster`.

- `U_P = "https://api.example.com/v1/cluster/mcp"`
- `U_A = "https://internal/mcp"`

Both host AND path differ. Affects Cloudflare with CF Tunnel,
AWS API Gateway, Kong, Envoy, NGINX ingress, HAProxy, Caddy,
Traefik — i.e., everything in §1's table.

### 2.2 Host rewriting (ALB-style)

Public hostname differs from the backend hostname:

- `U_P = "https://api.example.com/mcp"`
- `U_A = "https://internal-svc.svc.cluster.local/mcp"`

Path is preserved; host is rewritten. AWS ALB, GCP load balancers, and
internal service meshes all do this.

### 2.3 Trailing-slash normalization

Some proxies emit `/mcp` for `/mcp/` or vice versa:

- `U_P = "https://api.example.com/mcp/"`
- `U_A = "https://api.example.com/mcp"`

NGINX with `merge_slashes on` (the default) does this. CDN edge nodes
sometimes do this for cache-key normalization.

### 2.4 Query-parameter reordering

A proxy or HTTP client library may reorder query parameters for cache
normalization:

- `U_P = "https://api.example.com/mcp?b=2&a=1"`
- `U_A = "https://api.example.com/mcp?a=1&b=2"`

Cloudflare's argo cache can do this; some Go `net/url` re-serializers
sort keys; OpenAPI client generators sometimes alphabetize.

### 2.5 Percent-encoding case folding

`%2F` vs `%2f` are equivalent per RFC 3986 §6.2.2.1 but byte-distinct:

- `U_P = "https://api.example.com/mcp?path=%2Fhome"`
- `U_A = "https://api.example.com/mcp?path=%2fhome"`

HTTP/2 clients on some platforms canonicalize to lowercase hex; HTTP/1
servers usually preserve as-emitted. The byte forms differ even when
the proxy "preserves" the URL.

### 2.6 Scheme rewriting

TLS-terminating proxies rewrite `https://` to `http://` on the
internal hop:

- `U_P = "https://api.example.com/mcp"`
- `U_A = "http://internal/mcp"`

Common with AWS ALB, GCP load balancers, and Kubernetes ingress
controllers in front of plaintext-pod backends.

### 2.7 Summary

Every rewrite class above is *expected behavior* of widely-deployed
reverse proxies operated by competent SREs. None of them is
misconfiguration. The 0.1.0 spec's signed-URL definition is
incompatible with all of them.

## 3. Design options

Five options surfaced during design review (the tracking bead lists
them; this section evaluates each). Two additional options are
included for completeness.

### 3.1 Option 1 — Signed canonical URL only

P signs the **canonical absolute URL** (scheme + authority + path +
query, normalized per RFC 3986 §6.2). A verifies against the same
canonical form derived from `request.url`.

- (a) Survives proxies: **No.** Canonicalization doesn't address
  prefix stripping, host rewriting, scheme rewriting, or trailing-
  slash normalization — those change the URL semantically, not just
  byte-form.
- (b) Cross-implementation byte-equality: **Yes**, if RFC 3986
  normalization is followed exactly. But implementations
  (Go `net/url`, Python `urllib.parse`, JS `URL`, Rust `url`) disagree
  on edge cases (empty path, port-with-default, percent-encoding
  reserved-char handling), so "exactly" is harder than it looks.
- (c) Complexity: medium. A canonicalization library or hand-rolled
  rules with extensive test vectors.
- (d) Receipts compatibility: trivially yes — `request_hash` is over
  the canonical URL.

**Verdict:** Doesn't solve the actual problem. Strawman option;
addresses only §2.5 (case folding) and partially §2.3 (trailing
slash). Reject.

### 3.2 Option 2 — Per-route-template signing

P signs the **JSON-RPC method name** (or route template) rather than
the URL, e.g., `"tools/call:bead_create"` instead of any URL.

- (a) Survives proxies: **Yes** — the URL doesn't appear in the
  canonical bytes at all.
- (b) Byte-equality: trivial — route templates are short ASCII strings.
- (c) Complexity: low at the verifier; medium at the spec level
  (defining the route-template grammar for every route kind).
- (d) Receipts compatibility: yes, but RECEIPTS.md's claim that the
  receipt commits to the request being verified weakens — the
  receipt would commit to "P called `tools/call:bead_create`," but
  not to *which* call (URL identifies endpoint instance + path
  params).

**Verdict:** Reduces the binding strength. Loses the URL's role as
a *target identity* (which deployment, which path) in the signature.
Acceptable for some closed-grammar protocols (JSON-RPC over a single
endpoint) but breaks down for any RESTful or REST-adjacent route.
Cloister already routes `GET /interlace/peers/{fp}` with `{fp}` as a
path parameter that materially identifies the resource being read —
this option would either need to inline path params into the
template (re-introducing the canonicalization problem) or drop them
from the signature (losing binding). Reject for general use.

### 3.3 Option 3 — `X-Interlace-Original-URL` header

P emits `X-Interlace-Original-URL: <url-P-signed>` alongside the
existing signature headers. A's verifier uses the header value as
the URL field in canonical bytes instead of `request.url`.

- (a) Survives proxies: **Sort-of.** Headers are MORE likely to be
  preserved than path/host, but proxies strip headers too — AWS API
  Gateway strips unknown headers by default; CloudFront strips all
  headers not in the cache-key allowlist; some WAFs strip `X-` prefix
  headers entirely as a "security" default.
- (b) Byte-equality: yes, the header value is opaque to canonical
  bytes — it's whatever P emits.
- (c) Complexity: low. New header parse + canonical-bytes input
  substitution.
- (d) Receipts compatibility: yes, with consistent definition —
  `request_hash` is over canonical bytes that include the header
  value as the URL field.

**Issues:**

1. **Self-referential signing.** P signs a URL field that P controls
   and that the proxy may not see. An attacker who compromises P's
   signing key (which is the leak-resistance assumption Interlace
   already makes) can decouple "the URL I signed" from "the URL I
   actually requested" — but that's no different from compromising
   P generally, so no new attack surface.

2. **Header preservation in the wild.** Even with the
   `Interlace-Original-URL` naming (no `X-` per RFC 6648), proxies
   may strip unknown headers. Operators must configure preservation
   explicitly. This is the same problem the spec is trying to solve,
   just relocated to a different header.

3. **Trailing-newline ambiguity in canonical bytes.** The canonical
   format is `method\nurl\nts\nnonce\nbody`. The `url` field is
   bounded by LFs; an attacker who can inject an LF into the header
   value (RFC 9112 §5 forbids it, but parsers vary) could shift the
   field boundary.

**Verdict:** Workable, but pushes the configuration burden from
"preserve URL" to "preserve a specific header" — a lateral move that
doesn't simplify operator config. Keep as a secondary option for
deployments where Option 5 doesn't fit; not the recommendation.

### 3.4 Option 4 — TLS exporter channel binding

P binds the signature to the TLS session via RFC 9266 exporter
material. A verifies that the same exporter binds the back-end TLS
session.

- (a) Survives proxies: **No, by design.** TLS-terminating proxies
  break exporter binding because the inner and outer TLS sessions are
  distinct. Only works for end-to-end TLS deployments.
- (b) Byte-equality: trivial — exporters are 32-byte fixed values.
- (c) Complexity: HIGH. Requires runtime access to TLS exporter
  material from the worker, which **workerd does not expose**.
  workerd's `Request` API gives no hook into the underlying TLS
  session. Cloudflare Workers production has no exporter access.
- (d) Receipts compatibility: orthogonal; receipts would commit to
  the exporter, but P and A would need to agree on which TLS session
  the exporter came from.

**Verdict:** Architecturally incompatible with cloister's substrate
(workerd has no TLS exporter API). Also misses the whole class of
TLS-terminating proxies, which is most of them. Reject for v0.2.0;
revisit if a non-workerd implementation lands and the deployment
guarantees end-to-end TLS.

### 3.5 Option 5 — Sign path-suffix after configurable prefix

The canonical URL field is replaced by the **path-suffix relative to
an operator-declared prefix.** A's deployment declares its prefix in
`.well-known/interlace/index.json`; P fetches the declaration during
trust setup and signs over the path-suffix only.

Concretely:

```
canonical = "<method>\n<path-suffix>\n<ts>\n<nonce-b64>\n<body>"
```

where `<path-suffix>` is the path component of P's request URL after
stripping the declared prefix, with a normalization rule (see §4).

A's verifier:

1. Reads its own declared prefix from its deployment config.
2. Reconstructs the path-suffix from `request.url`'s path.
3. Recomputes canonical bytes with the path-suffix.

The host, scheme, and prefix are NOT signed. Only:

- Method
- Path-suffix (with normalization)
- Timestamp, nonce, body

Survives §2.1 (prefix stripping by definition), §2.2 (host rewriting,
host isn't signed), §2.6 (scheme rewriting, scheme isn't signed).

Doesn't survive §2.3 / §2.4 / §2.5 by itself — those need additional
normalization rules (§4) that both ends apply.

- (a) Survives proxies: **Yes** for the §2.1/§2.2/§2.6 cases (the
  common ones). The §2.3/§2.4/§2.5 cases (trailing slash, query
  reorder, percent-encoding) need normalization rules but are tractable.
- (b) Byte-equality: yes — `path-suffix` is well-defined per §4 with
  test vectors.
- (c) Complexity: medium. Need:
  - Prefix declaration in `.well-known/interlace/index.json`.
  - Normalization spec for path-suffix (§4).
  - P-side prefix fetch + cache.
- (d) Receipts compatibility: yes — `request_hash` is over canonical
  bytes that include the path-suffix.

**Verdict:** Strongest option. Survives the dominant rewrite class
(prefix stripping) by removing the prefix from the signature
altogether, rather than fighting the proxy to preserve it. Host and
scheme drop out for the same reason. The remaining edge cases (query
order, percent-encoding) are tractable with a small set of
normalization rules.

### 3.6 Option 6 — `Forwarded` header reconstruction (additional)

P signs over the URL it sent; A reconstructs the original URL from
[RFC 7239](https://www.rfc-editor.org/rfc/rfc7239) `Forwarded` header
values that the proxy adds.

- Most proxies emit `X-Forwarded-Host`, `X-Forwarded-Proto`,
  `X-Forwarded-Prefix` (Traefik/NGINX/Caddy/HAProxy variants).
- Less commonly the RFC 7239 standard `Forwarded` header.

**Verdict:** Inverts Option 3: instead of P telling A what URL P
signed, A asks the proxy what URL P saw. Same configuration burden
(operator must enable the forwarded-header on every hop), but more
fragile because A trusts the proxy's reconstruction rather than P's
declaration. Reject — Option 5 strictly dominates.

### 3.7 Option 7 — Hybrid prefix + optional URL claim (additional)

Combine Option 5 (path-suffix base) with an optional
`Interlace-Original-URL` header (Option 3 form) that P emits when its
deployment wants stronger host/scheme binding.

A's verifier:

- If the header is present and the deployment policy enables it: use
  the full URL form (Option 3 semantics).
- Otherwise: use path-suffix form (Option 5 semantics).

- (a) Survives proxies: depends on which mode is active.
- (b) Byte-equality: yes, with explicit mode selection in
  `.well-known/interlace/index.json`.
- (c) Complexity: highest of all options — two canonical-bytes
  formats, mode negotiation, header preservation when in URL mode.
- (d) Receipts compatibility: depends on mode, but consistent within
  a deployment.

**Verdict:** Worth considering as a v0.3.0 extension if Option 5 turns
out to be insufficient. Not for v0.2.0 — premature complexity for a
problem Option 5 solves on its own for the cases we have evidence of.

## 4. Recommendation: Option 5 (path-suffix with normalization)

**Recommended canonical signing input for v0.2.0:**

```
<method>\n<path-suffix>\n<ts>\n<nonce-b64url-no-pad>\n<body>
```

where `<path-suffix>` is derived from P's request URL by the
normalization rules in §4.2.

Rationale:

1. **Addresses the dominant rewrite class (prefix stripping) by
   construction.** Removing the prefix from the signature means no
   proxy preservation is required.
2. **Drops host and scheme from the signature**, eliminating §2.2
   (host rewriting) and §2.6 (scheme rewriting) as failure modes.
3. **Tractable normalization for query and percent-encoding** (§4.2).
4. **Receipts inherit cleanly** — `request_hash = SHA-256(canonical
   bytes including path-suffix)`. RECEIPTS.md §5's claim that
   `request_hash` is over "the URL P signed (pre-rewrite)" remains
   true; "the URL P signed" is now precisely the path-suffix.
5. **Operator configuration is one field** — declare the prefix in
   `.well-known/interlace/index.json`. Compare Option 3 (configure
   header preservation on every proxy hop) or status quo (configure
   every proxy to not rewrite URLs, which is fighting the proxy's
   purpose).

### 4.1 Prefix declaration

A's deployment publishes its public-facing routing prefix in
`.well-known/interlace/index.json`:

```jsonc
{
  // ... existing fields (CA bundle, receipt modes, etc.) ...
  "url_canonicalization": {
    "version": "v1",
    "prefix": "/v1/cluster"
  }
}
```

- `prefix` is the operator-declared path prefix that P's request URL
  will carry but that A's verifier should ignore. Per §4.2.1.
- `prefix` MUST start with `/`, MUST NOT end with `/`, and MUST NOT
  contain percent-encoded bytes. Operators wanting a percent-encoded
  prefix MUST emit the decoded form here. Implementations MUST reject
  prefix values that contain `%` or any byte ≤ 0x20.
- `prefix == ""` (the empty string) means no prefix; the path-suffix
  is the full path. This is the default for direct deployments
  (workerd local, raw Cloudflare Workers without CF Tunnel
  prefix-mounting).

A's verifier MUST cache the prefix declaration and re-fetch on the
same cadence as the CA bundle (cloister: 4 minute interval,
0.1.0 §1.2). A prefix change is treated as a route version bump —
in-flight signatures under the old prefix MUST continue to verify
under it for the duration of one cert TTL window (5 minutes).

### 4.2 Path-suffix derivation

Given P's request URL `U_P` and the declared prefix `prefix`, the
canonical path-suffix is computed as follows:

1. **Extract the path.** Parse `U_P` per [RFC 3986](https://www.rfc-editor.org/rfc/rfc3986)
   and extract the `path` and `query` components. Discard scheme,
   authority, and fragment.
2. **Strip the prefix.** If `path` starts with `prefix + "/"` or
   `path == prefix`, strip the prefix from the start. Otherwise the
   request is **un-canonicalizable** and MUST be rejected by A as
   `bad_request_sig`.
3. **Normalize the remaining path.** Apply the rules in §4.3.
4. **Normalize the query.** Apply the rules in §4.4.
5. **Reassemble.** `<path-suffix> := <normalized-path> [ "?" <normalized-query> ]`,
   where the `?` and query are omitted iff the normalized query is
   empty.

### 4.3 Path normalization rules

Both P and A apply these rules to the path between strip and
canonical-bytes emission:

1. **Empty path → "/".** If after stripping the prefix the path is
   empty, the canonical path is `/`. This handles `prefix = "/api"`
   with `path = "/api"` (root-of-route case).
2. **Trailing-slash normalization.** A path that ends with a single
   trailing `/` other than the root `/` is normalized to omit the
   slash. `/foo/` → `/foo`; `/` → `/`.
3. **Repeated slash collapse.** Consecutive `/` runs are collapsed
   to a single `/`. `/foo//bar` → `/foo/bar`.
4. **Dot-segment removal.** `.` and `..` segments are removed per
   RFC 3986 §5.2.4. `/foo/./bar` → `/foo/bar`; `/foo/../bar` →
   `/bar`.
5. **Percent-encoding case folding.** All hex digits in percent-encoded
   triplets are normalized to uppercase. `%2f` → `%2F`. (RFC 3986
   §6.2.2.1 says uppercase is canonical, though that section is
   informative; this spec promotes it to normative.)
6. **Unreserved character decoding.** Percent-encoded bytes that
   represent RFC 3986 §2.3 unreserved characters (`ALPHA / DIGIT / "-"
   / "." / "_" / "~"`) are decoded to their literal form. `%41` → `A`;
   `%2D` → `-`. This handles the case where one HTTP client emits
   `%41` and another emits `A`.
7. **Reserved character encoding preserved.** Percent-encoded bytes
   that represent RFC 3986 §2.2 reserved characters (`/`, `?`, `#`,
   `[`, `]`, `@`, `!`, `$`, `&`, `'`, `(`, `)`, `*`, `+`, `,`, `;`,
   `=`) are NOT decoded — their literal vs encoded form is
   semantically significant in URLs and changing it would change the
   request target.

### 4.4 Query normalization rules

1. **Empty query.** If the query is missing or empty after the `?`,
   the canonical form omits the `?` entirely (and the `<path-suffix>`
   contains no `?`).
2. **Key-value pair extraction.** Parse the query as `key=value` pairs
   delimited by `&`. A pair with no `=` is treated as
   `key=` (empty value).
3. **Bytewise lex sort by key.** Sort pairs by the UTF-8 bytes of the
   key, ascending. Ties (same key, multiple values) preserve original
   order — duplicates ARE meaningful in many APIs (`?tag=a&tag=b`).
4. **Percent-encoding normalization.** Apply rules §4.3.5 and §4.3.6
   to keys and values. Reserved characters in values per §4.3.7 stay
   encoded.
5. **Empty-value pairs preserved.** `?foo=` is normalized to
   `foo=`, not stripped.

### 4.5 Un-canonicalizable requests

A request is **un-canonicalizable** if any of the following hold:

- `path` does not start with the declared `prefix + "/"` or equal
  `prefix`. The proxy has done more than prefix-strip (e.g., it has
  rewritten the path semantically, or P is hitting a different
  deployment than A's prefix declares).
- The URL is malformed per RFC 3986 (parser-rejected).
- The query contains a non-UTF-8 byte sequence after percent-decoding.

A's verifier MUST reject un-canonicalizable requests as
`bad_request_sig` rather than attempting partial canonicalization.
This matches the receipts spec's policy in RECEIPTS.md §5: rather
than emit a receipt over bytes P cannot reproduce, fail closed.

## 5. Normative spec text (drop-in to 0.2.0)

The following text replaces interlace-spec/0.1.0 §3.2 in
[`wire/lease-envelope.md`](../0.1.0/wire/lease-envelope.md) when 0.2.0
is published. It is also the authoritative reference for
RECEIPTS.md §5.

> ### 3.2 Canonical request bytes
>
> The signature is computed over UTF-8 bytes of a fixed-format string:
>
> ```
> <method>\n<path-suffix>\n<ts>\n<nonce-b64url-no-pad>\n<body>
> ```
>
> with **exactly one LF (`0x0A`) byte** between each field. No CRLF.
> No trailing newline.
>
> | Field         | Source |
> |---|---|
> | `method`      | HTTP method literal (`POST`, `GET`, etc.) |
> | `path-suffix` | Path + query of the request URL after prefix-strip and normalization per §3.3 |
> | `ts`          | Decimal Unix-ms, same value as `X-Signet-Ts` |
> | `nonce-b64url-no-pad` | base64url no-padding of the raw nonce bytes |
> | `body`        | Raw request body bytes, or empty string for GET |
>
> The host, scheme, and prefix are NOT part of the canonical signing
> input. This is a deliberate change from 0.1.0 where the full URL
> was signed; see [URL-CANONICALIZATION.md] for the rationale.
>
> ### 3.3 Path-suffix derivation (new in 0.2.0)
>
> Let `prefix` be the path prefix declared in A's
> `.well-known/interlace/index.json` under `url_canonicalization.prefix`.
>
> Given the request URL `U`, the canonical `path-suffix` is computed
> as follows. Implementations MUST apply each step in order; the
> output MUST be byte-equal across conforming implementations.
>
> #### 3.3.1 Prefix declaration
>
> The `prefix` field MUST start with `/`, MUST NOT end with `/`,
> MUST NOT contain `%`, and MUST NOT contain any byte with codepoint
> ≤ 0x20. The empty string `""` is permitted and means "no prefix."
>
> A's `.well-known/interlace/index.json` MUST include:
>
> ```jsonc
> {
>   "url_canonicalization": {
>     "version": "v1",
>     "prefix": "<prefix>"
>   }
> }
> ```
>
> When `url_canonicalization` is absent from `index.json`, conforming
> implementations MUST treat `prefix == ""` as the default. This
> preserves backward compatibility for deployments behind no proxy.
>
> #### 3.3.2 Extraction
>
> 1. Parse `U` per RFC 3986. Reject as `bad_request_sig` if parsing
>    fails.
> 2. Extract `path` and `query` from the parsed URL. Discard scheme,
>    authority, fragment.
>
> #### 3.3.3 Prefix-strip
>
> If `prefix` is empty, set `stripped_path := path` and proceed to
> §3.3.4.
>
> Otherwise:
>
> - If `path == prefix`, set `stripped_path := "/"` and proceed.
> - If `path` starts with `prefix + "/"`, set `stripped_path :=
>   path[len(prefix):]` (i.e., remove the prefix bytes; the leading
>   `/` of the slash that followed the prefix is retained) and
>   proceed.
> - Otherwise the request is un-canonicalizable. The verifier MUST
>   reject with `bad_request_sig`. No partial canonicalization is
>   permitted.
>
> #### 3.3.4 Path normalization
>
> Apply in order to `stripped_path`:
>
> 1. If empty, set to `/`.
> 2. Collapse consecutive `/` runs to a single `/`.
> 3. Resolve `.` and `..` segments per RFC 3986 §5.2.4.
> 4. Strip a single trailing `/` unless the path is exactly `/`.
> 5. For each percent-encoded triplet `%XY`:
>    - Uppercase `X` and `Y` (RFC 3986 §6.2.2.1).
>    - If the decoded byte is an RFC 3986 §2.3 unreserved character
>      (`ALPHA / DIGIT / - . _ ~`), replace the triplet with the
>      decoded byte.
>    - Otherwise leave the triplet encoded.
>
> The result is `canonical_path`.
>
> #### 3.3.5 Query normalization
>
> If the query is missing or empty, `canonical_query := ""`.
>
> Otherwise:
>
> 1. Split on `&` into `pairs`.
> 2. For each pair, split on the first `=` into `(key, value)`.
>    If no `=` is present, `(key, "")`.
> 3. Apply §3.3.4 step 5's percent-decoding rule to both key and
>    value (with the unreserved-character set; reserved bytes stay
>    encoded; hex case uppercased).
> 4. Sort `pairs` by the byte sequence of `key` in ascending
>    lexicographic order. Pairs with equal keys MUST preserve
>    their original relative order.
> 5. Reassemble as `key1=value1&key2=value2&...`.
>
> The result is `canonical_query`.
>
> #### 3.3.6 Path-suffix assembly
>
> ```
> path-suffix := canonical_path                                    if canonical_query == ""
>             := canonical_path + "?" + canonical_query            otherwise
> ```
>
> #### 3.3.7 Verifier procedure
>
> A's verifier, on receiving a request:
>
> 1. Compute `observed_path_suffix` per §3.3.2 – §3.3.6 over the URL
>    A sees in `request.url`.
> 2. Recompute canonical bytes per §3.2 with `observed_path_suffix`.
> 3. Verify the signature per the existing §3.4 pipeline.
>
> P's signer, before sending a request:
>
> 1. Fetch (or use cached) `prefix` from A's `index.json`.
> 2. Compute `signed_path_suffix` per §3.3.2 – §3.3.6 over the URL P
>    is about to send.
> 3. Sign canonical bytes per §3.2 with `signed_path_suffix`.
> 4. Emit the request. Proxies between P and A MAY rewrite host,
>    scheme, port, or prefix freely; the signature remains valid as
>    long as the path-suffix is preserved.
>
> #### 3.3.8 Prefix rotation
>
> When A changes its declared `prefix`, A MUST publish the new value
> in `index.json` and continue to accept the old value for at least
> 5 minutes (the maximum cert TTL window). Concretely: A's verifier
> tries the current-prefix-strip first; if the resulting path-suffix
> fails signature verification, A tries the immediately-previous
> prefix and verifies again. This is analogous to the bundle's
> active-key / previous-key rotation in §1.2.
>
> Implementations MUST limit this fallback to ONE previous prefix.
> Deeper rotation history is operator-discretionary and not part of
> the spec.

## 6. Compatibility with receipts (`cloister-ae713f`)

[`RECEIPTS.md`](RECEIPTS.md) §5 ("Interaction with URL canonicalization")
states:

> The `request_hash` field is computed by P over P's outgoing
> `request_canon`. If reverse proxies rewrite the URL between P and A,
> P's hash and A's hash diverge, breaking verification.
>
> This spec mandates that `request_hash` is computed over the **URL P
> signed** (pre-rewrite), and that proxies preserve a way for A to
> reconstruct the original URL form ...

This spec ratifies the canonical-bytes definition that satisfies that
mandate. Concretely:

```
request_canon       := canonical bytes per §3.2 (this spec)
                     = UTF-8(method LF path-suffix LF ts LF nonce_b64 LF body)
request_hash        := SHA-256(request_canon)
```

Both P and A compute `request_hash` over `path-suffix`, NOT over the
full URL P emitted or the full URL A received. Because path-suffix is
deterministic per §3.3 and is the SAME on P's and A's sides for
canonicalizable requests, `request_hash` is byte-equal at both ends.

The earlier RECEIPTS.md framing ("preserve a way for A to reconstruct
the original URL form ... e.g., via `X-Forwarded-Uri` or equivalent")
is **superseded** by this specification: there is no "original URL"
to reconstruct, because hosts, schemes, and prefixes were never part
of the signature in the first place. RECEIPTS.md §5 SHOULD be revised
to reference this document as the authoritative definition of
`request_canon`; that revision is tracked alongside the 0.2.0 spec
freeze.

**Cross-spec invariant.** If a future amendment changes either §3.2
(canonical bytes) here or RECEIPTS.md §2.1 (`request_hash` definition),
the other MUST be updated in the same SEP. Diverging definitions
would render the 0.2.0 spec internally inconsistent — a receipt's
`request_hash` is meant to be independently recomputable by V
(RECEIPTS.md §2.2.2 step 5) from the same canonical bytes that
verified P's signature. Receipts and the lease envelope share one
canonical-bytes definition; this document is the source of truth.

## 7. Test vectors

The following vectors are required in
[`test-vectors/url-canonicalization/`](test-vectors/url-canonicalization/).
Each implementation MUST reproduce them byte-equal.

1. `prefix-strip.json` — primary canonicalizable case. `prefix =
   "/v1/cluster"`; P signs `/v1/cluster/mcp`; A receives `/mcp`;
   both compute path-suffix `/mcp` and the signature verifies.
2. `host-rewrite.json` — host differs end-to-end but path is
   preserved. Verifies that host is not in the canonical bytes.
3. `trailing-slash.json` — P signs `/mcp/`, A receives `/mcp`; both
   normalize to `/mcp` and the signature verifies.
4. `query-reorder.json` — P signs `?b=2&a=1`, A receives `?a=1&b=2`;
   both sort to `a=1&b=2` and the signature verifies.
5. `percent-encoding-case.json` — P signs `%2F` in a query value, A
   receives `%2f`; both uppercase to `%2F` and verify.
6. `unreserved-decoded.json` — P signs `%41` in a path segment, A
   receives `A`; both normalize to `A` and verify.
7. `uncanonicalizable-reject.json` — A's prefix is `/v1/cluster`, A
   receives a request whose path starts with `/v2/cluster`. Verifier
   rejects as `bad_request_sig` (un-canonicalizable).
8. `empty-prefix.json` — `prefix = ""` (the default); path-suffix is
   the full path. Backward-compat path for direct deployments.
9. `root-of-route.json` — `prefix = "/api"`, request path is exactly
   `/api`; path-suffix is `/`.
10. `dot-segments.json` — path contains `./` and `../` segments;
    both ends apply RFC 3986 §5.2.4 and reach the same normalized
    path.
11. `prefix-rotation.json` — A's index.json declares prefix
    `/v2/cluster`; A's cache still has previous prefix `/v1/cluster`;
    a request signed under `/v1/cluster` verifies under fallback.

The test vectors carry a fixed Ed25519 keypair (the same fixture
shared with 0.1.0's `lease-envelope.json` — see
[`../0.1.0/test-vectors/README.md`](../0.1.0/test-vectors/README.md))
so that a conformant implementation that already passes 0.1.0's
envelope vectors can extend its conformance suite without
re-generating keys.

## 8. Cloister-side reference implementation (informational)

The cloister-side prototype lives as a helper function in
[`../../src/routes/lease-middleware.ts`](../../src/routes/lease-middleware.ts)
named `canonicalPathSuffix_0_2_0_prototype`. It is **NOT** wired into
the live verifier path — the production verifier still uses the
0.1.0 full-URL canonical bytes until 0.2.0 is ratified and a separate
follow-up bead lands the runtime integration. The helper exists to
demonstrate the algorithm for cross-implementation conformance and
to anchor the test-vector expected values to a reference impl.

The migration plan, when 0.2.0 ratifies:

1. New bead "wire 0.2.0 URL canonicalization into the live verifier."
2. The verifier reads `url_canonicalization.prefix` from
   `index.json` (already cached alongside the CA bundle).
3. `canonicalRequestBytes` is replaced by a new
   `canonicalRequestBytesV2` that takes the prefix and applies §3.3.
4. The old function is retained for the rotation window (one cert
   TTL = 5 minutes after the cluster bumps its spec-version
   declaration in `index.json`).
5. After the rotation window expires, the 0.1.0 verifier path is
   deleted.

Receipts (RECEIPTS.md) inherit the canonical bytes via
`request_hash = SHA-256(canonicalRequestBytesV2(...))`. The receipts
implementation lands in the same 0.2.0 cutover.

## 9. Open questions

1. **`prefix` discovery race during P's first contact.** P needs A's
   `index.json` before P can sign its first request. If P caches
   `index.json` and A rotates the prefix, P may sign under the old
   prefix until P's cache expires. The §3.3.8 rotation window
   addresses this but assumes a bounded P-side cache. Operators
   running long-cached P clients should publish a shorter `Max-Age`
   on `index.json` than their prefix-rotation cadence. Worth a
   normative MUST?

2. **Multi-prefix deployments.** Some operators front a single
   cluster with multiple public hostnames at different prefixes
   (e.g., a public API at `/v1` and a partner API at `/partner/v1`).
   v0.2.0 allows one prefix per cluster. A deployment with multiple
   prefixes would need to declare ONE in `index.json` and either
   accept that the other prefix won't canonicalize, or run two
   logical Interlace deployments. Worth extending to an array of
   prefixes in v0.3.0? Math-friend review may push on this.

3. **Backslash and Unicode path segments.** §3.3.4 doesn't say what
   to do with backslashes (`\`) or Unicode characters in the raw
   path bytes. RFC 3986 implicitly forbids them but real-world URLs
   sometimes carry them. The pragmatic answer: percent-encode any
   byte > 0x7F per RFC 3986 §3.3, and treat `\` as a literal byte
   in the path (NOT path-separator). Test vector #?? should pin
   this. Punted to round-2.

4. **Query value normalization for `+` ↔ `%20`.** HTML form encoding
   sends spaces as `+`, RFC 3986 sends them as `%20`. v0.2.0 treats
   them as distinct bytes in the signing input (because they are
   distinct on the wire). Implementations that emit one form and
   verify the other will fail signature checks. Operators using
   form-encoded clients (rare for Interlace, which is JSON-RPC over
   POST) should be aware. Worth a normative rule, or punt to round-2?

5. **Method-override headers (`X-HTTP-Method-Override`).** Some
   proxies translate `POST` with this header into `PUT`/`DELETE`/etc.
   §3.2's `<method>` is "the HTTP method as sent" — which side? P's
   POST or A's translated method? Recommend P signs over the
   logical method (matching what A's application sees), and proxies
   that translate methods MUST also rewrite `X-HTTP-Method-Override`
   semantics consistently. Worth normative text or out-of-scope?

6. **Capability negotiation with `RECEIPTS.md`'s `receipt_modes`.**
   `.well-known/interlace/index.json` will carry both
   `receipt_modes` (RECEIPTS.md §6.3) and `url_canonicalization`
   (this spec §4.1). Both are needed for a 0.2.0 P-side
   bootstrap. Test-vector #?? for `index.json` should pin a single
   canonical schema that both features share. Filed as a follow-up
   to the 0.2.0 freeze.

7. **WebSocket / `Upgrade: websocket` paths.** Interlace v0.1.0 is
   POST-over-HTTP only. If v0.3.0 adds a WebSocket binding, the URL
   the client connects to is significant for routing and `Origin`
   binding. Defer.

## 10. References

- [RFC 3986](https://www.rfc-editor.org/rfc/rfc3986) — URI Generic Syntax.
- [RFC 3986 §5.2.4](https://www.rfc-editor.org/rfc/rfc3986#section-5.2.4) — Dot-segment removal.
- [RFC 3986 §6.2.2.1](https://www.rfc-editor.org/rfc/rfc3986#section-6.2.2.1) — Percent-encoding case normalization.
- [RFC 7239](https://www.rfc-editor.org/rfc/rfc7239) — `Forwarded` header.
- [RFC 9110 §7.7](https://www.rfc-editor.org/rfc/rfc9110#section-7.7) — `:authority` and host rewriting semantics in proxies.
- [RFC 9112 §5](https://www.rfc-editor.org/rfc/rfc9112#section-5) — Header field parsing in HTTP/1.1.
- [RFC 9266](https://www.rfc-editor.org/rfc/rfc9266) — TLS exporter channel binding (Option 4 reference).
- [interlace-spec/0.1.0/wire/lease-envelope.md](../0.1.0/wire/lease-envelope.md) — Current §3.2 being replaced.
- [interlace-spec/0.2.0-draft/RECEIPTS.md §5](RECEIPTS.md) — Receipts compatibility reference.
- Kong path-stripping: [`strip_path`](https://docs.konghq.com/gateway/latest/key-concepts/routes/expressions/).
- Envoy `prefix_rewrite`: [route filters](https://www.envoyproxy.io/docs/envoy/latest/api-v3/config/route/v3/route_components.proto).
- AWS API Gateway stage stripping: [stage variables](https://docs.aws.amazon.com/apigateway/latest/developerguide/stage-variables.html).
