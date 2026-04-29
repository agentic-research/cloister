#!/usr/bin/env node
/**
 * cloister-stale-sync — PostToolUse hook.
 *
 * Reads Claude Code's tool-input JSON from stdin, extracts the edited file
 * path, and POSTs a `reparse {source: <path>}` MCP tools/call to cloister.
 * Cloister forwards it to ley-line-open's daemon, which re-parses the file
 * and lazily refreshes the LSP enrichment so subsequent lsp_* calls return
 * up-to-date hover / defs / refs / diagnostics.
 *
 * Configuration (env vars):
 *   CLOISTER_MCP_URL   — defaults to http://localhost:8787/mcp
 *   CLOISTER_SYNC_LOG  — set to "1" to log to stderr (useful when debugging)
 *
 * Failure mode:
 *   PostToolUse hooks are synchronous — Claude Code waits for them to finish
 *   (with a timeout). On any error (cloister down, file path missing, parse
 *   fail) the script exits 0 silently and fast. Staleness is preferable to
 *   noisy red text in every session, and silence keeps the hook off the hot
 *   path of the user's edit loop.
 */

const DEFAULT_URL = "http://localhost:8787/mcp";

export async function main({
  stdin = process.stdin,
  env   = process.env,
  fetch: fetchImpl = globalThis.fetch,
} = {}) {
  const log = env.CLOISTER_SYNC_LOG === "1"
    ? (...args) => console.error("[cloister-stale-sync]", ...args)
    : () => {};

  const url = env.CLOISTER_MCP_URL || DEFAULT_URL;

  let payload;
  try {
    payload = await readStdin(stdin);
  } catch (e) {
    log("stdin read failed:", e?.message);
    return 0;
  }

  const filePath = extractFilePath(payload);
  if (!filePath) {
    log("no file_path in tool input — skipping");
    return 0;
  }

  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tools/call",
    params: { name: "reparse", arguments: { source: filePath } },
  });

  try {
    const res = await fetchImpl(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!res.ok) {
      log(`cloister responded ${res.status}`);
      return 0;
    }
    log("reparse ok:", filePath);
  } catch (e) {
    log("cloister unreachable:", e?.message);
  }
  return 0;
}

export function extractFilePath(payload) {
  if (!payload || typeof payload !== "object") return null;
  // Claude Code passes {tool_input: {file_path, ...}} for Edit / Write / MultiEdit.
  // NotebookEdit uses notebook_path for the cell's owning notebook.
  const ti = payload.tool_input ?? payload.toolInput ?? null;
  if (!ti || typeof ti !== "object") return null;
  return (
    typeof ti.file_path     === "string" ? ti.file_path :
    typeof ti.notebook_path === "string" ? ti.notebook_path :
    null
  );
}

export async function readStdin(stream) {
  // Empty stdin is normal in tests/dev; treat as no payload rather than hanging.
  if (stream.isTTY) return null;
  const chunks = [];
  // Stream may yield Buffers (real stdin) or strings (Readable.from in tests);
  // normalize to Buffer because Buffer.concat strictly requires Uint8Arrays.
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  }
  if (chunks.length === 0) return null;
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw === "") return null;
  return JSON.parse(raw);
}

// Run as script, not when imported by tests.
const isDirectInvoke = import.meta.url === `file://${process.argv[1]}`
                    || (process.argv[1] && import.meta.url.endsWith(process.argv[1]));
if (isDirectInvoke) {
  main().then(code => process.exit(code ?? 0)).catch(() => process.exit(0));
}

// Re-export for tests that import this module directly.
export { DEFAULT_URL };
