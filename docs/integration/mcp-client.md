# Wire an MCP client to cloister

Cloister exposes a single MCP endpoint at `/mcp` — JSON-RPC over HTTP
with `text/event-stream` server-push (Streamable-HTTP transport). Any
MCP-compatible client connects to it the same way it would connect to
any other MCP server — there's nothing cloister-specific about the
wiring.

This doc covers:
- The three ways cloister is reachable (local single-worker, local cluster,
  hosted) and what URL to point at in each.
- Client configuration snippets for the most common clients.
- The lease/auth layer, when it's on and what changes on the client side.
- Common failure modes and how to read them.

## TL;DR

```jsonc
// .mcp.json (or per-client equivalent)
{
  "mcpServers": {
    "cloister": {
      "transport": "http",
      "url": "http://localhost:8787/mcp"
    }
  }
}
```

Start cloister with `task dev` (Path A in [GETTING-STARTED.md §3](../../GETTING-STARTED.md#3-run-cloister-locally)),
restart your client, and `bead_*`, `lsp_*`, `mache_*`, `reparse`, `enrich`,
`status` should appear in its tool list.

## Pick the right URL

| Where cloister is running | URL the client uses |
|---|---|
| `task dev` (wrangler dev, single worker, local) | `http://localhost:8787/mcp` |
| `task cluster:up` (full topology — cloister + notme + ley-line-open + mache + rosary) | `http://localhost:8787/mcp` (cloister-router is the public face) |
| `pnpm exec wrangler deploy` (Cloudflare Workers production) | `https://<your-subdomain>.<account>.workers.dev/mcp` |
| `docker run cloister:0.1.0` (self-hosted OCI image) | `http://<host>:8787/mcp`, typically behind a tunnel — see [`docs/deployment/off-platform-peers.md`](../deployment/off-platform-peers.md) for the CF Tunnel / WARP shape |

The MCP-spec rule cloister enforces: servers MUST bind to loopback, not
`0.0.0.0`. That means a self-hosted OCI image isn't directly internet-
reachable on its own — point a tunnel at it (CF Tunnel, Tailscale, etc.)
and have clients hit the tunnel's public hostname.

## Client snippets

### Claude Code

Project-level `.mcp.json` at the repo root (auto-discovered):

```jsonc
{
  "mcpServers": {
    "cloister": {
      "transport": "http",
      "url": "http://localhost:8787/mcp"
    }
  }
}
```

User-level — add to `~/.claude.json`'s `mcpServers` block.

Restart the Claude Code session to pick up the change. Verify with
`claude mcp list` if the CLI is on your PATH.

### Cursor / Continue / other Claude-API MCP clients

Same shape — point at `http://localhost:8787/mcp` with `transport: "sse"`
in whatever the client's MCP block is called. The MCP protocol is
client-agnostic; only the config-file location differs.

### Raw curl (sanity check before wiring a client)

```sh
# Initialise + list tools
curl -s -X POST http://localhost:8787/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | jq '.result.tools[].name'
```

You should see `bead_create`, `bead_search`, `lsp_hover`, `mache_get_overview`,
… If the list is empty, the upstream backends are unwired (see
[GETTING-STARTED.md §5](../../GETTING-STARTED.md#5-wire-upstreams-only-what-you-need)).

## Auth: when leases are on

Cloister's lease pipeline runs **always-on** when `INTERLACE_ROOT_PUBKEY`
is set in the deployment config. When unset (dev/test default), the gate
short-circuits and requests pass through. This is **deployment-binding
granularity**, not per-request bypass — once set, the substrate validates
every authenticated route.

With leases on, the client needs to send an `X-Interlace-Lease` header
on each `POST /mcp`. The lease is a short-lived (≤5 min by manifest
policy) signed token minted by [notme](https://github.com/agentic-research/notme)
against the cluster's root pubkey. See:

- [ADR-0007 (Interlace substrate)](../adr/0007-interlace-substrate.md) — the lease + attestation + discovery design.
- [docs/security/threat-model.md §13.2](../security/threat-model.md) — the "silence is evidence" invariant the lease chain provides.
- The lease-mint flow in [notme/README](https://github.com/agentic-research/notme) — how a client gets a dev cert.

For local dev, leave `INTERLACE_ROOT_PUBKEY` unset and skip auth entirely.

## Common failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `connection refused` on `/mcp` | Cloister isn't running, or it's bound to a different port | `task dev` (port 8787) or `task cluster:up`; check `lsof -i :8787` |
| `tools/list` returns empty | Upstream backends (notme, llo, mache, rosary) aren't wired | [GETTING-STARTED.md §5](../../GETTING-STARTED.md#5-wire-upstreams-only-what-you-need) — set `*_MCP_URL` env vars |
| 401 / lease-required | `INTERLACE_ROOT_PUBKEY` is set on the deployment, but the client didn't send `X-Interlace-Lease` | Either unset the env (dev) or wire notme to mint leases (prod) |
| 503 on `/identity/*` | notme service binding is missing | `task notme:up` to start notme on `:8788`; or remove the `notme-bot` service entry from `config.capnp` if running standalone |
| Tool calls hang | Backend (mache, ley-line-open) is unreachable | Check the specific `*_MCP_URL` env — `curl $URL` should return a response |
| `bead_create` returns `peer_lease_counters not found` | TrustStore DO didn't migrate; happens on fresh installs in dev when SQL schema is rolled forward | Tear down and recreate the cluster volume: `task cluster:down -- DESTROY=1` then `task cluster:up` |

## What tools are exposed

| Prefix | Backend | What it does |
|---|---|---|
| `bead_*` | BEAD_STORE DO (per-repo SQLite) | Issue tracking — create/search/list/comment/close beads. Same store rsry talks to directly. |
| `lsp_*` | ley-line-open daemon via LLO_MCP_URL | Position-based LSP — hover, definitions, references, document symbols, diagnostics. |
| `mache_*` | mache MCP server via MACHE_MCP_URL | Structural code intelligence — overview, communities, call graphs, semantic search, diagrams. Dynamic tool list (per ADR-0006). |
| `reparse` / `enrich` / `status` | ley-line-open lifecycle | Re-run parse / enrichment passes; report daemon state. |

Tool input schemas are codegen'd from `src/tool-schemas/*.ts` and surfaced
via `tools/list`. The schema is the contract — clients should consume it
rather than hardcoding shapes.

## Registry discovery — enumerate cloister's upstream surface

Cloister implements the [MCP Registry OpenAPI](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/api/openapi.yaml)
read surface (ADR-0016) under `/.well-known/mcp-registry/`. Clients that
already know how to consume an [MCP Registry](https://modelcontextprotocol.io/registry/about)
can list cloister's tenants programmatically without bespoke integration.

### List servers

```sh
curl -s http://localhost:8787/.well-known/mcp-registry/v0.1/servers | jq
```

Response shape (per the OpenAPI spec):

```jsonc
{
  "servers": [
    {
      "server": {
        "$schema": "https://modelcontextprotocol.io/schemas/draft/2025-12-01/server.schema.json",
        "name": "art.agentic-research/cloister/mache",
        "description": "mache (mache_* tools) — proxied through cloister, dynamic tools",
        "version": "0.0.0",
        "remotes": [
          { "type": "streamable-http", "url": "http://localhost:8787/mcp" }
        ]
      },
      "_meta": {
        "io.modelcontextprotocol.registry/official": {
          "id": "cloister:art.agentic-research/cloister/mache",
          "publishedAt": "1970-01-01T00:00:00Z",
          "updatedAt":   "1970-01-01T00:00:00Z",
          "isLatest":    true,
          "status":      "active"
        }
      }
    }
  ],
  "metadata": { "count": 1, "nextCursor": null }
}
```

### Fetch one server

```sh
curl -s "http://localhost:8787/.well-known/mcp-registry/v0.1/servers/art.agentic-research/cloister/mache" | jq
```

Returns the same envelope object for the named server, or 404 if unknown.
The 404 body is constant-shape — clients shouldn't gate on body content
beyond `error: "not_found"`.

### Client wiring

The Registry endpoint tells you *what* tenants cloister proxies; the
`/mcp` endpoint is where you actually call them. Typical flow:

1. `GET /.well-known/mcp-registry/v0.1/servers` to enumerate the
   upstream catalog at startup. Names are stable across deployments.
2. Configure your MCP client to point at `/mcp` (per "Pick the right
   URL" above).
3. The tool list you get via `tools/list` on `/mcp` is the union of
   the catalog's surfaces, namespaced per the manifest's `handlesPrefix`
   (e.g. `mache_*`, `lsp_*`).

### What's exposed and what isn't

Only externally-shaped backends appear in the Registry surface:

- **`httpForward`** (mache, ley-line-open, …) — yes
- **`leylineNet`** (companion-mediated upstreams) — yes
- **`durableObject`** (BeadStore) — no, intra-cluster
- **`serviceBinding`** (notme) — no, workerd Fetcher binding

This matches the spec's intent: a Registry entry should be something a
host application could *reach* with the right network placement, not an
implementation detail of the proxy.

## Where to go from here

- [`GETTING-STARTED.md`](../../GETTING-STARTED.md) — full local-dev walkthrough.
- [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) — what the components are and how they fit.
- [`docs/security/threat-model.md`](../security/threat-model.md) — auth model in detail; what `X-Interlace-Lease` actually proves.
- [`docs/adr/0016-cloister-as-private-mcp-registry.md`](../adr/0016-cloister-as-private-mcp-registry.md) — registry-surface design.
- [`interlace-spec/0.1.0/`](../../interlace-spec/0.1.0/README.md) — vendor-neutral wire spec if you're building a non-cloister implementation.
