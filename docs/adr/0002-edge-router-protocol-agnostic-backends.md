---
title: "ADR-0002: cloister as SSE/HTTP edge router with protocol-agnostic backends"
status: Accepted
date: 2026-04-28
tags: [architecture, routing, mcp, sse, workerd, capability]
supersedes_framing: [ADR-0001]
---

## Context

ADR-0001 framed cloister as "a portable MCP gateway." That framing is too narrow and is
already misleading the implementation. Two facts force a reframe:

1. **MCP is a JSON-RPC convention layered on SSE/HTTP.** The wire is just `text/event-stream`
   for the server-push side and `application/json` for `POST /mcp`. The router does not need
   to know about MCP to deliver bytes; MCP is one *tenant* of an SSE/HTTP edge.

2. **notme has a no-network local vault.** The vault is reachable only via workerd service
   binding — an unforgeable intra-process reference. cloister is the *only* thing on the
   network in front of it. Fewer knobs than Istio because the substrate (workerd service
   bindings + `globalOutbound` per-binding) already enforces what Istio bolts on with sidecars
   and a CA.

Concrete consequences this ADR must support:

- `cloister-ac8bcf` will add an `lsp_*` tool family that egresses over HTTP/UDS to
  `notme-proxy` → `leyline daemon --mcp-port`. Tool prefix routing must extend without
  touching the existing `bead_*` path.
- `cloister-acbf27` (CC plugin) is a pure MCP client of the edge — it does not see backends.
- Future tenants on the same edge: identity HTTP (already present), gRPC over h2 (workerd
  supports it natively), raw WebSocket streams.

The hardcoded if/else in `src/index.ts` (`if pathname === "/mcp"`, `if startsWith("/identity/")`,
`if toolName.startsWith("bead_")`) does not scale to that surface and will collide with the
parallel agent runs on `cloister-ac8bcf`.

## Decision

Two layers of routing, each with a small explicit interface.

### 1. `EdgeRoute` — outer HTTP/SSE multiplexing

```ts
interface EdgeRoute {
  match(request: Request): boolean;
  handle(request: Request, env: Env): Promise<Response>;
}
```

A `Router` holds an ordered table of `EdgeRoute`s and dispatches first-match-wins, falling
through to a 404. Routes are constructed once at module load; they read from `env` at
`handle` time (env is per-request). Concrete routes today:

- `HealthRoute` — `GET /health`, returns service metadata
- `NotmeIdentityRoute` — `/identity/*` → `env.NOTME` service binding (vault, no-net)
- `McpEdgeRoute` — `GET|POST /mcp`, owns SSE + JSON-RPC dispatch, fans out to `ToolBackend`s

Future routes plug in without touching existing ones (e.g. a `GrpcEdgeRoute` matching
`content-type: application/grpc`, a `WebSocketRoute` matching `upgrade: websocket`).

### 2. `ToolBackend` — inner MCP tool dispatch

```ts
interface ToolBackend {
  tools(): McpTool[];                                        // self-advertises in tools/list
  handles(toolName: string): boolean;                        // typically a name-prefix check
  invoke(name: string, args: Record<string, unknown>, env: Env): Promise<unknown>;
}
```

`McpEdgeRoute` aggregates registered backends:

- `tools/list` returns the union of all `backend.tools()`
- `tools/call` finds the first `backend.handles(name)` and delegates `invoke(...)`
- Unknown tool → JSON-RPC `-32601`
- A backend signals a structured failure by throwing `JsonRpcInvocationError(code, message)`;
  unknown throws map to `-32603 internal error`

Concrete backends today:

- `BeadToolBackend` — `bead_*` → `env.BEAD_STORE` Durable Object, keyed by `args.repo`

Concrete backends planned (not part of this ADR's scaffold):

- `UdsHttpToolBackend` — `lsp_*` → `notme-proxy` via UDS (cloister-ac8bcf)
- `HttpToolBackend` — generic HTTP egress (rosary, future leyline-direct)
- `ServiceBindingToolBackend` — generic intra-process proxy via a `Fetcher` binding

### Protocol-agnosticism contract

The router never imports MCP types. The MCP route is one tenant; identity is another. The
edge does not assume JSON-RPC, SSE, or any specific application protocol. New tenants are
new `EdgeRoute`s.

### Capability boundary

Backends receive `env` only at `invoke` time. A backend cannot capture `env` at construction
and cannot reach bindings other than what `env` exposes. The unforgeable-reference property
of service bindings is preserved end-to-end.

## Consequences

**Positive:**

- `cloister-ac8bcf` becomes one new file (`src/backends/lsp.ts` implementing `ToolBackend`)
  plus one line in the route table. No edits to `McpEdgeRoute`, no edits to `BeadToolBackend`.
- `cloister-acbf27` is unaffected — the CC plugin is a JSON-RPC client; it sees the edge,
  not the backends.
- `tools/list` aggregation is the obvious place to enforce a "no duplicate tool names"
  invariant (testable, table-driven).
- Each `EdgeRoute` and `ToolBackend` is a plain class — unit-testable without `SELF.fetch`.
- Future protocols (gRPC, WebSocket) extend the table; existing routes do not change.

**Negative / risks:**

- Indirection cost: ~100 LOC of glue (`router.ts`, `backends.ts`, three route classes, one
  backend class). Worth it because the existing surface is *already* heterogeneous (DO,
  service binding, HTTP env-var) and was being faked behind sequential `if`s.
- `EdgeRoute.match` is called for every route on every request. With 3–6 routes this is
  free; if the table grows beyond ~20 we revisit (e.g. trie or method/prefix index).
- `ToolBackend.handles` uses prefix matching. Two backends claiming the same prefix is a
  silent first-wins bug. The router enforces this with a startup check (duplicate tool name
  in `tools/list` aggregation = throw).

**Out of scope for this ADR:**

- Auth/JWT middleware on `POST /mcp` (stays in ADR-0001's work items)
- The CC plugin LSP-stale-didChange protocol (cloister-acbf27)
- The lsp_* UDS backend implementation (cloister-ac8bcf)
- gRPC tenant route

## Work items

- [x] Land the `Router` + `EdgeRoute` + `ToolBackend` scaffold in `src/` (commit `c176e4e`)
- [x] Migrate existing `bead_*` and `/identity/*` paths through the new abstraction
- [x] Add contract tests: route matching, tools/list aggregation, backend isolation,
      duplicate-tool detection
- [x] (cloister-ac8bcf) Implement `LspToolBackend` exposing `lsp_*` over HTTP to
      `LLO_MCP_URL`, register it (commit `45cc5cb`). Note: shipped as HTTP rather than
      UDS — UDS is fronted by `notme-proxy` in prod, so cloister stays HTTP-only.
- [x] (cloister-acbf27) Add `LeylineLifecycleBackend` (`reparse | enrich | status`) and
      ship the `cloister-stale-sync` Claude Code plugin in this repo (commit `c46a8f5`).
      Plugin auto-fires `reparse` on every Edit to keep `lsp_*` results fresh.
- [x] Add `LLO_MCP_URL` to both `wrangler.toml` and `config.capnp` (commit `4f970f6`)

## See also

- [ADR-0001](0001-workerd-mcp-gateway.md) — workerd choice and packaging story
- [ADR-0003](0003-content-addressed-bead-store.md) — substrate-free bead storage that plugs under `BeadToolBackend`
- [ADR-0004](0004-capnp-manifest.md) — Cap'n Proto manifest replacing the TS registration site this ADR introduced
- [ADR-0005](0005-internal-wire-leyline-net.md) — adds a `leylineNet` ToolBackend kind under the seam this ADR defines
- [../../README.md](../../README.md) — what each tenant does
- [../ARCHITECTURE.md](../ARCHITECTURE.md) — runtime model + sequence diagrams
- [../../GETTING-STARTED.md](../../GETTING-STARTED.md) — hands-on setup
- [../../hooks/README.md](../../hooks/README.md) — `cloister-stale-sync` plugin contract
