---
title: "ADR-0006: Tool schemas as Derived evidence — dynamic tools/list passthrough with TTL cache"
status: Accepted
date: 2026-04-30
tags: [architecture, manifest, mcp, schema, caching, evidence]
supersedes_framing: [ADR-0004 §"manifest is source of truth for tool schemas"]
---

## Context

ADR-0004 declared the capnp manifest the source of truth for the gateway's
route table *and* the tool schemas it advertises. Each `httpForward` backend
hand-curates an `inputSchemaJson` blob per tool, copy-pasted from upstream
docs and frozen at build time.

That worked when cloister fronted three backends with stable schemas
(`bead_*` over a DO, `lsp_*` over LLO, the LLO lifecycle trio). It does not
scale. The constellation has more upstreams arriving — `mache` (~17 tools),
`rsry` (eventually 30+), eventual `crumb`, `signet` — and each upstream
already exposes its full schema via MCP `tools/list`. Hand-curating the same
JSON Schema in the manifest is:

1. **Drift-prone.** When mache adds a tool or changes a parameter, cloister's
   advertised schema lies until someone notices and edits the manifest.
2. **Not type-safe in the way ADR-0004 promised.** The `inputSchemaJson`
   field is a `Text`. The build validates it parses as JSON; nothing
   validates it matches what the upstream actually accepts.
3. **Non-composable.** A "fan out from one schema" pipeline (capnp → Zod →
   OpenAPI → MCP `tools/list`) can't include backends whose schemas live in
   another repo's Go source. The manifest becomes a hand-merged digest
   instead of a derivable artifact.

The fix is structural: stop treating tool schemas as *Asserted* facts in the
manifest. Treat them as **Derived evidence** sourced from the upstream MCP
backend at observation time, cached with a TTL, and (eventually) signed for
provenance. The manifest still asserts *which backend handles which prefix*;
it stops asserting *what tools that backend exposes*.

## Decision

Add two fields to `HttpForwardBackend` (manifest/cloister.capnp):

```capnp
struct HttpForwardBackend {
  urlBinding   @0 :Text;
  tools        @1 :List(McpTool);   # Asserted catalog (used when dynamicTools=false)
  dynamicTools @2 :Bool;             # NEW: fetch tools/list from upstream
  stripPrefix  @3 :Text;             # NEW: prefix to strip on tools/call forward
}
```

Semantics:

- **`dynamicTools = false` (default).** Existing behavior. The `tools` field
  is the catalog. Asserted evidence — drift is the consumer's problem.
- **`dynamicTools = true`.** On the first `tools/list` request the backend
  POSTs `tools/list` to `urlBinding`'s URL. Each returned tool is advertised
  as `${handlesPrefix}${upstream_name}`. Result is cached with a 60-second
  TTL; concurrent first-fetches share one inflight Promise.
- **`stripPrefix`.** Applied to tool names before forwarding `tools/call`.
  For mache: advertised `mache_get_overview` → wire `get_overview`. For LLO
  whose upstream already prefixes with `lsp_`, leave `stripPrefix = ""`.

Modal calculus (matching the rosary modal-evidence frame):

| Mode | Source | Lifetime |
|------|--------|----------|
| **Asserted** | Hand-written `tools` list | Until manifest rebuild |
| **Derived** | Upstream `tools/list` response | Cached for TTL window |
| **Stale** (future) | Cache expired, refresh failed | Surfaces as `schema-pending` diagnostic |

When both are present (a backend with `dynamicTools = true` *and* a non-empty
`tools` list), Asserted overrides Derived for the named tool — the manifest
can pin a known-good schema even when upstream is unreachable, and the
Derived set extends rather than replaces.

## Cache shape

In-memory per worker, keyed by URL value (not by binding name — two backends
sharing `MACHE_MCP_URL` share a cache slot, which is correct):

```ts
type CachedManifest = {
  toolsByName: Map<string, McpTool>;  // upstream_name → tool (no prefix)
  fetchedAt:   number;                 // ms epoch
  contentHash: string;                 // sha256 of canonical JSON, future signing key
};
```

Workerd workers are short-lived; cache state does not survive worker
recycling. That is a feature: stale cache cannot outlive a deploy, and a
60-second TTL bounds drift within a worker generation.

The `contentHash` is computed but unused in this ADR — it reserves the
shape for the signing pass that lands once notme JWT (`cloister-825590`)
ships and a `signed-by-cloister` token can wrap the cached manifest.

## Failure modes and mitigations

- **Upstream down on first call.** `tools/list` fails; if `tools` is
  non-empty (Asserted catalog), advertise that. Otherwise advertise empty
  list and surface a `-32603` for `tools/call` against this backend until
  cache populates.
- **Schema drift mid-TTL.** Upstream changes a param shape; cloister
  advertises stale shape for up to 60s. Acceptable: agents calling with the
  new param get a `-32602`-shaped error from upstream which surfaces
  unchanged. The `schema-pending` diagnostic path is reserved for the
  signing pass.
- **Concurrent first-fetch thundering herd.** Single inflight Promise per
  cache slot; secondary callers await the same fetch. Standard pattern.
- **Tool name collision with another backend.** Build-time validator in
  `scripts/build-manifest.mjs` already rejects duplicate tool names across
  backends; with `dynamicTools = true` we cannot validate at build time
  because the catalog is unknown. Runtime aggregation in `McpEdgeRoute`
  must detect collision and prefer the first-registered backend (matching
  current ordering semantics).

## What this enables

- Adding `mache` as a backend becomes one capnp entry plus a binding —
  no copy-paste of 17 schemas. Same for future `crumb`, `signet`, third-party.
- The capnp+zod+OpenAPI fan-out pipeline (math-friend's morphism graph)
  becomes uniform: every backend's schemas come from *its own* type system
  through `tools/list`, not from a hand-merged manifest.
- The signing pass (future) attaches notme provenance to the cached manifest
  hash. Downstream verifiers check the signature once per TTL window;
  individual `tools/call` requests don't pay the verification cost.

## What this does not change

- ADR-0004's claim that the *route table* is manifest-asserted stands. This
  ADR scopes specifically to the per-backend tool catalog.
- `durableObject` and `serviceBinding` backends remain Asserted-only —
  they speak directly to local code whose schemas live in the same repo.
  Dynamic discovery is for upstream MCP servers, not in-process bindings.
- The static-tools path (`dynamicTools = false`) is unchanged. Existing
  backends continue to work without edits.

## Implementation status

Phase 1 (this ADR + initial impl, cloister-827d62):

- [x] Schema additions (`manifest/cloister.capnp`)
- [x] Runtime impl in `src/manifest/backends/http-forward.ts`
- [x] Tests in `test/manifest/http-forward-dynamic.test.ts`
- [x] mache wired up via `cloister.capnp` + `MACHE_MCP_URL` binding
- [x] e2e smoke spawns real mache, asserts `mache_*` round-trip

Phase 2 (deferred; requires notme JWT, cloister-825590):

- [ ] Sign the cached manifest hash with notme keys
- [ ] Surface a `schema-pending` diagnostic when cache refresh fails after expiry
- [ ] Verifiable provenance receipt attached to `tools/list` responses
