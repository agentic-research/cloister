# Tenants

A **tenant** is one logical surface mounted on the cloister-router's
public face. The MCP tenants share a single `/mcp` JSON-RPC endpoint
and dispatch by tool name; non-MCP tenants live at their own paths.
This grid answers the operator's first question — *"is X supported?"* —
without making them read 17 ADRs.

The source of truth is [`cloister.capnp`](../../cloister.capnp) and
[`cluster.compose.yaml`](../../cluster.compose.yaml). The CI gate
`task lint:tenant-docs` (in [`scripts/lint-tenant-docs.mjs`](../../scripts/lint-tenant-docs.mjs))
fails if a tenant declared in either file lacks a matching page here.

## Matrix

| Tenant | Tier | Backend kind | Handles-prefix | Scopes / paths |
|---|---|---|---|---|
| [bead-mcp](bead-mcp.md) | hypervisor | `durableObject` (`BEAD_STORE`) | `bead_` | `bead_create`, `bead_update`, `bead_search`, `bead_list`, `bead_close`, `bead_comment` — **deprecation in flight (cloister-c8b907), see [rsry-mcp](rsry-mcp.md)** |
| [rsry-mcp](rsry-mcp.md) | cluster | `mcpProxy` (Service binding `ROSARY_BUNDLE`) | `rsry_` | ~35 `rsry_*` tools — `rsry_bead_create`, `rsry_bead_search`, `rsry_status`, `rsry_dispatch`, … (full list in `cluster.toml`) |
| [mache-mcp](mache-mcp.md) | cluster | `mcpProxy` (Service binding `MACHE_MCP`) | `mache_` | `mache_*` — derived from upstream (ADR-0006) |
| [identity-bridge](identity-bridge.md) | hypervisor | `wellKnownIdentityBridge` | *(non-MCP)* | `/.well-known/openid-configuration`, `/.well-known/jwks.json`, `/.well-known/webfinger`, `/.well-known/nostr.json`, `/oauth/token` |
| [notme-proxy](notme-proxy-mcp.md) | hypervisor | *(egress mediator, not a backend)* | *(non-MCP)* | Reached only by the `COMPANION` wire from cloister-router — no public path. Holds the bridge cert; every outbound call and every UDS dial transits it. |

`lsp_*` tools (`lsp_hover`, `lsp_defs`, `lsp_refs`, `lsp_symbols`,
`lsp_diagnostics`) plus the `reparse` / `enrich` / `status` lifecycle
tools are not declared as hand-coded backends in `cloister.capnp`. They
arrive via the [`inputs.llo`](../../cluster.toml) declaration: the
lockfile→backend emitter derives a `generatedBackend` from the LLO
server.json that auto-claims those tool names against the `LSP_MCP`
service binding. So they're real and live, but not first-class tenants
— see the generated `[generated_backends]` block in
`cluster.lock.toml` for the canonical list.

Tier comes from [`cluster.capnp`](../../cluster.capnp) per ADR-0011's
three-criterion test. Backend kind comes from the `kind :union` variant
on `Backend` in [`manifest/cloister.capnp`](../../manifest/cloister.capnp) —
the five variants + per-kind purpose are documented in
[`docs/reference/backend-kinds.md`](../reference/backend-kinds.md).

## What this grid does NOT cover

These are substrate-layer endpoints, not tenants. They live in the
manifest's `routes[]` but they're the router's own machinery, not
something a deployer can swap out:

- `health` — liveness probe (`GET /health`)
- `wellKnownInterlace` — Interlace discovery doc (ADR-0007)
- `disclosure` — peer-attestation JSONL stream (ADR-0007 §11)
- `ociRegistry` — OCI Distribution v1.1 registry (`/v2/*`)
- `wellKnownMcpRegistry` — MCP Registry server catalog (ADR-0016)
- `serviceBindingProxy` for `/identity/*` — proxy to `notme-bot`,
  documented under [identity-bridge](identity-bridge.md) as the
  upstream cert mint.

## Adding a new tenant

1. Declare it in [`cloister.capnp`](../../cloister.capnp) (`routes[].mcp.backends[]`
   for an MCP tenant; a new `Route.kind` variant for a non-MCP one).
2. If it's a sibling process, declare it in
   [`cluster.capnp`](../../cluster.capnp) and regenerate
   `cluster.compose.yaml` via `task cluster:emit`.
3. Create `docs/tenants/<name>.md` here. The drift lint matches the
   backend name (or compose service name) to the doc filename — see
   the lint script's header for the exact rule.
4. If you're adding a new `Route.kind` or `Backend.kind` ordinal,
   write an ADR first per [CLAUDE.md](../../CLAUDE.md).

## See also

- [ADR-0002](../adr/0002-edge-router-protocol-agnostic-backends.md) — edge router with protocol-agnostic backends
- [ADR-0004](../adr/0004-capnp-manifest.md) — the manifest schema
- [ADR-0006](../adr/0006-derived-tool-schemas.md) — dynamic tools/list (mache uses this)
- [ADR-0011](../adr/0011-hypervisor-bundle-boundary.md) — tier classification
- [ADR-0013](../adr/0013-slice-grant-enforcement.md) — bundle isolation enforced by V8 isolate + Service bindings
- [ARCHITECTURE.md](../ARCHITECTURE.md) — runtime model + sequence diagrams
