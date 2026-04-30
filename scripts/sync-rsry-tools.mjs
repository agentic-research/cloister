#!/usr/bin/env node
/**
 * Generate a capnp manifest fragment for rsry's tool surface.
 *
 * rsry exposes ~27 tools and grows over time. Hand-transcribing each one
 * into `cloister.capnp` is busywork that goes stale; instead, this script
 * fetches `tools/list` from a running rsry MCP HTTP server and emits a
 * paste-ready capnp fragment.
 *
 * Workflow:
 *   1. Start rsry: `rsry serve --transport http --port 8383`
 *   2. Run this script: `node scripts/sync-rsry-tools.mjs > /tmp/rsry.capnp.txt`
 *   3. Paste the output into cloister.capnp's rosary backend tools list
 *   4. Run `task manifest` and review the diff
 *
 * Why not auto-merge into cloister.capnp directly? The manifest is the
 * source of truth and should be reviewed by a human — auto-merging would
 * silently surface upstream tools whose semantics nobody on this side has
 * vetted. Build-time validation (duplicate names, malformed schemas) still
 * runs against the resulting manifest.
 *
 * Env:
 *   RSRY_MCP_URL — defaults to http://localhost:8383/mcp
 */

const URL = process.env.RSRY_MCP_URL || "http://localhost:8383/mcp";

// ── MCP init dance ────────────────────────────────────────────────────────

const initRes = await fetch(URL, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Accept":       "application/json, text/event-stream",
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "cloister-sync-rsry-tools", version: "0.0.1" },
    },
  }),
});
if (!initRes.ok) {
  console.error(`initialize failed: HTTP ${initRes.status}`);
  process.exit(1);
}
const sessionId = initRes.headers.get("mcp-session-id");
if (!sessionId) {
  console.error("initialize succeeded but no Mcp-Session-Id header — wrong server?");
  process.exit(1);
}

// ── tools/list ────────────────────────────────────────────────────────────

const listRes = await fetch(URL, {
  method: "POST",
  headers: {
    "Content-Type":   "application/json",
    "Accept":         "application/json, text/event-stream",
    "Mcp-Session-Id": sessionId,
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
});
const body = await listRes.json();
if (body.error) {
  console.error(`tools/list error: ${body.error.code} ${body.error.message}`);
  process.exit(1);
}
const tools = body.result.tools;
console.error(`fetched ${tools.length} rsry tool definitions`);

// ── Emit capnp fragment ───────────────────────────────────────────────────
//
// Capnp const literals don't tolerate unescaped newlines in Text fields, so
// description and inputSchemaJson go through JSON.stringify (which produces
// valid capnp Text — capnp's escapes are a strict subset of JSON's).

process.stdout.write(`# AUTO-GENERATED — paste into cloister.capnp's rosary backend block.
# Source: ${URL} tools/list, ${tools.length} tools.
# To refresh: \`node scripts/sync-rsry-tools.mjs\`.

[\n`);

for (let i = 0; i < tools.length; i++) {
  const t = tools[i];
  const sep = i === tools.length - 1 ? "" : ",";
  process.stdout.write(
    `  ( name            = ${JSON.stringify(t.name)},\n` +
    `    description     = ${JSON.stringify(t.description ?? "")},\n` +
    `    inputSchemaJson = ${JSON.stringify(JSON.stringify(t.inputSchema ?? { type: "object", properties: {} }))} )${sep}\n`,
  );
}

process.stdout.write(`]\n`);

// ── Be polite — close session if rsry supports it ─────────────────────────

try {
  await fetch(URL, {
    method: "DELETE",
    headers: { "Mcp-Session-Id": sessionId },
  });
} catch { /* not fatal */ }
