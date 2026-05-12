// SPDX-License-Identifier: AGPL-3.0-or-later
//
// actor_ca_bundle — archival CA bundle entries for §2.2.2 V-archival
// receipt verification + §2.7 compromise-notice tracking.
//
// Per RECEIPTS.md §2.3: actors retain every per-epoch master pubkey
// indefinitely (or until `ca_decommission_after`), so a verifier can
// resolve historical receipts. Cloister stores its own per-epoch
// bundle here so the GET /interlace/ca-bundle/<epoch> endpoint can
// serve them.
//
// Compromise notices (§2.7) live in a sibling column on the same
// table: each row may carry a compromise-notice blob signed by the
// NEXT-EPOCH key.
//
// Per ADR-0012 this table lives in TrustStore (singleton).

export const SCHEMA_ACTOR_CA_BUNDLE = `
CREATE TABLE IF NOT EXISTS actor_ca_bundle (
  epoch                   INTEGER PRIMARY KEY,
  signing_key_pubkey_b64u TEXT NOT NULL,
  cert_der_b64u           TEXT,
  issued_at_ms            INTEGER NOT NULL,
  retired_at_ms           INTEGER,
  status                  TEXT NOT NULL CHECK (status IN ('active','retired')),
  compromise_notice_b64u  TEXT,
  external_anchor_uri     TEXT
);
CREATE INDEX IF NOT EXISTS actor_ca_bundle_status
  ON actor_ca_bundle(status, epoch);
`;

export interface SqlExecutor {
  exec(query: string, ...bindings: unknown[]): {
    toArray(): Record<string, unknown>[];
  };
}

export interface ActorCaBundleEntry {
  epoch:                    number;
  signing_key_pubkey_b64u:  string;
  cert_der_b64u:            string | null;
  issued_at_ms:             number;
  retired_at_ms:            number | null;
  status:                   "active" | "retired";
  compromise_notice_b64u:   string | null;
  external_anchor_uri:      string | null;
}

/**
 * Insert-or-update a CA bundle entry. Idempotent on `epoch` (PRIMARY
 * KEY); subsequent writes overwrite. Setting `status='retired'` plus
 * a non-null `retired_at_ms` is how the operator marks an epoch as
 * past-its-window.
 */
export function upsertActorCaBundle(sql: SqlExecutor, row: ActorCaBundleEntry): void {
  sql.exec(
    `INSERT INTO actor_ca_bundle
       (epoch, signing_key_pubkey_b64u, cert_der_b64u, issued_at_ms,
        retired_at_ms, status, compromise_notice_b64u, external_anchor_uri)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (epoch) DO UPDATE SET
       signing_key_pubkey_b64u = excluded.signing_key_pubkey_b64u,
       cert_der_b64u           = excluded.cert_der_b64u,
       issued_at_ms            = excluded.issued_at_ms,
       retired_at_ms           = excluded.retired_at_ms,
       status                  = excluded.status,
       compromise_notice_b64u  = excluded.compromise_notice_b64u,
       external_anchor_uri     = excluded.external_anchor_uri`,
    row.epoch,
    row.signing_key_pubkey_b64u,
    row.cert_der_b64u ?? null,
    row.issued_at_ms,
    row.retired_at_ms ?? null,
    row.status,
    row.compromise_notice_b64u ?? null,
    row.external_anchor_uri ?? null,
  );
}

/** Look up the bundle entry for an epoch. */
export function getActorCaBundle(sql: SqlExecutor, epoch: number): ActorCaBundleEntry | null {
  const rows = sql.exec(
    `SELECT epoch, signing_key_pubkey_b64u, cert_der_b64u, issued_at_ms,
            retired_at_ms, status, compromise_notice_b64u, external_anchor_uri
       FROM actor_ca_bundle
      WHERE epoch = ?
      LIMIT 1`,
    epoch,
  ).toArray();
  if (rows.length === 0) return null;
  return rows[0] as unknown as ActorCaBundleEntry;
}

/**
 * List all epochs in the archive, ordered by epoch DESC (most recent
 * first). Used to synthesize the `.well-known/interlace/index.json`
 * epoch index + the `/interlace/ca-bundle/list` debugging view.
 */
export function listActorCaBundleEpochs(sql: SqlExecutor): ActorCaBundleEntry[] {
  const rows = sql.exec(
    `SELECT epoch, signing_key_pubkey_b64u, cert_der_b64u, issued_at_ms,
            retired_at_ms, status, compromise_notice_b64u, external_anchor_uri
       FROM actor_ca_bundle
   ORDER BY epoch DESC`,
  ).toArray();
  return rows as unknown as ActorCaBundleEntry[];
}

/**
 * Attach a compromise-notice blob to an existing epoch's row. The blob
 * is the base64url-encoded canonical CBOR envelope of the notice (see
 * RECEIPTS.md §2.7). Caller is responsible for verifying the notice's
 * signature was made by the NEXT-epoch key before attaching.
 *
 * Returns true if the row existed and was updated, false otherwise
 * (caller MUST upsert the bundle row first).
 */
export function attachCompromiseNotice(
  sql: SqlExecutor,
  compromisedEpoch: number,
  noticeB64u: string,
): boolean {
  // Read the row first so we can detect "no such epoch" — SqlStorage's
  // exec doesn't surface row-count info, so we round-trip via SELECT.
  const existing = getActorCaBundle(sql, compromisedEpoch);
  if (existing === null) return false;
  sql.exec(
    `UPDATE actor_ca_bundle
        SET compromise_notice_b64u = ?
      WHERE epoch = ?`,
    noticeB64u, compromisedEpoch,
  );
  return true;
}
