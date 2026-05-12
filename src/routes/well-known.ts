/**
 * GET /.well-known/interlace/index.json — Interlace discovery doc
 * (ADR-0007). The body is synthesized at request time from the typed
 * manifest's `actor`, `policy`, and mcp-route capabilities. Manifest is
 * the single source of truth — capabilities flow from `cloister.capnp`,
 * never hand-maintained alongside.
 *
 * Schema follows Interlace §4.1 (extended Cloudflare Agent Skills RFC).
 * The actor's master public key bytes are loaded from the env binding
 * named in `actor.pubkeyBinding` and emitted as base64url at request
 * time; the binding name itself is in the manifest, the key bytes are
 * not.
 *
 * Empty `actor.fingerprint` opts the cloister out of Interlace
 * discovery — the route returns 404 in that case so peers fall back to
 * out-of-band configuration.
 */

import type { EdgeRoute } from "../router.js";
import type { Env } from "../types.js";
import type {
  Backend,
  Gateway,
  InterlacePolicy,
  McpToolSpec,
  Route,
} from "../manifest/types.js";

// ── Public route ──────────────────────────────────────────────────────────

export class WellKnownInterlaceRoute implements EdgeRoute {
  constructor(
    private readonly path:     string,
    private readonly manifest: Gateway,
  ) {}

  match(request: Request): boolean {
    return (
      request.method === "GET" &&
      new URL(request.url).pathname === this.path
    );
  }

  async handle(_request: Request, env: Env): Promise<Response> {
    if (!this.manifest.actor.fingerprint) {
      return new Response("interlace discovery disabled", { status: 404 });
    }

    const body = synthesize(this.manifest, env);

    return new Response(JSON.stringify(body, null, 2), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        // The doc reflects build-time pinned identity + manifest-derived
        // capabilities — stable across the lifetime of a deploy. Long
        // browser cache + ETag for cheap revalidation.
        "cache-control": "public, max-age=300, must-revalidate",
        "etag":          weakEtag(body),
      },
    });
  }
}

// ── Body synthesis ────────────────────────────────────────────────────────

interface CapabilityDoc {
  readonly name:        string;
  readonly description: string;
  readonly scopes:      readonly string[];
}

interface InterlaceDoc {
  readonly version:      string;
  readonly actor: {
    readonly fingerprint:        string;
    readonly master_public_key:  string;  // base64 SPKI/raw, or "" if env unset
    readonly algorithm:          string;
    readonly attestation_repo?:  string;
    readonly tunnel?: {
      readonly endpoint: string;
    };
  };
  readonly capabilities: readonly CapabilityDoc[];
  readonly policy: {
    readonly max_cert_lifetime_seconds: number;
    readonly require_interlock:        boolean;
    readonly min_algorithm:            string;
  };
}

/**
 * Build the discovery doc body. Pure function over (manifest, env) so
 * tests don't need a Request.
 */
export function synthesize(manifest: Gateway, env: Env): InterlaceDoc {
  const actor       = manifest.actor;
  const policy      = manifest.policy;
  const masterKeyB64 = readEnvString(env, actor.pubkeyBinding) ?? "";

  const capabilities = manifest.routes.flatMap(routeCapabilities);

  const actorDoc: InterlaceDoc["actor"] = {
    fingerprint:       actor.fingerprint,
    master_public_key: masterKeyB64,
    algorithm:         actor.algorithm,
    ...(actor.attestationRepo ? { attestation_repo: actor.attestationRepo } : {}),
    ...(actor.tunnelEndpoint  ? { tunnel: { endpoint: actor.tunnelEndpoint } } : {}),
  };

  return {
    version:      "0.1.0",
    actor:        actorDoc,
    capabilities,
    policy:       toPolicyDoc(policy),
  };
}

function toPolicyDoc(p: InterlacePolicy): InterlaceDoc["policy"] {
  return {
    max_cert_lifetime_seconds: p.maxCertLifetimeSeconds,
    require_interlock:         p.requireInterlock,
    min_algorithm:             p.minAlgorithm,
  };
}

// ── Capability extraction ─────────────────────────────────────────────────

function routeCapabilities(route: Route): CapabilityDoc[] {
  if (!("mcp" in route.kind)) return [];
  return route.kind.mcp.backends.flatMap(backendCapabilities);
}

function backendCapabilities(backend: Backend): CapabilityDoc[] {
  const tools: readonly McpToolSpec[] = pickTools(backend);
  return tools.map((tool) => ({
    name:        tool.name,
    description: tool.description,
    scopes:      [scopeFor(tool.name, backend.handlesPrefix)],
  }));
}

function pickTools(backend: Backend): readonly McpToolSpec[] {
  const k = backend.kind;
  if ("durableObject"  in k) return k.durableObject.tools;
  if ("mcpProxy"       in k) return k.mcpProxy.tools;
  if ("serviceBinding" in k) return k.serviceBinding.tools;
  if ("udsForward"     in k) return k.udsForward.tools;
  if ("leylineNet"     in k) return k.leylineNet.tools;
  return [];
}

/**
 * Map an MCP tool name to its Interlace scope string. Default rule:
 * `<tool-name>:*` — peers must request a scope that ⊇ the tool name when
 * minting an ephemeral cert. Per-tool scope refinement happens at the
 * verifier middleware (ADR-0007), not here — this doc just advertises
 * the coarsest scope that covers the tool.
 */
function scopeFor(toolName: string, _prefix: string): string {
  return `${toolName}:*`;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function readEnvString(env: Env, binding: string): string | undefined {
  if (!binding) return undefined;
  const v = (env as unknown as Record<string, unknown>)[binding];
  return typeof v === "string" ? v : undefined;
}

function weakEtag(body: InterlaceDoc): string {
  // Cheap stable hash — fingerprint ⊕ capability count is plenty for
  // cache validation; anything finer-grained would require crypto.subtle
  // (async, not great inside a synthesize+respond path).
  return `W/"${body.actor.fingerprint}-${body.capabilities.length}"`;
}
