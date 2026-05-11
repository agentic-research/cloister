---
title: "ADR-0015: MCP spec alignment — cloister formally adopts the MCP-Proxy-Server framing"
status: Accepted (2026-05-11)
date: 2026-05-11
tags: [architecture, mcp, spec, proxy, registry, lifecycle, manifest]
supersedes_framing: [ADR-0001 §"MCP gateway", ADR-0002 §"httpForward backend kind framing"]
decade: interlace-substrate
thread: mcp-spec-alignment
relates_to:
  - 0001-workerd-mcp-gateway.md
  - 0002-edge-router-protocol-agnostic-backends.md
  - 0006-derived-tool-schemas.md
  - 0007-interlace-substrate.md
sep_draft: docs/mcp-seps/SEP-XXXX-mcp-proxy-server-formalization.md
---

## Context

The Model Context Protocol (MCP) specification at
[modelcontextprotocol.io/specification](https://modelcontextprotocol.io/specification/2025-11-25)
defines three participant types: **Host** (the agent application), **Client**
(the host-side connector that speaks to one server), and **Server** (the
process that exposes tools/resources/prompts). The
[Security Best Practices](https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices)
document additionally names a fourth recurring pattern — **MCP Proxy Server**:

> An MCP server that connects MCP clients to third-party APIs, offering MCP
> features while delegating operations and acting as a single OAuth client
> to the third-party API server.

That document assigns **normative obligations** to MCP Proxy Servers:

1. MUST implement per-client consent before forwarding to a third-party
   authorization server (confused-deputy mitigation).
2. MUST NOT accept tokens not explicitly issued for the MCP server
   (token-passthrough prohibition).
3. MUST validate `redirect_uri` against the registered value.

But the **data-layer** specification has no construct for declaring proxy
status, advertising an aggregated upstream surface, or negotiating
proxy-specific capabilities. A proxy is treated as an undifferentiated
server.

### Where cloister fits

Cloister is *all four* participant types at different layers:

| Layer | MCP role | Notes |
|---|---|---|
| Public face (`POST /mcp`, `GET /mcp` SSE) | **Server** to external Hosts/Clients (Claude Code, agents) | Per ADR-0001/0002 |
| Internal aggregation (composition of mache, rosary, signet, …) | **Proxy Server** per Security Best Practices | Manifest declares upstreams; cloister forwards `tools/call` |
| Upstream connections (HTTP POST to mache, rosary, …) | **Client** to those upstreams | Currently spec-incomplete — see below |
| Operator deployment (workerd as host runtime) | **Host** equivalent for the bundle isolates it loads | Per ADR-0011/0013 |

The Proxy and Client roles are where cloister is currently spec-incomplete.

## The conflation problem

`cloister.capnp` declares upstream backends as:

```capnp
struct HttpForwardBackend {
  urlBinding @0 :Text;
  tools @1 :List(ToolSpec);
  dynamicTools @2 :Bool;
  stripPrefix @3 :Text;
  requiresSession @4 :Bool;
}
```

The naming makes a load-bearing claim: **the upstream relationship is "HTTP
forwarding" plus a session flag**. The implementation (`src/manifest/backends/http-forward.ts`,
`doInitialize` and `fetchUpstreamTools`) reads that claim and lives down to
it: it does an `initialize` POST when `requiresSession` is set, captures
`Mcp-Session-Id`, and forwards subsequent calls with that header. That is
the *thin HTTP forward + a session flag* mental model the field name primes.

But every aspect of that implementation is MCP-specific:

- It sends a JSON-RPC `initialize` request with `protocolVersion`,
  `capabilities`, `clientInfo` — the MCP lifecycle.
- It captures a `Mcp-Session-Id` — the MCP transport binding.
- It forwards `tools/call` JSON-RPC — the MCP data layer.
- It merges upstream `tools/list` into its own advertised catalog — the
  MCP proxy pattern.

What the manifest field calls "httpForward" is, in spec terms, **a fully
fledged MCP Client lifecycle on cloister's side, plus aggregation
semantics on the proxy-as-server side**. The naming hides this. As a
consequence the implementation drops obligations the spec assigns to
clients and proxies — most visibly the `notifications/initialized`
notification, which marks the completion of the MCP client lifecycle.

### The bug class this produces

`cloister-91e5d4` traced a "mache `tools/list` returns empty" failure to
this gap: mache 0.8.0 strictly enforces lifecycle completion and rejects
subsequent requests with "Invalid session ID" when `notifications/initialized`
never arrives. The proxy's catalog-merge code swallows the error and
returns the asserted-tools fallback. End users see the upstream's tools as
"missing"; there is no actionable diagnostic.

The bug is not in any one line of `http-forward.ts`. It is in the **manifest
schema's framing**: declaring the relationship as "HTTP forwarding" primes
implementors to think transport, not lifecycle. The lifecycle gets skipped
silently because the field name doesn't suggest one exists. The fix is not
just "add the notification" — it is to **rename the construct so its
obligations are legible**, then satisfy those obligations.

### The SEP this maps to

`docs/mcp-seps/SEP-XXXX-mcp-proxy-server-formalization.md` (drafted in this
repo per ADR-0001's reference-implementation convention) proposes a
`proxy` capability block, a `proxy/upstreams` introspection RPC, and a
normative list of obligations that align exactly with what cloister
needs internally. The SEP's `mcpProxy` backend kind is what `httpForward`
becomes when its real shape is named.

This ADR is the cloister-side counterpart to the SEP: it ratifies the
naming change locally and sequences the implementation work.

## Spec trajectory: why phase order matters

Two SEPs already in the upstream queue change the MCP wire substantially:

| SEP | Status | Effect |
|---|---|---|
| [SEP-2575](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2575) | Accepted | Removes `initialize` handshake. Replaces with per-request `MCP-Protocol-Version` header + `_meta` clientInfo / clientCapabilities. Adds `server/discover` RPC for capability introspection. |
| [SEP-2567](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2567) | Final | Removes server-side sessions. `Mcp-Session-Id` is no longer required for stateless clients; `tools/list` becomes cacheable across what used to be session boundaries. |

Taken together: the *current-spec* lifecycle is being deprecated. A
proxy that ships strict 2025-11-25 lifecycle compliance today is
implementing soon-to-be-deprecated behavior. A proxy that ships
sessionless-only is incompatible with mark3labs/mcp-go upstreams
(mache, rosary) which strictly enforce 2025-11-25.

The cloister substrate has to speak both for an overlap window. That
makes phase ordering load-bearing.

### Phase order: 0 → 3 → 2 → 1 (foundation, then ecosystem, then future, then current LAST)

| Phase | Scope | Why first/last |
|---|---|---|
| **Phase 0** (this bead, `cloister-a2b76f`) | ADR + spec-compliance test fixture | Foundation. The fixture becomes the executable contract for what Phase 1/2/3 must satisfy. No source code changes. |
| **Phase 3** (next) | MCP Registry surface — `GET /.well-known/mcp/servers` mapping to `proxy/upstreams` shape | Ecosystem citizenship. The MCP Registry [spec](https://modelcontextprotocol.io/registry/about) already defines server.json; cloister-as-private-registry is a structural fit. Doing this before Phase 2 keeps cloister discoverable to current-spec hosts during the protocol-version overlap window. |
| **Phase 2** | Sessionless-protocol support (SEP-2575 + SEP-2567) for upstreams that speak it | Future protocol. Build the dual-path code while the current path is still working — easier to refactor toward sessionless than to retrofit sessionless onto a hardened current-spec implementation. |
| **Phase 1** | Current-spec compliance — backend kind rename + `notifications/initialized` + version negotiation per upstream | Last. This is the smallest-surface, highest-risk change (touches every existing upstream); doing it last means the test fixture, registry surface, and dual-path code already exist as scaffolding, and Phase 1 is "satisfy the contract Phase 0 wrote." |

The intuition: "fix the bug" (Phase 1 in isolation) would patch a
deprecated path. The phase ordering ensures we *only* implement
current-spec strictness once the substrate is ready to also speak the
next protocol — minimizing the window where cloister is locked into
deprecated behavior.

## Decision

Cloister adopts the MCP-Proxy-Server framing formally.

1. **Naming**. The manifest backend kind currently called `httpForward`
   is conceptually an MCP Proxy upstream. It will be renamed `mcpProxy`
   in Phase 1, with a one-release deprecation alias so existing
   manifests keep working through the migration window.

2. **Phase 0 deliverables (this bead)**:
   - This ADR (the local design contract).
   - `test/spec/fixture-mcp-server.ts` — an importable strict-assert
     MCP server fixture that records spec violations on every request.
   - `test/spec/mcp-proxy-server-compliance.test.ts` — tests that
     exercise the obligations from the SEP §3 against
     cloister-as-MCP-client. Marked `it.skip` for the Phase 1/2/3
     contract; not gated yet.

3. **Phase 1 (future bead)**: rename `httpForward` → `mcpProxy`, with
   deprecation alias. Add `notifications/initialized` to the client
   lifecycle. Implement version negotiation per upstream (mark
   incompatible upstreams as `unreachable` rather than fall back).
   Tighten capability declaration (non-empty `capabilities` block in
   `initialize`). The Phase 0 fixture goes from `.skip` to gated.

4. **Phase 2 (future bead)**: dual-path support. When an upstream
   advertises SEP-2575 / SEP-2567 support, cloister speaks the
   sessionless protocol (per-request `MCP-Protocol-Version` header,
   `_meta` clientInfo, `server/discover` instead of `initialize`).
   The same fixture under its `mode: "next"` configuration exercises
   this path.

5. **Phase 3 (future bead)**: registry surface. A new well-known
   route kind (e.g. `mcpRegistry`) added to the manifest schema,
   mounted at `GET /.well-known/mcp/servers`, returns cloister's
   upstream catalog in the format the MCP Registry OpenAPI spec
   defines. This is the spec-aligned form of the SEP's `proxy/upstreams`
   RPC.

6. **SEP submission gating**. The SEP draft cannot be submitted
   upstream until cloister has shipped Phases 1–3 — the spec process
   requires a working reference implementation. Phase 0 (this bead)
   is the structural commitment that the reference implementation
   is being built. Phases 1–3 are the implementation.

## Consequences

**Positive:**

- The naming of `mcpProxy` makes the implementor read the MCP
  Specification's Lifecycle and Security Best Practices pages.
  `httpForward` does not. This is the single largest change.
- The Phase 0 fixture is the contract Phase 1/2/3 must satisfy. It
  defines what "cloister is MCP-spec-compliant" means in code, not
  in prose. A future change to `http-forward.ts` (or its successor)
  that breaks a fixture obligation fails the gate.
- The SEP gains a working reference implementation through cloister.
  This is the precondition for upstream submission.
- The phase order avoids implementing deprecated behavior twice.

**Negative / risks:**

- The `httpForward` → `mcpProxy` rename touches `cluster.capnp`,
  every cluster fixture, ARCHITECTURE.md, and the manifest TS
  mirror. The migration is mechanical but wide. Mitigation: ship
  the rename with a deprecation alias accepting both names for one
  release.
- The spec-compliance fixture lives in `test/spec/` — a new test
  directory. It must be excluded from the lint gate (the tests
  fail today, by design — they're the contract) until Phase 1
  lands. Mitigation: use `.skip` with a frontmatter comment
  pointing at this ADR.
- The Phase 0 contract may need revisions once Phase 1 implementation
  reveals corner cases. Mitigation: the fixture is a test file,
  not an external contract. Revising it in Phase 1 is normal.

**Cost:**

- One ADR, one fixture, one test file in Phase 0.
- Phase 1 is a single-PR rename + lifecycle add. Bounded.
- Phase 2 is a dual-path branch in `http-forward.ts` (post-rename
  `mcpProxy`). Larger; sequenced after Phase 3 to keep ecosystem
  visibility during the overlap window.
- Phase 3 is one new backend kind + one new route handler. Bounded.

## Alternatives considered

### Extend MCP Extensions framework (SEP-2133) instead of core data-layer change

The Extensions SEP-2133 provides a namespace (`io.modelcontextprotocol/<vendor>/<ext>`)
for modular and experimental MCP additions. We could declare the
proxy capability as an extension rather than asking for it in core.

**Rejected** because:

1. The "MCP Proxy Server" pattern is already named in the Security
   Best Practices document. It is not experimental; it is widely
   deployed. Extensions are explicitly for "modular, specialized, or
   experimental" additions. Putting `proxy` in extensions
   misclassifies its maturity.
2. The Security Best Practices' MUSTs already apply to proxies.
   Putting the proxy capability in extensions means a client that
   doesn't load the extension cannot tell it is talking to a proxy
   — but the security obligations still apply. The capability needs
   to be visible to *every* MCP client, which means it belongs in
   core capability negotiation.
3. The extension namespace (e.g. `io.modelcontextprotocol/proxy`)
   is awkward for what should be a first-class concept the spec
   already names.

### Do nothing (status quo)

Keep `httpForward(requiresSession=true)`. Add `notifications/initialized`
as a one-line bug fix to `doInitialize`. Skip the rename.

**Rejected** because:

1. It patches the current path without addressing the conflation.
   The bug class returns: the next spec obligation the implementation
   misses (version negotiation, capability declaration, token
   passthrough check) has the same root cause — the manifest field
   name doesn't prime the implementor to look at the MCP spec.
2. It implements deprecated behavior. SEP-2575 + SEP-2567 are landing.
   A proxy that hardens 2025-11-25 lifecycle compliance today has
   to refactor it out tomorrow.
3. It forfeits the SEP submission opportunity. Without a reference
   implementation aligned to the SEP, the upstream submission has
   no working code to cite.

### Implement Phase 1 first, then Phase 0 retroactively

Skip the test fixture. Fix the bug. Write tests after.

**Rejected** because:

1. The fixture is the contract. Writing tests "after" loses the
   benefit of test-driven specification — the implementation
   defines the tests instead of the spec defining the tests.
2. The Phase 1 PR becomes harder to review. Reviewers can't tell
   "is this behavior intentional?" without a fixture that asserts
   "this is what the spec requires."
3. The SEP submission requires the fixture to be lift-portable
   into `modelcontextprotocol/spec`'s test suite. Writing it
   against the cloister implementation rather than against the
   spec couples it to the implementation in ways that block
   upstreaming.

## Cross-references

- [ADR-0001](0001-workerd-mcp-gateway.md) — original MCP gateway
  framing. The "single MCP endpoint" claim is sound; what this ADR
  refines is *what cloister is on the wire* (a Proxy Server per
  the Security Best Practices doc).
- [ADR-0002](0002-edge-router-protocol-agnostic-backends.md) — the
  protocol-agnostic-backends framing. `httpForward` was one of the
  named backend kinds; this ADR renames it to its spec-aligned form
  in Phase 1.
- [ADR-0006](0006-derived-tool-schemas.md) — derived tool schemas
  (the `dynamicTools` field). This ADR retains the derivation
  semantics; it just renames the construct that uses them.
- [ADR-0007](0007-interlace-substrate.md) — the identity substrate.
  Per Obligation 3 of the SEP (token-passthrough prohibition),
  cloister obtains its own Interlace lease for each upstream and
  never forwards a client-issued lease. This ADR ratifies that
  property locally.
- `docs/mcp-seps/SEP-XXXX-mcp-proxy-server-formalization.md` —
  the upstream draft this ADR is the local counterpart to.
- `cloister-91e5d4` — the mache lifecycle-skip bug that motivated
  surfacing the conflation. Its fix lands in Phase 1.
- `cloister-a2b76f` — this bead, Phase 0 deliverable.

## What this ADR does NOT decide

- **The exact wire shape of `proxy/upstreams`**. The SEP draft has
  one; Phase 3 will exercise it and may iterate. Locked in Phase 3.
- **Whether `perUpstreamConsent` defaults true or false in
  cloister**. Phase 1 default is `true` (manifest grants are
  per-upstream already, per ADR-0013); revisited if the SEP forces
  a different default.
- **Backend-kind enum vs string** in the renamed manifest schema.
  Phase 1 decision; mechanical.
- **Whether the Phase 0 fixture is unit-test-style (fetch-injected)
  or integration-test-style (real workerd serving on a port)**.
  Phase 0 uses fetch-injected to fit vitest-pool-workers; a future
  bead may add an integration variant once the contract is stable.
