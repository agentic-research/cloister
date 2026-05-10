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
task lint            # tsc + worker tests + plugin tests (fast — ≤2s)
task verify          # lint + external-process harnesses (slower, CI gate)
```

`lint` is the inner-loop gate; `verify` adds:
- `wire:verify-roundtrip` — substrate equivalence vs the capnp CLI (requires `capnp` on PATH)
- `smoke:leyline-stub` — production codec ↔ real HTTP socket ↔ stub-companion (spawns Node)

If you don't have `task`:

```sh
pnpm exec tsc --noEmit
pnpm exec vitest run                    # workerd integration tests
node --test hooks/test/*.test.mjs       # CC plugin tests
```

## 3. Run cloister locally

Three equivalent paths — same code, different launcher.

### Path A — `wrangler dev` (hot reload, easiest, single process)

```sh
task dev             # → http://localhost:8787
```

### Path B — `workerd serve` (no Cloudflare account, matches the apko image)

```sh
task build:local     # bundles src/ → dist/index.js
task serve:local     # workerd serve config.capnp --experimental
```

### Path C — `task cluster:dev` (full cluster topology, mac-native)

Per [cluster.capnp](cluster.capnp), spawns cloister-router **plus**
sibling bundles (notme-identity, mache, rosary) as native processes
with UDS sockets in `/tmp/cloister-dev/run/`. Missing binaries are
skipped with hints — you can dev cloister-router alone if mache/rosary
aren't built. See
[docs/deployment/cluster-in-a-pod.md](docs/deployment/cluster-in-a-pod.md).

```sh
CLUSTER_DEV_DRY_RUN=1 task cluster:dev   # preview the launch plan
task cluster:dev                          # spawn it
```

All three paths bind cloister-router on `:8787`. Storage paths differ
slightly (`wrangler` uses `.wrangler/state/...`, `workerd` uses
`/data/do` per `config.capnp`, `cluster:dev` uses
`$HOME/.cache/cloister-dev/do/`); the DO API is identical.

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

The fast path: `task smoke` spins up leyline + cloister on private ports,
exercises the full chain, and tears everything down. Use this in CI or
whenever you want a single-command "is the chain wired?" check.

```sh
task smoke
```

The script (`scripts/e2e-smoke.sh`) is dev-mode — it talks to leyline
directly rather than going through `notme-proxy`, since notme-proxy
requires a real bridge cert pair. From cloister's perspective the
behavior is identical; only the transport differs.

If you'd rather drive it manually with `leyline daemon --mcp-port 8384`
and cloister running:

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

## 8. Ship it as a container

```sh
task apk:keygen   # one-time — generate the melange signing key
task image        # melange build → apko compose → cloister.tar
docker load < cloister.tar
docker run -p 8787:8787 -v $(pwd)/data:/data cloister:latest
```

`task image:check` parses `melange.yaml` + `apko.yaml` end-to-end without
running a real build — handy in CI. The output image is distroless: workerd
+ the cloister bundle, runs as uid `65532`, no shell, no pkgmgr. See
[docs/ARCHITECTURE.md#packaging-melange--apko](docs/ARCHITECTURE.md#packaging-melange--apko)
for the layout.

## 9. Hardening for prod

When you move past local dev, set:

```sh
# Comma-separated; supports a single :* port glob per entry. Disallowed
# origins get the "null" sentinel back, which browsers refuse.
ALLOWED_ORIGINS="https://app.example.com,http://localhost:*"
```

Other prod knobs (still ADR-0001 work items):
- notme JWT middleware on `POST /mcp`
- mTLS via notme-proxy in front of `LLO_MCP_URL`
- mount `/data` as a persistent volume for the BeadStore DO SQLite files

### Off-platform peers (CF Tunnel / WARP)

Cloister doesn't run a userspace WireGuard daemon — workerd has no kernel
access and the distroless apko image runs unprivileged. Off-platform
peers (laptops, IoT, agents in another constellation, self-hosted
services behind NAT) reach cloister through Cloudflare's edge: the peer
runs `cloudflared` (server-shaped) or `WARP` (client-shaped — literally
WireGuard managed by Cloudflare), CF anycast handles the rendezvous, and
Interlace `.well-known/interlace/index.json` (per ADR-0007) negotiates
identity on top.

See [`docs/deployment/off-platform-peers.md`](docs/deployment/off-platform-peers.md)
for the full deployment pattern, including a commented `cloudflared`
sidecar slot in `apko.yaml` for self-hosted deployments that want
CF Tunnel egress baked into the image.

## 10. Adding a new MCP-fronted service

Cloister's route table is declared in [`cloister.capnp`](cloister.capnp) at
the repo root; per ADR-0004, this is the source of truth. To add a service
(`rsry_*`, `mache_*`, `crumb_*`, …):

1. Decide the *kind*. Four real options:
   - **`durableObject`** — local DO-backed, like `bead_*`
   - **`httpForward`** — HTTP MCP server reachable via a URL env var (how
     `lsp_*`, `reparse|enrich|status`, and `mache_*` work today). Speaks
     JSON-RPC over HTTP. Two flavors via spec flags:
     - `dynamicTools = true` (ADR-0006) auto-derives the catalog from the
       upstream's `tools/list` and caches it for 60s. Used by `mache_*` —
       no hand-written schemas. Pair with `stripPrefix` to namespace bare
       upstream names (e.g. `get_overview` → `mache_get_overview`).
     - `requiresSession = true` performs the MCP Streamable HTTP
       `initialize` handshake and propagates `Mcp-Session-Id` on every
       request. Required for `mark3labs/mcp-go` upstreams (mache, rsry).
       Leave false for genuinely stateless upstreams (LLO daemon).
   - **`serviceBinding`** — another workerd Worker exposed as a `Fetcher`
   - **`leylineNet`** — capnp ToolCall/ToolResult over loopback HTTP to
     `cloister-companion`; companion handles the network hop with full
     leyline-net wire (signed Manifest + AEAD + handshake). Use when the
     upstream is on a different host or wants stateful authenticated
     sessions. Requires a running cloister-companion. See ADR-0005.
2. Add a backend entry inside the `/mcp` route's `mcp.backends` list:

   ```capnp
   # httpForward — Asserted catalog, stateless upstream (LLO shape)
   ( name          = "lsp",
     handlesPrefix = "lsp_",
     kind = (httpForward = (
       urlBinding = "LLO_MCP_URL",
       tools = [
         (name = "lsp_hover",
          description = "...",
          inputSchemaJson = "{\"type\":\"object\",\"properties\":...}"),
       ],
     )),
   ),

   # httpForward — Derived catalog with session-id (mache shape, ADR-0006)
   ( name          = "mache",
     handlesPrefix = "mache_",
     kind = (httpForward = (
       urlBinding      = "MACHE_MCP_URL",
       tools           = [],         # empty ⇒ fully Derived from upstream
       dynamicTools    = true,
       stripPrefix     = "mache_",   # bare names on wire, prefixed on advertise
       requiresSession = true,       # mark3labs/mcp-go session-id handshake
     )),
   ),

   # leylineNet — for backends fronted by cloister-companion
   ( name          = "rosary",
     handlesPrefix = "rsry_",
     kind = (leylineNet = (
       companionUrlBinding = "COMPANION_URL",
       upstreamId          = "rosary",
       tools = [...],
     )),
   ),
   ```

3. If the binding (`ROSARY_MCP_URL` or `COMPANION_URL`) isn't already in
   `wrangler.toml` + `config.capnp` + `src/types.ts`, add it.
4. Run `task manifest` (or just `task lint` — it depends on `manifest`).
   Build-time validators catch:
   - duplicate route paths
   - duplicate backend prefixes
   - duplicate tool names across backends
   - tools whose names don't start with their backend's prefix
   - malformed `inputSchemaJson`
5. Tests: the integration suite in `test/mcp.test.ts` already exercises the
   `tools/list` aggregation, so a new backend appears automatically. Add
   per-backend tests in `test/manifest/` if the wire-shape needs explicit
   coverage.

Empty `handlesPrefix` is allowed and means "exact-match against the
advertised tool names" — used today for `reparse | enrich | status` which
have no shared prefix on the upstream LLO daemon.

## 11. Adding a new HTTP route (not MCP)

Implement `EdgeRoute` in `src/routes/`, register it in
`src/manifest/runtime.ts` if you want it manifest-driven, or for a
one-off path tweak just declare it in `cloister.capnp` under one of the
existing route kinds (`health`, `httpProxy`, `serviceBindingProxy`).

## 12. Further reading

- [ADR-0001](docs/adr/0001-workerd-mcp-gateway.md) — why workerd
- [ADR-0002](docs/adr/0002-edge-router-protocol-agnostic-backends.md) — why
  edge router rather than MCP gateway, and why workerd's service bindings
  replace Istio-style mTLS
- [ADR-0003](docs/adr/0003-content-addressed-bead-store.md) — bead storage
  as Merkle DAG + CAS refs (Phase 1 shipped)
- [ADR-0004](docs/adr/0004-capnp-manifest.md) — Cap'n Proto manifest as the
  registration format
- [ADR-0007](docs/adr/0007-interlace-substrate.md) — Interlace identity:
  Signet leases, peer attestations, .well-known discovery
- [ADR-0011](docs/adr/0011-hypervisor-bundle-boundary.md) — hypervisor vs
  bundle tier classification (three-criterion test)
- [ADR-0012](docs/adr/0012-truststore-vs-beadstore.md) — DO classification:
  TrustStore / BlobStore / CredentialVault are hypervisor-tier singletons;
  BeadStore is per-repo
- [ADR-0013](docs/adr/0013-slice-grant-enforcement.md) — slice-grant
  enforcement via V8 isolate + service-binding-as-syscall (the security
  model behind `CredentialVault`)
- [interlace-spec/0.1.0/](interlace-spec/0.1.0/README.md) — **vendor-
  neutral protocol spec + test vectors** (extracted 2026-05-10) if you're
  building a second implementation
- [docs/perf/2026-05-10-lease-pipeline.md](docs/perf/2026-05-10-lease-pipeline.md)
  — measured per-step latency for the lease middleware (substrate overhead
  is ~520µs / 1ms p50 / 1ms p99 local after batching)
- [docs/deployment/cluster-in-a-pod.md](docs/deployment/cluster-in-a-pod.md)
  — running cloister + sibling bundles as a unit (mac-dev, compose, k8s)
- [docs/security/threat-model.md](docs/security/threat-model.md) — what
  this surface defends against, and the open gaps
