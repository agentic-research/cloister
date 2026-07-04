/**
 * Manifest runtime — turns a typed `Gateway` into a list of EdgeRoute
 * instances ready to plug into the Router.
 *
 * Three phases:
 *
 *   1. Static validation — done in `scripts/build-manifest.mjs` at build
 *      time (duplicate paths, prefixes, tool names; valid JSON schemas).
 *      We re-validate here as a defense-in-depth check; the same
 *      diagnostics surface as TypeError at instantiation.
 *
 *   2. Backend instantiation — for each McpRoute, build the list of
 *      ToolBackends from the kind→factory registry below.
 *
 *   3. Route instantiation — wrap McpRoute backends in McpEdgeRoute,
 *      health into HealthRoute, serviceBindingProxy into NotmeIdentityRoute,
 *      httpProxy into a generic HttpProxyRoute (created here, kept tiny).
 */

import type { EdgeRoute } from "../router.js";
import type { Env } from "../types.js";
import type { ToolBackend } from "../backends.js";
import {
  type Backend,
  type Gateway,
  type Route,
} from "./types.js";
import { McpEdgeRoute } from "../routes/mcp.js";
import { HealthRoute } from "../routes/health.js";
import { NotmeIdentityRoute } from "../routes/notme-identity.js";
import { WellKnownInterlaceRoute } from "../routes/well-known.js";
import { WellKnownIdentityBridgeRoute } from "../routes/well-known-identity.js";
import { DisclosureRoute } from "../routes/disclosure.js";
import { OciRegistryRoute } from "../routes/oci-registry.js";
import { WellKnownMcpRegistryRoute } from "../routes/well-known-mcp-registry.js";
import { CaBundleRoute } from "../routes/ca-bundle.js";
import { VaultProxyRoute } from "../routes/vault-proxy-route.js";
import { TenantDispatchRoute } from "../routes/tenant-dispatch.js";
import { consoleMetricEmitter, consoleReceiptEmitter } from "../routes/vault-proxy.js";
import { buildServiceRegistry } from "./vault-proxy-services.js";
import { DurableObjectToolBackend } from "./backends/durable-object.js";
import { McpProxyToolBackend } from "./backends/mcp-proxy.js";
import { ServiceBindingToolBackend } from "./backends/service-binding.js";
import { UdsForwardToolBackend } from "./backends/uds-forward.js";
import { LeylineNetToolBackend } from "./backends/leyline-net.js";

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Compile a manifest into the EdgeRoute table. Throws a TypeError on any
 * structural problem. The `path` field on each route is preserved as the
 * route's match target; HealthRoute and NotmeIdentityRoute internally know
 * their own paths today, so this implementation enforces those paths match
 * the route kind.
 */
export function instantiate(manifest: Gateway): EdgeRoute[] {
  validate(manifest);
  return manifest.routes.map((route) => toEdgeRoute(route, manifest));
}

// ── Route instantiation ───────────────────────────────────────────────────

function toEdgeRoute(route: Route, manifest: Gateway): EdgeRoute {
  const k = route.kind;
  if ("health" in k) {
    if (route.path !== "/health") {
      throw new TypeError(
        `manifest: health route must have path "/health"; got "${route.path}"`,
      );
    }
    return new HealthRoute();
  }
  if ("mcp" in k) {
    if (route.path !== "/mcp") {
      throw new TypeError(
        `manifest: mcp route must have path "/mcp"; got "${route.path}"`,
      );
    }
    const backends = k.mcp.backends.map(toToolBackend);
    // ADR-0015 Phase 2 / cloister-a35fdb: the gateway-level
    // `supportedProtocolVersions` controls what cloister advertises in
    // `server/discover` and accepts on the `MCP-Protocol-Version`
    // header. Omitted ⇒ runtime default (legacy + sessionless).
    return new McpEdgeRoute(backends, manifest.supportedProtocolVersions);
  }
  if ("serviceBindingProxy" in k) {
    // NotmeIdentityRoute hard-codes "/identity/*" + NOTME binding +
    // "notme-bot" host today. Enforce those at instantiation; future
    // generalisation is a follow-up bead.
    const spec = k.serviceBindingProxy;
    if (route.path !== "/identity") {
      throw new TypeError(
        `manifest: serviceBindingProxy currently only supports path "/identity"; got "${route.path}"`,
      );
    }
    if (spec.binding !== "NOTME") {
      throw new TypeError(
        `manifest: serviceBindingProxy currently only supports binding "NOTME"; got "${spec.binding}"`,
      );
    }
    if (spec.upstreamHost !== "notme-bot") {
      throw new TypeError(
        `manifest: serviceBindingProxy upstreamHost must be "notme-bot"; got "${spec.upstreamHost}"`,
      );
    }
    return new NotmeIdentityRoute();
  }
  if ("httpProxy" in k) {
    return new HttpProxyRoute(route.path, k.httpProxy.urlBinding, k.httpProxy.stripPrefix);
  }
  if ("wellKnownInterlace" in k) {
    // Receives the full manifest — synthesizes capabilities from mcp
    // routes, identity from `manifest.actor`, policy from `manifest.policy`.
    // See ADR-0007.
    return new WellKnownInterlaceRoute(route.path, manifest);
  }
  if ("disclosure" in k) {
    // GET /interlace/peers/:fp — selective disclosure of peer_attestations
    // chains. Lease-gated when INTERLACE_ROOT_PUBKEY is set. Defaults are
    // sane (INTERLACE_DISCLOSURE_HMAC_KEY for cursors, INTERLACE_ROOT_PUBKEY
    // for the published master pubkey). See ADR-0007 §11 / cloister-bdef0c.
    return new DisclosureRoute();
  }
  if ("wellKnownIdentityBridge" in k) {
    // Multi-format identity discovery (cloister-c9922f). One EdgeRoute
    // handles all five concrete paths (`/.well-known/openid-configuration`,
    // `/.well-known/jwks.json`, `/.well-known/webfinger`,
    // `/.well-known/nostr.json`, `/oauth/token`) because they all project
    // the same identity surface — `manifest.actor` + the master pubkey
    // bound at `env[actor.pubkeyBinding]`. First non-MCP tenant on the
    // router. The route's `path` field is a sentinel marker; the actual
    // path matching happens inside the handler.
    return new WellKnownIdentityBridgeRoute(manifest);
  }
  if ("ociRegistry" in k) {
    // OCI Distribution Spec (v1.1) registry, Phase 1 read-only (cloister-cabd57).
    // One EdgeRoute handles every `/v2/*` endpoint because they all
    // project the same content-addressed substrate: blobs from
    // BlobStore + tag→manifest mapping from TrustStore.registry_tags.
    // The route's `path` field is a sentinel marker; the actual path
    // matching happens inside the handler's URLPatterns. Sibling tenant
    // to the identity bridge — both are non-MCP tenants on the same
    // ADR-0002 seam.
    return new OciRegistryRoute();
  }
  if ("wellKnownMcpRegistry" in k) {
    // MCP Registry OpenAPI surface (ADR-0016, cloister-a30e40) — Phase 3
    // of the MCP spec-alignment arc. One EdgeRoute handles the v0.1
    // server discovery sub-paths under `/.well-known/mcp-registry/`. The
    // server catalog is synthesized from the manifest's mcp routes at
    // request time; the route's `path` is a sentinel marker — actual
    // matching happens inside the handler's URLPatterns. Third
    // metadata-surface route, sibling to wellKnownInterlace and
    // wellKnownIdentityBridge.
    return new WellKnownMcpRegistryRoute(manifest);
  }
  if ("caBundle" in k) {
    // Interlace 0.2.0 archival CA bundle endpoint (RECEIPTS.md §2.3, §2.7).
    // Serves GET /interlace/ca-bundle (list of epochs) and
    // GET /interlace/ca-bundle/<epoch> (per-epoch bundle + compromise notice).
    // V-archival verifiers consume this to replay receipts after key
    // rotation. Backed by TrustStore.actor_ca_bundle table.
    // Sibling metadata-surface route to wellKnownInterlace; the route's
    // `path` is a sentinel marker — actual matching is in the handler.
    return new CaBundleRoute();
  }
  if ("vaultProxy" in k) {
    // cloister/credential-isolation/v1 route (ADR-0024, cloister-8f57f0).
    // Service registry comes from the gateway-level vaultProxyServices
    // list (manifest-side declaration). Each entry's injection union
    // is converted from the capnp object-with-single-key shape into
    // the route's TS discriminated-union shape via `buildServiceRegistry`
    // imported from `./vault-proxy-services.ts` (the pure module that
    // both runtime AND `scripts/build-manifest.mjs` import).
    //
    // Credential store stays defaulted to in-memory (production wires
    // a vault-DO-backed impl via the composition root; separate bead).
    //
    // Status-code map (handler.ts behavior, pinned by vault-proxy.test.ts):
    //   - unauthenticated (lease verifier fails / no INTERLACE_ROOT_PUBKEY)
    //     → 401 with constant-shape body
    //   - service not declared → 404 with constant-shape body
    //   - peerFp ∉ allowedSubs → 403 with constant-shape body
    //   - credential not stored → 404 with constant-shape body
    // All four rejections share the body bytes so a probing client
    // cannot distinguish failure classes — preserves the §9.4.b
    // enumeration-oracle invariant from cloister-aa9376.
    // Production composition wires console-shaped receipts + metrics
    // emitters by default — closes X-1 from the 2026-05-18 adversarial
    // cycle (the route was previously instantiated with both undefined,
    // so master claim #3 audit-by-receipt was FALSE in production).
    // Operators can override via deps at composition time for Logpush
    // / structured-telemetry sinks. Per cloister-6e888b.
    const registry = buildServiceRegistry(manifest.vaultProxyServices ?? []);
    // X-3 / cloister-6f06cc: read `bundleIdName` from the route's
    // VaultProxySpec and thread it to the route. Empty / unset defaults
    // to "router" inside the route constructor (DEFAULT_BUNDLE_ID_NAME).
    // Per ADR-0021 each distinct bundleIdName yields an independent
    // env.VAULT_STORE.idFromName(...) instance.
    return new VaultProxyRoute({
      services:     (name) => registry.get(name) ?? null,
      receipts:     consoleReceiptEmitter(),
      metrics:      consoleMetricEmitter(),
      bundleIdName: k.vaultProxy.bundleIdName,
    });
  }
  if ("tenantDispatch" in k) {
    // Per-tenant dispatch route — ADR-0030 §A2 / cloister-0f144c.
    // Compiles the routing table at instantiation; validation throws
    // on operator errors (empty fields, unknown mode, duplicate name,
    // duplicate SNI matchValue). Lease verification happens BEFORE
    // dispatch via the lease middleware on individual routes inside
    // each tenant's workerd. Unknown tenant → constant-time 404 per
    // threat-model §13.7.1.
    return new TenantDispatchRoute(k.tenantDispatch);
  }
  // Exhaustiveness: kind is a discriminated union, so this is unreachable.
  const _exhaustive: never = k;
  void _exhaustive;
  throw new TypeError(`manifest: unknown route kind on path "${route.path}"`);
}

// ── VaultProxyService conversion lives in ./vault-proxy-services.ts ──────
//
// Imported above. Pure module so the build-time validator
// (scripts/build-manifest.mjs) can use the same code path without
// pulling in cloudflare:workers. Single source of truth — same
// `buildServiceRegistry` runs at build time AND at boot time.
// Per cloister-8f57f0 + the Copilot review on PR #36.

// ── ToolBackend instantiation ─────────────────────────────────────────────

function toToolBackend(b: Backend): ToolBackend {
  const k = b.kind;
  if ("durableObject" in k)  return new DurableObjectToolBackend(k.durableObject, b.handlesPrefix);
  if ("mcpProxy" in k)       return new McpProxyToolBackend(k.mcpProxy, b.handlesPrefix);
  if ("serviceBinding" in k) return new ServiceBindingToolBackend(k.serviceBinding, b.handlesPrefix);
  if ("udsForward" in k)     return new UdsForwardToolBackend(k.udsForward, b.handlesPrefix);
  if ("leylineNet" in k)     return new LeylineNetToolBackend(k.leylineNet, b.handlesPrefix);
  const _exhaustive: never = k;
  void _exhaustive;
  throw new TypeError(`manifest: unknown backend kind on backend "${b.name}"`);
}

// ── Generic HTTP-proxy EdgeRoute ──────────────────────────────────────────
//
// Tiny — used by the manifest's `httpProxy` route kind. Strips a prefix and
// forwards to a URL named by an env-var binding. No tools, no backends —
// purely an outer-layer proxy.

class HttpProxyRoute implements EdgeRoute {
  private readonly exactPattern:   URLPattern;
  private readonly subpathPattern: URLPattern;
  constructor(
    private readonly path:        string,
    private readonly urlBinding:  string,
    private readonly stripPrefix: string,
  ) {
    // URLPattern matches `<path>` exactly via `exactPattern` and any
    // subpath via `subpathPattern`. Built once at construction so each
    // request is just two `.test()` calls — cheaper than re-parsing
    // the URL or doing startsWith with manual segment-boundary checks.
    this.exactPattern   = new URLPattern({ pathname: path });
    this.subpathPattern = new URLPattern({ pathname: `${path}/*` });
  }

  match(request: Request): boolean {
    return this.exactPattern.test(request.url) ||
           this.subpathPattern.test(request.url);
  }

  async handle(request: Request, env: Env): Promise<Response> {
    const upstream = (env as unknown as Record<string, string>)[this.urlBinding];
    if (!upstream) {
      return new Response(`manifest: ${this.urlBinding} not configured`, { status: 503 });
    }
    const reqUrl  = new URL(request.url);
    const stripped = this.stripPrefix
      ? reqUrl.pathname.replace(new RegExp(`^${escapeRegex(this.stripPrefix)}`), "") || "/"
      : reqUrl.pathname;
    const target = new URL(stripped + reqUrl.search, upstream);
    return fetch(new Request(target.toString(), request));
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Validation ────────────────────────────────────────────────────────────

function validate(g: Gateway): void {
  const seenPaths = new Set<string>();
  const seenPrefixes = new Set<string>();
  const seenClaimsPrefixes = new Set<string>();
  const seenToolNames = new Set<string>();

  for (const r of g.routes) {
    if (seenPaths.has(r.path)) {
      throw new TypeError(`manifest: duplicate route path "${r.path}"`);
    }
    seenPaths.add(r.path);

    if ("mcp" in r.kind) {
      for (const b of r.kind.mcp.backends) {
        const hasClaims = "mcpProxy" in b.kind && (b.kind.mcpProxy.claims?.length ?? 0) > 0;

        // Empty prefix = exact-match-against-tool-list mode. Multiple
        // empty-prefix backends can coexist; tool-name uniqueness (below)
        // is the right invariant. The duplicate-prefix check applies only
        // to non-empty prefixes (where two backends both claiming "x_"
        // would silently first-wins shadow each other) — UNLESS every
        // backend sharing the prefix has a non-empty `claims` set.
        // McpProxyToolBackend.handles() (mcp-proxy.ts) checks `claims`
        // BEFORE falling back to prefix matching, so two claims-backed
        // backends sharing a prefix dispatch by exact upstream tool name,
        // not by prefix — no first-wins-shadow hazard. This is the shape
        // the P3 resolver produces for a multi-group server.json whose
        // groups share one `advertisedPrefix` (cloister-cb7263; e.g. mache's
        // navigation/callgraph/lsp/lifecycle/linter/mutate groups all
        // advertise under "mache_" but claim disjoint tool sets). A
        // claims-less backend sharing that same prefix is still the
        // original hazard (it falls back to prefix matching in
        // `handles()`), so it's tracked + rejected separately.
        if (b.handlesPrefix !== "") {
          const prefixSeenBefore = seenPrefixes.has(b.handlesPrefix);
          const bothClaimsBacked = hasClaims && seenClaimsPrefixes.has(b.handlesPrefix);
          if (prefixSeenBefore && !bothClaimsBacked) {
            throw new TypeError(
              hasClaims || seenClaimsPrefixes.has(b.handlesPrefix)
                ? `manifest: backend "${b.name}" shares prefix "${b.handlesPrefix}" with a ` +
                  `claims-less backend — the claims-less backend falls back to prefix matching ` +
                  `in handles() and would collide`
                : `manifest: duplicate backend prefix "${b.handlesPrefix}" (backend "${b.name}")`,
            );
          }
          if (hasClaims) seenClaimsPrefixes.add(b.handlesPrefix);
          seenPrefixes.add(b.handlesPrefix);
        }

        const inner =
          ("durableObject"  in b.kind) ? b.kind.durableObject  :
          ("mcpProxy"       in b.kind) ? b.kind.mcpProxy       :
          ("serviceBinding" in b.kind) ? b.kind.serviceBinding :
          ("udsForward"     in b.kind) ? b.kind.udsForward     :
          ("leylineNet"     in b.kind) ? b.kind.leylineNet     : null;
        if (!inner) {
          throw new TypeError(`manifest: backend "${b.name}" has no kind`);
        }

        // ADR-0006: dynamicTools requires a non-empty prefix so handles()
        // can dispatch upstream tools before the cache populates. An empty
        // prefix would leave handles() returning false until refreshTools()
        // runs, which races with the first tools/call from the client.
        //
        // Exception (cloister-8ede3f, P1): when `claims` is non-empty,
        // claim-aware routing in `McpProxyToolBackend.handles()` (see
        // src/manifest/backends/mcp-proxy.ts) dispatches by exact name
        // match against the claims set — no prefix needed. This is the
        // shape lockfile-generated backends use for groups without an
        // `advertisedPrefix` (e.g. LLO's `lifecycle` group: status /
        // enrich / reparse are bare names). Cloister-05334b (P1 of LLO
        // arc).
        if (
          "mcpProxy" in b.kind &&
          b.kind.mcpProxy.dynamicTools &&
          b.handlesPrefix === "" &&
          (b.kind.mcpProxy.claims?.length ?? 0) === 0
        ) {
          throw new TypeError(
            `manifest: backend "${b.name}" has dynamicTools=true but empty handlesPrefix AND empty claims; dynamic tools require either a non-empty prefix (ADR-0006) or a non-empty claims set (cloister-8ede3f)`,
          );
        }

        for (const t of inner.tools) {
          if (b.handlesPrefix !== "" && !t.name.startsWith(b.handlesPrefix)) {
            throw new TypeError(
              `manifest: tool "${t.name}" does not start with backend prefix "${b.handlesPrefix}"`,
            );
          }
          if (seenToolNames.has(t.name)) {
            throw new TypeError(`manifest: duplicate tool name "${t.name}" across backends`);
          }
          seenToolNames.add(t.name);
        }
      }
    }
  }
}
