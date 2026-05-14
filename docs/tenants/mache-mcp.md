# mache-mcp

The `mache_*` tools surface [mache](https://github.com/agentic-research/mache)
— a structural code-intelligence FUSE filesystem that exposes ~17 MCP
tools (`get_overview`, `find_callers`, `search`, `get_communities`, …)
over Streamable HTTP. cloister advertises them under the `mache_`
prefix, strips the prefix on `tools/call`, and uses ADR-0006's
**Derived schemas** — mache's tool catalog flows through without
manifest edits.

This is the canonical example of an `mcpProxy` upstream: a
non-workerd process reachable via a workerd `external` Service binding.

## Wire (current as of 2026-05-12; see [`cloister.capnp`](../../cloister.capnp) for source of truth)

```capnp
( name          = "mache",
  handlesPrefix = "mache_",
  kind = (mcpProxy = (
    urlBinding      = "MACHE_MCP_URL",
    serviceBinding  = "MACHE_MCP",
    tools           = [],          # empty + dynamicTools=true → fully Derived
    dynamicTools    = true,
    stripPrefix     = "mache_",
    requiresSession = true,        # mark3labs/mcp-go server; needs Mcp-Session-Id
  )),
),
```

`dynamicTools = true` means cloister fetches `tools/list` from the
upstream at request time and caches with TTL (default 60s); each
upstream tool is advertised as `${handlesPrefix}${upstream_name}`.
`requiresSession = true` makes cloister run the full Streamable-HTTP
lifecycle (POST `initialize`, capture `Mcp-Session-Id`, send it on
subsequent calls) — required because mark3labs/mcp-go servers reject
sessionless requests.

## Required bindings

| Binding | Kind | Where | Purpose |
|---|---|---|---|
| `MACHE_MCP` | `service = "mache-mcp"` | [`config.capnp`](../../config.capnp) | workerd Service binding; preferred locally (`external = (address = ...)`) — bypasses the `internet` ACL |
| `MACHE_MCP_URL` | `text = "http://localhost:7532/mcp"` | [`config.capnp`](../../config.capnp) | CF-prod fallback (Cloudflare Workers can't declare `external` services) |

Per [CLAUDE.md](../../CLAUDE.md): "config.capnp wins locally
(workerd-native shape); wrangler.toml's URL vars win on CF prod."

No vault slice today. ADR-0010 reframes URL bindings as vault slices;
when that lands, `MACHE_MCP_URL` becomes a `vaultSlice` declaration on
the bundle.

## Version pin

`mache:0.8.0` per
[`cluster.compose.yaml`](../../cluster.compose.yaml) (service
`mache`). The compose service binds `localhost:7532` and shares the
cloister-router's network namespace (`network_mode: service:cloister-router`)
so the Service binding resolves to loopback inside the pod.

## Upstream project

- Repo: [github.com/agentic-research/mache](https://github.com/agentic-research/mache)
- Process: `mache serve --http localhost:7532`
- Transport: MCP Streamable HTTP (mark3labs/mcp-go server)

## Auth

Same lease-gating posture as every MCP tenant — the gate is on
cloister's `/mcp` endpoint, not mache's. mache itself trusts whoever
can reach `localhost:7532` (the cluster's shared network namespace
makes that "any in-cluster bundle" today; ADR-0013's V8-isolate +
Service-binding-as-syscall is what keeps that safe).

## Cross-references

- [ADR-0004](../adr/0004-capnp-manifest.md) — the manifest schema (`mcpProxy` is the spec-aligned form of `httpForward`)
- [ADR-0006](../adr/0006-derived-tool-schemas.md) — dynamic tools/list passthrough + TTL cache + Asserted-vs-Derived schema evidence
- [ADR-0011](../adr/0011-hypervisor-bundle-boundary.md) — why mache is **cluster-tier** (removable without breaking the cluster)
- [ADR-0013](../adr/0013-slice-grant-enforcement.md) — the `external` Service binding **IS** the syscall enforcement boundary
- [ADR-0015](../adr/0015-mcp-spec-alignment.md) — Phase 1 rename `httpForward` → `mcpProxy`; mache is the canonical example
- Tracking bead `cloister-827d62` — dynamicTools wiring
- Tracking bead `cloister-b65a20` — Service-binding migration
