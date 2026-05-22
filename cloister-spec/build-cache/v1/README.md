# `cloister/build-cache/v1` — vendor-neutral specification

**Status:** Draft (2026-05-22)
**Audience:** anyone building a producer or provider of content-addressed
build artifacts in the cloister ecosystem — `mache push`/`pull` (bead
`mache-aeb262`), `me-bundle pack`/`restore` (bead `ley-line-open-dffb77`),
`agent-corpus` (bead `ley-line-open-79a37c`), and any future tool that
emits a `CacheLockfile` (LLO `cache.capnp` per ADR-0021).

**Non-goals:** v1 does NOT cover authentication beyond OCI's standard
bearer-token flow, does NOT specify cross-region replication policy,
does NOT define an SLA. v2+ may add those.

## What this capability is

A transport contract for **content-addressed build artifacts** — the
chunks named by a `CacheLockfile` (LLO ADR-0021) — between producers
(`mache push`, `me-bundle pack`, ...) and providers (cloister's OCI
registry endpoint, R2-backed buckets, any S3-compat surface).

Three load-bearing properties this v1 publishes:

1. **Content-addressed retrieval.** Every chunk is identified by its
   BLAKE3 hash (per Σ §3.4). `GET <prefix>/blobs/sha256:<hex>`
   (using OCI's digest encoding wrapper around BLAKE3 bytes — see
   §"Digest encoding") MUST return the exact bytes whose hash is
   `<hex>`. A response whose body does not satisfy that equality is a
   protocol violation; consumers MUST reject it.

2. **Idempotent insert.** Pushing the same chunk twice MUST be a
   no-op on the second attempt — the existing chunk is preserved,
   the second writer is told "already present" and proceeds. Mirrors
   the (IM) axiom of LLO's `BlobStore` trait.

3. **Manifest by name.** A `CacheLockfile` can be vended by a
   producer-chosen name (e.g. `mache/repo-name@commit-sha`,
   `me-bundle/<signet-authority-fp>`). Consumers resolve the name to
   a content digest, then fetch the manifest by digest, then walk
   `manifest.sources[].chunkHash` to fetch chunks.

## Relationship to other specs

```
                  cloister/build-cache/v1  (this spec)
                              ▲
                              │ transports
                              │
             ┌────────────────┴────────────────┐
             │                                 │
   LLO ADR-0021                       OCI Distribution Spec
   (CacheLockfile schema)             (HTTP transport)
```

This v1 **CONSUMES**:

- **LLO ADR-0021** — for the manifest's wire shape (`CacheLockfile`
  capnp / TOML / OCI JSON triplet). The manifest is OPAQUE to this
  transport; build-cache only knows it's an OCI artifact with a
  declared `mediaType`.
- **OCI Distribution Spec 1.1** — for the HTTP routes (`/v2/` API),
  digest encoding, blob upload protocol, and manifest semantics.
  This v1 does NOT re-specify OCI; it specifies the *cloister-side
  conventions* layered on top of OCI.

This v1 **DEFINES** (new content not in either upstream spec):

- The reverse-DNS-prefixed `mediaType` for `CacheLockfile` manifests.
- The producer-name namespace and the `/v2/<producer>/<scope>` path
  layout convention.
- The mapping between BLAKE3 (substrate native) and OCI's
  `sha256:`-prefixed digest convention.
- The acceptable provider impls and what each is allowed/forbidden
  to do.

## Document map

- `README.md` (this file) — the spec proper.
- `wire/manifest-shape.md` — OCI manifest JSON shape for cache lockfiles.
- `wire/digest-encoding.md` — BLAKE3 → OCI digest mapping.
- `wire/push-protocol.md` — producer-side flow: chunk upload, manifest publish.
- `wire/pull-protocol.md` — consumer-side flow: name resolve, manifest fetch, chunk fetch.
- `wire/error-responses.md` — error shapes specific to build-cache.
- `vectors/` — canonical fixtures: a (manifest, chunks) bundle whose
  hashes a conformant provider must reproduce exactly.

## Capability contract

In ADR-0026 / cloister-cf7a3b matchmaker terms:

```toml
# A provider declares it serves build-cache/v1:
[inputs.my-cache-server]
provides = ["build-cache/v1"]
requires = ["blob-store/v1", "named-manifest/v1"]

# A consumer declares it wants it:
[inputs.mache]
provides = ["code-intel-db/v1"]
requires = ["build-cache/v1", "blob-store/v1", "sheaf/v1"]
```

The matchmaker (cloister-cf7a3b, not yet shipped) walks `provides` /
`requires` and binds inputs. Until matchmaker lands, consumers wire
the transport URL by hand in `cluster.toml`.

## Acceptable provider impls

Three reference impls are anticipated; this v1 is impl-agnostic so
long as the on-the-wire contract holds:

| Impl | Storage | Use case |
|---|---|---|
| `cloister-oci` | cloister's existing OCI registry endpoint (ADR-0009) | local dev cluster, single-tenant |
| `r2-direct` | Cloudflare R2 / any S3-compat bucket | production, multi-tenant |
| `fs-local` | local filesystem at a config-named root | offline / air-gapped / CI cache |

All three speak the same `/v2/` API surface. `r2-direct` and `fs-local`
are HTTP servers wrapping the underlying storage; consumers don't see a
difference.

## Producer name namespace

The `<producer>` segment in `/v2/<producer>/<scope>/manifests/<ref>`
is a short-name from the LLO `Meta.producer` field of the lockfile
(`mache`, `me-bundle`, `agent-corpus`, …). The cloister-side registry
admin policy decides which producer names are accepted.

`<scope>` is producer-defined:

- mache: `<repo-name>/<commit-sha>` (e.g. `mache/abc123def`)
- me-bundle: `<signet-authority-fp>` (the per-identity bundle)
- agent-corpus: `<source-name>/<session-fp>` (per-session corpora)

`<ref>` is either:

- A digest (`sha256:...`), for content-addressed pulls.
- A tag, for name-based vending (e.g. `latest`, `main`,
  `<branch-name>`).

## Digest encoding

OCI uses `<algorithm>:<hex>` digest strings; canonical algorithm names
are `sha256`, `sha512`. The substrate uses BLAKE3 (Σ §3.4) — there is
no registered OCI algorithm name `blake3`.

**Decision:** this v1 uses `sha256:` as the digest prefix, but the
`<hex>` is the BLAKE3 hash bytes, not SHA-256. Rationale:

- Every OCI client accepts `sha256:` digests; using a non-standard
  algorithm name breaks tooling compatibility.
- The digest only needs to be a stable identifier on the wire; the
  cryptographic property (collision resistance) comes from BLAKE3,
  not from SHA-256 semantics.
- Cloister's existing OCI registry endpoint already accepts arbitrary
  bytes after the `sha256:` prefix; no change needed there.
- A consumer that re-hashes the bytes will see them hash to a
  different SHA-256 — but consumers SHOULD NOT re-hash with SHA-256;
  they verify against the CacheLockfile's `chunkHash` (BLAKE3) which
  this v1 reproduces in the `sha256:`-prefixed digest.

**This is a deliberate misuse of the algorithm prefix that this v1
documents explicitly.** Future v2 may register a `blake3:` prefix
with the OCI WG and migrate.

## Honest limits

- **Idempotency under concurrent push** depends on the underlying
  store. cloister-oci honors it via the OCI mount-blob protocol;
  r2-direct depends on the bucket's conditional-write semantics;
  fs-local uses atomic rename per LLO bead `ley-line-open-bb0316`.
  Consumers MUST be prepared for "blob already exists" responses.
- **Authentication beyond OCI bearer tokens is out of scope.**
  cloister's lease middleware (ADR-0007 interlace) can wrap this
  endpoint, but the build-cache contract itself doesn't require it.
- **Cross-region replication is not specified.** A cache hosted in
  one region serves consumers everywhere; latency is whatever the
  transport gives. r2-direct gets multi-region for free via R2's
  network; cloister-oci and fs-local are single-region.
- **GC policy is provider-side.** This v1 doesn't define when chunks
  are deleted. Producers MUST NOT rely on chunks staying around
  forever — re-push if a `pull` fails with 404.
- **Manifest signing is consumer-side.** me-bundle signs its
  manifest via signet before push; mache does not sign. The cache
  transport carries the bytes verbatim — it does not enforce
  signature checks.

## Conformance

A provider is **conformant with build-cache/v1** if:

1. It implements the OCI Distribution Spec 1.1 routes named in
   `wire/push-protocol.md` and `wire/pull-protocol.md`.
2. It accepts `CacheLockfile` manifests with the `mediaType` declared
   in `wire/manifest-shape.md`.
3. It serves chunks back byte-equal to what was pushed, addressed by
   the `sha256:<hex>` digest (where `<hex>` is the BLAKE3 bytes per
   §"Digest encoding").
4. Idempotent push: pushing a chunk whose digest already exists is a
   no-op (returns the existing digest).
5. The conformance vectors in `vectors/` round-trip exactly.

## Version policy

`v1` is the first stable release. Field additions follow LLO ADR-0014's
capnp ordinal discipline — new fields land at the next ordinal with a
default. Breaking changes go to `v2` under a fresh `cloister-spec/build-cache/v2/`
directory; v1 stays online indefinitely so old clients keep working.
