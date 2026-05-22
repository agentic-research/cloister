# Wire — manifest shape

The OCI manifest JSON shape for a `CacheLockfile` artifact.

## MediaType

```
application/vnd.cloister.build-cache.v1.manifest+json
```

This is the OCI manifest's `mediaType` field. The manifest's `config`
points at a `CacheLockfile` blob; each `layer` points at a chunk.

## Manifest body

```json
{
  "schemaVersion": 2,
  "mediaType": "application/vnd.oci.image.manifest.v1+json",
  "config": {
    "mediaType": "application/vnd.cloister.build-cache.v1.config+json",
    "digest": "sha256:<blake3-hex-of-config-bytes>",
    "size": <bytes>
  },
  "layers": [
    {
      "mediaType": "application/vnd.cloister.build-cache.v1.chunk",
      "digest": "sha256:<blake3-hex-of-chunk-bytes>",
      "size": <bytes>,
      "annotations": {
        "org.cloister.build-cache.path": "src/main.go",
        "org.cloister.build-cache.kind": "go-source"
      }
    },
    // ... one entry per CacheLockfile.sources[i]
  ],
  "annotations": {
    "org.cloister.build-cache.producer": "mache",
    "org.cloister.build-cache.producer_version": "0.7.1",
    "org.cloister.build-cache.schema_version": "0.1.0"
  }
}
```

## config blob

The `config` blob is the **canonical-encoded `CacheLockfile` capnp
bytes**, NOT the JSON form. Why capnp:

- Byte-equal across producers; canonical encoding is deterministic
  (LLO ADR-0014 §F8.6.4 cross-runtime fixture suite proves this).
- One source of truth; the on-disk TOML form is a rendering for
  human eyes, not a wire shape.
- Smaller than the JSON equivalent for the same data.

A consumer that wants the JSON form re-renders it via the
schema-bridge codegen path (cloister ADR-0022 / ADR-0025).

## layer blobs (chunks)

Each `layer` is the raw bytes the producer pushed for one
`CacheLockfile.sources[i].chunkHash` entry. For mache: the per-source
parse output. For me-bundle: an encrypted-or-scrubbed chunk of
personal state. For agent-corpus: an observation segment.

The `path` and `kind` annotations duplicate the lockfile's
`sources[i].path` and `sources[i].kind`. Strictly redundant — the
lockfile is canonical — but useful for `oras pull <ref>` workflows
that surface annotations on the CLI.

## Top-level annotations

Reverse-DNS-prefixed, per OCI annotation convention:

| Key | Source | Why duplicated |
|---|---|---|
| `org.cloister.build-cache.producer` | `CacheLockfile.meta.producer` | Visible to `oras pull --include-annotations` without parsing the config blob |
| `org.cloister.build-cache.producer_version` | `CacheLockfile.meta.producerVersion` | Same |
| `org.cloister.build-cache.schema_version` | `CacheLockfile.meta.schemaVersion` | Bumpable cache-eviction signal |

## Annotation discipline

Annotation keys MUST be reverse-DNS-prefixed. Future additions follow
the same convention; the `org.cloister.build-cache.*` namespace is
reserved by this v1.

## Size guidance

A typical mache lockfile for a 1000-file Go repo:

- config (canonical capnp): ~30 KiB
- 1000 layers, average 8 KiB each: ~8 MiB total
- Manifest JSON itself: ~150 KiB (dominated by `layers[]`)

Manifests >1 MiB are unusual but legal. The OCI Distribution Spec
doesn't impose a size cap on manifests; cloister-oci/fs-local impls
SHOULD support up to at least 16 MiB before failing.
