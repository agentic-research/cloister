# ADR-0029 — Per-repo membership boundary for the OCI registry surface

- **Status:** Proposed (2026-05-24)
- **Tracking bead:** `cloister-7c0a0b`
- **Surfaced by:** Adversarial review of cloister-667ea6 (enumeration-oracle-hunter + bundle-isolation-tester, PRs #83–#87).
- **Pairs with:** ADR-0003 (content-addressed storage — load-bearing constraint, see Context), ADR-0007 (Interlace lease auth — provides the `peerFp` attribution key), ADR-0024 (`cloister/credential-isolation/v1` capability — same threat-model precedent for constant-shape 404).

## Context

cloister's OCI registry route (`src/routes/oci-registry.ts`) implements OCI Distribution v1.1 pull + push against a singleton `BlobStore` Durable Object (`src/blob-store.ts:86`, addressed `idFromName("cluster")`). This singleton is **deliberate** per ADR-0003: it keeps the content-addressed property global so any blob put by any caller is reachable by digest from any other — a monoid axiom on the storage layer that other substrate components (BeadStore, TrustStore handoff, the four-step cross-DO orchestrator) depend on.

PR #84 wired cloister into the `build-cache/v1` capability — making cloister a multi-tenant build-cache provider for mache and future producers (me-bundle, agent-corpus). Adversarial review of that PR identified a fundamental gap:

> The pull paths (`HEAD`/`GET /v2/<name>/blobs/sha256:<hex>`, `HEAD`/`GET /v2/<name>/manifests/<reference>`) and the catalog/tags-list endpoints **ignore `<name>` for membership purposes** — `blob.has(d)` and `blob.get(d)` are global lookups against the singleton BlobStore. An unauthenticated caller probing `HEAD /v2/<anything>/blobs/sha256:<digest>` learns whether *any* tenant pushed that blob and can pull the bytes. `_catalog` enumerates every tenant repo; `tags/list` enumerates every tag.

For a build-cache substrate, this is more than confidentiality — cache artifacts encode source-code structure, dependency graphs, derived ASTs. Cross-tenant disclosure is a **reconstruction attack on a competitor's private codebase from the digest namespace alone**.

**The architectural constraint**: per `src/blob-store.ts:14-20`, partitioning BlobStore per-repo would break the ADR-0003 monoid axiom. The cross-DO handoff (BlobStore.put → BeadStore.bead_create → TrustStore.applyAttestation) relies on the global reachability property — every cluster participant must be able to fetch any committed blob by digest. Per-repo BlobStores would force per-repo cross-DO orchestrators and partition the substrate.

The fix must therefore be **orthogonal to storage**: a membership index that gates the OCI route's read surface without touching the BlobStore's global addressing.

## Decision

Add a `(repo, blob_digest)` **membership index** on the TrustStore (which already holds `registry_tags` for the same OCI surface). The OCI pull surface consults the index BEFORE serving bytes from BlobStore. The push surface writes the index as a side effect of every successful blob/manifest persist.

### Index shape

```sql
CREATE TABLE IF NOT EXISTS registry_blob_membership (
  repo        TEXT NOT NULL,
  digest      TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('blob', 'manifest')),
  written_at  INTEGER NOT NULL,
  written_by  TEXT,                -- nullable until lease attribution lands
  PRIMARY KEY (repo, digest, kind)
);
CREATE INDEX IF NOT EXISTS idx_membership_digest ON registry_blob_membership(digest);
```

Lives in TrustStore alongside `registry_tags`, NOT on BlobStore. Keeps BlobStore's monoid axiom intact.

### Pull-side change

Every pull path inserts a membership check BEFORE `blob.has(d)` / `blob.get(d)`:

```ts
// HEAD/GET /v2/<name>/blobs/<digest>
const trust = trustStoreStub(env);
const isMember = await trust.hasRegistryMembership(name, digest, 'blob');
if (!isMember) {
  // Constant-shape 404 — same body whether digest doesn't exist OR
  // exists but caller's repo has no membership. Matches the §9.4
  // "exists but not yours" precedent (threat-model.md, ADR-0024).
  return ociError(404, 'BLOB_UNKNOWN', `blob unknown: ${digest}`);
}
// Existing path: blob.has / blob.get against the global substrate.
```

Same pattern for manifests-by-digest. Tag pulls already go through `registry_tags`, which is per-repo — no change needed.

### Push-side change

Every successful blob/manifest persist writes the membership row:

```ts
await blob.put(body, asDigest(verified.key));
await trust.recordRegistryMembership(name, verified.key, 'blob', Date.now());
```

Per the ADR-0012 cross-DO discipline: BlobStore.put first (content-addressed, idempotent), THEN TrustStore membership write. Partial failure between the two is recoverable — re-push idempotently re-writes the membership row, and a membership row without a backing blob is a permanently-404 entry (caller sees `BLOB_UNKNOWN` on the consulting GET, just as if the index row didn't exist).

### Catalog/tags-list change

`GET /v2/_catalog` and `GET /v2/<name>/tags/list` must be auth-gated when `INTERLACE_ROOT_PUBKEY` is set:

- `_catalog`: return only repos the verified `peerFp`'s lease scope contains (e.g. `oci:read:<repo>` or `oci:read:*`).
- `tags/list`: 404 if the caller's lease doesn't carry `oci:read:<name>`.

When `INTERLACE_ROOT_PUBKEY` is unset (dev mode), both endpoints remain unrestricted — same dev-bypass discipline as the existing write gate.

## Trade-offs

| Aspect | Cost | Mitigation |
|---|---|---|
| Pull adds 1 RPC (TrustStore membership check) | Latency ~1ms per pull | Acceptable; the alternative — leaking cross-tenant — isn't a trade-off |
| Membership table grows with push volume | O(repos × blobs) rows | GC: when a tag/manifest unreferences a blob, GC sweeps memberships; orthogonal bead |
| Cross-tenant blob *dedup* loses visibility | Two tenants pushing the same bytes both pay storage in `BlobStore` once but get two membership rows | Acceptable; dedup at the addressable layer is preserved (one blob, two memberships) |
| Membership write is non-atomic with `BlobStore.put` | A push that succeeds at BlobStore but fails at TrustStore leaves the blob globally addressable but not pullable through OCI route | ADR-0012 discipline: re-push is idempotent; orphan blobs become reachable on retry. Same recovery shape as the four-step cross-DO orchestrator. |

## Open questions

1. **Pre-existing blobs**: cloister has been running multi-tenant since cloister-cabd57 (Phase 1 pull). Existing blobs have no membership rows. Do we backfill on first GET (lazy, by inferring membership from `registry_tags`)? Or refuse pulls until a backfill migration runs? **Tentative**: lazy backfill — if `registry_tags` for some repo points at the digest, infer membership and write it.

2. **Manifest layer reachability**: when a tenant pulls a manifest, the OCI client typically follows it to pull config + layer blobs. Each is a separate `GET .../blobs/<digest>` against the same tenant repo. The membership check at each is correct, but should manifest pull ALSO grant transitive membership to its referenced blobs? **Tentative**: yes — parse the manifest at push-time, write membership rows for `config.digest` and every `layers[].digest` under the same repo. Otherwise every cross-blob-but-same-manifest pull pays an unnecessary 404 and the consumer breaks.

3. **`peerFp` propagation**: today the OCI route's `gateWrite` verifies the lease but doesn't propagate the verified `peerFp` into the membership write. Lands as a separate bead (already noted on cloister-667ea6 — upload-session attribution gap).

4. **Bypass discipline**: when `INTERLACE_ROOT_PUBKEY` is unset, should pulls also be membership-checked? **Tentative**: yes — the dev-mode bypass is for AUTHN, not for the cross-tenant boundary. Even in dev, two repos shouldn't accidentally read each other's blobs.

## Pairs with

- ADR-0003 — the global content-addressed BlobStore is what this proposal explicitly DOES NOT change.
- ADR-0007 — Interlace lease provides the verified `peerFp` for attribution.
- ADR-0012 — the cross-DO BlobStore→TrustStore handoff discipline applies to the membership write.
- ADR-0024 — the constant-shape 404 precedent (`docs/security/threat-model.md` §9.4) is reused here.

## Implementation plan (separate beads)

1. **cloister-7c0a0b** (this ADR): schema + read-side membership check + write-side membership record.
2. **(follow-up)** lazy backfill for pre-existing blobs via `registry_tags`.
3. **(follow-up)** manifest-walk membership grant at push time (open question 2).
4. **(follow-up)** `peerFp` propagation through `UploadSession` (closes a separate cloister-667ea6 finding).
5. **(follow-up)** auth-gate `_catalog` + `tags/list`.

Each follow-up is independently shippable; this ADR establishes the model that makes them coherent.
