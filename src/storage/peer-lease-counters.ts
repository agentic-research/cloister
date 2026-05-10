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
 * Minimal SQL executor shape — matches workerd's `SqlStorage.exec` API.
 * Pure-function helpers here accept any executor satisfying this shape,
 * so unit tests can inject an in-memory fake.
 *
 * Workerd's `SqlStorage.exec` is non-generic and returns rows typed as
 * `Record<string, SqlStorageValue>`; callers cast at the read site.
 * (An earlier version of this interface used `<T>` on `exec`, but
 * TypeScript variance rejects assigning a real `SqlStorage` to it.)
 */
export interface SqlExecutor {
  exec(query: string, ...bindings: unknown[]): {
    toArray(): Record<string, unknown>[];
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
    .exec(
      "SELECT peer_fingerprint, seq, last_chain_hash, last_cert_fp, updated_at FROM peer_lease_counters WHERE peer_fingerprint = ?",
      peerFingerprint,
    )
    .toArray() as unknown as PeerLeaseCounter[];
  return rows[0] ?? null;
}

/**
 * Chain-integrity error — a defensive class of failure that should never
 * happen under correct callers. Surfaced so a caller bug or compromised
 * helper can't silently corrupt the chain (cloister-c75da6 / threat
 * model §7.4-7.5).
 */
export class ChainIntegrityError extends Error {
  override readonly name = "ChainIntegrityError";
}

/**
 * Defensive check: assert (prevSeq, prevHash) → (nextSeq, nextHash) is a
 * valid chain step. Used inside `applyLeaseCounter` so even if a future
 * refactor accepts seq from the caller, we'd still refuse non-monotonic
 * writes or hash-chain skips. The check is over the helper's OWN inputs
 * — it's defense-in-depth, not a substitute for trusting the caller.
 */
export async function assertChainStep(
  prevSeq: number,
  prevHash: string,
  nextSeq: number,
  nextHash: string,
  certFp: string,
  nonce: string,
  ts: number,
): Promise<void> {
  if (nextSeq !== prevSeq + 1) {
    throw new ChainIntegrityError(
      `non-monotonic seq: expected ${prevSeq + 1}, got ${nextSeq}`,
    );
  }
  const expectedNextHash = await nextChainHash(prevHash, certFp, nonce, ts);
  if (nextHash !== expectedNextHash) {
    throw new ChainIntegrityError(
      `chain-hash skip: expected ${expectedNextHash}, got ${nextHash}`,
    );
  }
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
 *
 * Throws `ChainIntegrityError` if the computed step is not a monotonic
 * extension of the prior chain (cloister-c75da6). Should never happen
 * under correct usage — the check is defense-in-depth so a future
 * refactor can't silently corrupt the chain.
 *
 * Implementation note: composed from `computeNextLeaseStep` (pure read +
 * digest) and `writeLeaseCounterRow` (pure write). The split exists so
 * the batched `verifyLeaseAndAdvanceChain` RPC (cloister-ee51b8) can
 * insert a `transactionSync` between the digest and the write so the
 * seen_nonces INSERT and the counter UPSERT commit atomically.
 */
export async function applyLeaseCounter(
  sql: SqlExecutor,
  peerFingerprint: string,
  certFingerprint: string,
  nonce: string,
  ts: number,
): Promise<{ seq: number; last_chain_hash: string }> {
  const step = await computeNextLeaseStep(sql, peerFingerprint, certFingerprint, nonce, ts);
  writeLeaseCounterRow(sql, peerFingerprint, certFingerprint, ts, step.seq, step.last_chain_hash);
  return { seq: step.seq, last_chain_hash: step.last_chain_hash };
}

/**
 * Compute the next chain step for a peer WITHOUT writing. Reads the
 * current row, folds (cert_fp, nonce, ts) into the chain hash via the
 * deterministic SHA-256 transcript, and asserts monotonic chain
 * extension.
 *
 * Returns `{ prevSeq, prevHash, seq, last_chain_hash }` — caller is
 * responsible for the UPSERT (typically via `writeLeaseCounterRow`,
 * usually inside a `transactionSync` for cross-table atomicity).
 *
 * Extracted from `applyLeaseCounter` for cloister-ee51b8 so the
 * batched RPC can do the digest async BEFORE entering the synchronous
 * write transaction (since `transactionSync` doesn't accept async
 * callbacks). The chain math is byte-identical to `applyLeaseCounter`
 * — the spec test vectors at `interlace-spec/0.1.0/test-vectors/
 * lease-counter.json` verify this.
 */
export async function computeNextLeaseStep(
  sql: SqlExecutor,
  peerFingerprint: string,
  certFingerprint: string,
  nonce: string,
  ts: number,
): Promise<{
  prevSeq:         number;
  prevHash:        string;
  seq:             number;
  last_chain_hash: string;
}> {
  const existing = readLeaseCounter(sql, peerFingerprint);
  const prevHash = existing?.last_chain_hash ?? ZERO_HASH;
  const prevSeq  = existing?.seq ?? 0;

  const last_chain_hash = await nextChainHash(prevHash, certFingerprint, nonce, ts);
  const seq = prevSeq + 1;

  await assertChainStep(prevSeq, prevHash, seq, last_chain_hash, certFingerprint, nonce, ts);

  return { prevSeq, prevHash, seq, last_chain_hash };
}

/**
 * UPSERT the counter row. Pure synchronous write — safe to call inside
 * `transactionSync`. Caller MUST have computed `seq` + `last_chain_hash`
 * via `computeNextLeaseStep` (or equivalent) so monotonicity and
 * chain-step assertions hold.
 */
export function writeLeaseCounterRow(
  sql:             SqlExecutor,
  peerFingerprint: string,
  certFingerprint: string,
  ts:              number,
  seq:             number,
  lastChainHash:   string,
): void {
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
    lastChainHash,
    certFingerprint,
    ts,
  );
}
