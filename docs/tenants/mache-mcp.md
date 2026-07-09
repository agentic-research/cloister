# mache-mcp

The `mache_*` tools surface [mache](https://github.com/agentic-research/mache)
— a structural code-intelligence FUSE filesystem that exposes ~17 MCP
tools (`get_overview`, `find_callers`, `search`, `get_communities`, …)
over Streamable HTTP.

As of cloister-2d987e, mache is wired through the ADR-0026 **resolver
pipeline** (the same one `llo`/ley-line-open uses) instead of a single
hand-written `dynamicTools=true` catch-all backend. mache's own
`server.json` carries a 6-group `_meta.art.cloister/v1` block
(navigation, callgraph, lsp, lifecycle, linter, mutate); `task
cluster:resolve` reads it and emits one `[[generated_backends]]` row
per group into `cluster.lock.toml`, and `task manifest` injects those
rows into `cloister.capnp`'s `/mcp` route.

This is the canonical example of a **multi-group single-input**
resolver wiring: one `[inputs.*]` entry fanning out into several named
backends, each claiming a disjoint slice of the upstream's tool
catalog, rather than one backend claiming everything.

## Wire (current as of cloister-2d987e; see [`cluster.lock.toml`](../../cluster.lock.toml) `[[generated_backends]]` + [`cloister.capnp`](../../cloister.capnp) for source of truth)

```toml
# cluster.toml
[inputs.mache]
ref            = "io.github.org/agentic-research/mache@main"
version        = "0.13.0"
from           = "file:///path/to/mache/server.json"  # dev escape hatch
urlBinding     = "MACHE_MCP_URL"
serviceBinding = "MACHE_MCP"
```

`task cluster:resolve` reads mache's `server.json` `_meta.art.cloister/v1.groups[]`
and derives one backend per group, e.g.:

```capnp
( name          = "navigation",
  handlesPrefix = "mache_",
  kind = (mcpProxy = (
    urlBinding      = "MACHE_MCP_URL",
    serviceBinding  = "MACHE_MCP",
    tools           = [],          # fully Derived (ADR-0006)
    dynamicTools    = true,
    claims          = [ "list_directory", "read_file", "get_overview",
                         "get_architecture", "get_diagram", "get_communities" ],
  )),
),
# ...5 more: callgraph, lsp, lifecycle, linter, mutate
```

All 6 backends share `handlesPrefix = "mache_"` (mache's server.json
gives every group the same `advertisedPrefix`) but have disjoint,
non-empty `claims` sets. `McpProxyToolBackend.handles()`
(`src/manifest/backends/mcp-proxy.ts`) checks `claims` **before**
falling back to prefix matching, so dispatch is by exact upstream tool
name, not by the shared prefix — sharing a prefix across claims-backed
backends from the same input is safe (no ADR-0002 first-wins-shadow
hazard). `src/manifest/runtime.ts`'s `validate()` and
`scripts/build-manifest.mjs`'s build-time mirror both special-case this:
the duplicate-prefix check only fires when a claims-less backend would
be involved (that backend genuinely falls back to prefix matching and
would collide).

**`stripPrefix` derivation (fixed in cloister-2d987e):** mache's groups
declare bare `upstreamNames` (e.g. `find_callers`, not
`mache_find_callers`) under a non-empty `advertisedPrefix`. `tools()`
correctly *advertises* each as `mache_find_callers` (the "don't
re-prefix" rule doesn't apply — the bare upstream name doesn't already
start with the prefix, so it gets prefixed once for advertisement). But
`handles()` checks the **advertised** name (`mache_find_callers`)
against `claims`, which only holds the **bare** upstream name
(`find_callers`) — without a `stripPrefix` to reconcile the two, the
call never matches. `scripts/resolve-inputs.mjs:deriveStripPrefix`
derives `stripPrefix = advertisedPrefix` per group whenever that
group's `upstreamNames` are bare (don't already start with
`advertisedPrefix`) — mirroring the same bare-vs-prefixed condition
`tools()` uses for the don't-double-prefix rule — and leaves it `""`
for already-prefixed groups (llo's shape, unaffected). A group whose
`upstreamNames` mix both shapes is rejected at resolve time (loud
error naming the group) rather than silently mis-stripped.

## Cross-input name collisions

`_meta.art.cloister/v1`'s `name` field is only guaranteed unique
*within one server.json's `groups[]`* (per
`leyline-schema-spec/mcp-tool/v1/wire/meta-groups.md`), not across inputs.
mache and llo both happen to name a group `lsp` and a group
`lifecycle`. `scripts/build-manifest.mjs`'s `overlayLockfileBackends`
detects this and qualifies the **second-processed** row as
`${input}/${name}` (e.g. `mache/lsp`) so neither input's tools are
silently dropped — see the emitted `src/generated/manifest.ts` for the
resolved names. This is cosmetic (the qualified `name` field is only
operator/log/disclosure-endpoint-facing); it doesn't affect routing.

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

`mache:0.13.0` per the `[[bundles]]` entry in
[`cluster.toml`](../../cluster.toml) (name `mache`) and
[`cluster.compose.yaml`](../../cluster.compose.yaml) (service
`mache`). Unlike `llo` (which has no `[[bundles]]` entry — it's not
compose-managed), mache's bundle is what actually runs the container;
it was kept when the hand-written `[[routes.mcp.backends]]` mache
shell was retired in favor of the resolver-generated backends. The
compose service binds `localhost:7532` and shares the cloister-router's
network namespace (`network_mode: service:cloister-router`) so the
Service binding resolves to loopback inside the pod.

## Upstream project

- Repo: [github.com/agentic-research/mache](https://github.com/agentic-research/mache)
- Process: `mache serve --http localhost:7532`
- Transport: MCP Streamable HTTP (mark3labs/mcp-go server)
- `server.json`'s `_meta.art.cloister/v1.groups[]`: navigation,
  callgraph, lsp, lifecycle, linter, mutate

## Auth

Same lease-gating posture as every MCP tenant — the gate is on
cloister's `/mcp` endpoint, not mache's. mache itself trusts whoever
can reach `localhost:7532` (the cluster's shared network namespace
makes that "any in-cluster bundle" today; ADR-0013's V8-isolate +
Service-binding-as-syscall is what keeps that safe).

## Cross-references

- [ADR-0002](../adr/0002-edge-router-protocol-agnostic-backends.md) — the duplicate-prefix-is-a-silent-first-wins-bug invariant this doc's claims-aware exception refines
- [ADR-0004](../adr/0004-capnp-manifest.md) — the manifest schema (`mcpProxy` is the spec-aligned form of `httpForward`)
- [ADR-0006](../adr/0006-derived-tool-schemas.md) — dynamic tools/list passthrough + TTL cache + Asserted-vs-Derived schema evidence
- [ADR-0011](../adr/0011-hypervisor-bundle-boundary.md) — why mache is **cluster-tier** (removable without breaking the cluster)
- [ADR-0013](../adr/0013-slice-grant-enforcement.md) — the `external` Service binding **IS** the syscall enforcement boundary
- [ADR-0015](../adr/0015-mcp-spec-alignment.md) — Phase 1 rename `httpForward` → `mcpProxy`; mache is the canonical example
- [ADR-0026](../adr/0026-tool-composition-model.md) — the resolver pipeline this doc now describes
- `leyline-schema-spec/mcp-tool/v1/wire/meta-groups.md` — the `_meta.art.cloister/v1.groups[]` wire spec
- Tracking bead `cloister-2d987e` — mache resolver migration (this doc's rewrite + the stripPrefix gap)
- Tracking bead `cloister-827d62` — dynamicTools wiring (superseded by the resolver path for mache)
- Tracking bead `cloister-b65a20` — Service-binding migration
- Tracking bead `cloister-8ede3f` — claims-aware routing (`McpProxyToolBackend.handles()`)
