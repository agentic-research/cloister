# Wire — push protocol

Producer-side flow: take a `CacheLockfile` + chunks, upload everything,
end up with a manifest the world can pull by name.

## Prerequisites

- `CacheLockfile` capnp message (canonical-encoded). The producer
  built this locally per LLO ADR-0021.
- For each `CacheLockfile.sources[i]`, the raw bytes of the chunk
  whose hash is `sources[i].chunkHash`. These are in the producer's
  local `BlobStore` (LLO `ley-line-open-bb0316` for fs-local, or
  whatever the producer's storage backend is).
- A target registry URL (e.g. `https://cache.example.com`).
- An optional auth credential (bearer token, etc.; out of scope for
  this v1).

## Steps

### 1. Initiate the artifact upload

```
HEAD /v2/<producer>/<scope>/blobs/sha256:<config-digest>
```

If 200, the config blob already exists — skip step 2.
If 404, proceed to step 2.

### 2. Push the config blob

Standard OCI two-step:

```
POST /v2/<producer>/<scope>/blobs/uploads/
→ 202 Location: /v2/<producer>/<scope>/blobs/uploads/<upload-uuid>
```

Then:

```
PUT /v2/<producer>/<scope>/blobs/uploads/<upload-uuid>?digest=sha256:<hex>
Content-Type: application/octet-stream
Content-Length: <bytes>

<canonical-encoded CacheLockfile bytes>
```

Response: `201 Created` with `Location:` and `Docker-Content-Digest:`
headers.

### 3. Push each chunk

For each `CacheLockfile.sources[i]`, repeat steps 1 and 2 with:

- digest = `sha256:<hex(sources[i].chunkHash.bytes)>`
- bytes = the chunk's raw bytes

**Idempotency (the (IM) axiom):** if HEAD returns 200, the chunk is
already present and the producer SKIPS the upload. Providers MUST
honor this — re-uploading is wasted IO; double-write of identical
bytes is also acceptable but providers are not required to handle it
gracefully.

**Parallelism is allowed.** A producer MAY push chunks concurrently.
Order doesn't matter — chunks are independent. Providers MUST handle
concurrent uploads of the same digest (e.g. two producers racing on
the same blob); both should succeed, with at most one actually
writing.

### 4. Push the manifest

```
PUT /v2/<producer>/<scope>/manifests/<ref>
Content-Type: application/vnd.oci.image.manifest.v1+json

<manifest JSON>
```

`<ref>` is either:

- `sha256:<hex>` — the BLAKE3 hash of the canonical-encoded manifest
  JSON. Content-addressed; immutable.
- A human-readable tag (`latest`, `main`, `<branch>`, etc.) —
  mutable; later pushes overwrite.

Producers SHOULD push by both digest and tag. The digest push is the
canonical reference; the tag push is a stable alias.

### 5. Verify

After the manifest push, the producer SHOULD GET the manifest back
and assert:

- The returned bytes hash to the same digest the producer expected.
- The returned `layers[]` digests match the producer's lockfile's
  `chunkHash` values byte-for-byte (after the `sha256:` prefix is
  stripped and hex is decoded).

Failure at step 5 is a provider bug; producers MUST treat it as a
push failure and retry or escalate.

## Failure modes

| Step | Failure | Producer action |
|---|---|---|
| 1 | Network timeout | Retry with exponential backoff |
| 2 | 413 (payload too large) | Provider config issue; escalate, do not work around |
| 3 | 5xx on chunk upload | Retry that chunk; don't restart from step 1 |
| 4 | 409 (conflict on tag) | Tag was claimed by another writer mid-flight; re-fetch tag, decide whether to overwrite |
| 5 | Manifest body mismatch | Provider corruption; escalate, do not silently retry |

## What the producer MUST NOT do

- Cache success across processes. Each `mache push` is its own session;
  the producer cannot assume blobs from a previous session are still
  present. Always HEAD-check.
- Push chunks for entries it doesn't have. If a chunk is missing
  locally, the producer MUST fail with a clear "chunk X needed but
  not in local store" error — never push zero-byte or placeholder
  content.
- Sign the manifest in a way that breaks OCI manifest parsing.
  Manifest signing happens at a layer ABOVE this v1 (e.g. signet
  detached signature, cosign signature). If a future v2 specifies
  signed manifests, it will define the wire shape; v1 doesn't.
