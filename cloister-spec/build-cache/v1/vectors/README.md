# `build-cache/v1` conformance vectors

Canonical artifact bundle a `build-cache/v1` provider must reproduce
exactly. Generated deterministically by the producer in
`ley-line-open/rs/ll-core/schema-capnp/examples/gen_build_cache_vectors.rs`.

## Files

| File | Bytes | Role |
|---|---|---|
| `chunk-001.bin` | 269 | Raw layer bytes for `src/main.go`'s parse output |
| `chunk-002.bin` | 163 | Raw layer bytes for `src/auth.go`'s parse output |
| `lockfile-config.bin` | 584 | Canonical-encoded `CacheLockfile` capnp (LLO ADR-0021); manifest `config` blob |
| `manifest.json` | 1149 | OCI manifest wrapping config + chunks; the artifact a provider serves |
| `digests.json` | 1602 | Every file's BLAKE3 (= the on-the-wire `sha256:` per `cloister-spec/build-cache/v1/README.md` §"Digest encoding") AND real SHA-256 sidechannel |
| `VECTORS.sha256` | 405 | `sha256sum`-compatible integrity manifest for git-tracked drift detection |

## How to verify

A provider impl is **conformant with `cloister/build-cache/v1`** if,
given these vectors as input:

1. The provider serves `chunk-001.bin` byte-equal when GET'd at the
   digest `sha256:bfc7feb1382c50dfc6e389aa9b4c6608ca9a18d004b84b6959c624450da52f6a`.
2. The provider serves `chunk-002.bin` byte-equal when GET'd at
   `sha256:7e14934fd38caee251736be450b9c4e323def4292633aac9167ac7c7681dbc37`.
3. The provider serves `lockfile-config.bin` byte-equal when GET'd at
   `sha256:1a8f93c163c836aecae2fd3e33b03644399c0888474e9d7b2c1f61877e8f8c49`.
4. The provider serves `manifest.json` byte-equal when GET'd at the
   manifest reference, and the body parses as the OCI manifest in
   `manifest.json`.
5. Re-pushing any of the above is a no-op (idempotent insert).
6. A consumer walking the manifest and verifying every layer digest
   against the bytes returned succeeds without raising.

A consumer impl is **conformant** if:

1. Given the manifest, it can fetch the config + every layer.
2. Decoding `lockfile-config.bin` via the `cache.capnp` schema produces
   a `CacheLockfile` whose `sources[i].chunkHash` exactly matches the
   digest of `chunks[i].bin`.
3. The `root` field's bytes equal `BLAKE3(chunkHash[0] || chunkHash[1])`
   (the producer-defined root rule for this vector set; producers MAY
   pick a different rule but consumers reproduce whatever the lockfile
   commits).
4. `VECTORS.sha256` verifies via `sha256sum -c VECTORS.sha256`.

## How to regenerate

Vectors are deterministic — every input is a constant in the producer
code. Two runs produce byte-equal output. If you need to regenerate
(e.g. you bumped LLO's `CacheLockfile` schema):

```sh
cd ley-line-open/rs
cargo run -p leyline-schema-capnp --example gen_build_cache_vectors -- \
    ../../cloister/cloister-spec/build-cache/v1/vectors
```

The generator overwrites every file in the output dir. Run with the
old code, diff against `git status`, run with the new code, diff
again — bytes should be identical if the regen was a pure refactor.

## Why BLAKE3 in `sha256:`-prefixed digests?

See `cloister-spec/build-cache/v1/README.md` §"Digest encoding". TL;DR:
substrate uses BLAKE3 (Σ §3.4); OCI registers no `blake3:` algorithm;
this v1 reuses `sha256:` with BLAKE3 bytes inside. `digests.json`
exposes both the BLAKE3 hash (canonical, wire) and a real SHA-256
sidechannel so ecosystem tools that need a true SHA-256 (commit gates,
git LFS) have one without re-hashing.

## Why two `VECTORS.sha256`-style files (`VECTORS.sha256` + `digests.json`)?

Different audiences:

- `VECTORS.sha256` is a flat `sha256sum`-compatible file. Run
  `sha256sum -c VECTORS.sha256` from the vectors dir to verify
  integrity. Useful for CI and for `find . | xargs sha256sum` users.
- `digests.json` is structured — names every file's role, exposes
  BLAKE3 (the canonical wire digest per v1) alongside SHA-256, and
  documents source paths + kinds. Useful for provider impl tests
  that need to assert against a specific named role rather than a
  filename.

## Compat note

These vectors are tied to `cloister/build-cache/v1`. A `v2` will live
under `cloister-spec/build-cache/v2/vectors/` with its own bytes;
`v1` vectors stay frozen so old conformant impls keep passing.
