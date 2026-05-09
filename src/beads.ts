/**
 * BeadStore — Durable Object with native SQLite.
 *
 * One instance per repo, keyed by stable DO name (hash of repo path).
 * Schema matches rosary's bead model so cross-tool reads are trivial.
 *
 * Local dev:  `wrangler dev` runs workerd on-disk SQLite.
 * Prod:        Cloudflare Durable Objects built-in SQLite.
 */

import type { Bead, BeadState, BeadPriority, JsonRpcRequest, JsonRpcResponse } from "./types.js";
import { okResponse, errResponse } from "./types.js";

// BeadStore is BUNDLE-LAYER per ADR-0011's three-criterion test (per-repo,
// idFromName(repo) — many instances per cluster, not singleton). It holds
// only work-item state — beads + comments. Trust state (peer_attestations,
// peer_lease_counters, future vault) lives in `TrustStore` (hypervisor-
// layer, singleton per cluster) at `src/trust-store.ts`. The 2026-05-09
// adversarial review identified that putting trust state here violated the
// boundary criteria; the fix moved peer_lease_counters out and reserved
// the same DO class (TrustStore) for future peer_attestations + vault.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS beads (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  state       TEXT NOT NULL DEFAULT 'open',
  priority    INTEGER NOT NULL DEFAULT 0,
  labels      TEXT NOT NULL DEFAULT '[]',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  created_by  TEXT,
  repo        TEXT NOT NULL DEFAULT '',
  notes       TEXT
);

CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bead_id    TEXT NOT NULL REFERENCES beads(id),
  body       TEXT NOT NULL,
  author     TEXT NOT NULL DEFAULT 'unknown',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export class BeadStore implements DurableObject {
  // Alias to a clear SQLite context — avoids ambiguity with process exec calls.
  private readonly db: SqlStorage;

  constructor(ctx: DurableObjectState, _env: unknown) {
    this.db = ctx.storage.sql;
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(SCHEMA);
  }

  private query(sql: string, ...bindings: SqlStorageValue[]): SqlStorageCursor<Record<string, SqlStorageValue>> {
    return this.db.exec(sql, ...bindings);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }
    const req = await request.json<JsonRpcRequest>();
    const res = this.dispatch(req);
    return Response.json(res);
  }

  private dispatch(req: JsonRpcRequest): JsonRpcResponse {
    try {
      switch (req.method) {
        case "bead_create":  return this.create(req);
        case "bead_update":  return this.update(req);
        case "bead_search":  return this.search(req);
        case "bead_list":    return this.list(req);
        case "bead_get":     return this.get(req);
        case "bead_close":   return this.close(req);
        case "bead_comment": return this.addComment(req);
        default:
          return errResponse(req.id, -32601, `unknown method: ${req.method}`);
      }
    } catch (e) {
      return errResponse(req.id, -32603, String(e));
    }
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  private create(req: JsonRpcRequest): JsonRpcResponse {
    const p = req.params as Record<string, unknown>;
    const id = generateId();
    const title       = String(p.title ?? "");
    const description = String(p.description ?? "");
    const priority    = Number(p.priority ?? 0) as BeadPriority;
    const labels      = JSON.stringify(p.labels ?? []);
    const created_by  = p.created_by != null ? String(p.created_by) : null;
    const repo        = String(p.repo ?? "");

    this.query(
      `INSERT INTO beads (id, title, description, priority, labels, created_by, repo)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id, title, description, priority, labels, created_by, repo,
    );

    return okResponse(req.id, { id, title, state: "open" as BeadState });
  }

  private update(req: JsonRpcRequest): JsonRpcResponse {
    const p   = req.params as Record<string, unknown>;
    const id  = String(p.id ?? "");
    const sets: string[]      = ["updated_at = datetime('now')"];
    const vals: SqlStorageValue[] = [];

    if (p.title != null)       { sets.push("title = ?");       vals.push(String(p.title)); }
    if (p.description != null) { sets.push("description = ?"); vals.push(String(p.description)); }
    if (p.state != null)       { sets.push("state = ?");       vals.push(String(p.state)); }
    if (p.priority != null)    { sets.push("priority = ?");    vals.push(Number(p.priority)); }
    if (p.labels != null)      { sets.push("labels = ?");      vals.push(JSON.stringify(p.labels)); }
    if (p.notes != null)       { sets.push("notes = ?");       vals.push(String(p.notes)); }

    this.query(`UPDATE beads SET ${sets.join(", ")} WHERE id = ?`, ...vals, id);
    return okResponse(req.id, { updated: true });
  }

  private search(req: JsonRpcRequest): JsonRpcResponse {
    const p     = req.params as Record<string, unknown>;
    const query = `%${String(p.query ?? "").toLowerCase()}%`;
    const rows  = this.query(
      `SELECT * FROM beads WHERE LOWER(title) LIKE ? OR LOWER(description) LIKE ?
       ORDER BY updated_at DESC LIMIT 50`,
      query, query,
    );
    return okResponse(req.id, { beads: cursorToBeads(rows) });
  }

  private list(req: JsonRpcRequest): JsonRpcResponse {
    const p     = req.params as Record<string, unknown>;
    const state = p.state != null ? String(p.state) : null;
    const rows  = state != null
      ? this.query(`SELECT * FROM beads WHERE state = ? ORDER BY updated_at DESC LIMIT 100`, state)
      : this.query(`SELECT * FROM beads ORDER BY updated_at DESC LIMIT 100`);
    return okResponse(req.id, { beads: cursorToBeads(rows) });
  }

  private get(req: JsonRpcRequest): JsonRpcResponse {
    const p    = req.params as Record<string, unknown>;
    const id   = String(p.id ?? "");
    const rows = this.query(`SELECT * FROM beads WHERE id = ?`, id);
    const beads = cursorToBeads(rows);
    if (beads.length === 0) return errResponse(req.id, 404, `bead not found: ${id}`);
    return okResponse(req.id, { bead: beads[0] });
  }

  private close(req: JsonRpcRequest): JsonRpcResponse {
    const p  = req.params as Record<string, unknown>;
    const id = String(p.id ?? "");
    this.query(`UPDATE beads SET state = 'done', updated_at = datetime('now') WHERE id = ?`, id);
    return okResponse(req.id, { closed: true });
  }

  private addComment(req: JsonRpcRequest): JsonRpcResponse {
    const p       = req.params as Record<string, unknown>;
    const bead_id = String(p.id ?? "");
    const body    = String(p.body ?? "");
    const author  = String(p.author ?? "unknown");
    this.query(`INSERT INTO comments (bead_id, body, author) VALUES (?, ?, ?)`, bead_id, body, author);
    this.query(`UPDATE beads SET updated_at = datetime('now') WHERE id = ?`, bead_id);
    return okResponse(req.id, { commented: true });
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function generateId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

function cursorToBeads(cursor: SqlStorageCursor<Record<string, SqlStorageValue>>): Bead[] {
  const results: Bead[] = [];
  for (const row of cursor) {
    results.push({
      id:          String(row["id"]),
      title:       String(row["title"]),
      description: String(row["description"]),
      state:       row["state"] as BeadState,
      priority:    Number(row["priority"]) as BeadPriority,
      labels:      JSON.parse(String(row["labels"] ?? "[]")) as string[],
      created_at:  String(row["created_at"]),
      updated_at:  String(row["updated_at"]),
      created_by:  row["created_by"] != null ? String(row["created_by"]) : undefined,
      repo:        String(row["repo"] ?? ""),
      notes:       row["notes"] != null ? String(row["notes"]) : undefined,
    });
  }
  return results;
}
