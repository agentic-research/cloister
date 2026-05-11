// SPDX-License-Identifier: AGPL-3.0-or-later
//
// registry_tags — OCI registry tag index. Maps `(repo, tag)` → manifest
// content digest. Lives in TrustStore (hypervisor-tier singleton DO)
// alongside the other cluster-singleton substrate state.
//
// Per cloister-cabd57 (OCI registry Phase 1 — read-only pull path):
// manifests + blobs themselves are content-addressed and live in
// BlobStore. Tags are mutable pointers, so they need their own index.
// One row per (repo, tag); the manifest digest is the only mutable
// thing — same blob may be referenced by many tags.
//
// Why TrustStore (not BlobStore, not a new DO):
//   - BlobStore is the immutable content-addressed monoid (ADR-0003
//     phase 1). Adding a mutable table there would muddy the algebra.
//   - TrustStore is already the hypervisor-tier singleton with SQL +
//     blockConcurrencyWhile semantics, and the registry-tag write set
//     is small (low-write-volume — push events, not pull events).
//   - A separate `RegistryIndex` DO would add config surface for no
//     gain at this size. Phase 2 (writes/uploads) can split out if
//     the table grows hot.
//
// Schema:
//
//   registry_tags (
//     repo            TEXT NOT NULL,        -- e.g. "notme", "cloister/router"
//     tag             TEXT NOT NULL,        -- e.g. "0.1.0", "latest"
//     manifest_digest TEXT NOT NULL,        -- "sha256:<hex>" — points at BlobStore
//     created_at      INTEGER NOT NULL,     -- Unix-ms of last upsert
//     PRIMARY KEY (repo, tag)
//   )
//
// Indexes (implicit via PK ORDER BY): the listing queries hit
// (repo, tag) ascending, which the primary key already serves.
//
// This module is a pure-function helper over an injected SQL executor,
// mirroring the pattern in src/storage/peer-lease-counters.ts. The DO
// surface lives in src/trust-store.ts; tests inject an in-memory SQL
// shim for unit coverage of the helpers.

/** SQL DDL for the table. Included in TrustStore's schema migration. */
export const SCHEMA_REGISTRY_TAGS = `
CREATE TABLE IF NOT EXISTS registry_tags (
  repo            TEXT NOT NULL,
  tag             TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (repo, tag)
);
`;

/** One tag row. */
export interface RegistryTag {
  repo:            string;
  tag:             string;
  manifest_digest: string;
  created_at:      number;
}

/**
 * Minimal SQL executor shape — matches workerd's `SqlStorage.exec` API.
 *
 * Workerd's `SqlStorage.exec` is non-generic and returns rows typed as
 * `Record<string, SqlStorageValue>`; callers cast at the read site.
 * Same shape as `src/storage/peer-lease-counters.ts` (intentional —
 * the storage helpers should be testable against a single fake).
 */
export interface SqlExecutor {
  exec(query: string, ...bindings: unknown[]): {
    toArray(): Record<string, unknown>[];
  };
}

/**
 * UPSERT a tag → manifest digest mapping. Idempotent on (repo, tag):
 * the same (repo, tag, digest) tuple can be applied any number of times
 * without creating duplicate rows. A re-tag (same (repo, tag), different
 * digest) overwrites the row in place — this matches the OCI spec, where
 * tags are mutable pointers.
 *
 * `digest` MUST already be in "sha256:<hex>" form. The OCI registry
 * route validates the prefix at the HTTP boundary.
 */
export function upsertTag(
  sql:    SqlExecutor,
  repo:   string,
  tag:    string,
  digest: string,
  nowMs:  number,
): void {
  sql.exec(
    `INSERT INTO registry_tags (repo, tag, manifest_digest, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(repo, tag) DO UPDATE SET
       manifest_digest = excluded.manifest_digest,
       created_at      = excluded.created_at`,
    repo, tag, digest, nowMs,
  );
}

/**
 * Look up the manifest digest for a tag. Returns null when the tag is
 * unknown. Used by `GET /v2/<name>/manifests/<reference>` when
 * `<reference>` is a tag (vs. a `sha256:...` digest, which bypasses the
 * index and goes directly to BlobStore).
 */
export function getManifestDigestForTag(
  sql:  SqlExecutor,
  repo: string,
  tag:  string,
): string | null {
  const rows = sql.exec(
    "SELECT manifest_digest FROM registry_tags WHERE repo = ? AND tag = ? LIMIT 1",
    repo, tag,
  ).toArray() as { manifest_digest: string }[];
  return rows.length === 0 ? null : rows[0]!.manifest_digest;
}

/**
 * List all tags for one repo. Used by `GET /v2/<name>/tags/list`.
 * Empty array when the repo is unknown — the OCI spec treats an unknown
 * repo as a 404 on `tags/list`, but the caller (route) makes that
 * decision based on whether the array is empty AND there are no other
 * cues (e.g. blob existence) for the name.
 */
export function listTagsForRepo(sql: SqlExecutor, repo: string): string[] {
  const rows = sql.exec(
    "SELECT tag FROM registry_tags WHERE repo = ? ORDER BY tag",
    repo,
  ).toArray() as { tag: string }[];
  return rows.map((r) => r.tag);
}

/**
 * List all repos with at least one tag. Used by `GET /v2/_catalog`.
 * Returned in lexicographic order so the listing is stable + cache-
 * friendly. The OCI spec allows pagination via `?n=<limit>&last=<repo>`;
 * Phase 1 returns everything (the table is small — bundle counts are
 * tens-of-rows at the cluster scale we ship today).
 */
export function listRepos(sql: SqlExecutor): string[] {
  const rows = sql.exec(
    "SELECT DISTINCT repo FROM registry_tags ORDER BY repo",
  ).toArray() as { repo: string }[];
  return rows.map((r) => r.repo);
}
