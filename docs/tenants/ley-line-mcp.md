# ley-line-mcp

The lifecycle tools (`reparse`, `enrich`, `status`) sit alongside
[lsp-mcp](lsp-mcp.md) on the same upstream daemon
([ley-line-open](https://github.com/jamestexas/ley-line-open)). They
control the daemon itself rather than the source tree it indexes:

- `reparse` — re-run tree-sitter parsing over the source tree (or a single file)
- `enrich` — run an enrichment pass (e.g. `lsp`, `embed`) optionally scoped to specific files
- `status` — daemon phase, head SHA, last reparse timestamp, per-pass enrichment progress

This is the **only MCP backend in the manifest with empty
`handlesPrefix`** — the upstream daemon exposes them as bare names
without a prefix, so cloister forwards them verbatim. Schemas live in
[`src/tool-schemas/lifecycle.ts`](../../src/tool-schemas/lifecycle.ts).

## Wire (current as of 2026-05-12; see [`cloister.capnp`](../../cloister.capnp) for source of truth)

```capnp
( name          = "leyline-lifecycle",
  handlesPrefix = "",                            # exact-match dispatch
  kind = (mcpProxy = (
    urlBinding     = "LLO_MCP_URL",
    serviceBinding = "LSP_MCP",                  # same upstream as `lsp_*`
    tools = [
      ( name = "reparse", description = "...", inputSchemaJson = "" ),
      ( name = "enrich",  description = "...", inputSchemaJson = "" ),
      ( name = "status",  description = "...", inputSchemaJson = "" ),
    ],
  )),
),
```

Exact-match (empty `handlesPrefix`) means cloister checks `bead_*` and
`lsp_*` prefixes first; only if none match does it consider these
exact names. Two backends sharing a prefix is a build error — and the
empty prefix only collides with another empty prefix, of which there
can be only one.

## Required bindings

Identical to [lsp-mcp](lsp-mcp.md) — same upstream daemon.

| Binding | Kind | Where | Purpose |
|---|---|---|---|
| `LSP_MCP` | `service = "llo-mcp"` | [`config.capnp`](../../config.capnp) | workerd Service binding to LLO daemon |
| `LLO_MCP_URL` | `text = "http://localhost:8384/mcp"` | [`config.capnp`](../../config.capnp) | CF-prod fallback URL |

Empty `LLO_MCP_URL` disables both `lsp_*` and these lifecycle tools.

## Version pin

Same as [lsp-mcp](lsp-mcp.md): ley-line-open is not currently in
[`cluster.compose.yaml`](../../cluster.compose.yaml). Floats with the
LLO binary on the dev box.

## Upstream project

- Repo: [github.com/jamestexas/ley-line-open](https://github.com/jamestexas/ley-line-open)
- Process: the LLO daemon on port `:8384`

## Auth

Same lease-gating posture as every MCP tenant — gate is on cloister's
`/mcp` endpoint, not on the upstream daemon.

## Cross-references

- Companion tenant: [lsp-mcp](lsp-mcp.md) (same upstream, `lsp_*` prefix)
- [ADR-0004](../adr/0004-capnp-manifest.md) — the manifest schema
- [ADR-0005](../adr/0005-internal-wire-leyline-net.md) — note: `leyline-net` (the wire) is **different** from this `leyline-lifecycle` tenant. The wire is for the future cloister-companion seam (rsry, signet); these lifecycle methods are HTTP `mcpProxy` to the local LLO daemon. The naming overlap is unfortunate.
- [ADR-0015](../adr/0015-mcp-spec-alignment.md) — Phase 1 rename `httpForward` → `mcpProxy`
