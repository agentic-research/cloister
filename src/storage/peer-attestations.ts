// SPDX-License-Identifier: AGPL-3.0-or-later
//
// peer_attestations — per-(peer, seq) bilateral chain entry written on
// state-boundary mutations.
//
// Per ADR-0007 amendment 2026-05-08 + ADR-0012 (the BeadStore/TrustStore
// split). The table lives in TrustStore (singleton per cluster), NOT in
// BeadStore (per-repo). Cross-DO consistency between bead state and
// attestation state is via ADR-0003 content-addressed handoff:
//
//   1. bead_create writes canonical bytes to BlobStore (CAS; idempotent)
//   2. BlobStore returns digest
//   3. BeadStore writes bead row referencing digest         (per-repo, ACID)
//   4. TrustStore writes peer_attestations row referencing  (singleton, ACID)
//      the same digest
//
// On step-4 failure: caller enqueues into pending_attestations
// (cloister-c6d378 / src/storage/pending-attestations.ts) and a retry
// pump claims-and-retries on a backoff schedule. Three states for a
// peer's chain:
//
//   COMPLETE — every state-write has a peer_attestations row
//   PENDING  — pending_attestations row awaiting retry (maybe exhausted)
//   GAP      — neither — real misbehavior or unrecoverable failure
//
// Schema invariants:
//   - PRIMARY KEY (peer_fingerprint, seq) — sequence is per-peer monotonic
//   - prev_self_ref points at the previous row's content_hash (chain self)
//   - prev_peer_ref points at the peer-side counterpart digest (cross-chain)
//   - cert + sig are stored in raw DER/bytes form so disclosure can
//     re-verify offline against the peer-shipped master pubkey

/** SQL DDL — idempotent via CREATE IF NOT EXISTS. */
export const SCHEMA_PEER_ATTESTATIONS = `
CREATE TABLE IF NOT EXISTS peer_attestations (
  peer_fingerprint TEXT NOT NULL,
  seq              INTEGER NOT NULL,
  prev_self_ref    TEXT,
  prev_peer_ref    TEXT,
  content_hash     TEXT NOT NULL,
  content_type     TEXT NOT NULL,
  scope            TEXT NOT NULL,
  cert             BLOB NOT NULL,
  sig              BLOB NOT NULL,
  created_at       INTEGER NOT NULL,
  -- bead_id: cloister-c8b907 sub-bead 1 / ADR-0033 D5 amendment 2026-06-24.
  -- After BeadStore-DO deprecation the §13.4 audit chain reconstitutes via
  -- a JOIN through this column: each attestation row knows which bead row
  -- it audits, even when the bead row lives in rsry/bd's Dolt (which
  -- doesn't carry content_hash). NULL is valid for pre-migration rows AND
  -- for attestations that aren't bead-create (e.g. future state-boundary
  -- writes against other DO state).
  bead_id          TEXT,
  PRIMARY KEY (peer_fingerprint, seq)
);
CREATE INDEX IF NOT EXISTS peer_attestations_content
  ON peer_attestations(peer_fingerprint, content_hash);
-- Non-unique index — a bead may in principle have multiple attestations
-- across retries / recoveries. Single-attestation-per-bead is the common
-- case but not an invariant.
CREATE INDEX IF NOT EXISTS peer_attestations_bead_id
  ON peer_attestations(bead_id) WHERE bead_id IS NOT NULL;
`;

/** Minimal SQL executor surface. */
export interface SqlExecutor {
  exec(query: string, ...bindings: unknown[]): {
    toArray(): Record<string, unknown>[];
  };
}

export interface PeerAttestation {
  peer_fingerprint: string;
  seq:              number;
  prev_self_ref:    string | null;
  prev_peer_ref:    string | null;
  content_hash:     string;
  content_type:     string;
  scope:            string;
  cert:             Uint8Array;
  sig:              Uint8Array;
  created_at:       number;
  /**
   * Cross-table link to the bead row this attestation audits. NULL means
   * either (a) pre-migration row that predates `cloister-c8b907 sub-bead 1`,
   * or (b) an attestation against state OTHER than a bead (future
   * state-boundary writes — none today). cloister-c8b907 / ADR-0033 D5
   * amendment 2026-06-24.
   */
  bead_id:          string | null;
}

/**
 * AttestationIntegrityError — kept for compatibility with callers that
 * want exception semantics. The helper itself returns a Result-shape;
 * see `ApplyAttestationResult`. Construct an instance from a
 * `prev_self_ref_mismatch` result if you need to throw.
 */
export class AttestationIntegrityError extends Error {
  override readonly name = "AttestationIntegrityError";
}

/**
 * Result of `applyAttestation`. Returned (not thrown) so the failure mode
 * crosses workerd RPC boundaries cleanly. The integrity-failure path is
 * defense-in-depth — it should NEVER fire under correct caller behavior,
 * but when it does fire it must be observable as a value, not a hidden
 * unhandled rejection in the test reporter.
 *
 * - `ok: true`  — INSERT happened; row is the new chain entry.
 * - `ok: false, error: "prev_self_ref_mismatch"` — caller's claimed
 *   prev_self_ref didn't match the actual chain head. `expected` is
 *   what the chain says; `got` is what the caller supplied. No row was
 *   written.
 */
export type ApplyAttestationResult =
  | { ok: true;  seq: number; row: PeerAttestation }
  | {
      ok: false;
      error: "prev_self_ref_mismatch";
      message: string;
      expected: string | null;
      got: string | null;
    };

/** Read the most-recent attestation for a peer, or null if none exist. */
export function lastAttestationForPeer(
  sql: SqlExecutor,
  peerFingerprint: string,
): PeerAttestation | null {
  const rows = sql
    .exec(
      `SELECT peer_fingerprint, seq, prev_self_ref, prev_peer_ref,
              content_hash, content_type, scope, cert, sig, created_at, bead_id
         FROM peer_attestations
        WHERE peer_fingerprint = ?
     ORDER BY seq DESC
        LIMIT 1`,
      peerFingerprint,
    )
    .toArray();
  return rows[0] ? rowToAttestation(rows[0]) : null;
}

/**
 * Look up attestations by bead_id — the §13.4 audit query post-BeadStore-DO
 * deprecation (cloister-c8b907 / ADR-0033 D5 amendment). Returns all
 * attestation rows whose bead_id matches, ordered by created_at ASC. Empty
 * list means either the bead has no attestation (created via direct rsry
 * bypass, no orchestrator) or no rows match (the bead doesn't exist or
 * was created pre-migration).
 *
 * `peer_attestations_bead_id` partial index covers this query.
 */
export function attestationsForBead(
  sql: SqlExecutor,
  beadId: string,
): PeerAttestation[] {
  const rows = sql
    .exec(
      `SELECT peer_fingerprint, seq, prev_self_ref, prev_peer_ref,
              content_hash, content_type, scope, cert, sig, created_at, bead_id
         FROM peer_attestations
        WHERE bead_id = ?
     ORDER BY created_at ASC`,
      beadId,
    )
    .toArray();
  return rows.map((r) => rowToAttestation(r));
}

/**
 * Append one peer_attestations row for a state-boundary write.
 *
 * The caller already verified the cert + extracted scope + computed
 * content_hash via the cross-DO handoff (BlobStore-CAS step). This
 * helper:
 *   1. Looks up the peer's previous chain head
 *   2. Validates that caller-supplied prev_self_ref matches it
 *      (defense-in-depth — throws AttestationIntegrityError on
 *      mismatch; never writes a forked chain row)
 *   3. Appends the new row with seq = prevSeq + 1
 *
 * Idempotency: caller guarantees content_hash uniqueness via BlobStore
 * CAS. If the same (peer_fingerprint, content_hash) is appended twice
 * (e.g. retry after partial failure), the SECOND write is a different
 * seq — the chain captures both observations. That's the right
 * semantic: each state-boundary observation is its own row even if the
 * underlying content didn't change.
 */
export function applyAttestation(
  sql: SqlExecutor,
  args: {
    peerFingerprint: string;
    /** sha256 hex of the canonical bead bytes (via BlobStore). */
    contentHash:     string;
    contentType:     string;
    scope:           string;
    /** Cert DER from the verified lease envelope. */
    cert:            Uint8Array;
    /** Ed25519 sig over (canonical bead bytes || prev_self_ref). */
    sig:             Uint8Array;
    /** Caller's claim about the peer's previous chain head. */
    prevSelfRef:     string | null;
    /** Cross-chain ref to the peer-side counterpart, or null at genesis. */
    prevPeerRef:     string | null;
    /** Server-side timestamp (Unix ms). */
    nowMs:           number;
    /**
     * Optional bead_id linking this attestation to a specific bead row.
     * Set by the bead-create orchestrator (`src/routes/bead-create-orchestrator.ts`)
     * after step 2 produces the bead row. Future state-boundary writes
     * against non-bead state leave this null. Per cloister-c8b907 sub-bead 1.
     */
    beadId?:         string | null;
  },
): ApplyAttestationResult {
  const last = lastAttestationForPeer(sql, args.peerFingerprint);
  const expectedPrevSelfRef = last?.content_hash ?? null;
  if (args.prevSelfRef !== expectedPrevSelfRef) {
    return {
      ok: false,
      error: "prev_self_ref_mismatch",
      message:
        `prev_self_ref mismatch for peer ${args.peerFingerprint}: ` +
        `expected ${expectedPrevSelfRef ?? "(genesis)"}, got ${args.prevSelfRef ?? "(genesis)"}`,
      expected: expectedPrevSelfRef,
      got:      args.prevSelfRef,
    };
  }
  const seq = (last?.seq ?? 0) + 1;

  const beadId = args.beadId ?? null;
  sql.exec(
    `INSERT INTO peer_attestations
       (peer_fingerprint, seq, prev_self_ref, prev_peer_ref,
        content_hash, content_type, scope, cert, sig, created_at, bead_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args.peerFingerprint,
    seq,
    args.prevSelfRef,
    args.prevPeerRef,
    args.contentHash,
    args.contentType,
    args.scope,
    args.cert,
    args.sig,
    args.nowMs,
    beadId,
  );

  return {
    ok: true,
    seq,
    row: {
      peer_fingerprint: args.peerFingerprint,
      seq,
      prev_self_ref:    args.prevSelfRef,
      prev_peer_ref:    args.prevPeerRef,
      content_hash:     args.contentHash,
      content_type:     args.contentType,
      scope:            args.scope,
      cert:             args.cert,
      sig:              args.sig,
      created_at:       args.nowMs,
      bead_id:          beadId,
    },
  };
}

/**
 * List all attestations for a peer, ordered by seq ASC. Used by the
 * disclosure endpoint (bdef0c) to return a peer's chain from genesis
 * forward.
 */
export function listAttestationsForPeer(
  sql: SqlExecutor,
  peerFingerprint: string,
  options: { fromSeq?: number; limit?: number } = {},
): PeerAttestation[] {
  const fromSeq = options.fromSeq ?? 0;
  const limit = options.limit ?? 1000;
  const rows = sql
    .exec(
      `SELECT peer_fingerprint, seq, prev_self_ref, prev_peer_ref,
              content_hash, content_type, scope, cert, sig, created_at, bead_id
         FROM peer_attestations
        WHERE peer_fingerprint = ? AND seq >= ?
     ORDER BY seq ASC
        LIMIT ?`,
      peerFingerprint,
      fromSeq,
      limit,
    )
    .toArray();
  return rows.map(rowToAttestation);
}

/**
 * Find an attestation by (peer_fingerprint, content_hash). Used by the
 * pending-attestations retry pump: before re-attempting a write, check
 * whether the row already exists (idempotency safeguard for crash-
 * mid-commit recovery).
 */
export function findAttestationByContent(
  sql: SqlExecutor,
  peerFingerprint: string,
  contentHash: string,
): PeerAttestation | null {
  const rows = sql
    .exec(
      `SELECT peer_fingerprint, seq, prev_self_ref, prev_peer_ref,
              content_hash, content_type, scope, cert, sig, created_at, bead_id
         FROM peer_attestations
        WHERE peer_fingerprint = ? AND content_hash = ?
     ORDER BY seq DESC
        LIMIT 1`,
      peerFingerprint,
      contentHash,
    )
    .toArray();
  return rows[0] ? rowToAttestation(rows[0]) : null;
}

// ── helpers ──────────────────────────────────────────────────────────────

function rowToAttestation(r: Record<string, unknown>): PeerAttestation {
  return {
    peer_fingerprint: r["peer_fingerprint"] as string,
    seq:              r["seq"]              as number,
    prev_self_ref:    (r["prev_self_ref"]   as string | null) ?? null,
    prev_peer_ref:    (r["prev_peer_ref"]   as string | null) ?? null,
    content_hash:     r["content_hash"]     as string,
    content_type:     r["content_type"]     as string,
    scope:            r["scope"]            as string,
    cert:             r["cert"]             as Uint8Array,
    sig:              r["sig"]              as Uint8Array,
    created_at:       r["created_at"]       as number,
    // bead_id: nullable per cloister-c8b907 sub-bead 1. Old rows
    // pre-migration return undefined → coerce to null. Newer rows
    // carry the bead_id from `applyAttestation.args.beadId`.
    bead_id:          (r["bead_id"]         as string | null | undefined) ?? null,
  };
}
