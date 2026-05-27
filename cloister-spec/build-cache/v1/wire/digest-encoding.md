# Wire — digest encoding

How build-cache/v1 maps BLAKE3 digests into the OCI `sha256:` prefix.

## Background

OCI distribution uses `<algorithm>:<hex>` digest strings. The only
universally supported algorithm name is `sha256`. The LLO substrate
uses BLAKE3-256 (Σ §3.4) — there is no registered OCI algorithm name
for BLAKE3.

## Encoding rule

```
wire_digest = "sha256:" + hex(blake3_256(chunk_bytes))
```

The `<hex>` portion is the **BLAKE3-256** hash of the raw bytes,
hex-encoded lowercase (64 characters). It is NOT a SHA-256 hash.

This is a deliberate misuse of the `sha256:` algorithm prefix,
documented in the [spec README](../README.md#digest-encoding).

## Why not `blake3:`?

Every OCI client, registry proxy, and CDN cache key parser accepts
`sha256:` digests without modification. A non-standard algorithm name
would require changes across the entire OCI tooling chain. This v1
prioritizes wire compatibility over algorithm-name honesty.

## Verification

A consumer that receives a digest from the wire MUST verify it against
the chunk bytes using BLAKE3, not SHA-256:

```
received_digest = "sha256:<hex>"
expected_hex    = hex(blake3_256(chunk_bytes))
assert received_digest == "sha256:" + expected_hex
```

A consumer that naively re-hashes with SHA-256 will see a mismatch.
This is expected — the `sha256:` prefix is a transport convention, not
an algorithm assertion.

## Cloister dual-verify gate

Cloister's `BlobStore.put` (`src/storage/workerd.ts`) accepts a
caller-provided key and verifies the body matches under SHA-256 **or**
BLAKE3. This defense-in-depth gate ensures:

- OCI-native clients (Docker, ORAS, cosign) that send real SHA-256
  digests continue to work.
- build-cache/v1 clients that send BLAKE3-in-`sha256:` digests are
  accepted after the BLAKE3 fallback matches.
- Arbitrary unverified keys are always rejected.

## Future

A `blake3:` algorithm prefix may be registered with the OCI
distribution spec. Migration to `blake3:` would be a v2 concern;
this v1 documents the `sha256:` overloading explicitly so the
migration path is clear.
