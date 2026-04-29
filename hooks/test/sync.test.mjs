// Run with:  node --test hooks/test/sync.test.mjs
//
// Tests the cloister-stale-sync hook script end-to-end with stubbed stdin,
// env, and fetch. The script's only side effect is the outbound POST to
// cloister, so we capture that via the injected fetch and assert the wire
// shape matches what cloister's LeylineLifecycleBackend expects.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { Readable } from "node:stream";
import { main, extractFilePath, DEFAULT_URL } from "../sync.mjs";

// ── Helpers ────────────────────────────────────────────────────────────────

function stdinFrom(value) {
  // Node's Readable.from emits the payload as a single chunk; the script
  // joins chunks before JSON.parse, so this matches real CC stdin behavior.
  const r = Readable.from([typeof value === "string" ? value : JSON.stringify(value)]);
  r.isTTY = false;
  return r;
}

function recordingFetch(response = { ok: true, status: 200, body: { jsonrpc: "2.0", id: 0, result: {} } }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(response.body), {
      status:  response.status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetchImpl, calls };
}

// ── extractFilePath ────────────────────────────────────────────────────────

test("extractFilePath: pulls file_path from tool_input", () => {
  assert.equal(extractFilePath({ tool_input: { file_path: "/x/a.rs" } }), "/x/a.rs");
});

test("extractFilePath: falls back to notebook_path for NotebookEdit", () => {
  assert.equal(extractFilePath({ tool_input: { notebook_path: "/x/n.ipynb" } }), "/x/n.ipynb");
});

test("extractFilePath: tolerates camelCase toolInput", () => {
  assert.equal(extractFilePath({ toolInput: { file_path: "/x/a.rs" } }), "/x/a.rs");
});

test("extractFilePath: returns null for missing/empty payloads", () => {
  assert.equal(extractFilePath(null), null);
  assert.equal(extractFilePath({}), null);
  assert.equal(extractFilePath({ tool_input: null }), null);
  assert.equal(extractFilePath({ tool_input: {} }), null);
  assert.equal(extractFilePath({ tool_input: { other: "x" } }), null);
});

// ── main: happy path ───────────────────────────────────────────────────────

test("main: POSTs reparse to CLOISTER_MCP_URL with extracted file path", async () => {
  const { fetchImpl, calls } = recordingFetch();
  const code = await main({
    stdin: stdinFrom({ tool_input: { file_path: "/x/foo.rs" } }),
    env:   { CLOISTER_MCP_URL: "http://cloister/mcp" },
    fetch: fetchImpl,
  });
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://cloister/mcp");
  assert.equal(calls[0].init.method, "POST");
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.method, "tools/call");
  assert.equal(sent.params.name, "reparse");
  assert.deepEqual(sent.params.arguments, { source: "/x/foo.rs" });
});

test("main: defaults to localhost:8787/mcp when CLOISTER_MCP_URL is unset", async () => {
  const { fetchImpl, calls } = recordingFetch();
  await main({
    stdin: stdinFrom({ tool_input: { file_path: "/a" } }),
    env:   {},
    fetch: fetchImpl,
  });
  assert.equal(calls[0].url, DEFAULT_URL);
});

// ── main: silent-failure mode ──────────────────────────────────────────────

test("main: exits 0 silently when stdin is empty", async () => {
  const empty = Readable.from([""]);
  empty.isTTY = false;
  let fetchCalled = false;
  const code = await main({
    stdin: empty,
    env:   {},
    fetch: async () => { fetchCalled = true; return new Response("", { status: 200 }); },
  });
  assert.equal(code, 0);
  assert.equal(fetchCalled, false, "must not POST when there's no payload");
});

test("main: exits 0 silently when no file_path is present", async () => {
  let fetchCalled = false;
  const code = await main({
    stdin: stdinFrom({ tool_input: { other: "x" } }),
    env:   {},
    fetch: async () => { fetchCalled = true; return new Response("", { status: 200 }); },
  });
  assert.equal(code, 0);
  assert.equal(fetchCalled, false);
});

test("main: exits 0 silently when cloister responds non-2xx", async () => {
  const { fetchImpl } = recordingFetch({ ok: false, status: 502, body: { ok: false } });
  const code = await main({
    stdin: stdinFrom({ tool_input: { file_path: "/a" } }),
    env:   {},
    fetch: fetchImpl,
  });
  assert.equal(code, 0);
});

test("main: exits 0 silently when fetch throws (cloister unreachable)", async () => {
  const code = await main({
    stdin: stdinFrom({ tool_input: { file_path: "/a" } }),
    env:   {},
    fetch: async () => { throw new Error("ECONNREFUSED"); },
  });
  assert.equal(code, 0);
});

test("main: exits 0 silently when stdin is not valid JSON", async () => {
  const garbage = Readable.from(["{not json"]);
  garbage.isTTY = false;
  let fetchCalled = false;
  const code = await main({
    stdin: garbage,
    env:   {},
    fetch: async () => { fetchCalled = true; return new Response("", { status: 200 }); },
  });
  assert.equal(code, 0);
  assert.equal(fetchCalled, false);
});
