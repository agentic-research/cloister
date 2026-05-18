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
    // Mount with SAFE-CLOSED defaults: empty service registry +
    // in-memory credential store → every request 404 with constant-
    // shape body. Composition root (e.g. cluster.toml bootstrap, when
    // the Phase 11 schema add lands) supplies real CredentialStore +
    // ServiceResolver via VaultProxyRoute's constructor deps.
    return new VaultProxyRoute();
  }
  // Exhaustiveness: kind is a discriminated union, so this is unreachable.
  const _exhaustive: never = k;
  void _exhaustive;
  throw new TypeError(`manifest: unknown route kind on path "${route.path}"`);
}

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
  const seenToolNames = new Set<string>();

  for (const r of g.routes) {
    if (seenPaths.has(r.path)) {
      throw new TypeError(`manifest: duplicate route path "${r.path}"`);
    }
    seenPaths.add(r.path);

    if ("mcp" in r.kind) {
      for (const b of r.kind.mcp.backends) {
        // Empty prefix = exact-match-against-tool-list mode. Multiple
        // empty-prefix backends can coexist; tool-name uniqueness (below)
        // is the right invariant. The duplicate-prefix check applies only
        // to non-empty prefixes (where two backends both claiming "x_"
        // would silently first-wins shadow each other).
        if (b.handlesPrefix !== "") {
          if (seenPrefixes.has(b.handlesPrefix)) {
            throw new TypeError(
              `manifest: duplicate backend prefix "${b.handlesPrefix}" (backend "${b.name}")`,
            );
          }
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
        if ("mcpProxy" in b.kind && b.kind.mcpProxy.dynamicTools && b.handlesPrefix === "") {
          throw new TypeError(
            `manifest: backend "${b.name}" has dynamicTools=true but empty handlesPrefix; dynamic tools require a non-empty prefix (see ADR-0006)`,
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
