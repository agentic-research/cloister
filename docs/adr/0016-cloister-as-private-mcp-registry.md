---
title: "ADR-0016: cloister as a private MCP Registry"
status: Accepted (2026-05-11)
date: 2026-05-11
tags: [architecture, mcp, spec, registry, discovery, manifest]
decade: interlace-substrate
thread: mcp-spec-alignment
relates_to:
  - 0001-workerd-mcp-gateway.md
  - 0002-edge-router-protocol-agnostic-backends.md
  - 0006-derived-tool-schemas.md
  - 0015-mcp-spec-alignment.md
sep_draft: docs/mcp-seps/SEP-XXXX-mcp-proxy-server-formalization.md
bead: cloister-a30e40
---

## Context

Phase 3 of the MCP spec-alignment arc (per ADR-0015). The
[MCP Registry](https://modelcontextprotocol.io/registry/about) is the
ecosystem's official discovery layer for MCP servers — a centralized
metadata repository keyed by a reverse-DNS namespace, exposed under a
[published OpenAPI spec](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/api/openapi.yaml).
The public registry is one implementation; the OpenAPI spec is
explicitly written so other registries — including private ones — can
implement the same shape and be consumed by the same host tooling:

> In addition to a public REST API, the MCP Registry defines an OpenAPI
> spec that other MCP registries can implement in order to provide a
> standardized interface for MCP host applications. … Private MCP
> registries can implement it as well to benefit from existing host
> application support.
>
> — modelcontextprotocol.io/registry/about

Cloister already declares its full upstream catalog in `cloister.capnp`:
the manifest enumerates every backend (mache, ley-line-open lsp,
rosary, …) with its tool list, prefix, and transport. That is exactly
the information an MCP Registry surfaces — just in a different
serialization. Surfacing the manifest under the Registry shape is
structurally free: one URLPattern + a synthesis function.

## Decision

Cloister implements the MCP Registry OpenAPI v0.1 server-discovery
surface as a new well-known route kind, `wellKnownMcpRegistry`:

```
GET /.well-known/mcp-registry/v0.1/servers          # list
GET /.well-known/mcp-registry/v0.1/servers/{name}   # detail
```

Both endpoints return server.json envelopes matching the spec's
[server.schema.json draft](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/draft/server.schema.json):
`name`, `description`, `version`, `repository`, `remotes`, plus an
`_meta` envelope under the `io.modelcontextprotocol.registry/official`
namespace key the spec reserves.

The catalog is synthesized from the manifest's mcp routes at request
time. One server.json per externally-shaped backend:

| Backend kind | Included? | Why |
|---|---|---|
| `httpForward` | Yes | Real upstream URL — consumers could call directly given the right network placement |
| `leylineNet` | Yes | Same — companion-mediated but addressable |
| `durableObject` | No | Intra-cluster compute. Not an MCP server in the spec's sense |
| `serviceBinding` | No | Workerd Fetcher binding. Not addressable as an MCP server |
| `udsForward` | No | Loopback socket; not externally-discoverable |

### Naming convention

Reverse-DNS per the Registry spec's namespace rules:
`art.agentic-research/cloister/<backend-id>`. The two segments encode:

- **`art.agentic-research`** — the umbrella organization namespace. Once
  ART's GitHub org has DNS verification with the public registry, this
  becomes the verifiable owner of all `art.agentic-research/*` names.
- **`cloister`** — the routing fabric. Distinguishes upstreams reached
  through this proxy from the same upstream's direct registration.
- **`<backend-id>`** — the manifest's `Backend.name` field. Stable
  across minor reconfigs per the manifest's contract.

### Path prefix divergence

The official registry serves `/v0.1/servers` at the host root.
Cloister mounts under `/.well-known/mcp-registry/v0.1/...` because:

1. `/v0.1/` at the root would collide with any future versioned API
   cloister exposes (the OCI registry already takes `/v2/` because
   that's the OCI spec's mandated path).
2. `.well-known/` is the IANA-reserved space for metadata endpoints
   ([RFC 8615](https://datatracker.ietf.org/doc/html/rfc8615)).
   Co-locating with `/.well-known/interlace/index.json` and the
   `/.well-known/openid-configuration` family makes the registry
   discoverable through the same conventions consumers already use.

The OpenAPI *shape* (envelope, fields, pagination) is preserved
verbatim — only the path prefix differs. Consumers that parameterize
the base URL (which the OpenAPI spec encourages via its `servers:`
block) work without modification.

### Read-only in this phase

Phase 3 implements the read path only. Deferred:

- **`POST /v0.1/publish`** — would let external publishers register
  servers under cloister's namespace. Requires verification machinery
  (DNS challenge / GitHub OAuth) that cloister doesn't host.
- **Version history endpoints** (`/v0.1/servers/{name}/versions`,
  `/versions/{version}`, status endpoints). Cloister upstreams aren't
  independently versioned today — each backend's version is whatever
  the upstream reports through `tools/list` (per ADR-0006). Wiring
  per-upstream versioning is a separate bead.
- **Namespace verification.** No DNS-challenge / GitHub-OAuth wiring.
  Names are asserted by the manifest, trusted because the manifest
  itself is build-time-pinned per ADR-0004.
- **Search query parameter** on the list endpoint. Bounded catalog
  (≤20 entries) — client-side filtering is sufficient until catalog
  size justifies wiring.

## Distinction from `proxy/upstreams`

The SEP draft at `docs/mcp-seps/SEP-XXXX-mcp-proxy-server-formalization.md`
proposes a `proxy/upstreams` MCP RPC for proxy-specific introspection.
Both surfaces can and should coexist; they answer different questions:

| Surface | Question | Caller |
|---|---|---|
| `GET /.well-known/mcp-registry/v0.1/servers` | "What MCP servers are discoverable at this host?" | Host application / registry aggregator |
| `proxy/upstreams` RPC | "What upstream surface is this proxy aggregating, and what's each upstream's per-call state?" | MCP client of *this* proxy server |

The Registry surface is per-named-server discovery — every entry
should make sense to a host that doesn't know cloister is a proxy.
`proxy/upstreams` is proxy-aware: it returns aggregated state (per-
upstream latency, lifecycle phase, fallback status) that only matters
once the client has accepted cloister-as-proxy. The two surfaces
share data (both list cloister's upstreams) but serve different
consumer roles.

If a host treats cloister as a regular MCP server (no `proxy`
capability awareness), the Registry surface still gives it the
discovery benefit. If a host *is* proxy-aware, it can use
`proxy/upstreams` for richer state and use the Registry for the
canonical per-server `server.json` envelope.

## Consequences

**Positive:**

- Host applications that already consume an MCP Registry can discover
  cloister's tenants the standard way. No cloister-specific client
  code path.
- Aggregators that pull metadata from registries on a schedule (per
  the Registry docs: "once per hour") can include private cloister
  deployments alongside the public registry without bespoke
  integration.
- The Registry shape is stable across the SEP-2575 + SEP-2567
  transition (ADR-0015 Phase 2): the discovery surface is
  orthogonal to the lifecycle protocol the discovered server speaks.
  Phase 2's protocol changes do not affect the Registry response.
- Establishes the precedent that cloister's well-known surface is the
  meeting point with the broader spec ecosystem. The next ADR adding
  another spec-mandated discovery doc (MCP Marketplaces, future
  Registry write APIs) lands in the same pattern.

**Negative / risks:**

- The spec is in preview (per the modelcontextprotocol.io Note: "The
  MCP Registry is currently in preview. Breaking changes or data
  resets may occur before general availability"). Field renames or
  envelope shape changes upstream will need a corresponding cloister
  update. Mitigation: the synthesis function (`synthesizeAll`) is a
  single point of edit; the route is thin.
- The version field is a `"0.0.0"` placeholder pending per-upstream
  version wiring. Consumers that gate on version will see all
  cloister upstreams as "the same version" until that wiring lands.
  Mitigation: documented in code + the docs/integration/mcp-client.md
  registry-discovery section.
- The path-prefix divergence (`/.well-known/mcp-registry/v0.1/`
  instead of `/v0.1/`) is non-standard. Mitigation: the OpenAPI
  spec's `servers:` block is designed for exactly this; clients
  parameterize the base URL.

**Cost:**

- One new route kind + one new route handler + one ADR. Bounded.
- The synthesis function reads only the manifest — no DO RPC, no
  env lookups, no cache invalidation. Lowest-complexity route in
  the codebase.

## Alternatives considered

### Surface the catalog only through the existing Interlace discovery doc

`/.well-known/interlace/index.json` already aggregates cloister's
capabilities. We could expand its `capabilities` block to include
upstream metadata, instead of standing up a separate Registry surface.

**Rejected** because:

1. The Interlace discovery doc is for *peers in the trust mesh* (per
   ADR-0007 §4.1). MCP Registry consumers are host applications that
   may have no Interlace relationship with cloister at all. Mixing
   the two audiences in one doc forces consumers to filter.
2. The two docs have different cache shapes: Interlace identity
   rarely changes; the upstream catalog changes whenever the manifest
   updates. Separate ETags / cache windows are cleaner.
3. The OpenAPI compatibility benefit is lost. A host that already
   knows how to consume an MCP Registry can't use the Interlace doc;
   it'd need a cloister-specific parser.

### Implement the write surface (`/publish`) in Phase 3

Add the publish endpoint now so external services can register
themselves under cloister's namespace.

**Rejected** because:

1. The write path requires the verification machinery (DNS challenge,
   GitHub OAuth) — both substantial additions, both orthogonal to
   the read-discovery benefit. Independently valuable beads.
2. Cloister's `cloister.capnp` is build-time-pinned per ADR-0004.
   Accepting external publish-time additions would either bypass
   the manifest (breaking ADR-0004) or require a manifest
   re-emission pipeline (a different ADR's territory).
3. The read surface is the load-bearing one for ecosystem
   citizenship. Write is a follow-up.

### Mount at `/registry/...` instead of `/.well-known/mcp-registry/...`

Skip the `.well-known/` prefix; use a shorter `/registry/v0.1/...`.

**Rejected** because:

1. `.well-known/` is the IANA-reserved space for metadata endpoints
   (RFC 8615). Discovery endpoints belong there as a matter of
   convention.
2. `/registry/` could plausibly collide with a future registry-like
   thing (a code registry, a vault-slice registry). Reserving the
   short-name namespace for things that aren't conventionally under
   `.well-known/` is the right discipline.

## Cross-references

- [ADR-0015](0015-mcp-spec-alignment.md) — the multi-phase MCP
  spec-alignment arc. This ADR ratifies Phase 3.
- [ADR-0001](0001-workerd-mcp-gateway.md) — original MCP gateway
  framing.
- [ADR-0002](0002-edge-router-protocol-agnostic-backends.md) — the
  protocol-agnostic seam that lets a metadata route coexist with
  `/mcp` and `/v2/`.
- [ADR-0004](0004-capnp-manifest.md) — manifest as build-time
  contract; the catalog this Registry surface exposes.
- [ADR-0006](0006-derived-tool-schemas.md) — dynamic tools/list
  semantics. Drives the "we don't know upstream version" footnote
  on the placeholder version field.
- [ADR-0007](0007-interlace-substrate.md) — Interlace discovery doc.
  The "peer discovery vs registry discovery" distinction this ADR
  draws from.
- `docs/mcp-seps/SEP-XXXX-mcp-proxy-server-formalization.md` — the
  SEP draft proposing `proxy/upstreams`. Distinct surface, same
  underlying data.
- `cloister-a30e40` — Phase 3 deliverable bead.

## What this ADR does NOT decide

- **Whether `proxy/upstreams` lands** — that's a separate Phase
  decision tied to the SEP submission timeline.
- **The exact wire shape of future write endpoints**. Reserved for
  the bead that adds `/publish`.
- **Whether to register `art.agentic-research/cloister/*` names
  with the public registry**. Operational decision, not an
  architecture one. Separate bead if/when.
- **Pagination cursor format**. `nextCursor: null` today; format is
  unconstrained when real pagination lands. Whatever it is should
  be opaque to consumers per the OpenAPI spec's convention.
