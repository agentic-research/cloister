# lsp-mcp

The `lsp_*` tools surface position-based LSP operations (hover,
definitions, references, document symbols, diagnostics) over MCP. The
upstream is the **ley-line-open daemon** — an LSP-aware indexer that
keeps a structural projection of the source tree warm.

Unlike `mache_*` (which uses Derived schemas), `lsp_*` ships a fixed
**Asserted** catalog of five tools. Schemas live in
[`src/tool-schemas/lsp.ts`](../../src/tool-schemas/lsp.ts) and are
injected by the build at codegen time.

## Wire (current as of 2026-05-12; see [`cloister.capnp`](../../cloister.capnp) for source of truth)

```capnp
( name          = "lsp",
  handlesPrefix = "lsp_",
  kind = (mcpProxy = (
    urlBinding     = "LLO_MCP_URL",
    serviceBinding = "LSP_MCP",
    tools = [
      ( name = "lsp_hover",        description = "...", inputSchemaJson = "" ),
      ( name = "lsp_defs",         description = "...", inputSchemaJson = "" ),
      ( name = "lsp_refs",         description = "...", inputSchemaJson = "" ),
      ( name = "lsp_symbols",      description = "...", inputSchemaJson = "" ),
      ( name = "lsp_diagnostics",  description = "...", inputSchemaJson = "" ),
    ],
  )),
),
```

No `stripPrefix` — the upstream LLO daemon already names its tools
`lsp_*`, so cloister forwards the names verbatim. No `requiresSession`
— the LLO daemon is genuinely stateless.

## Required bindings

| Binding | Kind | Where | Purpose |
|---|---|---|---|
| `LSP_MCP` | `service = "llo-mcp"` | [`config.capnp`](../../config.capnp) | workerd Service binding; preferred locally — terminates at the LLO daemon's HTTP listener |
| `LLO_MCP_URL` | `text = "http://localhost:8384/mcp"` | [`config.capnp`](../../config.capnp) | CF-prod fallback. Empty value disables both `lsp_*` and the [ley-line-mcp](ley-line-mcp.md) lifecycle tenant |

Both tenants share the same upstream daemon — `lsp_*` (Asserted
catalog) and [ley-line-mcp](ley-line-mcp.md) (`reparse` / `enrich` /
`status`, exact-match) both route through `LSP_MCP` / `LLO_MCP_URL`.

## Version pin

`ley-line-open` is not currently in
[`cluster.compose.yaml`](../../cluster.compose.yaml) as a sibling
container — the standard ART cluster runs LLO as a separate process on
the host (port `:8384` by default). Pin floats with whatever
`ley-line-open` binary is on the dev box's PATH. ADR-0009 phase 2
(`ley-line-open` as an apko-built sibling image) will give it a pin
in compose.

## Upstream project

- Repo: [github.com/agentic-research/ley-line-open](https://github.com/agentic-research/ley-line-open) (the open subset of `ley-line`; raptorq + sqlite-blast stay closed per ADR-0005)
- Process: the LLO daemon (`llod` or equivalent) on port `:8384`
- Transport: MCP JSON-RPC over HTTP (no session, no `text/event-stream` SSE needed)

## Auth

Lease-gated at cloister's `/mcp` endpoint per the standard MCP-tenant
posture; the LLO daemon itself trusts loopback. Same V8-isolate +
Service-binding-as-syscall containment as every cluster-tier upstream
(ADR-0013).

## Cross-references

- [ADR-0002](../adr/0002-edge-router-protocol-agnostic-backends.md) — `HttpForwardToolBackend` was the original shape
- [ADR-0004](../adr/0004-capnp-manifest.md) — the manifest schema
- [ADR-0011](../adr/0011-hypervisor-bundle-boundary.md) — LLO is cluster-tier
- [ADR-0013](../adr/0013-slice-grant-enforcement.md) — Service-binding isolation
- [ADR-0015](../adr/0015-mcp-spec-alignment.md) — Phase 1 rename `httpForward` → `mcpProxy`
- Companion tenant: [ley-line-mcp](ley-line-mcp.md) (same upstream, different prefix)
