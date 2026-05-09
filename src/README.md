# `src/` — cloister worker source

This is the **cloister-router bundle** (per [ADR-0010](../docs/adr/0010-vault-and-bundle-clusters.md)
terminology) — a workerd Worker that fronts the public face
(MCP/JSON-RPC over HTTP/SSE), routes requests to backends declared in
the typed manifest, and exposes Interlace identity surfaces.

## Layout

```
src/
├── index.ts             # composition root — instantiate(manifest) → router
├── router.ts            # Router + EdgeRoute interface (outer-layer dispatch)
├── backends.ts          # ToolBackend interface (MCP-layer dispatch)
├── beads.ts             # BeadStore Durable Object (per-repo bead state)
├── cors.ts              # ALLOWED_ORIGINS allowlist + CORS helpers
├── types.ts             # Env shape (workerd bindings)
│
├── routes/              # EdgeRoute implementations
│   ├── health.ts        # GET /health
│   ├── mcp.ts           # GET|POST /mcp (SSE + JSON-RPC)
│   ├── notme-identity.ts# /identity/* → notme service binding
│   └── well-known.ts    # GET /.well-known/interlace/index.json
│
├── manifest/            # capnp manifest → runtime EdgeRoute table
│   ├── types.ts         # hand-mirrored Cloister.Gateway TS types
│   ├── runtime.ts       # instantiate(manifest): EdgeRoute[]
│   ├── spec.ts          # inputSchemaJson → parsed JSON Schema
│   └── backends/        # ToolBackend factories per kind
│       ├── durable-object.ts
│       ├── http-forward.ts
│       ├── service-binding.ts
│       ├── uds-forward.ts    # placeholder, not wired
│       └── leyline-net.ts    # IPC to cloister-companion
│
├── wire/                # hand-rolled capnp codec (ADR-0005)
│   ├── codec.ts         # WireBuilder / WireReader (pointer + segment primitives)
│   ├── manifest.ts      # encode/decode Manifest (dead in production — kept for schema parity)
│   ├── tool-call.ts     # encode/decode ToolCall (used by leyline-net.ts)
│   └── tool-result.ts   # encode/decode ToolResult (composite-list + union)
│
├── storage/             # DO-internal storage helpers (when present)
│
└── generated/           # gitignored — populated by `task manifest`
    └── manifest.ts      # typed JSON literal of the consumer cloister.capnp
```

## Two-layer dispatch

```mermaid
flowchart TB
    REQ["incoming Request"]
    R["Router (router.ts)<br/>ordered EdgeRoute table"]
    H["HealthRoute<br/>routes/health.ts"]
    I["NotmeIdentityRoute<br/>routes/notme-identity.ts"]
    M["McpEdgeRoute<br/>routes/mcp.ts"]
    W["WellKnownInterlaceRoute<br/>routes/well-known.ts"]

    B["DurableObjectToolBackend<br/>bead_*"]
    L["HttpForwardToolBackend<br/>lsp_*, mache_*, reparse|enrich|status"]
    LN["LeylineNetToolBackend<br/>(via cloister-companion)"]

    REQ --> R
    R -->|first match wins| H
    R --> I
    R --> M
    R --> W
    M -->|"handles(name)"| B
    M --> L
    M --> LN
```

The outer layer ([ADR-0002 EdgeRoute](../docs/adr/0002-edge-router-protocol-agnostic-backends.md))
dispatches HTTP requests to `EdgeRoute`s. The MCP edge route, in turn,
dispatches MCP tool calls to `ToolBackend`s.

## Where to make changes

| Goal | File(s) |
|---|---|
| Add a new public path | `routes/<name>.ts` + manifest schema entry + `manifest/runtime.ts` branch |
| Add a new MCP backend kind | `manifest/backends/<kind>.ts` + manifest schema field + `manifest/types.ts` mirror + `manifest/runtime.ts` branch |
| Add a new MCP tool to an existing backend | edit the consumer `cloister.capnp` only — schema travels through `task manifest` |
| Touch the wire format | `src/wire/<file>.ts` + `wire/cloister.capnp` schema + regenerate fixtures via `task wire:fixtures` |
| Add a Durable Object | new file alongside `beads.ts`, register in `wrangler.toml` + `config.capnp` (must travel together) |

## Worker entry

`src/index.ts` is the composition root. It imports the typed manifest
from `src/generated/manifest.ts`, hands it to `instantiate()`, and
exports the `default { fetch(...) }` Worker handler.

```ts
const router = new Router(instantiate(manifest));
export default {
  fetch(request, env, ctx): Promise<Response> {
    return router.handle(request, env);
  },
};
```

There is no per-feature flag. The route table is what the manifest says
it is.

## See also

- [`../manifest/`](../manifest/) — capnp schema for what we instantiate
- [`../wire/`](../wire/) — capnp wire schemas (production + test fixtures)
- [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) — runtime model, sequence diagrams
- [`../CLAUDE.md`](../CLAUDE.md) — conventions, gotchas, when-to-write-an-ADR rules
