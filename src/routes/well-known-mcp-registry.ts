// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MCP Registry OpenAPI surface — cloister as a private MCP Registry
// (ADR-0016, cloister-a30e40, Phase 3 of the MCP spec-alignment arc per
// ADR-0015).
//
// The MCP Registry spec at modelcontextprotocol.io/registry defines a
// standardised REST API (`/v0.1/servers`, `/v0.1/servers/{name}`) for
// host applications to discover MCP servers. The public registry is one
// implementation; the OpenAPI spec is explicitly written so *other*
// registries — including private ones — can implement the same shape
// and be consumed by the same host tooling.
//
// Cloister already declares its upstream catalog in `cloister.capnp`
// (mache, ley-line-open lsp, rosary, …). Surfacing that catalog under
// the Registry shape is structurally free: one URLPattern + a synthesis
// function. Host applications that already know how to consume an MCP
// Registry see cloister as one and can enumerate its tenants the
// standard way.
//
// ## Endpoint catalog
//
//   GET /.well-known/mcp-registry/v0.1/servers          list (paginated)
//   GET /.well-known/mcp-registry/v0.1/servers/{name}   single server.json
//
// `{name}` is the URL-encoded server name in the reverse-DNS form
// `art.agentic-research/cloister/<backend-id>`.
//
// ## Why under /.well-known
//
// The official registry serves `/v0.1/servers` at the root of its host.
// Cloister already binds `/mcp`, `/v2/*`, `/identity/*`, `/health`,
// `/.well-known/*` at the same origin — putting the registry under
// `.well-known/` avoids name collision with future top-level routes and
// makes it co-discoverable with the other identity / metadata
// endpoints. The OpenAPI shape is preserved — only the path prefix
// differs.
//
// Spec divergence ADR-0016 records:
//
//   - Path prefix is `/.well-known/mcp-registry/v0.1/...` not `/v0.1/...`
//   - List endpoint shape, server.json fields, and 404 semantics
//     conform to the spec exactly.
//   - Read-only: `POST /publish` and version-history endpoints are
//     deferred. Cloister upstreams aren't independently versioned —
//     each one's version is whatever the backend reports.
//
// ## Constant-time 404
//
// `GET /.well-known/mcp-registry/v0.1/servers/{name}` for an unknown
// name returns a constant-time 404 modelled on the disclosure-endpoint
// pattern (threat-model §9). Reasoning: the server catalog is public
// metadata, so the existence-oracle concern is weaker than disclosure's
// — but the symmetry costs nothing and keeps the response shape
// uniform across cloister's well-known surface.

import type { EdgeRoute } from "../router.js";
import type { Env } from "../types.js";
import type {
  Backend,
  Gateway,
  HttpForwardBackend,
  LeylineNetBackend,
} from "../manifest/types.js";

// ── URLPatterns ───────────────────────────────────────────────────────────

const PATTERN_LIST   = new URLPattern({
  pathname: "/.well-known/mcp-registry/v0.1/servers",
});
const PATTERN_DETAIL = new URLPattern({
  pathname: "/.well-known/mcp-registry/v0.1/servers/:name+",
});

// ── Namespace conventions ─────────────────────────────────────────────────

/**
 * Reverse-DNS prefix for cloister-managed server names. Per the MCP
 * Registry spec's namespace rules: the public registry uses
 * `io.github.<user>/<server>` and similar; cloister uses
 * `art.agentic-research/cloister/<backend-id>` to identify both the
 * upstream tenant (`<backend-id>`) and the routing fabric (`cloister`)
 * under the ART umbrella namespace.
 */
const SERVER_NAME_PREFIX = "art.agentic-research/cloister/";

/**
 * Server.json schema URL the spec defines. Emitted as the `$schema`
 * field on each server detail.
 */
const SERVER_JSON_SCHEMA_URL =
  "https://modelcontextprotocol.io/schemas/draft/2025-12-01/server.schema.json";

/**
 * `_meta` extension namespace key the spec reserves for registries to
 * surface their own metadata on a server entry. Per the OpenAPI spec
 * the public registry uses this exact key; private registries SHOULD
 * use the same key so consumers can parse it uniformly.
 */
const META_REGISTRY_KEY = "io.modelcontextprotocol.registry/official";

// ── Schema (TS mirror of server.json) ─────────────────────────────────────

interface ServerRemote {
  readonly type: "streamable-http" | "sse" | "stdio";
  readonly url:  string;
}

interface ServerRepository {
  readonly url:    string;
  readonly source: string;
}

interface ServerDetail {
  readonly $schema?:    string;
  readonly name:        string;
  readonly description: string;
  readonly version:     string;
  readonly repository?: ServerRepository;
  readonly remotes?:    readonly ServerRemote[];
}

interface RegistryMetaEntry {
  readonly id:           string;
  readonly publishedAt:  string;
  readonly updatedAt:    string;
  readonly isLatest:     boolean;
  readonly status:       "active";
}

interface RegistryEnvelopeMeta {
  readonly [META_REGISTRY_KEY]: RegistryMetaEntry;
}

interface ServerEnvelope {
  readonly server: ServerDetail;
  readonly _meta:  RegistryEnvelopeMeta;
}

interface ServerListResponse {
  readonly servers:  readonly ServerEnvelope[];
  readonly metadata: {
    readonly count:      number;
    readonly nextCursor: string | null;
  };
}

// ── Public route ──────────────────────────────────────────────────────────

export class WellKnownMcpRegistryRoute implements EdgeRoute {
  constructor(private readonly manifest: Gateway) {}

  match(request: Request): boolean {
    if (request.method !== "GET") return false;
    return (
      PATTERN_LIST.test(request.url) ||
      PATTERN_DETAIL.test(request.url)
    );
  }

  async handle(request: Request, _env: Env): Promise<Response> {
    const url = request.url;
    const base = baseUrl(request);

    // ── /.well-known/mcp-registry/v0.1/servers ─────────────────────────────
    if (PATTERN_LIST.test(url)) {
      const servers = synthesizeAll(this.manifest, base);
      const body: ServerListResponse = {
        servers,
        metadata: {
          count:      servers.length,
          // Phase 3 returns the full catalog in one shot — cloister's
          // upstream count is bounded by the manifest (≤20 in practice).
          // Pagination wiring is here as null; a future bead will add
          // real cursor handling once the catalog can exceed a single
          // page.
          nextCursor: null,
        },
      };
      return jsonResponse(body);
    }

    // ── /.well-known/mcp-registry/v0.1/servers/{name} ──────────────────────
    {
      const m = PATTERN_DETAIL.exec(url);
      if (m) {
        // URLPattern's `:name+` greedy-binds the rest of the path, so
        // an encoded slash inside the name segment round-trips
        // correctly. Decode for matching against synthesized names.
        const raw = m.pathname.groups.name ?? "";
        const decoded = safeDecode(raw);
        if (decoded === null) {
          // Malformed percent-encoding — constant-time 404 instead of
          // 400 so the response shape doesn't leak well-formedness.
          return constantTime404();
        }
        const entry = findByName(this.manifest, base, decoded);
        if (!entry) {
          return constantTime404();
        }
        return jsonResponse(entry);
      }
    }

    // Unreachable — match() filters to the two patterns above.
    return constantTime404();
  }
}

// ── Catalog synthesis ─────────────────────────────────────────────────────

/**
 * Walk the manifest's mcp routes and emit one server.json envelope per
 * externally-shaped backend. Pure over (manifest, baseUrl) so tests can
 * exercise it without a Request.
 *
 * Excluded backends:
 *
 *   - `durableObject` (BeadStore) — intra-cluster compute, not an MCP
 *     server in the spec's sense. The DO doesn't speak MCP on a URL;
 *     callers reach it through cloister's `/mcp` aggregation. Surfacing
 *     it as a Registry entry would mislead consumers.
 *   - `serviceBinding` (notme) — same reasoning. Workerd Fetcher
 *     binding, not an addressable MCP server.
 *
 * Included: `httpForward` and `leylineNet` — both project to a real
 * upstream that consumers could call directly given the right network
 * placement.
 */
export function synthesizeAll(manifest: Gateway, base: string): readonly ServerEnvelope[] {
  const out: ServerEnvelope[] = [];
  for (const route of manifest.routes) {
    if (!("mcp" in route.kind)) continue;
    for (const backend of route.kind.mcp.backends) {
      const detail = synthesizeOne(backend, base);
      if (!detail) continue;
      out.push({
        server: detail,
        _meta:  buildMetaEnvelope(detail.name),
      });
    }
  }
  return out;
}

function synthesizeOne(backend: Backend, base: string): ServerDetail | null {
  const k = backend.kind;
  if ("httpForward" in k) {
    return buildDetailFromHttpForward(backend, k.httpForward, base);
  }
  if ("leylineNet" in k) {
    return buildDetailFromLeylineNet(backend, k.leylineNet, base);
  }
  // durableObject + serviceBinding + udsForward are not externally-
  // shaped backends; omit from the public registry surface.
  return null;
}

function buildDetailFromHttpForward(
  backend:  Backend,
  forward:  HttpForwardBackend,
  base:     string,
): ServerDetail {
  return {
    $schema:     SERVER_JSON_SCHEMA_URL,
    name:        `${SERVER_NAME_PREFIX}${backend.name}`,
    description: describeBackend(backend, forward.tools.length, /* dynamic= */ !!forward.dynamicTools),
    // Cloister doesn't track upstream versions — emit a placeholder
    // that's spec-valid (semver). When per-upstream version is wired
    // (e.g. via dynamic capabilities), this becomes the real value.
    version:     "0.0.0",
    remotes:     [{ type: "streamable-http", url: `${base}/mcp` }],
  };
}

function buildDetailFromLeylineNet(
  backend:  Backend,
  leyline:  LeylineNetBackend,
  base:     string,
): ServerDetail {
  void leyline;
  return {
    $schema:     SERVER_JSON_SCHEMA_URL,
    name:        `${SERVER_NAME_PREFIX}${backend.name}`,
    description: describeBackend(backend, 0, /* dynamic= */ true),
    version:     "0.0.0",
    remotes:     [{ type: "streamable-http", url: `${base}/mcp` }],
  };
}

function describeBackend(backend: Backend, toolCount: number, dynamic: boolean): string {
  // Spec caps description at 100 chars. Cloister-side names are short
  // (mache, lsp, leyline-lifecycle) so the synthesized text fits.
  const prefix = backend.handlesPrefix
    ? `${backend.name} (${backend.handlesPrefix}* tools)`
    : backend.name;
  const tail = dynamic
    ? "dynamic tools"
    : `${toolCount} tool${toolCount === 1 ? "" : "s"}`;
  const text = `${prefix} — proxied through cloister, ${tail}`;
  return text.length > 100 ? `${text.slice(0, 97)}...` : text;
}

function buildMetaEnvelope(serverName: string): RegistryEnvelopeMeta {
  // The public registry stamps real UUIDs + ISO timestamps on every
  // record. Cloister's catalog is manifest-derived and stateless —
  // there's no "publishedAt" event to record. We emit deterministic
  // ids derived from the server name so consumers that key off `id`
  // get a stable identifier across calls, and timestamps pinned to a
  // reference epoch so the surface looks coherent without requiring
  // per-request mutable state.
  const id = `cloister:${serverName}`;
  const ts = "1970-01-01T00:00:00Z";
  return {
    [META_REGISTRY_KEY]: {
      id,
      publishedAt: ts,
      updatedAt:   ts,
      isLatest:    true,
      status:      "active",
    },
  };
}

function findByName(
  manifest: Gateway,
  base:     string,
  name:     string,
): ServerEnvelope | null {
  // Catalog is small (≤20 entries) — linear scan is fine, and a Map
  // would be premature optimization. The synthesize path is what
  // tests assert against; reusing it here keeps the two paths in lockstep.
  //
  // Defense-in-depth: `synthesizeAll` already filters out backend kinds
  // that aren't externally-shaped (durableObject / serviceBinding /
  // udsForward — see synthesizeOne), so any name belonging to such a
  // backend is absent from the catalog and `find` returns undefined,
  // collapsing to the constant-time 404 in the caller. Even if a future
  // refactor decouples this lookup from synthesizeAll, the same kind
  // filter must apply — the single-server endpoint MUST NOT leak
  // intra-cluster backends as 200-with-nulls (cloister-ec7a52).
  const all = synthesizeAll(manifest, base);
  return all.find((e) => e.server.name === name) ?? null;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function baseUrl(request: Request): string {
  // Compute the issuer URL from the inbound Request. Same convention as
  // well-known-identity.ts — workerd / Cloudflare Workers populate
  // request.url with the public origin, so this is the canonical
  // hostname for the deployment.
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: {
      "content-type":  "application/json; charset=utf-8",
      // Catalog is derived from the build-time manifest; stable across
      // a deploy. 5-minute browser cache matches the other well-known
      // routes (well-known.ts, well-known-identity.ts).
      "cache-control": "public, max-age=300, must-revalidate",
    },
  });
}

/**
 * Constant-shape 404 for unknown server names. Body is fixed-length
 * JSON envelope so probing for which names exist by response size is
 * defeated — modelled on the disclosure endpoint's
 * `constantTimeErrorResponse`. The status code itself is observable,
 * but that's intentional: the spec's GET-on-unknown-name is 404.
 */
function constantTime404(): Response {
  // Fixed-shape envelope, padded with a constant comment field to a
  // round size. Keeps the response valid JSON for clients that parse
  // unconditionally, while making the byte length independent of which
  // name was requested.
  const body = JSON.stringify({
    error:   "not_found",
    message: "server not found",
    _pad:    "0".repeat(192),
  });
  return new Response(body, {
    status: 404,
    headers: {
      "content-type":   "application/json; charset=utf-8",
      "cache-control":  "no-store",
      "content-length": String(new TextEncoder().encode(body).byteLength),
    },
  });
}

/**
 * `decodeURIComponent` throws on malformed sequences (`%G0`, lone `%`,
 * etc.). Wrap so we can return a clean 404 instead of a 500.
 */
function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}
