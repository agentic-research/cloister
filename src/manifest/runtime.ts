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
import { DurableObjectToolBackend } from "./backends/durable-object.js";
import { HttpForwardToolBackend } from "./backends/http-forward.js";
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
    return new McpEdgeRoute(backends);
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
  // Exhaustiveness: kind is a discriminated union, so this is unreachable.
  const _exhaustive: never = k;
  void _exhaustive;
  throw new TypeError(`manifest: unknown route kind on path "${route.path}"`);
}

// ── ToolBackend instantiation ─────────────────────────────────────────────

function toToolBackend(b: Backend): ToolBackend {
  const k = b.kind;
  if ("durableObject" in k)  return new DurableObjectToolBackend(k.durableObject, b.handlesPrefix);
  if ("httpForward" in k)    return new HttpForwardToolBackend(k.httpForward, b.handlesPrefix);
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
  constructor(
    private readonly path:        string,
    private readonly urlBinding:  string,
    private readonly stripPrefix: string,
  ) {}

  match(request: Request): boolean {
    const u = new URL(request.url);
    return u.pathname === this.path || u.pathname.startsWith(this.path + "/");
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
          ("httpForward"    in b.kind) ? b.kind.httpForward    :
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
        if ("httpForward" in b.kind && b.kind.httpForward.dynamicTools && b.handlesPrefix === "") {
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
