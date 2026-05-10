# Wire: disclosure JSONL

The disclosure endpoint at `GET /interlace/peers/{fp}` streams
newline-delimited JSON (`application/jsonl`). One record per line.

## Line ordering

1. Exactly one **header** record (first line).
2. Zero or more **attestation** records, ordered by ascending `seq`.
3. Zero or more **pending** records (state-write retries awaiting
   resolution).

A trailing LF after the last line is included.

## Record shapes

### header

```json
{
  "type": "header",
  "version": "v1",
  "peer_fingerprint": "<utf8>",
  "master_public_key": "<b64-standard 32-byte Ed25519 pubkey>",
  "next_cursor": "<opaque cursor token>"
}
```

`next_cursor` is OMITTED when there are no more attestation pages.

### attestation

```json
{
  "type": "attestation",
  "seq": <int ≥ 1>,
  "prev_self_ref": "<sha256 hex>" | null,
  "prev_peer_ref": "<sha256 hex>" | null,
  "content_hash": "<sha256 hex of canonical state-write bytes>",
  "content_type": "<utf8>",
  "scope": "<utf8>",
  "cert_b64": "<b64-standard cert DER>",
  "sig_b64": "<b64-standard Ed25519 signature>",
  "created_at": <unix-ms>
}
```

- `prev_self_ref` is `null` only for the genesis row.
- `cert` is the full DER (so a third-party auditor with the
  `master_public_key` from the header can re-verify the cert chain
  offline).
- `sig` is `Ed25519(ephemeral, canonical_bytes || prev_self_ref)`
  where `canonical_bytes` are the state-write's canonical bytes
  (whose digest is `content_hash`).

### pending

```json
{
  "type": "pending",
  "content_hash": "<sha256 hex>",
  "scope": "<utf8>",
  "attempts": <int ≥ 1>,
  "next_retry_at": <unix-ms>,
  "exhausted": <bool>,
  "created_at": <unix-ms>,
  "last_attempt_at": <unix-ms> | null
}
```

- `exhausted: true` means the retry budget has been spent and the
  actor will not attempt the write again. The state-write is in GAP
  status (no attestation, no further retries).
- `next_retry_at: 9007199254740991` (`Number.MAX_SAFE_INTEGER`) is
  the sentinel cloister uses for exhausted rows.

## Cursor token format

```
v1.<base64url payload-json>.<base64url HMAC-SHA256>
```

Payload (canonical JSON: keys sorted ASCII-ascending, no whitespace):

```json
{"fromSeq":<int>,"peerFp":"<utf8>","ts":<unix-ms>}
```

The HMAC is over UTF-8 of the dot-concatenated `v1.<payload-b64u>`
(i.e. the first two segments). HMAC key is a 32+ byte secret shared
across all replicas of the actor.

Verification:

- Reject if `cursor.split(".").length != 3`.
- Reject if `parts[0] != "v1"`.
- Verify HMAC. Verifiers MUST use a constant-time MAC comparison.
- Decode payload, type-check `fromSeq: number`, `peerFp: string`,
  `ts: number`.
- Reject if `payload.peerFp != URL path peerFp`.

Failure mode: return the constant-time 404 error response (below);
do NOT signal cursor failures distinctly.

## Constant-time error response

ALL disclosure-endpoint errors (unknown peer, auth denied, malformed
cursor, malformed URL) return the same response:

```
HTTP/1.1 404 Not Found
content-type: application/octet-stream
content-length: 256
cache-control: no-store

<256 ASCII '0' bytes>
```

Body is exactly 256 bytes of ASCII `0x30`. The content-length is a
fixed constant (`CONSTANT_TIME_ERROR_BODY_LEN = 256`).

Implementations MUST NOT add status-distinguishing headers (e.g.
`x-error-class: denied`), MUST NOT vary body bytes by failure class,
and MUST NOT vary processing time by failure class beyond unavoidable
cryptographic timing.

See [`../test-vectors/disclosure.json`](../test-vectors/disclosure.json)
for a fixed peer chain and the expected JSONL output.
