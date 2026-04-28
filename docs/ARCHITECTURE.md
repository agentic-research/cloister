# Architecture

cloister is a workerd-based MCP gateway. Same TypeScript bundle runs locally via the `workerd` binary and on Cloudflare Workers in production — no code changes, only config differs.

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

The code is identical. Storage differs: local disk vs Cloudflare-managed Durable Object SQLite. Both use the same DO SQL API (`ctx.storage.sql`).

## Request routing

```mermaid
sequenceDiagram
    participant C as MCP Client
    participant GW as Worker (index.ts)
    participant DO as BeadStore DO
    participant NM as notme (identity)
    participant RY as rosary MCP

    C->>GW: POST /mcp {"method":"tools/call","params":{"name":"bead_create",...}}
    GW->>DO: POST internal JSON-RPC (keyed by repo path)
    DO-->>GW: {"id":"abc123","state":"open"}
    GW-->>C: {"content":[{"type":"text","text":"..."}]}

    C->>GW: GET /mcp
    GW-->>C: text/event-stream\ndata: {"protocolVersion":"2024-11-05",...}\n\n
    Note over C,GW: SSE keep-alive: ": ping" every 15s

    C->>GW: POST /mcp {"method":"tools/call","params":{"name":"rsry_decompose",...}}
    GW->>RY: HTTP proxy → ROSARY_MCP_URL
    RY-->>GW: JSON-RPC response
    GW-->>C: forwarded result

    C->>GW: GET /identity/token
    GW->>NM: service binding (no network hop in prod)
    NM-->>GW: JWT
    GW-->>C: JWT
```

## Component map

```mermaid
graph TD
    subgraph cloister ["cloister (src/)"]
        IDX["index.ts\nWorker entry + MCP routing"]
        BDO["beads.ts\nBeadStore Durable Object"]
        TYP["types.ts\nEnv bindings + shared types"]
        IDX --> BDO
        IDX --> TYP
        BDO --> TYP
    end

    subgraph storage ["Storage"]
        SQL["SQLite\nvia ctx.storage.sql\none DB per repo path"]
        BDO --> SQL
    end

    subgraph bindings ["Bindings (wrangler.toml / config.capnp)"]
        BSTORE["BEAD_STORE\nDurableObjectNamespace"]
        NOTME_B["NOTME\nFetcher (service binding)"]
        RURL["ROSARY_MCP_URL\ntext var"]
        SURL["SIGNET_URL\ntext var"]
    end

    IDX --> BSTORE
    IDX --> NOTME_B
    IDX --> RURL
    IDX --> SURL
```

## Bead store per repo

Each repo gets its own Durable Object instance, keyed by repo path:

```mermaid
graph LR
    GW["Gateway"]
    GW -->|idFromName('/repos/rosary')| R["BeadStore\n/repos/rosary\nSQLite: beads, comments"]
    GW -->|idFromName('/repos/mache')| M["BeadStore\n/repos/mache\nSQLite: beads, comments"]
    GW -->|idFromName('/repos/crumb')| C["BeadStore\n/repos/crumb\nSQLite: beads, comments"]
```

Isolation is physical: separate SQLite files, separate DO instances, no shared state.

## SSE (Server-Sent Events)

```mermaid
sequenceDiagram
    participant C as Any SSE client (browser, Python, Go, Rust)
    participant GW as Worker GET /mcp

    C->>GW: GET /mcp
    GW-->>C: HTTP 200\nContent-Type: text/event-stream\nCache-Control: no-cache

    GW-->>C: data: {"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2024-11-05"}}\n\n
    Note over GW,C: standard W3C SSE — no MCP-specific framing

    loop every 15s
        GW-->>C: : ping\n\n
        Note over GW,C: comment line — proxies don't close idle connections
    end
```

SSE uses `ReadableStream<Uint8Array>` with standard `data: ...\n\n` framing. Any language's EventSource implementation works without MCP-specific libraries.

## Packaging (melange + apko)

cloister and rosary have different security profiles and are packaged separately:

```mermaid
graph TB
    subgraph cloister_pkg ["cloister apko image (minimal)"]
        WD["workerd binary"]
        JS["dist/index.js\n(wrangler build output)"]
        CFG["config.capnp"]
        WD --- JS
        WD --- CFG
    end

    subgraph rosary_pkg ["rosary apko image (permissive)"]
        RB["rosary binary\n(cargo build --release)"]
        GIT["git"]
        DOLT["dolt"]
    end

    subgraph compose ["pod / compose"]
        cloister_pkg -->|ROSARY_MCP_URL=http://localhost:8383/mcp| rosary_pkg
    end
```

cloister: no shell, no subprocesses, non-root, read-only FS — fully hardenable.
rosary: needs subprocess caps (git, dolt, claude-cli), writable volumes — separate profile.

## Non-workerd backends

Services that don't run in workerd are reached via HTTP URL env vars:

| Var | Service | Notes |
|-----|---------|-------|
| `ROSARY_MCP_URL` | rosary (Rust) | Orchestration, decompose, dispatch |
| `SIGNET_URL` | signet (Go) | Key exchange — not yet deployed |

`ley-line-open` is a Rust library, not a service — linked into rosary, not proxied.

## Security surface

| Layer | Risk | Mitigation |
|-------|------|-----------|
| MCP endpoint | Unauthenticated in local dev | Add notme JWT middleware before prod deploy |
| BeadStore SQL | Parameterized queries throughout | No injection risk |
| notme proxy | SSRF? | NOTME is a service binding (not user-controlled URL) |
| rosary proxy | SSRF | ROSARY_MCP_URL is an env var, not a request param |
| CORS | `*` in local dev | Tighten to specific origins before prod |
