# Wire — receipt commitment

The audit receipt a `cloister/credential-isolation/v1` proxy MUST emit
for every proxy call (success OR upstream error). Pinned by the route
handler's `ProxyCallReceipt` interface
(`src/routes/vault-proxy.ts:501`).

Receipts are the third load-bearing property of v1 (see README §"What
this capability is"): a third party with the master pubkey can verify
a peer's history offline without holding any credential bytes. This
doc specifies the receipt shape; the **signing + chain** layer is
inherited verbatim from `interlace-spec/0.1.0/RECEIPTS.md` §2.

## Receipt shape

Each receipt is exactly these ten fields:

| Field | Type | Source | Notes |
|---|---|---|---|
| `capability` | string (constant) | literal | Always `"cloister/credential-isolation/v1"` — pins the receipt to this spec version |
| `peerFp` | string (64-hex sha256) | `VerifiedLease.peerFp` | The verified caller's cert fingerprint; matches the `subjectFp` the credential was stored under |
| `service` | string | parsed from URL | Logical service name (e.g. `"openai"`); MUST NOT include slashes |
| `upstreamStatus` | integer | upstream `Response.status` | Whatever the upstream returned (200, 4xx, 5xx) — including connection-failed proxied as 502 |
| `upstreamUrlPath` | string | parsed from URL | Everything after `<service>/` including leading slash; query string is **dropped** to avoid leaking caller-controlled bytes |
| `requestSizeBytes` | integer | content-length of incoming body | 0 for GET/HEAD; for POST/PUT/PATCH the body's serialized size |
| `responseSizeBytes` | integer | content-length of upstream response body | The proxied response size; 0 on error paths that returned no body |
| `wallClockMs` | integer | route handler timing | Total proxy-call duration from inbound parse to outbound emit, in ms |
| `tsMs` | integer (unix ms) | `Date.now()` at emit | Receipt emission timestamp |
| `nonceHex` | string (32-hex) | random 16 bytes | Per-receipt nonce; pairs with the Interlace receipt-chain commitment per RECEIPTS.md §2.4 |

## Canonical encoding

Receipts are serialized as **deterministic-JSON** per
`interlace-spec/0.1.0/CDDL/canonical-json.md`:

1. UTF-8, no BOM
2. Keys sorted lexicographically by Unicode code point
3. Numbers as integers (no scientific notation, no trailing `.0`)
4. Strings escape only the required JSON characters (`\"`, `\\`,
   `\b`, `\f`, `\n`, `\r`, `\t`, plus `\uXXXX` for control bytes <
   0x20). Non-ASCII passes through as raw UTF-8.
5. No whitespace between tokens (`{"a":1,"b":2}`, not `{"a": 1, "b": 2}`)

Implementations producing the same receipt fields MUST emit byte-equal
output. The canonical bytes are what gets hashed into the chain.

## What receipts MUST NOT carry

Pinned by the no-leak Phase 5 tests (`test/routes/vault-proxy.test.ts`
scenario 2 + scenario 5 + scenario 7):

- **Credential value** (any encoding, any field, any nested location)
- **Request body bytes** (request size is captured; bytes are not)
- **Response body bytes** (response size is captured; bytes are not)
- **Query string** (caller-controlled; could carry secrets or
  enumeration-oracle inputs)
- **Stored allowedSubs list** (revealing the glob list would leak
  authorization shape across peers)
- **Upstream URL fragment** (also caller-controllable)
- **Request or response headers** (other than the metadata derived
  above — the literal header values never appear)

A v2 implementation that adds any field MUST verify its disclosure
under the "what an adversarial caller can correlate across many
receipts" test before shipping.

## What receipts MUST commit to

The receipt is chained per-peer via `interlace-spec/0.1.0/RECEIPTS.md`
§2.4: each new receipt's hash is computed over (canonical-receipt-bytes
‖ prev-receipt-hash). Forks in the chain are detectable by the
disclosure endpoint (`GET /interlace/peers/<peerFp>`) per ADR-0007.

The `nonceHex` field is what makes two otherwise-identical receipts
(same peer, same service, same status, same sizes, same ms) produce
distinct hashes — so an attacker who replays an exact request cannot
collapse two chain entries into one.

## Emission ordering

Receipts are emitted **exactly once per `POST /vault/proxy/...`
request**, regardless of outcome:

- Success (upstream 2xx) → one receipt with `upstreamStatus`=that 2xx
- Upstream 4xx/5xx → one receipt with the upstream status
- Constant-shape 404 (no credential / unauthorized) → **no receipt**
  (the request never reached the upstream; emitting a receipt would
  leak the existence-vs-authorization distinction)
- Lease verification failure (401) → **no receipt** (no verified peerFp
  to attribute to)
- Rate limit 429 → **no receipt** (the request was rejected pre-proxy)

The emit happens **after** the upstream call completes, in the same
event-loop turn as the response is returned to the caller. Conformant
implementations MUST NOT batch or defer emission beyond the request's
lifetime — silence-is-evidence (ADR-0007 §13.2) breaks otherwise.

## Cross-implementation byte-equality

Two implementations are conformant on receipts iff: given the same
sequence of (request, upstream-response) pairs, they emit a
byte-equal sequence of canonical receipt strings.

Test vectors covering this property are filed at `cloister-954f21`
(L7 — pending wire-spec completion + ref-impl decision).
