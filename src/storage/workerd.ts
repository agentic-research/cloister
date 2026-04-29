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

import { digestBytes } from "./canonical.js";
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

export class WorkerdBlobStore implements BlobStore {
  private readonly sql: Sql;
  private readonly blobs: string;

  constructor(sqlStorage: SqlStorage, prefix: string = "store") {
    assertSafePrefix(prefix);
    this.sql = new Sql(sqlStorage);
    this.blobs = `${prefix}_blobs`;
    this.sql.run(
      `CREATE TABLE IF NOT EXISTS ${this.blobs} (
         digest TEXT PRIMARY KEY,
         bytes  BLOB NOT NULL
       )`,
    );
  }

  async put(bytes: Uint8Array): Promise<Digest> {
    const d = await digestBytes(bytes);
    // INSERT OR IGNORE — put is idempotent; same digest → no duplicate row.
    // We don't care about rowcount here; idempotency is the contract, not a
    // signal to the caller.
    countRows(
      this.sql.run(
        `INSERT OR IGNORE INTO ${this.blobs} (digest, bytes) VALUES (?, ?) RETURNING digest`,
        d,
        asBlob(bytes),
      ),
    );
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
    return null;
  }

  async has(digest: Digest): Promise<boolean> {
    const cursor = this.sql.run<{ one: number }>(
      `SELECT 1 AS one FROM ${this.blobs} WHERE digest = ? LIMIT 1`,
      digest,
    );
    for (const _ of cursor) return true;
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
