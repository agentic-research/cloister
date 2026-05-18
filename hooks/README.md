# cloister-stale-sync — Claude Code plugin

A `PostToolUse` hook that keeps ley-line-open's parse + LSP cache fresh while
Claude Code edits files. Closes the **stale-rust-analyzer gap** that otherwise
makes `lsp_hover` / `lsp_defs` / `lsp_refs` / `lsp_diagnostics` return outdated
results during long sessions.

## What it does

After every `Edit`, `Write`, `MultiEdit`, or `NotebookEdit` tool call, the hook
POSTs a `reparse {source: <changed_file>}` MCP call to cloister:

```
CC ─Edit→ <file>
   └─PostToolUse hook→ POST /mcp tools/call reparse → cloister
                                                      └→ ley-line-open daemon
                                                          └→ tree-sitter re-parse
                                                              └→ LSP enrichment (lazy)
```

`reparse` is exposed by the `mcpProxy` backend whose `urlBinding=LLO_MCP_URL`
and empty `handlesPrefix` matches the three lifecycle tools (`reparse`,
`enrich`, `status`) by exact name — see [`docs/tenants/ley-line-mcp.md`](../docs/tenants/ley-line-mcp.md)
for the wiring + `src/manifest/backends/mcp-proxy.ts` for the implementation
(formerly `LeylineLifecycleBackend` / `HttpForwardToolBackend` pre-ADR-0015
rename). The plugin is fire-and-quiet: any failure (cloister down, no
`file_path`, parse error) exits `0` silently rather than spamming red text
on every edit.

## Install

```sh
# In a Claude Code session:
claude plugin add ~/path/to/cloister
```

Or for development without installing:

```sh
claude --plugin-dir ~/path/to/cloister
```

## Configuration

Environment variables read at hook time:

| Variable           | Default                       | Purpose                                       |
| ------------------ | ----------------------------- | --------------------------------------------- |
| `CLOISTER_MCP_URL` | `http://localhost:8787/mcp`   | Where to POST `reparse` calls                 |
| `CLOISTER_SYNC_LOG`| (unset)                       | Set to `1` to log activity to stderr          |

Cloister itself needs `LLO_MCP_URL` set (in `wrangler.toml` / `config.capnp`)
pointing at your `leyline daemon --mcp-port` instance.

## Test

```sh
node --test hooks/test/sync.test.mjs
```

11 tests covering payload extraction (Edit / NotebookEdit / camelCase variants),
the happy-path POST shape, and the silent-failure modes (empty stdin, missing
`file_path`, non-2xx response, network error, malformed JSON).

## Files

```
.claude-plugin/plugin.json   manifest (name, version, author)
hooks/hooks.json             PostToolUse matcher + command
hooks/sync.mjs               the script — reads stdin, POSTs reparse
hooks/test/sync.test.mjs     node --test suite (no extra deps)
```

## See also

- [../README.md](../README.md) — cloister overview
- [../GETTING-STARTED.md](../GETTING-STARTED.md) — install + wire upstreams + verify
- [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) — request routing diagrams
- [../docs/adr/0002-edge-router-protocol-agnostic-backends.md](../docs/adr/0002-edge-router-protocol-agnostic-backends.md)
  — why every backend is a kind-typed sibling
- [../docs/reference/backend-kinds.md](../docs/reference/backend-kinds.md)
  — canonical enumeration of the five `Backend.kind` variants + per-kind purpose
- [../docs/adr/0015-mcp-spec-alignment.md](../docs/adr/0015-mcp-spec-alignment.md)
  — the `httpForward` → `mcpProxy` rename rationale
