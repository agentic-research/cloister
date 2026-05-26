// SPDX-License-Identifier: AGPL-3.0-or-later
//
// registry_blob_membership — per-repo membership index for the OCI
// registry pull surface. Maps `(repo, digest, kind)` -> exists, gating
// cross-tenant blob/manifest reads against the cluster-singleton
// BlobStore.
//
// Per ADR-0029 (cloister-7c0a0b, surfaced by cloister-667ea6
// adversarial review): BlobStore is deliberately a cluster singleton
// (load-bearing for ADR-0003's content-addressed monoid axiom), so
// the cross-tenant boundary lives ORTHOGONAL to storage — a membership
// index the OCI pull surface consults before serving bytes.
//
// Why TrustStore (not BlobStore, not a new DO):
//   - BlobStore is the immutable content-addressed monoid (ADR-0003).
//     A per-repo table there would muddy the algebra and contradict
//     the singleton design.
//   - TrustStore is the hypervisor-tier singleton already, with the
//     same SQL+blockConcurrencyWhile semantics; registry_tags lives
//     there for these reasons. This is a sibling table.
//   - A separate RegistryIndex DO would add config surface for no
//     gain at the size we ship today.
//
// Schema (repo, digest, kind) PK prevents duplicates; an UPSERT
// on-conflict refreshes recorded_at + recorded_by so re-pushes stay
// current. The digest column holds bare hex (caller strips the
// "sha256:" prefix to match BlobStore's internal addressing).
//
// Mirrors src/storage/registry-tags.ts: pure-function helpers over
// an injected SQL executor; DO surface in src/trust-store.ts.

/** SQL DDL for the table. Included in TrustStore's schema migration. */
export const SCHEMA_REGISTRY_BLOB_MEMBERSHIP = `
CREATE TABLE IF NOT EXISTS registry_blob_membership (
  repo        TEXT NOT NULL,
  digest      TEXT NOT NULL,
  kind        TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  recorded_by TEXT,
  PRIMARY KEY (repo, digest, kind)
);
CREATE INDEX IF NOT EXISTS idx_membership_digest
  ON registry_blob_membership(digest);
`;

/** Two membership kinds, matching the two OCI GET shapes. */
export type MembershipKind = "blob" | "manifest";

/**
 * SQL executor shape — matches workerd's `SqlStorage` API. Same shape
 * as src/storage/registry-tags.ts's SqlExecutor.
 */
export interface SqlExecutor {
  exec(query: string, ...bindings: unknown[]): {
    toArray(): Record<string, unknown>[];
  };
}

/**
 * UPSERT a membership row. Idempotent on (repo, digest, kind); a
 * re-push refreshes recorded_at + recorded_by in place. `digest` MUST
 * be the bare hex (no "sha256:" prefix). `peerFp` is the verified
 * Interlace lease subject when available, null otherwise (dev mode
 * or pre-lease-wiring callers).
 */
export function recordMembership(
  sql:     SqlExecutor,
  repo:    string,
  digest:  string,
  kind:    MembershipKind,
  nowMs:   number,
  peerFp?: string | null,
): void {
  sql.exec(
    `INSERT INTO registry_blob_membership (repo, digest, kind, recorded_at, recorded_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(repo, digest, kind) DO UPDATE SET
       recorded_at = excluded.recorded_at,
       recorded_by = excluded.recorded_by`,
    repo, digest, kind, nowMs, peerFp ?? null,
  );
}

/**
 * Membership probe: does `repo` have access to `digest` (under `kind`)?
 *
 * The OCI pull surface calls this BEFORE BlobStore.get/has — a `false`
 * return means the route MUST return constant-shape 404 (matching the
 * §9.4 "exists but not yours" precedent from threat-model.md / ADR-0024).
 * The response is indistinguishable from "digest doesn't exist anywhere"
 * — that's the point. An attacker probing cross-repo namespace cannot
 * differentiate "blob exists in some other tenant" from "blob doesn't
 * exist" on a 404.
 */
export function hasMembership(
  sql:    SqlExecutor,
  repo:   string,
  digest: string,
  kind:   MembershipKind,
): boolean {
  const rows = sql.exec(
    `SELECT 1 AS one FROM registry_blob_membership
     WHERE repo = ? AND digest = ? AND kind = ? LIMIT 1`,
    repo, digest, kind,
  ).toArray();
  return rows.length > 0;
}

/**
 * List repos with membership of a digest. Diagnostic helper — NOT used
 * on the pull path. Useful for GC reachability scans (a digest with
 * zero memberships is a sweep candidate) and operator forensics.
 */
export function listReposWithMembership(
  sql:    SqlExecutor,
  digest: string,
): string[] {
  const rows = sql.exec(
    `SELECT DISTINCT repo FROM registry_blob_membership
     WHERE digest = ? ORDER BY repo`,
    digest,
  ).toArray() as { repo: string }[];
  return rows.map((r) => r.repo);
}
