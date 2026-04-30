#!/usr/bin/env node
/**
 * stub-companion — local-dev mock of cloister-companion's HTTP face.
 *
 * Honors the cloister↔companion contract from ADR-0005 + bead
 * cloister-5183bc:
 *
 *   POST <any path>
 *   Content-Type: application/x-capnp; type=ToolCall
 *   body = capnp-encoded ToolCall
 *
 *   →
 *
 *   200 OK
 *   Content-Type: application/x-capnp; type=ToolResult
 *   body = capnp-encoded ToolResult
 *
 * The stub doesn't speak full leyline-net wire (no Manifest envelope,
 * no AEAD, no signing) — neither does cloister↔companion (per the
 * 2026-04-30 amendment, that hop is IPC). The real Rust companion will
 * speak full leyline-net wire on its EGRESS face (companion↔backend);
 * the stub is just a stand-in for the cloister-side validation work.
 *
 * Routing:
 *   - Decode incoming ToolCall
 *   - Lookup canned response in STUBS by `${upstreamId}:${toolName}`
 *     or fall back to a generic `{"echo":<args>}` payload
 *   - Encode ToolResult, return
 *
 * Usage:
 *   task companion:stub                 # listens on :8385
 *   PORT=9999 task companion:stub       # custom port
 *
 * Validates: cloister's wire produces bytes a real listener parses
 * correctly. Counterpart to `task wire:verify-roundtrip` which does
 * the same thing against the capnp CLI in-process.
 */

import { createServer } from "node:http";
import { decodeToolCall } from "../dist-verify/src/wire/tool-call.js";
import { encodeToolResult } from "../dist-verify/src/wire/tool-result.js";

const PORT = Number(process.env.PORT ?? 8385);
const VERBOSE = process.env.STUB_COMPANION_VERBOSE === "1";

// Canned responses keyed by `${upstreamId}:${toolName}`. Add real ones as
// you exercise specific upstream wiring; the default below echoes the
// ToolCall args back so any tool returns a parseable result.
const STUBS = {
  "rosary:rsry_status": () => ({
    content: [{ kind: "text", text: '{"phase":"ready","head_sha":"stub","note":"this is the stub companion"}' }],
    isError: false,
  }),
  "rosary:rsry_list_beads": () => ({
    content: [{ kind: "text", text: '{"total":0,"beads":[],"note":"stub returns empty fleet"}' }],
    isError: false,
  }),
  "leyline:lsp_hover": () => ({
    content: [{ kind: "text", text: '{"node_id":"stub","hover":"// stub companion fixture"}' }],
    isError: false,
  }),
};

// ── Server ────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("stub-companion only handles POST\n");
    return;
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);

  let toolCall;
  try {
    toolCall = decodeToolCall(new Uint8Array(body));
  } catch (e) {
    log(`! decode failed: ${e.message}`);
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end(`stub-companion: invalid capnp ToolCall: ${e.message}\n`);
    return;
  }

  const key = `${toolCall.upstreamId}:${toolCall.toolName}`;
  const argsText = new TextDecoder().decode(toolCall.argumentsJson);
  log(`→ ${key} args=${argsText.length > 80 ? argsText.slice(0, 80) + "…" : argsText}`);

  const stub = STUBS[key];
  const result = stub
    ? stub(toolCall)
    : {
        content: [{
          kind: "text",
          text: JSON.stringify({
            stub:       true,
            upstreamId: toolCall.upstreamId,
            toolName:   toolCall.toolName,
            argsText,
          }),
        }],
        isError: false,
      };

  let bytes;
  try {
    bytes = encodeToolResult(result);
  } catch (e) {
    log(`! encode failed: ${e.message}`);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(`stub-companion: encode failed: ${e.message}\n`);
    return;
  }

  res.writeHead(200, {
    "Content-Type": "application/x-capnp; type=ToolResult",
    "Content-Length": String(bytes.length),
  });
  res.end(Buffer.from(bytes));
  log(`← ${key} ok (${bytes.length} bytes)`);
});

server.listen(PORT, () => {
  console.error(`stub-companion: listening on http://localhost:${PORT}/  (POST capnp ToolCall → capnp ToolResult)`);
  console.error(`stub-companion: stubs registered for ${Object.keys(STUBS).length} ${Object.keys(STUBS).length === 1 ? "tool" : "tools"}; unmatched calls echo args back`);
  console.error(`stub-companion: STUB_COMPANION_VERBOSE=1 to see per-request log lines`);
});

process.on("SIGINT",  () => { console.error("\nstub-companion: shutting down"); server.close(() => process.exit(0)); });
process.on("SIGTERM", () => { server.close(() => process.exit(0)); });

function log(msg) {
  if (VERBOSE) console.error(`stub-companion ${new Date().toISOString().slice(11, 19)} ${msg}`);
}
