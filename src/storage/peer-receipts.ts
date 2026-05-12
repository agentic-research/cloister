// SPDX-License-Identifier: AGPL-3.0-or-later
//
// peer_receipts — cross-restart durable store for receipts cloister
// observes as a CLIENT (P-side, when consuming upstream Interlace
// responses) plus receipts cloister EMITS as the actor (A-side).
//
// Per RECEIPTS.md §2.2.2 V-archival verification: V replays a stored
// receipt against A's archived CA bundle for the receipt's epoch. To
// support that audit path, both directions of the receipt traffic are
// persisted by `request_hash` (the canonical key — receipts commit to
// it, and V re-derives it to look up).
//
// The table is INDEX-ONLY storage of the receipt envelope blob. Bytes
// are content-addressed; integrity is via the envelope's own
// signature, not via SQL-level constraints. SQL gives us efficient
// lookup-by-request-hash + lookup-by-actor-epoch for sweep operations.
//
// Per ADR-0012, this table lives in TrustStore (singleton per cluster),
// not in BeadStore. Receipts witnessed by a cluster are cluster-scoped,
// not per-repo.

/** SQL DDL. Idempotent via CREATE IF NOT EXISTS. */
export const SCHEMA_PEER_RECEIPTS = `
CREATE TABLE IF NOT EXISTS peer_receipts (
  actor_fp         TEXT NOT NULL,
  request_hash     TEXT NOT NULL,
  direction        TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  epoch            INTEGER NOT NULL,
  peer_fp          TEXT,
  status           INTEGER NOT NULL,
  timestamp_ms     INTEGER NOT NULL,
  envelope_b64u    TEXT NOT NULL,
  observed_at_ms   INTEGER NOT NULL,
  PRIMARY KEY (actor_fp, request_hash, direction)
);
CREATE INDEX IF NOT EXISTS peer_receipts_actor_epoch
  ON peer_receipts(actor_fp, epoch, timestamp_ms);
CREATE INDEX IF NOT EXISTS peer_receipts_peer_fp
  ON peer_receipts(peer_fp, observed_at_ms);
`;

/** Minimal SQL executor surface — shared with peer-attestations. */
export interface SqlExecutor {
  exec(query: string, ...bindings: unknown[]): {
    toArray(): Record<string, unknown>[];
  };
}

export interface PeerReceiptRow {
  actor_fp:       string;
  request_hash:   string;
  direction:      "in" | "out";
  epoch:          number;
  peer_fp:        string | null;
  status:         number;
  timestamp_ms:   number;
  envelope_b64u:  string;
  observed_at_ms: number;
}

/**
 * Insert (or REPLACE on conflict) a receipt row. Idempotent on
 * (actor_fp, request_hash, direction).
 */
export function upsertPeerReceipt(
  sql: SqlExecutor,
  row: PeerReceiptRow,
): void {
  sql.exec(
    `INSERT INTO peer_receipts
       (actor_fp, request_hash, direction, epoch, peer_fp, status,
        timestamp_ms, envelope_b64u, observed_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (actor_fp, request_hash, direction) DO UPDATE SET
       epoch          = excluded.epoch,
       peer_fp        = excluded.peer_fp,
       status         = excluded.status,
       timestamp_ms   = excluded.timestamp_ms,
       envelope_b64u  = excluded.envelope_b64u,
       observed_at_ms = excluded.observed_at_ms`,
    row.actor_fp, row.request_hash, row.direction, row.epoch, row.peer_fp ?? null,
    row.status, row.timestamp_ms, row.envelope_b64u, row.observed_at_ms,
  );
}

/** Look up a receipt by (actor_fp, request_hash, direction). */
export function findPeerReceipt(
  sql: SqlExecutor,
  actorFp: string,
  requestHash: string,
  direction: "in" | "out",
): PeerReceiptRow | null {
  const rows = sql.exec(
    `SELECT actor_fp, request_hash, direction, epoch, peer_fp, status,
            timestamp_ms, envelope_b64u, observed_at_ms
       FROM peer_receipts
      WHERE actor_fp = ? AND request_hash = ? AND direction = ?
      LIMIT 1`,
    actorFp, requestHash, direction,
  ).toArray();
  if (rows.length === 0) return null;
  return rows[0] as unknown as PeerReceiptRow;
}

/** List receipts for an actor + epoch (audit sweep helper). */
export function listReceiptsForActorEpoch(
  sql: SqlExecutor,
  actorFp: string,
  epoch: number,
  limit = 100,
): PeerReceiptRow[] {
  const rows = sql.exec(
    `SELECT actor_fp, request_hash, direction, epoch, peer_fp, status,
            timestamp_ms, envelope_b64u, observed_at_ms
       FROM peer_receipts
      WHERE actor_fp = ? AND epoch = ?
   ORDER BY timestamp_ms ASC
      LIMIT ?`,
    actorFp, epoch, limit,
  ).toArray();
  return rows as unknown as PeerReceiptRow[];
}
