# Wire — pull protocol

Consumer-side flow: take a producer + scope + ref, end up with a
materialized `CacheLockfile` + every chunk it references.

## Prerequisites

- A registry URL (`https://cache.example.com`).
- A producer name (`mache`, `me-bundle`, ...).
- A scope (producer-defined, e.g. `mache/abc123def`).
- A ref (digest or tag).
- Optional auth (bearer token, etc.; out of scope).

## Steps

### 1. Fetch the manifest

```
GET /v2/<producer>/<scope>/manifests/<ref>
Accept: application/vnd.oci.image.manifest.v1+json
```

Response: 200 with the manifest JSON body.

If `<ref>` is a digest: the consumer MUST hash the returned bytes
(with BLAKE3, per §"Digest encoding" in the spec README) and compare
to `<ref>`. Mismatch = provider corruption, refuse the manifest.

If `<ref>` is a tag: take the `Docker-Content-Digest:` response
header as the canonical content reference; consumers SHOULD pin this
digest for future pulls instead of the mutable tag.

### 2. Verify the manifest's mediaType

The manifest body's `mediaType` MUST be
`application/vnd.oci.image.manifest.v1+json`. The `config.mediaType`
MUST be `application/vnd.cloister.build-cache.v1.config+json` (or
later v* if the consumer supports it). Reject otherwise.

### 3. Fetch the config blob

```
GET /v2/<producer>/<scope>/blobs/<config.digest>
```

The body is canonical-encoded `CacheLockfile` capnp bytes. Decode
via LLO `cache_capnp::CacheLockfile::Reader` (Rust) or
`cache.ReadRootCacheLockfile()` (Go) per LLO ADR-0021.

The consumer MUST hash the body bytes (BLAKE3) and compare to
`config.digest` (after the `sha256:` prefix). Mismatch = provider
corruption, refuse the config.

### 4. Fetch chunks

For each `manifest.layers[i]`:

```
GET /v2/<producer>/<scope>/blobs/<layers[i].digest>
```

The body is the chunk's raw bytes.

Verify-on-read (per LLO `BlobStore::get` contract):

- Hash the returned bytes (BLAKE3).
- Compare to `layers[i].digest` (after `sha256:` prefix).
- Mismatch = provider corruption or tampering. Refuse.

The consumer also cross-checks the lockfile: the digest in
`manifest.layers[i]` MUST match `lockfile.sources[i].chunkHash` byte-
for-byte. If the manifest and the lockfile disagree, that's a
producer bug; refuse the bundle.

### 5. Verify the assembled root

After all chunks are materialized, the consumer reconstructs the
producer's output (mache: assemble the .db; me-bundle: write files;
agent-corpus: re-emit observation stream) and hashes the assembled
output. The consumer MUST compare that hash to
`lockfile.root.bytes`. Mismatch = either the producer didn't honor
the contract, or the chunks were corrupted in a way that survived
per-chunk verification (impossible under (CR)+BLAKE3 collision
resistance, but the test should still happen for completeness).

## Parallelism

Chunks are independent — consumers MAY fetch them in parallel. The
manifest fetch (step 1) and config fetch (step 3) are serial: the
manifest names the config digest.

## Caching

A pulled chunk is a content-addressed blob. Consumers SHOULD cache
chunks locally (in an `FsBlobStore`-shaped store per LLO bead
`ley-line-open-bb0316`) keyed by digest. Subsequent pulls of the
same digest hit the local cache, skipping the network entirely.

## Failure modes

| Step | Failure | Consumer action |
|---|---|---|
| 1 | 404 (manifest missing) | Producer hasn't pushed yet, OR was GC'd. Surface to user; don't auto-retry the network. |
| 1 | Network error | Retry with exponential backoff. |
| 1 | Digest mismatch | Provider corruption. Escalate; do NOT fall back to a different provider silently. |
| 2 | Wrong mediaType | Provider serving the wrong kind of artifact. Refuse. |
| 3 | Config digest mismatch | Same as step 1 mismatch. |
| 4 | Chunk digest mismatch | Same as step 1 mismatch — chunk-level corruption. |
| 4 | 404 on a chunk | Producer's manifest references a chunk that no longer exists. Producer error or GC'd. Refuse the bundle; the partial set is unusable. |
| 5 | Assembled root mismatch | Producer or transport bug — see step description. |

## What the consumer MUST NOT do

- Accept manifests, config blobs, or chunks without verifying the
  digest end-to-end. The substrate's "verify-on-read" contract is
  binding (LLO `BlobStore::get` spec, ADR-0021).
- Reassemble the output and ship it onward without verifying the
  assembled root. A consumer that propagates unverified bytes is a
  weak link in the trust chain.
- Treat a `<ref>` tag pull as canonical. Tags are mutable; the
  consumer SHOULD pin to the digest from step 1's
  `Docker-Content-Digest:` header and cache the digest as the
  long-term reference.
