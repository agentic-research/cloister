/**
 * Workerd-substrate BlobStore + RefStore — DO SQLite-backed.
 *
 * Each instance lives inside a Durable Object, which gives us linearizability
 * for free: a DO is single-threaded per instance, so the whole BlobStore +
 * RefStore inside it sees serial operations. No locks, no Raft.
 *
 * Tables (created on first use, idempotent):
 *
 *   <prefix>_blobs (digest TEXT PRIMARY KEY, bytes BLOB NOT NULL)
 *   <prefix>_refs  (name   TEXT PRIMARY KEY, digest TEXT NOT NULL)
 *
 * The prefix exists so multiple stores can coexist in one DO (e.g. test
 * isolation, or future per-namespace storage in a single bead DO).
 */

import { digestBytes, blake3HexBytes } from "./canonical.js";
import {
  type BlobStore,
  type Digest,
  type RefStore,
  asDigest,
  isDigest,
} from "./types.js";

/**
 * Thin wrapper over a workerd `SqlStorage` so the rest of this module talks
 * to a small private API rather than the workerd binding directly.
 */
class Sql {
  constructor(private readonly s: SqlStorage) {}
  run<T extends Record<string, SqlStorageValue> = Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: SqlStorageValue[]
  ): SqlStorageCursor<T> {
    return this.s.exec<T>(query, ...bindings);
  }
}

/** Force-execute a cursor and count its result rows. Used with RETURNING. */
function countRows(cursor: SqlStorageCursor<Record<string, SqlStorageValue>>): number {
  let n = 0;
  for (const _ of cursor) n++;
  return n;
}

/**
 * Workers expects `SqlStorageValue` for blob bindings. Older workers-types
 * accept Uint8Array directly; newer ones want ArrayBuffer. Be explicit.
 */
function asBlob(bytes: Uint8Array): ArrayBuffer {
  // Slice into a fresh ArrayBuffer that owns exactly bytes.byteLength bytes.
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return buf;
}

// cloister-f193d3: chunk size for oversized blobs. 1 MiB stays well under
// workerd DO-SQLite's ~2 MB per-value ceiling (SQLITE_TOOBIG).
const BLOB_CHUNK_SIZE = 1 << 20;

export class WorkerdBlobStore implements BlobStore {
  private readonly sql: Sql;
  private readonly blobs: string;
  private readonly chunks: string;

  constructor(sqlStorage: SqlStorage, prefix: string = "store") {
    assertSafePrefix(prefix);
    this.sql = new Sql(sqlStorage);
    this.blobs = `${prefix}_blobs`;
    this.chunks = `${prefix}_blob_chunks`;
    this.sql.run(
      `CREATE TABLE IF NOT EXISTS ${this.blobs} (
         digest TEXT PRIMARY KEY,
         bytes  BLOB NOT NULL
       )`,
    );
    // cloister-f193d3: blobs larger than one DO-SQLite value (~2 MB) are
    // split across this table and rejoined on read. Small blobs stay in
    // the single-row table above (back-compat — untouched).
    this.sql.run(
      `CREATE TABLE IF NOT EXISTS ${this.chunks} (
         digest TEXT NOT NULL,
         seq    INTEGER NOT NULL,
         bytes  BLOB NOT NULL,
         PRIMARY KEY (digest, seq)
       )`,
    );
  }

  async put(bytes: Uint8Array, key?: Digest): Promise<Digest> {
    let d: Digest;
    if (key === undefined) {
      // Default content-addressed path: substrate computes SHA-256.
      d = await digestBytes(bytes);
    } else {
      // Caller-provided-key path (build-cache/v1 — see BlobStore interface
      // doc and cloister-spec/build-cache/v1/wire/digest-encoding.md).
      // build-cache/v1 clients send BLAKE3 hex inside an OCI sha256:
      // prefix, so the key won't match a real SHA-256 of the body.
      // Dual-verify: try SHA-256 first (OCI-native clients), fall back
      // to BLAKE3 (build-cache/v1 clients). Reject if neither matches.
      // Filed as cloister-7e631b after adversarial review of #84.
      const sha = await digestBytes(bytes);
      if (sha === key) {
        d = key;
      } else {
        const blake = blake3HexBytes(bytes);
        if (blake !== key) {
          throw new Error(
            `BlobStore.put: digest mismatch — key=${key} ` +
              `sha256(body)=${sha} blake3(body)=${blake}`,
          );
        }
        d = key;
      }
    }
    // INSERT OR IGNORE — put is idempotent; same digest → same rows.
    // cloister-f193d3: blobs at/under the chunk size take the original
    // single-row path; larger ones split across the chunks table and rejoin
    // transparently on read (a single DO-SQLite value over ~2 MB throws
    // SQLITE_TOOBIG). A given digest is deterministically small-or-large,
    // so the two paths never collide.
    if (bytes.length <= BLOB_CHUNK_SIZE) {
      countRows(
        this.sql.run(
          `INSERT OR IGNORE INTO ${this.blobs} (digest, bytes) VALUES (?, ?) RETURNING digest`,
          d,
          asBlob(bytes),
        ),
      );
    } else {
      for (let seq = 0, off = 0; off < bytes.length; seq++, off += BLOB_CHUNK_SIZE) {
        const chunk = bytes.slice(off, Math.min(off + BLOB_CHUNK_SIZE, bytes.length));
        this.sql.run(
          `INSERT OR IGNORE INTO ${this.chunks} (digest, seq, bytes) VALUES (?, ?, ?)`,
          d,
          seq,
          asBlob(chunk),
        );
      }
    }
    return d;
  }

  async get(digest: Digest): Promise<Uint8Array | null> {
    const cursor = this.sql.run<{ bytes: ArrayBuffer }>(
      `SELECT bytes FROM ${this.blobs} WHERE digest = ?`,
      digest,
    );
    for (const row of cursor) {
      // workerd may return either an ArrayBuffer or a Uint8Array view
      // depending on version; the static type says ArrayBuffer, the runtime
      // sometimes returns Uint8Array. Normalize.
      const raw: unknown = row.bytes;
      if (raw instanceof Uint8Array) return raw;
      return new Uint8Array(raw as ArrayBuffer);
    }
    // Not stored as a single row — try the chunked path (cloister-f193d3).
    return this.getChunked(digest);
  }

  /** Rejoin an oversized blob split across the chunks table, in seq order. */
  private getChunked(digest: Digest): Uint8Array | null {
    const cursor = this.sql.run<{ bytes: ArrayBuffer }>(
      `SELECT bytes FROM ${this.chunks} WHERE digest = ? ORDER BY seq ASC`,
      digest,
    );
    const parts: Uint8Array[] = [];
    let total = 0;
    for (const row of cursor) {
      const raw: unknown = row.bytes;
      const part = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer);
      parts.push(part);
      total += part.length;
    }
    if (parts.length === 0) return null;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }

  async has(digest: Digest): Promise<boolean> {
    const cursor = this.sql.run<{ one: number }>(
      `SELECT 1 AS one FROM ${this.blobs} WHERE digest = ? LIMIT 1`,
      digest,
    );
    for (const _ of cursor) return true;
    const chunked = this.sql.run<{ one: number }>(
      `SELECT 1 AS one FROM ${this.chunks} WHERE digest = ? LIMIT 1`,
      digest,
    );
    for (const _ of chunked) return true;
    return false;
  }
}

export class WorkerdRefStore implements RefStore {
  private readonly sql: Sql;
  private readonly refs: string;

  constructor(sqlStorage: SqlStorage, prefix: string = "store") {
    assertSafePrefix(prefix);
    this.sql = new Sql(sqlStorage);
    this.refs = `${prefix}_refs`;
    this.sql.run(
      `CREATE TABLE IF NOT EXISTS ${this.refs} (
         name   TEXT PRIMARY KEY,
         digest TEXT NOT NULL
       )`,
    );
  }

  async cas(
    name: string,
    expected: Digest | null,
    next: Digest,
  ): Promise<boolean> {
    if (!isDigest(next)) {
      throw new TypeError(`refStore.cas: 'next' is not a valid digest: ${next}`);
    }

    if (expected === null) {
      // Create-only: succeed iff the row doesn't already exist. RETURNING
      // emits one row when an INSERT actually happens, zero when IGNORE
      // suppressed it. cursor.rowsWritten can lag in workerd if the cursor
      // isn't iterated, so we iterate explicitly via countRows.
      const inserted = countRows(
        this.sql.run(
          `INSERT OR IGNORE INTO ${this.refs} (name, digest) VALUES (?, ?) RETURNING digest`,
          name,
          next,
        ),
      );
      return inserted === 1;
    }

    // Update-only-if-current-matches. RETURNING emits exactly the rows the
    // WHERE clause matched — i.e. 1 if expected matched, 0 if not.
    const updated = countRows(
      this.sql.run(
        `UPDATE ${this.refs} SET digest = ? WHERE name = ? AND digest = ? RETURNING digest`,
        next,
        name,
        expected,
      ),
    );
    return updated === 1;
  }

  async list(prefix: string): Promise<Array<[string, Digest]>> {
    const out: Array<[string, Digest]> = [];
    // SQL LIKE escape: keep '%', '_', '\\' literal so a prefix like
    // "refs/agents/" matches as a literal prefix, not as a glob.
    const escaped = prefix.replace(/[\\%_]/g, "\\$&");
    const cursor = this.sql.run<{ name: string; digest: string }>(
      `SELECT name, digest FROM ${this.refs} WHERE name LIKE ? ESCAPE '\\' ORDER BY name`,
      escaped + "%",
    );
    for (const row of cursor) {
      out.push([row.name, asDigest(row.digest)]);
    }
    return out;
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Reject prefixes that could break the table-name interpolation. We only
 * splice this into DDL/DML at construction time, so an aggressive whitelist
 * is fine — everyday names are a-z / 0-9 / _.
 */
function assertSafePrefix(prefix: string): void {
  if (!/^[a-z][a-z0-9_]*$/.test(prefix)) {
    throw new Error(
      `storage prefix must match /^[a-z][a-z0-9_]*$/ (got: ${JSON.stringify(prefix)})`,
    );
  }
}
