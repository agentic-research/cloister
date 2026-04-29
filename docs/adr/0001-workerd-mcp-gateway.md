---
title: "ADR-0001: cloister — workerd as portable MCP gateway"
status: Accepted
date: 2026-04-27
tags: [architecture, mcp, workerd, cloudflare, packaging]
---

## Context

The ART ecosystem has multiple tools (rosary, mache, crumb, signet, notme) each exposing
capabilities over different transports. Claude Code and other MCP clients must configure each
tool separately. There is no unified ingress point, no shared identity layer, and no portable
packaging story that works on Mac, Linux, and Cloudflare without code changes.

Two specific pain points:

1. **Multi-tool friction**: adding rosary + mache + crumb to a client requires three separate
   MCP server configs. Each has its own auth story (or none).

2. **Packaging gap**: rosary and mache are Rust/Go binaries. Packaging them for distribution
   via apko/melange requires a build pipeline per language. There is no runtime that handles
   both bead storage and tool routing that can ship as a single reproducible artifact.

Alternatives considered:

- **Native Rust HTTP gateway** (axum): portable binary, but Durable Objects with native SQLite
  are not available — would require a separate SQLite setup and lose the Cloudflare-native
  storage story. No service binding mechanism for collocated identity calls.

- **Go gateway**: same issues as Rust. The ecosystem (CF Workers SDK) is TypeScript-first.

- **WASM in Workers**: Rust/Go compiled to WASM runs in workerd, but Durable Objects with native
  SQLite are not accessible from WASM. Service bindings are partial. The Workers API surface
  is TypeScript-native; WASM is a guest with limited access.

- **Elixir/Phoenix**: the rig/conductor layer already uses Elixir for orchestration. Adding
  it here would introduce a third runtime language in the gateway tier with no clear benefit
  over workerd for this use case.

## Decision

Use **Cloudflare Workers / workerd** (TypeScript) as the MCP gateway layer:

- One Worker (`src/index.ts`) handles all MCP JSON-RPC routing
- `BeadStore` Durable Object with native SQLite stores beads per-repo (one DO instance per repo path)
- notme identity authority wired via service binding (`/identity/*` proxy, zero network hop in prod)
- Non-workerd backends (rosary, signet) reached via HTTP URL env vars (`ROSARY_MCP_URL`, `SIGNET_URL`)
- SSE (`GET /mcp`) uses standard `text/event-stream` framing — cross-language compatible
- `config.capnp` enables `workerd serve` locally without wrangler or Cloudflare account
- Packaged as a minimal apko image: workerd binary + JS bundle + config.capnp

Hardening split: cloister image is fully hardenable (no shell, no subprocesses, read-only FS).
rosary image is a separate package with its own security profile (needs git, dolt, claude-cli).

## Consequences

**Positive:**
- Single MCP endpoint for all tools; clients configure one server
- Identical code path locally (`workerd`) and in production (Cloudflare) — no environment drift
- Durable Objects provide per-repo SQLite with zero infrastructure — no Postgres, no Redis
- notme integration is a service binding (no network latency for identity in prod)
- apko/melange packaging is straightforward: wrangler build → embed in capnp → workerd binary
- Tests run in real workerd via `@cloudflare/vitest-pool-workers` — no mocks for DO or SSE

**Negative / risks:**
- workerd has no support for spawning subprocesses — rosary's subprocess model (git, dolt, claude -p)
  cannot move into cloister; must remain as a separate HTTP backend
- Cloudflare service bindings only work between Workers — signet (Go) and mache (Go) are HTTP proxies,
  not service bindings, which adds latency
- `config.capnp` must be kept in sync with `wrangler.toml` manually — two sources of truth for bindings

## Status update (2026-04-28)

The original "MCP gateway" framing has been superseded by [ADR-0002](0002-edge-router-protocol-agnostic-backends.md),
which reframes cloister as an SSE/HTTP edge router with protocol-agnostic backends.
The packaging and runtime decisions in this ADR remain in force; only the conceptual
shape of "what cloister is" has been generalized. The bullet about routing unknown
tools to rosary is obsolete — tool routing is now explicit per backend, not fall-through.

## Work items

- [x] Wire `lsp_*` and lifecycle ops to ley-line-open via `LLO_MCP_URL` (ADR-0002)
- [x] Ship the `cloister-stale-sync` Claude Code plugin (ADR-0002, hooks/)
- [x] Tighten CORS from `*` — env-driven `ALLOWED_ORIGINS` allowlist with port-`:*`
      glob support, falls back to wildcard for dev (commit `3b4f5e6`, `src/cors.ts`)
- [x] Write `melange.yaml` for cloister package and `apko.yaml` composing the
      distroless OCI image (commit `5843027`, `task apk` / `task image`).
      Note: shipped as a *cloister-only* image, not "cloister + rosary"; the
      composition story lives at deploy time (pod / compose), not in apko.
- [x] End-to-end smoke harness (`scripts/e2e-smoke.sh`, `task smoke`) exercises
      `curl → cloister → leyline` in dev mode (no notme-proxy hop)
- [ ] Add notme JWT auth middleware to `POST /mcp` for production hardening
- [ ] Add `mache_*` tool family as a new `ToolBackend` (proxy to mache HTTP endpoint)
- [ ] Add rosary passthrough as a `ToolBackend` (`rsry_*` → `ROSARY_MCP_URL`)
- [ ] Add signet binding when signet gains an HTTP MCP surface
- ~~Add DoltLite evaluation~~ — superseded by [ADR-0003](0003-content-addressed-bead-store.md):
  the structural answer is a content-addressed DAG + CAS refs, not an embedded DB engine.
  WASM in workerd cannot reach DO native SQLite, so the original premise was unworkable.

## See also

- [ADR-0002](0002-edge-router-protocol-agnostic-backends.md) — current architecture
- [ADR-0003](0003-content-addressed-bead-store.md) — substrate-free bead storage
- [../../README.md](../../README.md) — what cloister exposes today
- [../ARCHITECTURE.md](../ARCHITECTURE.md) — runtime model + diagrams
- [../../GETTING-STARTED.md](../../GETTING-STARTED.md) — hands-on setup
