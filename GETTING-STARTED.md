# Getting started with cloister

This is the hands-on path: install, run, smoke-test, wire upstreams, install
the Claude Code plugin, verify the full chain. About 5–10 minutes if you
already have node + pnpm; longer if you also need to spin up `ley-line-open`
or `notme`.

For the *why* and *how it's shaped*, read [README.md](README.md) →
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) →
[ADR-0001](docs/adr/0001-workerd-mcp-gateway.md) →
[ADR-0002](docs/adr/0002-edge-router-protocol-agnostic-backends.md).

## 1. Prerequisites

| Tool       | Why                                              |
| ---------- | ------------------------------------------------ |
| `node 18+` | runs the worker bundle (via wrangler) and the CC plugin's hook script |
| `pnpm 10`  | package manager (locked in `package.json`)       |
| `task`     | optional, runs Taskfile.yml entries              |

Optional, only needed if you want the relevant backends working:

| Tool                          | Enables                                                   |
| ----------------------------- | --------------------------------------------------------- |
| `ley-line-open` daemon        | `lsp_*` + `reparse` / `enrich` / `status` MCP tools       |
| `notme` worker                | `/identity/*` proxy (JWT, passkeys, agent certs)          |
| `rosary` MCP HTTP             | future passthrough of orchestration tools                 |
| `workerd` binary              | running directly without wrangler / Cloudflare account    |

## 2. Install + bootstrap

```sh
git clone https://github.com/agentic-research/cloister
cd cloister
pnpm install
```

Run the test suite once to confirm everything compiles:

```sh
task lint            # tsc + 68 worker tests + 11 plugin tests
```

If you don't have `task`:

```sh
pnpm exec tsc --noEmit
pnpm exec vitest run                    # 68 tests in real workerd
node --test hooks/test/*.test.mjs       # 11 plugin tests
```

## 3. Run cloister locally

Two equivalent paths — same code, different launcher.

### Path A — `wrangler dev` (hot reload, easiest)

```sh
task dev             # → http://localhost:8787
```

### Path B — `workerd serve` (no Cloudflare account, matches the apko image)

```sh
task build:local     # bundles src/ → dist/index.js
task serve:local     # workerd serve config.capnp --experimental
```

Both bind on `:8787`. Storage paths differ slightly (`wrangler` uses
`.wrangler/state/...`, `workerd` uses `/data/do` per `config.capnp`); the
DO API is identical.

## 4. Smoke tests

Always works (no upstreams required):

```sh
# Liveness + backend snapshot
curl -s http://localhost:8787/health | jq

# List the MCP tools cloister exposes (bead_* + lsp_* + lifecycle)
curl -s -X POST http://localhost:8787/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}' \
  | jq '.result.tools[].name'

# Create + list a bead (uses the BEAD_STORE Durable Object — no network)
curl -s -X POST http://localhost:8787/mcp \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc":"2.0","id":1,"method":"tools/call",
    "params":{"name":"bead_create","arguments":{"repo":"/tmp/demo","title":"hello"}}
  }' | jq
```

You should see 14 tools: 6 `bead_*`, 5 `lsp_*`, and 3 lifecycle (`reparse`,
`enrich`, `status`).

## 5. Wire upstreams (only what you need)

### a) `ley-line-open` — for `lsp_*` and `reparse` / `enrich` / `status`

Start the daemon on whatever port matches `LLO_MCP_URL` in
`wrangler.toml` / `config.capnp` (default `8384`):

```sh
leyline daemon --mcp-port 8384
```

Verify cloister can reach it:

```sh
curl -s -X POST http://localhost:8787/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"status","arguments":{}}}' | jq
```

Expect `{"phase":"ready",...}`. If you see
`-32603 "LLO unreachable"` the daemon isn't up; if you see
`"LLO_MCP_URL not configured"` your env didn't pick up the binding.

### b) `notme` — for `/identity/*`

```sh
cd ../notme/worker
wrangler dev --port 8788
```

Then from cloister:

```sh
curl -s http://localhost:8787/identity/health | jq
```

If notme isn't running, `/identity/*` returns 503 — the rest of cloister
keeps working.

### c) Production wiring

In production cloister talks to `ley-line-open` *through* `notme-proxy`
(over UDS) for attestation. Set `LLO_MCP_URL=http://notme-proxy/mcp` and
make sure notme-proxy is forwarding to your daemon's UDS socket. See
[ADR-0002](docs/adr/0002-edge-router-protocol-agnostic-backends.md#capability-boundary).

## 6. Install the CC plugin (optional but recommended)

The `cloister-stale-sync` plugin lives in this repo — it auto-fires
`reparse` on every Edit/Write/MultiEdit/NotebookEdit so `lsp_*` tools
return up-to-date data inside long Claude Code sessions.

```sh
# In a Claude Code session:
claude plugin add ~/path/to/cloister
```

Or, without installing:

```sh
claude --plugin-dir ~/path/to/cloister
```

Configure (optional):

```sh
export CLOISTER_MCP_URL=http://localhost:8787/mcp   # default
export CLOISTER_SYNC_LOG=1                          # debug to stderr
```

See [hooks/README.md](hooks/README.md) for the full plugin contract.

## 7. Verify the full chain

With `leyline daemon --mcp-port 8384` and cloister both running:

```sh
# 1. Edit a file (any way you like)
echo 'fn main() {}' > /tmp/demo/main.rs

# 2. Trigger reparse (the plugin does this automatically on Edit/Write)
curl -s -X POST http://localhost:8787/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"reparse","arguments":{"source":"/tmp/demo/main.rs"}}}'

# 3. Now lsp_hover sees the new content
curl -s -X POST http://localhost:8787/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call",
       "params":{"name":"lsp_hover","arguments":{"file":"/tmp/demo/main.rs","line":0,"col":3}}}'
```

If the second call returns `fn main()` info, the chain
`CC → cloister → LLO` is wired correctly.

## 8. Where to next

- **Want to add a new MCP tool family?** Implement `ToolBackend` in `src/backends/`,
  register it in `src/index.ts`'s `McpEdgeRoute([...])`. See `LspToolBackend`
  and `LeylineLifecycleBackend` as templates.
- **Want a new HTTP route (not MCP)?** Implement `EdgeRoute` in `src/routes/`,
  append to `ROUTES` in `src/index.ts`. See `HealthRoute`.
- **Want to ship as a container?** ADR-0001 covers the apko/melange story
  ([docs/adr/0001-workerd-mcp-gateway.md](docs/adr/0001-workerd-mcp-gateway.md)).
- **Want the architecture rationale?** [ADR-0002](docs/adr/0002-edge-router-protocol-agnostic-backends.md)
  explains why cloister is an edge router rather than an MCP gateway, and
  why workerd's service-binding model replaces Istio-style mTLS.
