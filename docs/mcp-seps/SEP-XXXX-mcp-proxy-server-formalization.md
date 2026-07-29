# SEP-XXXX: Formalize MCP Proxy Server as a First-Class Type

| Field         | Value                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| **SEP**       | XXXX                                                                                                 |
| **Title**     | Formalize MCP Proxy Server as a First-Class Type                                                     |
| **Status**    | Draft                                                                                                |
| **Type**      | Standards Track                                                                                      |
| **Created**   | 2026-05-11                                                                                           |
| **Author(s)** | James Gardner ([@jamestexas](https://github.com/jamestexas))                                         |
| **Sponsor**   | TBD                                                                                                  |
| **PR**        | TBD                                                                                                  |

***

## Abstract

The current MCP specification (2025-11-25) defines three participant types: Host, Client, and Server. The Security Best Practices document additionally names a fourth, recurring pattern — **MCP Proxy Server** — and assigns it normative obligations (no token passthrough, per-client consent for OAuth flows, redirect-URI validation). However, the data-layer specification does not model this pattern: a proxy is treated as an undifferentiated server, with no protocol-level mechanism for declaring proxy status, advertising the surface of upstream servers it aggregates, or negotiating proxy-specific capabilities.

This conflation produces three concrete failure modes in deployed proxies: (1) silent lifecycle non-compliance on the proxy-as-client side (e.g., dropped `notifications/initialized`, missed `server/discover` calls); (2) inability for hosts to distinguish a proxy from a direct server, which affects caching, discovery, and security UI; (3) ad-hoc reinvention of tool-namespacing conventions, with each implementation choosing its own prefix scheme and aggregation semantics.

This SEP proposes a minimal, non-breaking addition: a `proxy` capability block servers MAY declare in their `server/discover` response, a `proxy/upstreams` RPC for introspecting the aggregated surface, and a normative list of obligations a server declaring `proxy` capability MUST satisfy. Hosts that ignore the capability see the proxy as a regular server (graceful degradation). Hosts that recognize it gain the ability to render proxy-aware UI, share caches across proxied connections, and enforce per-upstream consent.

## Motivation

### The conflation is real

The MCP Security Best Practices document explicitly defines an "MCP Proxy Server" as:

> An MCP server that connects MCP clients to third-party APIs, offering MCP features while delegating operations and acting as a single OAuth client to the third-party API server.

It then assigns normative obligations to this entity:

* **MCP proxy servers MUST implement per-client consent** before forwarding to the third-party authorization server (confused-deputy mitigation).
* **MCP servers MUST NOT accept any tokens that were not explicitly issued for the MCP server** (token-passthrough prohibition).
* **MCP proxy servers MUST validate that the `redirect_uri` in authorization requests exactly matches the registered URI**.

These are MUSTs assigned to a class of entity. But the data-layer specification has no construct for declaring that one is a member of that class. The result: every proxy implementation must (a) infer that the obligations apply to it from prose, (b) implement them without spec-level affordances, and (c) hope clients trust this assertion implicitly.

### The lifecycle problem (concrete failure case)

A proxy is both a server (to external clients) and a client (to upstream servers). The MCP client lifecycle includes obligations that a "thin HTTP forward" mental model loses sight of. The current spec requires:

1. `initialize` request with declared client capabilities.
2. `initialize` response with negotiated server capabilities and protocol version.
3. **`notifications/initialized` notification** — "After successful initialization, the client sends a notification to indicate it's ready." (Quoted from the Architecture page; reinforced by the lifecycle page.)
4. Normal operations.

Step 3 is often skipped by proxies that implement steps 1, 2, and 4 from a "do an HTTP POST, parse the response, store the session ID" perspective. Strict spec-compliant servers (e.g., mache 0.8.0) reject subsequent requests with "Invalid session ID" because the lifecycle never completed. The proxy's `tools/list` returns empty for that upstream; the failure is silent (the proxy's catalog merge swallows the error rather than surfacing it). End users see the upstream's tools as missing, with no actionable diagnostic.

The reference implementation for this SEP (cloister, [agentic-research/cloister](https://github.com/agentic-research/cloister)) hit exactly this bug in production deployment, traced to its `httpForward` backend kind in the manifest — a naming choice that primed implementors to think of the relationship as HTTP-forwarding rather than as a full MCP-client lifecycle on the proxy's behalf.

### Capability filtering is undefined

When a proxy aggregates *N* upstreams, the relationship between the proxy's advertised capabilities and the upstreams' is undefined:

* Does the proxy advertise the **union** of upstream capabilities (e.g., if any upstream supports `notifications/tools/list_changed`, the proxy advertises it)?
* Does it advertise only its **own** intrinsic capabilities (proxy-as-server), with upstream capabilities accessible only through the introspection RPC proposed below?
* Does it advertise the **intersection** (only what every upstream agrees on)?

The spec is silent. Implementations vary. Hosts cannot rely on any particular convention.

### Tool namespacing is reinvented per proxy

Proxies aggregate tools from multiple upstreams. To avoid name collisions, every proxy invents its own namespacing convention:

* Cloister uses `mache_*` / `lsp_*` prefixes.
* Some proxies use `<server-id>.<tool-name>` dotted notation.
* Others use no prefix at all and rely on first-registered-wins (with no mechanism for the client to know which upstream a tool came from).

This is exactly the kind of convention that benefits from spec-level standardization: clients gain a predictable surface, server authors don't have to choose, and proxy implementations don't fragment.

### MCP Registry alignment

The MCP Registry specification defines a server.json metadata format for publicly accessible servers. Private registries can implement the same OpenAPI surface to be discoverable by host applications. An MCP Proxy Server with multiple upstreams is structurally a private registry: it has a catalog, it has metadata, it has a namespace. Today there is no spec-level path for a proxy to expose its upstream catalog through the same surface a host already knows how to consume. This SEP creates that path.

## Specification

### 1. New capability: `proxy`

A server MAY include a `proxy` capability block in its `server/discover` response (per [SEP-2575], on protocol versions that support `server/discover`) or in its `initialize` response (on protocol versions that retain the handshake). The capability block has the following shape:

```typescript
interface ProxyCapability {
  /**
   * The number of upstream servers this proxy aggregates. The actual list
   * is fetched via `proxy/upstreams`. This count is advertised in capability
   * negotiation so a client can decide whether to call `proxy/upstreams`
   * (skip if zero or absent; useful information when planning context).
   */
  upstreamCount: number;

  /**
   * If true, the proxy enforces per-upstream consent independently — a client
   * approving the proxy does NOT grant the proxy authority to call any upstream
   * without further negotiation. If false, accepting the proxy means accepting
   * its full upstream set.
   *
   * Honest declaration is required: a proxy MUST NOT advertise
   * `perUpstreamConsent: true` if its implementation cannot enforce per-upstream
   * scopes.
   */
  perUpstreamConsent: boolean;

  /**
   * Whether the proxy aggregates upstream tools under a namespace prefix
   * (e.g., `mache_*`), under dotted notation (`mache.get_overview`), or
   * passes upstream tool names through unchanged. Hosts use this to render
   * tool origins in UI.
   */
  namespacing: "prefix" | "dotted" | "passthrough";
}
```

Servers declaring this capability **MUST** satisfy all normative obligations listed in §3 of this SEP.

### 2. New RPC: `proxy/upstreams`

A server declaring the `proxy` capability **MUST** implement the `proxy/upstreams` RPC. This is an introspection endpoint that returns the proxy's upstream surface.

**Request schema:**

```typescript
interface ProxyUpstreamsRequest extends Request {
  method: "proxy/upstreams";
  params?: {};
}
```

**Response schema:**

```typescript
interface ProxyUpstreamsResult extends Result {
  /**
   * The set of upstream servers this proxy aggregates.
   * Order is not significant.
   */
  upstreams: UpstreamServerDescriptor[];
}

interface UpstreamServerDescriptor {
  /**
   * Stable identifier for this upstream within the proxy's namespace.
   * For `namespacing: "prefix"`, this is the prefix without trailing
   * separator (e.g., "mache" for mache_*). For "dotted", the dotted
   * prefix. For "passthrough", an opaque identifier the proxy
   * uses internally; no relationship to tool names.
   */
  id: string;

  /**
   * Human-readable name; safe to surface in UI.
   */
  name: string;

  /**
   * The upstream's `serverInfo` as obtained during the proxy's
   * client-side lifecycle handshake with the upstream. MAY be absent
   * if the proxy has not yet connected to the upstream or if the
   * upstream did not provide serverInfo.
   */
  serverInfo?: Implementation;

  /**
   * The upstream's negotiated capabilities as seen by the proxy.
   * MAY be a subset of what the upstream actually advertises if the
   * proxy filters capabilities.
   */
  capabilities?: ServerCapabilities;

  /**
   * Reachability state. `ready` means the proxy has completed the
   * MCP lifecycle with this upstream and is forwarding requests
   * normally. `unreachable` means the upstream is configured but not
   * currently responsive. `degraded` means the upstream is partially
   * available (e.g., responding to some methods but not others).
   *
   * A proxy MUST update this state in real time; hosts that subscribe
   * to `notifications/proxy/upstreams_changed` (see §4) receive
   * updates as state transitions occur.
   */
  state: "ready" | "unreachable" | "degraded";
}
```

The `proxy/upstreams` response **MUST NOT** include any credential material (tokens, headers, etc.) or per-client routing state. It is a metadata-only surface.

### 3. Normative obligations for `proxy`-capability servers

A server declaring the `proxy` capability **MUST**:

1. **Complete the full MCP client lifecycle** with each upstream it aggregates. This includes (on protocol versions that require it) the `notifications/initialized` notification after the `initialize` response. Skipping any lifecycle step is a spec violation, regardless of whether the upstream tolerates it. If lifecycle completion fails (for any reason — handshake error, missing notification ack, session-expiry response from upstream), the proxy **MUST** mark the upstream as `unreachable` in `proxy/upstreams` and **MUST NOT** silently fall back to a stale tool catalog for that upstream.

2. **Validate version compatibility per-upstream**. If an upstream returns a protocol version the proxy does not support, the proxy **MUST** mark that upstream as `unreachable` in `proxy/upstreams` and **MUST NOT** silently fall back to incompatible behavior. The proxy **MAY** support multiple protocol versions internally and select the right one per upstream.

3. **Never pass through client-issued credentials to upstreams** (token-passthrough prohibition from Security Best Practices, restated normatively here). The proxy is its own audience; client tokens authorize the proxy, not the proxy's upstreams. The proxy obtains its own credentials for each upstream through a mechanism outside the scope of this SEP (OAuth client credentials per SEP-1046, configured static credentials, capability tokens, etc.).

4. **Surface upstream errors with attribution**. When forwarding a `tools/call` and the upstream returns an error, the proxy **MUST** include the upstream id in the JSON-RPC error's `data` field:
   ```json
   {
     "error": {
       "code": -32603,
       "message": "upstream returned error",
       "data": { "upstream": "mache", "code": -32000, "message": "..." }
     }
   }
   ```
   This lets hosts distinguish "the proxy is broken" from "this specific upstream is broken."

5. **Not advertise upstream capabilities the proxy cannot fulfill**. If the proxy does not implement `sampling`, it MUST NOT advertise `sampling` even if an upstream supports it; the proxy is the spec-compliance boundary for the client.

6. **Honor `perUpstreamConsent: true` if declared**. The proxy MUST implement a per-upstream gate that allows a client to enable/disable individual upstreams. The mechanism is implementation-defined (manifest config, runtime RPC, host UI hook) but its presence is normative.

### 4. New notification: `notifications/proxy/upstreams_changed`

A server declaring the `proxy` capability **MAY** declare `listChanged` within the capability:

```json
"proxy": { "upstreamCount": 3, "perUpstreamConsent": true, "namespacing": "prefix", "listChanged": true }
```

If so, the server **MUST** send `notifications/proxy/upstreams_changed` whenever:

* An upstream's `state` transitions (ready → unreachable, etc.).
* An upstream is added or removed from the proxy's configuration.

The notification carries no body; the client refetches `proxy/upstreams` to see the new state.

### 5. Interaction with `tools/list`, `resources/list`, `prompts/list`

A `proxy`-capability server's `tools/list` (and friends) **MUST** return the aggregated tools across upstreams, with names rewritten according to the declared `namespacing` policy. The order is implementation-defined; hosts MUST NOT depend on it.

Where capability filtering is needed (e.g., the proxy supports resources but a given upstream does not), the proxy includes only the items it can serve. The proxy **MUST NOT** advertise an upstream's tool/resource/prompt unless the proxy will actually forward the corresponding `*/call` / `*/read` / `*/get` request to that upstream.

## Rationale

### Why a new capability block rather than a new server type?

The MCP data layer is structured around capability negotiation, not around a typed hierarchy of server kinds. A proxy is still a server — it has tools, it accepts the same JSON-RPC requests, it implements the same lifecycle. The only thing different is the *internal* relationship to one or more upstreams, plus a set of normative obligations the proxy must honor.

Treating "proxy" as a capability (an opt-in declaration with normative obligations) rather than a type (a discriminated union member) is consistent with how `tools`, `resources`, `prompts`, `sampling`, `elicitation`, etc., are modeled. It also preserves graceful degradation: a host that doesn't recognize the `proxy` capability sees a regular server, which is correct (the proxy *is* a server; "proxy" is additional structure, not a replacement).

### Why an introspection RPC rather than embedding upstream metadata in `tools/list`?

`tools/list` is on the hot path; SEP-2567 calls out that hosts may now cache it across what used to be session boundaries. Including upstream metadata inline would bloat every `tools/list` response with information that's stable across many tool-list refreshes.

A separate `proxy/upstreams` RPC is fetched on demand — typically once when the host connects, then on `notifications/proxy/upstreams_changed`. This keeps the hot path lean while making the upstream surface formally addressable.

### Why a normative list of obligations rather than just informational?

The security spec already imposes MUSTs on proxies. The data layer should make those MUSTs *enforceable through capability declaration*. A server declaring `proxy` is contractually committing to the obligations; a client that connects to a `proxy`-capability server can rely on those obligations being met (or, if they aren't, can report a non-compliance bug against a precise spec section).

The alternative — leaving the obligations as prose-only — preserves the status quo: every proxy interprets them differently, and clients have no recourse beyond "trust the implementor."

### Why this namespace and not extensions framework (SEP-2133)?

The Extensions framework (SEP-2133) is for *modular, specialized, or experimental* additions. The proxy pattern is none of these — it's widely deployed, fundamental to gateway scenarios, and named by the security spec as a recognized entity. It belongs in core, not in an extension. (An extension would also force the `io.modelcontextprotocol/proxy` namespace, which is awkward for what should be a first-class concept.)

### Alternative considered: do nothing

The status quo "works" in the limited sense that proxies exist and clients connect to them. But it works through implementation-by-implementation diligence, not through spec-level affordances. The cost is the failure modes enumerated in Motivation: silent lifecycle bugs, no client awareness of proxy-ness, ad-hoc namespacing. As the ecosystem scales — multi-tenant gateways, federated proxy chains, host applications consuming many proxies — these costs compound. Formalizing now is cheaper than retrofitting later.

### Alternative considered: implicit discovery via `server/discover`

A version of this SEP could have proxies advertise themselves only through `serverInfo.proxy: true` (or similar metadata) without a dedicated capability block or introspection RPC. The reasons that was rejected:

* No structured surface for upstream metadata — hosts have to call `tools/list` and infer.
* No normative-obligation hook — implementations can claim `proxy: true` without committing to any specific behavior.
* No path for upstream state changes (the `unreachable` / `ready` / `degraded` semantics).

The richer surface specified here pays for itself in clarity of contract and observability of proxy state.

## Backward Compatibility

This SEP is **strictly additive**. Servers that do not declare the `proxy` capability are unaffected. Clients that do not recognize the `proxy` capability see a regular server, which is correct behavior (graceful degradation per the Extensions SEP's negotiation pattern).

Existing proxy implementations may opt in by:

1. Auditing their MCP-client-side lifecycle for spec compliance (Obligation 1).
2. Implementing per-upstream state tracking sufficient to populate `proxy/upstreams`.
3. Declaring the capability block in their discover/initialize response.
4. Adding the `proxy/upstreams` RPC handler.

No deprecation cycle is required. Existing proxies continue to work; they just don't gain the host-side affordances until they opt in.

## Reference Implementation

[Cloister](https://github.com/agentic-research/cloister) implements this SEP as a reference. Specifically:

* The `mcpProxy` backend kind (the renamed `httpForward` per the SEP's terminology alignment) handles the proxy-as-client lifecycle including `notifications/initialized`, per-upstream session management, and upstream state tracking.
* `proxy/upstreams` is exposed through the `McpEdgeRoute` handler.
* The `proxy` capability is advertised in cloister's `initialize` response (and, when SEP-2575 lands, in `server/discover`).
* Per-upstream consent (`perUpstreamConsent: true`) is enforced through the `cluster.capnp` manifest's `wires` declarations — bundles only get bindings to upstreams the operator explicitly grants.
* The token-passthrough prohibition (Obligation 3) is enforced architecturally: cloister obtains its own Interlace lease for each upstream and never forwards the client-issued lease.

A spec-compliance test fixture at `test/spec/mcp-proxy-server-compliance.test.ts` exercises every normative obligation against the cloister implementation. The fixture is structured so it can be lifted into the official `modelcontextprotocol/spec` test suite if this SEP advances to Final.

Cloister also exercises the failure cases — see `cloister-91e5d4` (mache `notifications/initialized` skip) and its resolution as a worked example of the obligation in practice.

## Security Implications

### Token passthrough is restated normatively

Obligation 3 restates the Security Best Practices' token-passthrough prohibition as a data-layer MUST tied to the `proxy` capability declaration. A proxy that advertises `proxy` and then passes through client-issued tokens is non-compliant; clients that detect this behavior (via audience claims in tokens they observe being reused) MUST treat the proxy as untrusted.

### Per-upstream consent surface

When `perUpstreamConsent: true` is advertised, the proxy commits to enforcing per-upstream gating. This is a security feature, not a UI feature: it bounds the blast radius of any single upstream's compromise. A client UI that respects this capability allows the user to disable a compromised upstream without disconnecting from the proxy entirely.

### Confused deputy mitigation aligns with existing SEPs

Per the Security Best Practices, proxies that bridge to third-party authorization servers MUST implement per-client consent. This SEP does not duplicate that requirement — it's already in the security spec. What this SEP does is make it clear *which* servers have that obligation: those declaring the `proxy` capability. Without this SEP, every server has to audit whether the security spec's proxy obligations apply to it; with this SEP, the declaration is the audit trail.

### `proxy/upstreams` metadata exposure

The `proxy/upstreams` RPC exposes information about a proxy's internal topology. In some deployments this is sensitive (e.g., a private-network proxy that doesn't want to advertise which internal services it bridges to). The RPC is gated by whatever authentication the proxy already requires; a proxy that wants to hide its upstreams can simply not declare the `proxy` capability (graceful degradation makes this safe — clients see a regular server).

The RPC explicitly forbids returning credentials or routing state (§2), so even if leaked it cannot be used to bypass the proxy's auth or impersonate it.

### SSRF surface unchanged

The proxy's outbound URLs (where it forwards requests to upstreams) are configured by the proxy operator, not by the client. This SEP introduces no new client-controlled URL fetching, so the SSRF surface from the Security Best Practices is unchanged. (Hosts that consume `proxy/upstreams` metadata still MUST NOT use URLs from that response to make their own outbound requests — they're informational only.)

## Deviations in the reference implementation (cloister)

Recorded here so a reviewer comparing cloister against MCP 2026-07-28 finds
the deltas stated rather than discovered.

1. **`server/discover` is authenticated.** The spec intends discovery as a
   pre-auth first call. Cloister is a private MCP registry (ADR-0016) whose
   threat model treats capability inventory as enumerable surface (threat
   model §9 uses constant-time 404s for exactly this class), so `server/
   discover` sits behind the lease gate like every other method, grantable
   via the `server:discover` scope. An unauthenticated probe receives the
   same deny shape as any unauthenticated call — the method's existence
   leaks nothing (pinned by test, contracts.test.ts "gate posture").
   Deployments wanting spec-literal pre-auth discovery can front cloister
   with a static discovery document; the gate stays.

2. **`Mcp-Method` / `Mcp-Name` are advisory.** Trust decisions derive from
   the signed body; present-and-disagreeing headers reject with
   `HeaderMismatchError` (-32020) before the gate. Threat model §13.11.

## Open Questions

### Should `perUpstreamConsent` be a stronger MUST?

Currently a proxy MAY declare `perUpstreamConsent: false` (i.e., "trust the whole upstream set or trust nothing"). For high-trust scenarios (homogeneous cluster of bundles operated by one entity) this is correct. For low-trust scenarios (a host connecting to a third-party proxy that aggregates random remote servers) it's a footgun. A stronger version of this SEP would make `perUpstreamConsent: true` mandatory; the current draft leaves the choice to the proxy operator.

### Relationship to MCP Registry

A `proxy/upstreams` response is structurally close to an MCP Registry response (per [Registry](https://modelcontextprotocol.io/registry/about)). A future SEP could align the two formats explicitly, allowing a proxy to expose its upstreams as a registry surface to compatible hosts. Out of scope for this SEP; flagged for follow-up.

### Should this SEP define behavior for proxy-chained scenarios?

A proxy that aggregates upstreams which are themselves proxies (proxy chains) is not explicitly addressed. The obligations in §3 transitively apply (each proxy in the chain must be spec-compliant), but the introspection RPC doesn't define whether a proxy should recursively flatten its upstreams' upstreams. Current draft: each proxy reports only its direct upstreams; the host is responsible for recursing if it wants to. This may merit clarification before Final.

[SEP-2575]: https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2575
[SEP-2567]: https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2567
[SEP-2133]: https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2133
[SEP-1046]: https://github.com/modelcontextprotocol/modelcontextprotocol/pull/1046
