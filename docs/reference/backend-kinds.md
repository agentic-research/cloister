# Backend kinds — reference

The canonical enumeration of `Backend.kind` variants in
[`cloister.capnp`](../../cloister.capnp). Every backend an operator
can declare in a manifest is one of these five.

**This is the source of truth for the enum, the per-kind shape, and
the ADR each is anchored to.** When other docs need to mention which
backend kinds exist, they link here rather than enumerate (the bug
that prompted `cloister-9d4555` was the enumeration drifting across
5+ files; this page is the convergence point).

For the per-file implementation map (which `.ts` file implements
which `kind`) see
[`src/manifest/backends/README.md`](../../src/manifest/backends/README.md).
For the schema decisions behind the kind-typed shape see
[ADR-0002](../adr/0002-edge-router-protocol-agnostic-backends.md) and
[ADR-0004](../adr/0004-capnp-manifest.md).

## The five kinds

| `kind` | Transport | One-line purpose | Anchor ADR | Use when |
|---|---|---|---|---|
| **`durableObject`** | DO RPC | Forward `tools/call` to a Durable Object derived from a key argument (`repo`, `session_id`, …). Per-key durable state. | [ADR-0012](../adr/0012-truststore-vs-beadstore.md) | The tool's state has to survive Worker restarts AND is partitioned by a caller-supplied key. BeadStore is the canonical example. |
| **`mcpProxy`** | HTTP `fetch` | POST `tools/call` JSON-RPC to an upstream MCP HTTP endpoint. Supports the MCP Streamable HTTP session handshake (`requiresSession`) and ADR-0006 derived tools (`dynamicTools`). | [ADR-0002](../adr/0002-edge-router-protocol-agnostic-backends.md) + [ADR-0015](../adr/0015-mcp-spec-alignment.md) | The upstream tool is itself an MCP server reachable over HTTP — including `mache`, `ley-line-open`, and any operator-declared external MCP. The post-ADR-0015 rename: the legacy `httpForward` ordinal still parses for migration, but new manifests use `mcpProxy`. |
| **`serviceBinding`** | workerd `Fetcher` | Same wire shape as `mcpProxy` but the upstream is another Worker exposed as a [service binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/). No network hop. | [ADR-0002](../adr/0002-edge-router-protocol-agnostic-backends.md) | The upstream Worker is co-located in the same cluster / pod. `notme-identity` and the planned in-cluster tool bundles are the targets. |
| **`udsForward`** | capnp over loopback HTTP → `cloister-companion` → UDS | Workerd cannot dial `AF_UNIX` directly; the request is wrapped as a capnp `ToolCall`, POSTed to companion with `X-Cloister-Transport: uds` + `X-Cloister-Socket-Path`, and companion opens the UDS. | [ADR-0005](../adr/0005-internal-wire-leyline-net.md) (amendment 2026-04-30) | The upstream tool runs as a host-side process reachable only via a Unix domain socket — operator development setups, `mache` running locally outside workerd, etc. |
| **`leylineNet`** | capnp over loopback HTTP → `cloister-companion` | Cloister↔companion IPC seam. Encodes `ToolCall` via `src/wire/tool-call.ts`, POSTs to `env[companionUrlBinding]`, decodes `ToolResult` via `src/wire/tool-result.ts`. AEAD / signing live at companion's egress face. | [ADR-0005](../adr/0005-internal-wire-leyline-net.md) | The upstream tool is reached via the companion's Rust-side network stack — for off-platform peers (`rsry` cluster-wide, signed cross-network calls) and anything that needs companion-side trust mediation. |

## Where the kind is declared

Three matched declarations on every backend:

1. **Schema** — `Backend.kind` `:union` variant in
   [`manifest/cloister.capnp`](../../manifest/cloister.capnp).
   Ordinals are append-only; never renumber. The legacy `httpForward`
   variant `@3` still parses; new manifests use `mcpProxy` `@7`
   ([ADR-0015](../adr/0015-mcp-spec-alignment.md)).

2. **TypeScript mirror** — discriminated union in
   [`src/manifest/types.ts`](../../src/manifest/types.ts).

3. **Runtime branch** — switch in
   [`src/manifest/runtime.ts`](../../src/manifest/runtime.ts) that
   instantiates one of the `ToolBackend` classes in
   [`src/manifest/backends/`](../../src/manifest/backends/).

Adding a new kind is a three-file commit per the contract in
[`manifest/README.md`](../../manifest/README.md). Bumping the
canonical enum here is the fourth step.

## When this list changes

If you add or remove a `Backend.kind` ordinal in
[`manifest/cloister.capnp`](../../manifest/cloister.capnp), update
the table above. Other docs that mention which kinds exist link
to this page; they don't need to know.

For routes (the `Route.kind` union — `mcp`, `disclosure`,
`wellKnown`, etc.) see the per-route docs under
[`docs/tenants/`](../tenants/README.md).
