// SPDX-License-Identifier: AGPL-3.0-or-later
//
// pending_attestations — retry queue for cross-DO attestation writes
// that didn't make it to the TrustStore on the first try.
//
// Closes threat-model finding §8 (cloister-c6d378): ADR-0012's content-
// addressed handoff is recoverable on retry, but the model didn't
// specify WHO retries, the retry budget, where the retry-pending state
// lives, or what the disclosure endpoint shows during the retry window.
//
// This module supplies that detail:
//
//   - The substrate is a SQLite table inside TrustStore. State is
//     visible cross-bundle so the disclosure endpoint can distinguish
//     three states for a peer's chain:
//       * COMPLETE — every state-boundary write has a peer_attestations row
//       * PENDING  — there's a row in pending_attestations awaiting retry
//       * GAP      — neither row exists (the dangerous case; real misbehavior
//                    or unrecoverable failure)
//
//   - Retries use exponential backoff: 30s → 1m → 2m → 5m → 10m. After
//     `MAX_RETRY_ATTEMPTS` failures the row stays in pending forever
//     with `attempts >= MAX_RETRY_ATTEMPTS`; that's the signal that
//     a human needs to investigate (storage corruption, schema drift,
//     etc.).
//
//   - A DO alarm in TrustStore drives the retry pump (filed as a
//     follow-up bead — this module ships the substrate, not the timer
//     wiring). Until that lands, the helpers are a pure data layer
//     that the bead_create path inserts into and a manual sweep can
//     read from.
//
// Why not put the table in BeadStore? The retries live with the
// attestation writes; both target TrustStore. Putting them in BeadStore
// would require BeadStore→TrustStore RPC during the retry, defeating
// the purpose of the retry queue.
//
// ── Why `prev_self_ref` is NOT a column on this table ────────────────────
//
// The pending row stores `cert`, `sig`, `scope`, and `content_hash` —
// enough to recompute the attestation but NOT enough to blindly replay
// the original `applyAttestation` call. That's deliberate, and worth
// preserving.
//
// `prev_self_ref` for an attestation is "the chain_hash of the peer's
// previous attestation, at write time." If we cached the pre-failure
// value here and replayed it at drain time, we'd fork the chain
// whenever a concurrent direct write landed between the first attempt
// and the retry. Concretely:
//
//   t0: applyAttestation(peer=P, content=X) computes prev_self_ref = A
//       (= current chain head for P). TrustStore write fails. Row
//       enqueued with cached prev_self_ref = A.
//   t1: applyAttestation(peer=P, content=Y) for a DIFFERENT bead
//       succeeds. Chain head for P is now B, sealing A → B.
//   t2: drainPendingRetries runs. If we replay with prev_self_ref = A,
//       the new row claims A as its predecessor — but B already does.
//       The chain forks: A has two successors (X and Y), both at the
//       same seq. §13.2 disclosure cannot recover.
//
// To avoid forking, the drain re-reads the chain head at retry time
// and computes prev_self_ref fresh. The pending row carries the
// inputs that don't depend on chain ordering (cert/sig/scope/
// content_hash); the order-dependent piece is re-derived at write.
// This matches the lease-counter chain pattern in
// peer-lease-counters.ts:computeNextLeaseStep — order-dependent
// fields are computed at write time against the current chain head,
// never persisted upstream of the write.
//
// Implication for callers: do NOT add a `prev_self_ref` column here
// without a design conversation. Its absence is load-bearing for
// concurrent-write correctness.

/** Hard-coded backoff schedule (milliseconds). Index = attempt count. */
export const RETRY_BACKOFF_MS: readonly number[] = [
  30_000,    // 30s after first failure
  60_000,    // 1m
  120_000,   // 2m
  300_000,   // 5m
  600_000,   // 10m
];

/** Max retry attempts. After this, the row stays pending and a human takes over. */
export const MAX_RETRY_ATTEMPTS = RETRY_BACKOFF_MS.length;

/** SQL DDL for the pending_attestations table. Idempotent. */
export const SCHEMA_PENDING_ATTESTATIONS = `
CREATE TABLE IF NOT EXISTS pending_attestations (
  peer_fp        TEXT NOT NULL,
  content_hash   TEXT NOT NULL,
  scope          TEXT NOT NULL,
  cert           BLOB NOT NULL,
  sig            BLOB NOT NULL,
  attempts       INTEGER NOT NULL DEFAULT 0,
  next_retry_at  INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  last_attempt_at INTEGER,
  PRIMARY KEY (peer_fp, content_hash)
);
CREATE INDEX IF NOT EXISTS pending_attestations_next_retry
  ON pending_attestations(next_retry_at)
  WHERE attempts < ${MAX_RETRY_ATTEMPTS};
`;

/** Minimal SQL executor surface — same shape as the other storage helpers. */
export interface SqlExecutor {
  exec(query: string, ...bindings: unknown[]): {
    toArray(): Record<string, unknown>[];
  };
}

export interface PendingAttestation {
  peer_fp:         string;
  content_hash:    string;
  scope:           string;
  cert:            Uint8Array;
  sig:             Uint8Array;
  attempts:        number;
  next_retry_at:   number;
  created_at:      number;
  last_attempt_at: number | null;
}

/**
 * Compute the next-retry timestamp from the current attempt count.
 * Returns `null` once we've exhausted MAX_RETRY_ATTEMPTS — caller is
 * expected to keep the row but stop scheduling retries.
 */
export function backoffNextRetry(attempts: number, nowMs: number): number | null {
  if (attempts >= MAX_RETRY_ATTEMPTS) return null;
  return nowMs + RETRY_BACKOFF_MS[attempts]!;
}

/**
 * Enqueue a pending attestation for retry. Idempotent on (peer_fp,
 * content_hash) — re-enqueueing the same logical write doesn't reset
 * the attempts counter (so a retry storm can't paper over a failure).
 *
 * The first attempt was the failed write; nextRetry counts from there.
 */
export function enqueuePending(
  sql: SqlExecutor,
  args: {
    peerFp:      string;
    contentHash: string;
    scope:       string;
    cert:        Uint8Array;
    sig:         Uint8Array;
    nowMs:       number;
  },
): { enqueued: boolean } {
  const nextRetry = backoffNextRetry(0, args.nowMs);
  // ON CONFLICT DO NOTHING: if a pending row already exists for this
  // (peer_fp, content_hash), keep its existing state — the retry pump
  // already owns it.
  const rows = sql
    .exec(
      `INSERT INTO pending_attestations
         (peer_fp, content_hash, scope, cert, sig, attempts, next_retry_at, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT (peer_fp, content_hash) DO NOTHING
       RETURNING peer_fp`,
      args.peerFp,
      args.contentHash,
      args.scope,
      args.cert,
      args.sig,
      nextRetry,
      args.nowMs,
    )
    .toArray();
  return { enqueued: rows.length === 1 };
}

/**
 * Claim the next batch of retry-eligible rows (rows where
 * `next_retry_at <= now` and `attempts < MAX_RETRY_ATTEMPTS`).
 *
 * Caller iterates the batch, attempts each TrustStore write, and on
 * success calls `commitPending` or on failure `recordFailedAttempt`.
 */
export function claimRetryBatch(
  sql: SqlExecutor,
  nowMs: number,
  limit: number = 32,
): PendingAttestation[] {
  const rows = sql
    .exec(
      `SELECT peer_fp, content_hash, scope, cert, sig, attempts,
              next_retry_at, created_at, last_attempt_at
         FROM pending_attestations
        WHERE next_retry_at <= ? AND attempts < ?
     ORDER BY next_retry_at ASC
        LIMIT ?`,
      nowMs,
      MAX_RETRY_ATTEMPTS,
      limit,
    )
    .toArray();
  return rows.map((r) => ({
    peer_fp:         r["peer_fp"]         as string,
    content_hash:    r["content_hash"]    as string,
    scope:           r["scope"]           as string,
    cert:            r["cert"]            as Uint8Array,
    sig:             r["sig"]             as Uint8Array,
    attempts:        r["attempts"]        as number,
    next_retry_at:   r["next_retry_at"]   as number,
    created_at:      r["created_at"]      as number,
    last_attempt_at: (r["last_attempt_at"] as number | null) ?? null,
  }));
}

/**
 * Record a successful retry — delete the pending row. Caller has already
 * written the peer_attestations row to TrustStore.
 */
export function commitPending(
  sql: SqlExecutor,
  peerFp: string,
  contentHash: string,
): { deleted: boolean } {
  const rows = sql
    .exec(
      `DELETE FROM pending_attestations
        WHERE peer_fp = ? AND content_hash = ?
        RETURNING peer_fp`,
      peerFp,
      contentHash,
    )
    .toArray();
  return { deleted: rows.length === 1 };
}

/**
 * Record a FAILED retry attempt — increment attempts, push next_retry_at
 * forward by the backoff schedule. If attempts hits MAX_RETRY_ATTEMPTS,
 * `next_retry_at` is set to a sentinel (`Number.MAX_SAFE_INTEGER`) so
 * the row no longer surfaces in `claimRetryBatch` but stays visible to
 * the disclosure endpoint as `PENDING (failed)`.
 */
export function recordFailedAttempt(
  sql: SqlExecutor,
  peerFp: string,
  contentHash: string,
  nowMs: number,
): { newAttempts: number; nextRetryAt: number | null } {
  const current = sql
    .exec(
      `SELECT attempts FROM pending_attestations WHERE peer_fp = ? AND content_hash = ?`,
      peerFp,
      contentHash,
    )
    .toArray();
  if (current.length === 0) {
    return { newAttempts: 0, nextRetryAt: null };
  }
  const newAttempts = (current[0]!["attempts"] as number) + 1;
  const next = backoffNextRetry(newAttempts, nowMs);
  const stored = next ?? Number.MAX_SAFE_INTEGER;
  sql.exec(
    `UPDATE pending_attestations
        SET attempts = ?,
            next_retry_at = ?,
            last_attempt_at = ?
      WHERE peer_fp = ? AND content_hash = ?`,
    newAttempts,
    stored,
    nowMs,
    peerFp,
    contentHash,
  );
  return { newAttempts, nextRetryAt: next };
}

/**
 * List all pending rows for a single peer (used by the disclosure
 * endpoint to surface PENDING vs GAP vs COMPLETE state).
 */
export function listPendingForPeer(
  sql: SqlExecutor,
  peerFp: string,
): PendingAttestation[] {
  const rows = sql
    .exec(
      `SELECT peer_fp, content_hash, scope, cert, sig, attempts,
              next_retry_at, created_at, last_attempt_at
         FROM pending_attestations
        WHERE peer_fp = ?
     ORDER BY created_at ASC`,
      peerFp,
    )
    .toArray();
  return rows.map((r) => ({
    peer_fp:         r["peer_fp"]         as string,
    content_hash:    r["content_hash"]    as string,
    scope:           r["scope"]           as string,
    cert:            r["cert"]            as Uint8Array,
    sig:             r["sig"]             as Uint8Array,
    attempts:        r["attempts"]        as number,
    next_retry_at:   r["next_retry_at"]   as number,
    created_at:      r["created_at"]      as number,
    last_attempt_at: (r["last_attempt_at"] as number | null) ?? null,
  }));
}
