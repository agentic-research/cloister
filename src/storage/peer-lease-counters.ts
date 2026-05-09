// SPDX-License-Identifier: AGPL-3.0-or-later
//
// peer_lease_counters — per-peer hash-chained counter, updated on every
// authenticated request.
//
// Per ADR-0007 audit amendment 2026-05-08 (cloister-e1d54e): the
// `peer_attestations` table only writes on state-boundary mutations
// (bead_create/update/close/comment). A peer who only ever invokes
// read-only tools (lsp_*, mache_*, bead_search) leaves zero attestation
// rows, breaking spec §13.2's "silence is evidence" property — silence
// becomes indistinguishable from "we never interacted."
//
// The lease counter restores the property at one row-update per call.
// One row per peer (NOT one per call); a hash chain inside the row
// captures the sequence. Both sides can independently reconstruct the
// chain because the inputs are deterministic.
//
// Schema:
//
//   peer_lease_counters (
//     peer_fingerprint TEXT PRIMARY KEY,
//     seq              INTEGER NOT NULL,
//     last_chain_hash  TEXT NOT NULL,    -- sha256_hex(prev || cert_fp || nonce || ts)
//     last_cert_fp     TEXT NOT NULL,
//     updated_at       INTEGER NOT NULL  -- Unix-ms, server-timestamped
//   )
//
// On first observation of a peer, `prev_chain_hash = ZERO_HASH` and
// `seq = 1`. Subsequent calls fold (cert_fp, nonce, server_ts) into the
// chain, monotonically increasing seq.
//
// This module is a pure-function helper over an injected SQL executor —
// the actual Durable Object call site is in `src/beads.ts` (the
// BeadStore DO). Keeping the chain logic out of the DO class makes it
// independently testable.

/** Genesis hash (256 zero bits, hex). Used when no prior counter exists. */
export const ZERO_HASH = "0".repeat(64);

/** SQL DDL for the table. Included in BeadStore's schema migration. */
export const SCHEMA_PEER_LEASE_COUNTERS = `
CREATE TABLE IF NOT EXISTS peer_lease_counters (
  peer_fingerprint TEXT PRIMARY KEY,
  seq              INTEGER NOT NULL,
  last_chain_hash  TEXT NOT NULL,
  last_cert_fp     TEXT NOT NULL,
  updated_at       INTEGER NOT NULL
);
`;

export interface PeerLeaseCounter {
  peer_fingerprint: string;
  seq: number;
  last_chain_hash: string;
  last_cert_fp: string;
  updated_at: number;
}

/**
 * Minimal SQL executor shape — matches workerd's `SqlStorage` API used by
 * `BeadStore`. Pure-function helpers here accept any executor satisfying
 * this shape, so unit tests can inject an in-memory fake.
 */
export interface SqlExecutor {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): {
    toArray(): T[];
  };
}

/**
 * Fold (cert_fp, nonce, ts) into the previous chain hash. Deterministic —
 * verifier on the peer side can reconstruct the chain from the same
 * inputs.
 */
export async function nextChainHash(
  prevHash: string,
  certFp: string,
  nonce: string,
  ts: number,
): Promise<string> {
  const data = new TextEncoder().encode(`${prevHash}${certFp}${nonce}${ts}`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Read the current counter for a peer, or `null` if no counter exists.
 * Pure read — does not mutate.
 */
export function readLeaseCounter(
  sql: SqlExecutor,
  peerFingerprint: string,
): PeerLeaseCounter | null {
  const rows = sql
    .exec<PeerLeaseCounter>(
      "SELECT peer_fingerprint, seq, last_chain_hash, last_cert_fp, updated_at FROM peer_lease_counters WHERE peer_fingerprint = ?",
      peerFingerprint,
    )
    .toArray();
  return rows[0] ?? null;
}

/**
 * Apply one authenticated-request observation to a peer's counter.
 *
 * Reads the current row (or genesis), folds (cert_fp, nonce, ts) into the
 * chain hash, increments `seq`, upserts. Returns the new row's seq +
 * chain hash so the caller can include them in any wire response (e.g.
 * if a peer asks "what's our current lease state?").
 *
 * `nonce` is the request's anti-replay nonce — the lease middleware
 * generates it per request and includes it in the verified envelope, so
 * folding it in here binds the chain to a specific request, not just
 * to (peer, time). Two distinct requests at the same `ts` produce
 * distinct chain hashes.
 */
export async function applyLeaseCounter(
  sql: SqlExecutor,
  peerFingerprint: string,
  certFingerprint: string,
  nonce: string,
  ts: number,
): Promise<{ seq: number; last_chain_hash: string }> {
  const existing = readLeaseCounter(sql, peerFingerprint);
  const prevHash = existing?.last_chain_hash ?? ZERO_HASH;
  const prevSeq  = existing?.seq ?? 0;

  const last_chain_hash = await nextChainHash(prevHash, certFingerprint, nonce, ts);
  const seq = prevSeq + 1;

  // UPSERT — INSERT or replace via ON CONFLICT(peer_fingerprint).
  sql.exec(
    `INSERT INTO peer_lease_counters
       (peer_fingerprint, seq, last_chain_hash, last_cert_fp, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(peer_fingerprint) DO UPDATE SET
       seq = excluded.seq,
       last_chain_hash = excluded.last_chain_hash,
       last_cert_fp = excluded.last_cert_fp,
       updated_at = excluded.updated_at`,
    peerFingerprint,
    seq,
    last_chain_hash,
    certFingerprint,
    ts,
  );

  return { seq, last_chain_hash };
}
