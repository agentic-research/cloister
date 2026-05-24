# `cloister/build-cache/v1` — vendor-neutral specification

**Status:** Draft (2026-05-24, paired with cloister-4d376e — the BLAKE3-in-`sha256:` digest fallback that lets cloister act as a v1 push/pull provider. Conformance vectors landed with cloister-667ea6; producer reference is LLO `gen_build_cache_vectors` at `rs/ll-core/schema-capnp/examples/`.)
**Audience:** anyone building a second `build-cache/v1` provider (cloister, a future Cloudflare R2-only one, a self-hosted registry) or producer (mache, me-bundle, agent-corpus). If your provider stores the bytes in `vectors/` under the digests in `digests.json` and serves them back byte-equal, you're conformant.

**Non-goals:** v1 does NOT cover:
- Layer chunking strategy (producer's choice — the spec only fixes the digest-and-store wire)
- Authn/authz on the registry surface (orthogonal — wire works under any OCI-compatible auth model: cloister uses ADR-0007 Interlace leases on production cloister deployments, anonymous for self-hosted dev)
- TTL / GC policy (operator choice — vectors are content-addressed, GC is a substrate-internal concern)
- Cross-region replication (substrate-internal; mache producers don't see it)
- Manifest list / fat-manifest / OCI index (single-arch manifests only in v1)

## What this capability is

A **content-addressed substrate** for cache lockfiles produced by any tool that emits the `cache.capnp:CacheLockfile` schema (Σ §3 / ley-line-open-ae89aa). The producer (mache, me-bundle, agent-corpus) emits:

1. **Chunks** — opaque bytes (one per `SourceEntry.chunkHash` in the lockfile)
2. **Config blob** — the canonical-encoded `CacheLockfile`
3. **OCI manifest JSON** — wires (1) + (2) under OCI Distribution v1.1 shape

The provider (cloister, any compliant registry) accepts these via the OCI push surface (`POST /v2/<repo>/blobs/uploads/...`, `PUT /v2/<repo>/manifests/<reference>`) and serves them back via the pull surface (`GET /v2/<repo>/blobs/<digest>`, `GET /v2/<repo>/manifests/<reference>`). Provider-side, the bytes are content-addressed; the digest in the wire IS the storage key.

Three loadbearing properties this v1 publishes:

1. **Digest encoding is BLAKE3-in-`sha256:` prefix.** Σ §3.4 locks the LLO substrate to BLAKE3, but the OCI client ecosystem (Docker, ORAS, cosign, `oras-go`) only knows how to mint `sha256:` digests. v1 makes a deliberate compatibility trade-off: the on-the-wire digest is `sha256:<64-hex>` per OCI grammar, but the bytes are BLAKE3-256 of the body. Providers MUST accept both genuine SHA-256 and BLAKE3 under the `sha256:` prefix on push (verify-on-write tries SHA-256 first, falls back to BLAKE3); they MUST serve back exactly the bytes that were pushed under whatever digest was claimed.

2. **Round-trip byte-equality is the conformance contract.** A provider that accepts the bytes in `vectors/` under the digests in `digests.json` and serves them back byte-equal — for chunks, config, and manifest — is conformant. There is no other test. No size renegotiation, no normalization, no media-type rewriting.

3. **The OCI manifest is the durable bind.** Restore (mache `cache fetch`, me-bundle `bundle pull`) walks: fetch manifest by reference → parse config digest → fetch config blob → for each `sources[].chunkHash` listed in config, fetch chunk blob. The manifest's `config.digest` and `layers[].digest` are the discovery surface; pulling them by digest from any v1 provider yields the same bytes.

## Relationship to other specs

```
                   cloister-spec/build-cache/v1
                                  │
                  ┌───────────────┼───────────────┐
                  │               │               │
              consumes        depends on      consumed by
                  ▼               ▼               ▼
       OCI Distribution     ley-line-open       mache, me-bundle,
       v1.1 (push/pull,     /cache.capnp        agent-corpus
       /v2/ shape)          (CacheLockfile)     (producers)
                            +
                            ADR-0014/0021
                            (capnp evolution)
```

This v1 **CONSUMES**:
- OCI Distribution Specification v1.1 — for the `/v2/<name>/blobs/uploads/...` push paths, `/v2/<name>/blobs/<digest>` and `/v2/<name>/manifests/<reference>` pull paths, and the error-code vocabulary (`BLOB_UPLOAD_INVALID`, `DIGEST_INVALID`, `MANIFEST_INVALID`, `NAME_INVALID`).
- `ley-line-open/cache.capnp` (ADR-0021) — for the `CacheLockfile` config-blob schema.

This v1 **DEFINES** (new content not in either upstream):
- The **BLAKE3-in-`sha256:`** digest-encoding decision (§Digest encoding below).
- The **OCI media types** under the `application/vnd.cloister.build-cache.v1.*` namespace (see `wire/manifest-shape.md`).
- The **manifest annotations** (`org.cloister.build-cache.producer`, `.producer_version`, `.schema_version`, per-layer `.kind` + `.path`).
- The **conformance vectors** in `vectors/`.

## Digest encoding

OCI Distribution requires every digest to take the form `<alg>:<hex>` where `<alg>` is a registered algorithm — in practice, every shipped client only emits `sha256:`. Σ §3.4 commits the LLO substrate to **BLAKE3-256** (ADR-0014 §"why BLAKE3"). v1 reconciles these by:

- **The on-the-wire digest prefix is `sha256:`**, per OCI grammar. Clients that don't know about BLAKE3 (Docker, ORAS, cosign, `oras-go`) keep working without modification.
- **The bytes carried under that prefix are BLAKE3-256** of the body, hex-encoded lowercase.
- **Providers verify-on-write** by trying SHA-256 first (so OCI-native pushes from Docker / ORAS / cosign with genuine SHA-256 digests still work — the fast path), falling back to BLAKE3 on mismatch (the build-cache/v1 path). A collision in **either** algorithm is infeasible to engineer under current adversary budgets, so accepting the union does not weaken integrity. Failure responses MUST name both computed hashes so client diagnostics show what the provider actually saw.

This decision is **deliberate compatibility debt**. A future v2 may revisit it (e.g., adopt `blake3:` once a non-trivial fraction of client tooling speaks it natively), but v1 prioritizes "works today against unmodified OCI clients" over "uses a registered algorithm prefix."

## Wire summary

### Push surface (provider implements)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v2/<name>/blobs/uploads/?digest=sha256:<hex>` | Monolithic blob push (body = full chunk / config). Provider verifies digest per §Digest encoding, returns `201 Created` with `Location:` + `Docker-Content-Digest:` headers. |
| `POST` | `/v2/<name>/blobs/uploads/` | Begin chunked upload. Returns `202 Accepted` with `Location:` carrying upload-session UUID. |
| `PATCH` | `/v2/<name>/blobs/uploads/<uuid>` | Append chunk bytes to a chunked upload session. |
| `PUT` | `/v2/<name>/blobs/uploads/<uuid>?digest=sha256:<hex>` | Finalize a chunked upload. Provider re-verifies the concatenated bytes per §Digest encoding. |
| `PUT` | `/v2/<name>/manifests/<reference>` | Push manifest (reference = tag OR `sha256:<hex>` digest). Provider verifies digest-by-body if reference is a digest. |

### Pull surface (provider implements)

| Method | Path | Purpose |
|---|---|---|
| `HEAD`/`GET` | `/v2/<name>/blobs/sha256:<hex>` | Fetch blob by digest. Provider returns the exact bytes that were pushed. |
| `HEAD`/`GET` | `/v2/<name>/manifests/<reference>` | Fetch manifest. `Content-Type` is the manifest's own `mediaType`. |

### Repository name grammar

Per OCI: `<lowercase-alnum-or-hyphen>(/<lowercase-alnum-or-hyphen>)*`. cloister's `REPO_NAME_RE` is the authoritative regex (`src/routes/oci-registry.ts`).

## Document map

- `README.md` (this file) — the spec proper.
- `wire/manifest-shape.md` — *deferred to v1.1; the canonical example lives in `vectors/manifest.json`, fully annotated below.*
- `vectors/` — canonical inputs + expected digests. The conformance contract.
  - `chunk-001.bin`, `chunk-002.bin` — example chunks (faux parse output; producers in the wild emit capnp-encoded `_ast` tables from mache, capnp-encoded transcript turns from me-bundle, etc. — the format is producer-defined, the digest is the contract).
  - `lockfile-config.bin` — canonical-encoded `CacheLockfile` referencing the two chunks above.
  - `manifest.json` — OCI manifest wrapping config + chunks.
  - `digests.json` — every file's BLAKE3 digest (as `sha256:` per §Digest encoding) AND its real SHA-256 (sidechannel for git-LFS, commit gates, ecosystem tools).
  - `VECTORS.sha256` — `sha256sum`-compatible integrity sidechannel for git-tracked verification.

## Conformance test

A `build-cache/v1` provider is conformant iff, for every file in `vectors/` (chunks + config + manifest):

1. The provider accepts a `POST /v2/<some-repo>/blobs/uploads/?digest=sha256:<blake3_hex>` of the file's bytes, returning `201` (for blobs) or accepts the analogous manifest PUT for `manifest.json`.
2. The provider returns the **exact same bytes** on a subsequent `GET /v2/<some-repo>/blobs/sha256:<blake3_hex>` (or `GET /v2/<some-repo>/manifests/sha256:<blake3_hex>`).

The cloister reference test is `test/routes/oci-build-cache-conformance.test.ts`. A new provider passing the same vectors against its own surface is conformant.

## Producer reference

The LLO `gen_build_cache_vectors` example (`rs/ll-core/schema-capnp/examples/gen_build_cache_vectors.rs`) is the **deterministic vector generator**. Two runs on different machines produce byte-equal outputs. To regenerate (after a schema-evolution change to `cache.capnp`):

```sh
cd ley-line-open/rs/ll-core/schema-capnp
cargo run --example gen_build_cache_vectors -- \
    ../../../../cloister/cloister-spec/build-cache/v1/vectors
```

Then commit the regenerated `vectors/` to cloister. The `VECTORS.sha256` sidechannel will change, which is itself the diff signal that something in the producer chain moved.
