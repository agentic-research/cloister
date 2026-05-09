// SPDX-License-Identifier: AGPL-3.0-or-later
//
// seen_nonces — anti-replay nonce ledger keyed on (cert_fp, nonce).
//
// Closes cloister-c5c846 / threat-model §6.2.3: the lease middleware
// advertises "replay defense via nonce window" but no uniqueness check
// existed. An attacker who captured an authenticated envelope could
// replay it for the remaining cert TTL (~5 min worst case) until this
// table rejected the duplicate.
//
// Design:
//
//   - Key the ledger on (cert_fp, nonce) — NOT just nonce. Two different
//     peers with independently-minted ephemeral certs could mint the
//     same random nonce; that's not a replay. Only a duplicate within
//     the same cert is.
//   - Use INSERT ... ON CONFLICT DO NOTHING + RETURNING — the row count
//     in the cursor distinguishes "fresh" (1 row returned) from
//     "duplicate" (0 rows). Idiomatic SQLite, no read-then-write race.
//   - Caller (lease middleware) does the check BEFORE the counter
//     UPSERT. A duplicate must short-circuit before the chain advances.
//
// Garbage collection:
//
//   The math friend's threat model accepts that nonces older than the
//   max cert TTL can be evicted; an attacker can't replay a cert that's
//   already expired. Phase 1: no GC — entries accumulate. SQLite
//   handles millions of rows without trouble; rows are 64 bytes each;
//   at sustained 100 req/sec the ledger grows ~5 MB/day. Phase 2 work
//   filed as a follow-up: opportunistic prune on every Nth UPSERT.

/** SQL DDL for the seen_nonces table. Idempotent — `CREATE IF NOT EXISTS`. */
export const SCHEMA_SEEN_NONCES = `
CREATE TABLE IF NOT EXISTS seen_nonces (
  cert_fp TEXT NOT NULL,
  nonce   TEXT NOT NULL,
  ts_ms   INTEGER NOT NULL,
  PRIMARY KEY (cert_fp, nonce)
);
`;

/**
 * Minimal SQL executor shape — same contract as peer-lease-counters.ts.
 * Pure-function helpers accept anything matching this surface so unit
 * tests can inject an in-memory fake.
 */
export interface SqlExecutor {
  exec(query: string, ...bindings: unknown[]): {
    toArray(): Record<string, unknown>[];
  };
}

/**
 * Atomically record a (cert_fp, nonce) tuple. Returns:
 *
 *   - `{ fresh: true }`  — first time we've seen this tuple; caller may
 *     proceed with the request.
 *   - `{ fresh: false }` — duplicate; caller MUST reject as replay.
 *
 * The check is a single SQL statement (INSERT ... ON CONFLICT DO
 * NOTHING RETURNING) — no read-then-write window.
 */
export function recordSeenNonce(
  sql: SqlExecutor,
  certFp: string,
  nonce: string,
  tsMs: number,
): { fresh: boolean } {
  const rows = sql
    .exec(
      `INSERT INTO seen_nonces (cert_fp, nonce, ts_ms) VALUES (?, ?, ?)
       ON CONFLICT(cert_fp, nonce) DO NOTHING
       RETURNING cert_fp`,
      certFp,
      nonce,
      tsMs,
    )
    .toArray();
  return { fresh: rows.length === 1 };
}

/**
 * Garbage-collect nonces older than `beforeTsMs`. Returns the number of
 * rows deleted. Safe to call ad-hoc; SQLite's PK lookup makes the
 * timestamp scan cheap on a covering range.
 */
export function pruneSeenNoncesBefore(
  sql: SqlExecutor,
  beforeTsMs: number,
): number {
  const rows = sql
    .exec(
      `DELETE FROM seen_nonces WHERE ts_ms < ? RETURNING cert_fp`,
      beforeTsMs,
    )
    .toArray();
  return rows.length;
}
