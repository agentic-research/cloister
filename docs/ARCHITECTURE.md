# Architecture

cloister is an SSE/HTTP edge router that runs on workerd. The same
TypeScript bundle runs locally via the `workerd` binary and on Cloudflare
Workers in production — no code changes, only config differs.

This document covers the runtime model and request routing as implemented
today. The decisions behind it are in the ADRs:

- [ADR-0001](adr/0001-workerd-mcp-gateway.md) — why workerd
- [ADR-0002](adr/0002-edge-router-protocol-agnostic-backends.md) — why edge
  router with protocol-agnostic backends, not "an MCP gateway"
- [ADR-0003](adr/0003-content-addressed-bead-store.md) — substrate-free bead
  storage as content-addressed DAG + CAS refs (Phase 1 landed; Phase 2 planned)
- [ADR-0004](adr/0004-capnp-manifest.md) — Cap'n Proto manifest replacing the
  TS registration site. **Shipped**: `cloister.capnp` at the repo root is the
  source of truth for routes; `task manifest` compiles it to
  `src/generated/manifest.ts`; `src/index.ts` instantiates from there.

If you're trying to *run* cloister rather than understand its shape, start
at [../GETTING-STARTED.md](../GETTING-STARTED.md).

## Runtime model

```mermaid
graph TB
    subgraph local ["Local (workerd serve config.capnp)"]
        direction LR
        W["Worker\nsrc/index.ts"]
        DO["BeadStore DO\nSQLite on disk\n/data/do"]
        W --- DO
    end

    subgraph cf ["Cloudflare (wrangler deploy)"]
        direction LR
        CW["Worker\nsrc/index.ts"]
        CDO["BeadStore DO\nCF-managed SQLite"]
        CW --- CDO
    end

    Dev["Developer / Claude Code"] -->|workerd :8787| local
    Prod["Production client"] -->|CF edge| cf
```

The code is identical. Storage differs: local disk vs Cloudflare-managed
Durable Object SQLite. Both use the same DO SQL API (`ctx.storage.sql`).

## Request routing — two layers

ADR-0002 introduces two small interfaces. The outer layer dispatches HTTP
requests to `EdgeRoute`s. The MCP edge route, in turn, dispatches tool
calls to `ToolBackend`s.

```mermaid
graph TB
    REQ["incoming Request"]
    R["Router (ordered table)"]
    H["HealthRoute\nGET /health"]
    I["NotmeIdentityRoute\n/identity/*"]
    M["McpEdgeRoute\nGET|POST /mcp"]

    B["BeadToolBackend\nbead_*\n→ env.BEAD_STORE DO"]
    L["LspToolBackend\nlsp_*\n→ env.LLO_MCP_URL"]
    F["LeylineLifecycleBackend\nreparse | enrich | status\n→ env.LLO_MCP_URL"]

    REQ --> R
    R -->|first match wins| H
    R --> I
    R --> M
    M -->|handles(name)| B
    M --> L
    M --> F
```

### EdgeRoute — HTTP/SSE multiplexing

Each `EdgeRoute` answers `match(request)` and `handle(request, env)`. The
router tries them in order; the first match wins, and falls through to a
404. Routes never see one another and never call back into the Router.

### ToolBackend — MCP tool dispatch

`McpEdgeRoute` aggregates a list of `ToolBackend`s. For `tools/list` it
returns the *union* of every backend's `tools()`. For `tools/call` it finds
the first backend whose `handles(name)` returns true and delegates
`invoke(name, args, env)`.

The route throws at construction if two backends advertise the same tool
name — duplicate-tool-name shadowing is loud, not silent.

## Sequence diagrams

### bead_create — local DO

```mermaid
sequenceDiagram
    participant C as MCP Client
    participant R as Router
    participant ME as McpEdgeRoute
    participant BB as BeadToolBackend
    participant DO as BeadStore DO

    C->>R: POST /mcp tools/call bead_create
    R->>ME: match → /mcp
    ME->>BB: handles("bead_create") → true
    BB->>DO: stub.fetch — keyed by args.repo
    DO-->>BB: {id, state}
    BB-->>ME: result
    ME-->>C: {content:[{type:"text", text:"..."}]}
```

### lsp_hover — HTTP forward to ley-line-open

```mermaid
sequenceDiagram
    participant C as MCP Client
    participant ME as McpEdgeRoute
    participant LB as LspToolBackend
    participant LLO as ley-line-open daemon

    C->>ME: POST /mcp tools/call lsp_hover {file,line,col}
    ME->>LB: handles("lsp_hover") → true
    LB->>LLO: POST env.LLO_MCP_URL — tools/call lsp_hover
    LLO-->>LB: {content:[{type:"text", text:"<json>"}]}
    LB-->>ME: parsed JSON (or raw text fallback)
    ME-->>C: re-wrapped as MCP content
```

### reparse — fired by the CC plugin

```mermaid
sequenceDiagram
    participant CC as Claude Code
    participant H as PostToolUse hook (sync.mjs)
    participant CL as cloister
    participant LLO as ley-line-open

    CC->>CC: Edit /x/foo.rs
    CC->>H: stdin = {tool_name, tool_input:{file_path}}
    H->>CL: POST /mcp tools/call reparse {source:"/x/foo.rs"}
    CL->>LLO: forward (LeylineLifecycleBackend → LLO_MCP_URL)
    LLO-->>CL: {ok:true, files_reparsed:1}
    CL-->>H: 2xx (silently ignored on failure)
    Note over CC,LLO: subsequent lsp_* calls now see fresh data
```

### /identity/* — service binding to notme

```mermaid
sequenceDiagram
    participant C as Client
    participant ME as NotmeIdentityRoute
    participant NM as notme worker (vault)

    C->>ME: GET /identity/token
    Note over ME,NM: env.NOTME is a workerd Fetcher —\nunforgeable intra-process ref
    ME->>NM: fetch (no network hop)
    NM-->>ME: JWT
    ME-->>C: JWT
```

The notme vault has *no network*. It is reachable only through this service
binding, which is an unforgeable reference. cloister is the only thing on
the network in front of it. See ADR-0002 §"Capability boundary".

## SSE (Server-Sent Events)

```mermaid
sequenceDiagram
    participant C as Any SSE client (browser, Python, Go, Rust)
    participant GW as McpEdgeRoute (GET /mcp)

    C->>GW: GET /mcp
    GW-->>C: HTTP 200\nContent-Type: text/event-stream\nCache-Control: no-cache

    GW-->>C: data: {"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2024-11-05"}}\n\n
    Note over GW,C: standard W3C SSE — no MCP-specific framing

    loop every 15s
        GW-->>C: : ping\n\n
        Note over GW,C: comment line — proxies don't close idle connections
    end
```

Any language's EventSource implementation works without MCP-specific
libraries.

## Component map

```mermaid
graph TD
    subgraph compose ["Composition root"]
        IDX["index.ts\nbuilds ROUTES, exports Worker"]
    end

    subgraph router ["Routing layer"]
        RR["router.ts\nRouter + EdgeRoute"]
        H["routes/health.ts"]
        I["routes/notme-identity.ts"]
        M["routes/mcp.ts\nMcpEdgeRoute (SSE + JSON-RPC)"]
    end

    subgraph backends ["MCP backends"]
        BI["backends.ts\nToolBackend interface\nJsonRpcInvocationError"]
        BB["backends/bead.ts\nBeadToolBackend"]
        BL["backends/lsp.ts\nLspToolBackend"]
        BF["backends/leyline.ts\nLeylineLifecycleBackend"]
    end

    subgraph durable ["Durable layer"]
        BDO["beads.ts\nBeadStore DO + SQLite schema"]
    end

    IDX --> RR
    IDX --> H
    IDX --> I
    IDX --> M
    M --> BB
    M --> BL
    M --> BF
    BB --> BDO
    BL -.->|HTTP| LLO[(LLO_MCP_URL)]
    BF -.->|HTTP| LLO
```

`router.ts`, `backends.ts`, and the four route/backend modules are the
*entire* abstraction surface. New tenants are new files in `routes/` or
`backends/` plus one line in `index.ts`'s ROUTES table. There is no
plugin loader, manifest, or registry. ADR-0002 details the contract.

## Bead store per repo

Each repo gets its own Durable Object instance, keyed by repo path:

```mermaid
graph LR
    GW["BeadToolBackend"]
    GW -->|idFromName('/repos/rosary')| R["BeadStore\n/repos/rosary\nSQLite: beads, comments"]
    GW -->|idFromName('/repos/mache')| M["BeadStore\n/repos/mache\nSQLite: beads, comments"]
    GW -->|idFromName('/repos/crumb')| C["BeadStore\n/repos/crumb\nSQLite: beads, comments"]
```

Isolation is physical: separate SQLite files, separate DO instances, no
shared state.

## Bindings

Bindings live in two files that must stay in sync — one source of truth for
each launcher:

| Binding            | Type                        | Where                                       | Used by                                        |
| ------------------ | --------------------------- | ------------------------------------------- | ---------------------------------------------- |
| `BEAD_STORE`       | `DurableObjectNamespace`    | `wrangler.toml`, `config.capnp`             | `BeadToolBackend`                              |
| `NOTME`            | `Fetcher` (service binding) | `wrangler.toml`, `config.capnp`             | `NotmeIdentityRoute`                           |
| `LLO_MCP_URL`      | text var                    | `wrangler.toml`, `config.capnp`             | `LspToolBackend`, `LeylineLifecycleBackend`    |
| `ROSARY_MCP_URL`   | text var                    | `wrangler.toml`, `config.capnp`             | (future) rosary passthrough                    |
| `SIGNET_URL`       | text var                    | `wrangler.toml`, `config.capnp`             | (future) signet binding                        |
| `ALLOWED_ORIGINS`  | text var (optional)         | env-only (unset in wrangler/capnp defaults) | `pickAllowedOrigin` in `src/cors.ts`           |

## Packaging (melange + apko)

cloister ships as a **distroless OCI image** built by `task image`. The
recipe lives in `melange.yaml` (APK build) + `apko.yaml` (image compose).

```mermaid
graph TB
    subgraph cloister_pkg ["cloister.tar — apko output"]
        WD["/usr/bin/workerd"]
        JS["/usr/share/cloister/index.js\n(wrangler build output)"]
        CFG["/usr/share/cloister/config.capnp"]
        DATA["/data (volume mount\nfor DO SQLite)"]
        WD --- JS
        WD --- CFG
        WD -.->|reads/writes| DATA
    end

    subgraph rosary_pkg ["rosary apko image (permissive — separate)"]
        RB["rosary binary"]
        GIT["git"]
        DOLT["dolt"]
    end

    subgraph compose ["pod / compose"]
        cloister_pkg -->|ROSARY_MCP_URL| rosary_pkg
    end
```

What `task image` produces:

- workerd binary + the wrangler-built JS bundle + `config.capnp`
- no shell, no package manager, no subprocesses
- runs as `uid 65532` (non-root)
- entrypoint `workerd serve --experimental /usr/share/cloister/config.capnp`
- two architectures: `x86_64` + `aarch64`
- per-origin layering — same upstream packages share a layer, so updates
  pull only the changed layer (~70% smaller deltas)

cloister's security profile is fully hardenable. rosary lives in its own
image because it needs subprocess caps (git, dolt, claude-cli) and writable
volumes.

`task image:check` parses `melange.yaml` + `apko.yaml` end-to-end without
running a real build — useful in CI before bumping versions.

## Security surface

| Layer            | Risk                                | Mitigation                                                |
| ---------------- | ----------------------------------- | --------------------------------------------------------- |
| `POST /mcp`      | Unauthenticated in local dev        | Add notme JWT middleware before prod deploy (ADR-0001 work item) |
| BeadStore SQL    | Parameterized queries throughout    | No injection risk                                         |
| notme proxy      | SSRF?                               | `NOTME` is a service binding (not a user-controlled URL)  |
| LLO HTTP         | SSRF                                | `LLO_MCP_URL` is an env var, not a request param          |
| rosary proxy     | SSRF                                | `ROSARY_MCP_URL` is an env var                            |
| CORS             | `*` in local dev                    | `ALLOWED_ORIGINS` env var enables a literal+`:*`-port allowlist; disallowed origins receive `null` sentinel — see `src/cors.ts` |
| notme vault      | Side channel                        | Vault has no network — only reachable via service binding |
| Container surface| Shell, pkgmgr, root                 | Distroless apko image; no shell, no pkgmgr, runs as uid 65532 |

## Where to next

- Set it up: [../GETTING-STARTED.md](../GETTING-STARTED.md)
- Add a new MCP tool family: see `LspToolBackend` / `LeylineLifecycleBackend`
  for templates, register in `src/index.ts`'s `McpEdgeRoute([...])`
- Add a new HTTP tenant: implement `EdgeRoute`, append to `ROUTES`
- Plugin contract: [../hooks/README.md](../hooks/README.md)
