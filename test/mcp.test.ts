/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";

// ── Helpers ────────────────────────────────────────────────────────────────

function post(method: string, params?: unknown): Promise<Response> {
  return SELF.fetch("http://localhost/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
  });
}

async function mcp<T = Record<string, unknown>>(method: string, params?: unknown): Promise<T> {
  const res = await post(method, params);
  return res.json<T>();
}

async function tool(name: string, args: Record<string, unknown>) {
  return mcp<{
    result?: { content: Array<{ type: string; text: string }> };
    error?: { code: number; message: string };
  }>("tools/call", { name, arguments: args });
}

// Each test suite uses a unique repo path to isolate DO state
function repo(label: string): string {
  return `/test/cloister/${label}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── HTTP routing ───────────────────────────────────────────────────────────

describe("routing", () => {
  it("GET /health returns ok", async () => {
    const res = await SELF.fetch("http://localhost/health");
    expect(res.status).toBe(200);
    const body = await res.json<{ status: string; service: string }>();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("cloister");
  });

  it("GET /health includes backend config", async () => {
    const body = await (await SELF.fetch("http://localhost/health")).json<Record<string, unknown>>();
    expect(body).toHaveProperty("backends");
  });

  it("unknown path returns 404", async () => {
    const res = await SELF.fetch("http://localhost/unknown");
    expect(res.status).toBe(404);
  });

  it("DELETE /mcp returns 405", async () => {
    const res = await SELF.fetch("http://localhost/mcp", { method: "DELETE" });
    expect(res.status).toBe(405);
  });

  it("GET /mcp returns SSE stream", async () => {
    const res = await SELF.fetch("http://localhost/mcp");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    // Read the first event — should be the MCP init notification
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain("data:");
    expect(text).toContain("protocolVersion");
    reader.cancel();
  });

  it("POST /mcp with bad JSON returns parse error", async () => {
    const res = await SELF.fetch("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    const body = await res.json<{ error: { code: number } }>();
    expect(body.error.code).toBe(-32700);
  });
});

// ── MCP lifecycle ──────────────────────────────────────────────────────────

describe("MCP lifecycle", () => {
  it("initialize returns server info", async () => {
    const res = await mcp<{ result: { serverInfo: { name: string }; protocolVersion: string } }>(
      "initialize",
    );
    expect(res.result.serverInfo.name).toBe("cloister");
    expect(res.result.protocolVersion).toBe("2024-11-05");
  });

  it("ping returns empty result", async () => {
    const res = await mcp<{ result: Record<string, never> }>("ping");
    expect(res.result).toEqual({});
  });

  it("tools/list aggregates bead_* tools (lsp_* now derived from LLO upstream)", async () => {
    const res = await mcp<{ result: { tools: Array<{ name: string }> } }>("tools/list");
    const names = res.result.tools.map(t => t.name);
    // The bead_* set lives in cloister (DurableObject backend); the
    // assertion checks the in-process MCP surface advertises every
    // bead tool. The `lsp_*` set was removed from cloister's asserted
    // catalog by cloister-d9347e (P5 of the LLO arc); cloister now
    // derives the catalog at request time from LLO's `tools/list`. In
    // the workerd test pool LLO_MCP_URL points at an unreachable port,
    // so the derived cache stays empty and `lsp_*` does not surface
    // here — this is correct behavior, not a regression. See
    // test/manifest/mcp-proxy-dynamic.test.ts for the LSP-shape
    // dynamic-derivation tests (stubbed fetch, asserts no
    // double-prefix, etc.).
    for (const expected of [
      "bead_create", "bead_update", "bead_search",
      "bead_list", "bead_close", "bead_comment",
    ]) {
      expect(names).toContain(expected);
    }
    // No `lsp_*` should surface — the upstream is unreachable in tests.
    expect(names.some(n => n.startsWith("lsp_"))).toBe(false);
    // Sanity: no duplicates across backends.
    expect(new Set(names).size).toBe(names.length);
  });

  it("tools/list tools have required inputSchema fields", async () => {
    const res = await mcp<{ result: { tools: Array<{ name: string; inputSchema: { required: string[] } }> } }>("tools/list");
    const create = res.result.tools.find(t => t.name === "bead_create")!;
    expect(create.inputSchema.required).toContain("repo");
    expect(create.inputSchema.required).toContain("title");
  });

  it("unknown method returns -32601", async () => {
    const res = await mcp<{ error: { code: number } }>("no/such/method");
    expect(res.error.code).toBe(-32601);
  });
});

// ── bead_create ────────────────────────────────────────────────────────────

describe("bead_create", () => {
  it("creates a bead and returns id + state", async () => {
    const r = repo("create");
    const res = await tool("bead_create", { repo: r, title: "my bead" });
    const data = JSON.parse(res.result!.content[0].text);
    expect(data.id).toBeTruthy();
    expect(data.title).toBe("my bead");
    expect(data.state).toBe("open");
  });

  it("missing repo returns -32602 error", async () => {
    const res = await tool("bead_create", { title: "no repo" });
    expect(res.error!.code).toBe(-32602);
  });

  it("unknown tool returns -32601", async () => {
    const res = await tool("bead_nonexistent", { repo: repo("x") });
    expect(res.error!.code).toBe(-32601);
  });
});

// ── bead CRUD round-trip ───────────────────────────────────────────────────

describe("bead round-trip", () => {
  let r: string;
  let beadId: string;

  beforeEach(async () => {
    r = repo("roundtrip");
    const res = await tool("bead_create", { repo: r, title: "rt bead", priority: 2 });
    beadId = JSON.parse(res.result!.content[0].text).id as string;
  });

  it("bead_list returns created bead", async () => {
    const res = await tool("bead_list", { repo: r });
    const { beads } = JSON.parse(res.result!.content[0].text) as { beads: Array<{ id: string }> };
    expect(beads.some(b => b.id === beadId)).toBe(true);
  });

  it("bead_list filters by state", async () => {
    const openRes  = await tool("bead_list", { repo: r, state: "open" });
    const doneRes  = await tool("bead_list", { repo: r, state: "done" });
    const openList = JSON.parse(openRes.result!.content[0].text).beads as Array<{ id: string }>;
    const doneList = JSON.parse(doneRes.result!.content[0].text).beads as Array<{ id: string }>;
    expect(openList.some(b => b.id === beadId)).toBe(true);
    expect(doneList.some(b => b.id === beadId)).toBe(false);
  });

  it("bead_search finds by title keyword", async () => {
    const res = await tool("bead_search", { repo: r, query: "rt bead" });
    const { beads } = JSON.parse(res.result!.content[0].text) as { beads: Array<{ id: string }> };
    expect(beads.some(b => b.id === beadId)).toBe(true);
  });

  it("bead_search returns empty for no match", async () => {
    const res = await tool("bead_search", { repo: r, query: "zzz_no_match_zzz" });
    const { beads } = JSON.parse(res.result!.content[0].text) as { beads: unknown[] };
    expect(beads).toHaveLength(0);
  });

  it("bead_update changes title and state", async () => {
    await tool("bead_update", { repo: r, id: beadId, title: "updated", state: "in_progress" });
    const listRes = await tool("bead_list", { repo: r, state: "in_progress" });
    const { beads } = JSON.parse(listRes.result!.content[0].text) as { beads: Array<{ id: string; title: string }> };
    const updated = beads.find(b => b.id === beadId);
    expect(updated?.title).toBe("updated");
  });

  it("bead_close sets state to done", async () => {
    await tool("bead_close", { repo: r, id: beadId });
    const res  = await tool("bead_list", { repo: r, state: "done" });
    const { beads } = JSON.parse(res.result!.content[0].text) as { beads: Array<{ id: string }> };
    expect(beads.some(b => b.id === beadId)).toBe(true);
  });

  it("bead_comment adds a comment", async () => {
    const res = await tool("bead_comment", { repo: r, id: beadId, body: "looks good", author: "ci" });
    const data = JSON.parse(res.result!.content[0].text);
    expect(data.commented).toBe(true);
  });

  it("different repos have isolated bead stores", async () => {
    const r2    = repo("isolated");
    const res2  = await tool("bead_list", { repo: r2 });
    const beads = JSON.parse(res2.result!.content[0].text).beads as Array<{ id: string }>;
    expect(beads.some(b => b.id === beadId)).toBe(false);
  });
});
