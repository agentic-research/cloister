// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Multi-format identity discovery bridge (cloister-c9922f).
//
// First non-MCP tenant of the cloister edge router (ADR-0002). Publishes
// the cluster's existing Interlace identity (master pubkey + manifest-
// declared capabilities) under three additional standard wire formats,
// plus a minimal OAuth2 token endpoint so cloister is a working OIDC
// IdP — not just discoverable.
//
//   GET  /.well-known/openid-configuration   OIDC discovery (RFC 8414 +
//                                            OIDC core 1.0)
//   GET  /.well-known/jwks.json              JWK Set (RFC 7517 + RFC 8037
//                                            for EdDSA / Ed25519)
//   GET  /.well-known/webfinger              JRD (RFC 7033) keyed off
//                                            ?resource=acct:cluster@host
//   GET  /.well-known/nostr.json             NIP-05 names+relays mapping
//   POST /oauth/token                        client_credentials grant
//                                            issuing a JWT signed by the
//                                            cluster master
//
// All five concrete paths share one EdgeRoute because they all project
// the same underlying identity surface: `manifest.actor.fingerprint`,
// the master pubkey at `env[actor.pubkeyBinding]`, and the capabilities
// aggregated across the manifest's mcp routes. Splitting into five
// EdgeRoute classes would multiply boilerplate (constructor, match,
// readEnv, JSON envelope) with no semantic gain.
//
// ## What this is NOT
//
//   - No login UI / authorization-code flow. client_credentials only;
//     adding interactive auth needs its own ADR + bead.
//   - No ActivityPub inbox/outbox. WebFinger only handles identity
//     discovery, not message delivery.
//   - No relay implementation. NIP-05 is just identity mapping.
//   - No placeholder identity. The fingerprint, pubkey, and capabilities
//     all derive from the manifest's real `actor` block + the master
//     pubkey bytes pinned at deploy time. If `actor.fingerprint` is
//     empty (Interlace discovery disabled), the bridge returns 404
//     across all formats — symmetric with WellKnownInterlaceRoute.
//
// ## Token signing
//
// Cloister has only the master *public* key (verifies leases against it
// per src/routes/lease-middleware.ts). The matching private key lives
// in notme's SigningAuthority DO; cloister cannot directly sign with
// it. The token endpoint forwards JWT signing to notme via the existing
// NOTME service binding (`POST /internal/sign-jwt` — a contract notme
// will implement; until then the endpoint surfaces 503). This matches
// the same delegation pattern src/storage/notme-bundle-fetcher.ts uses
// for `/internal/ca-bundle`.

import type { EdgeRoute } from "../router.js";
import type { Env } from "../types.js";
import type { Backend, Gateway, McpToolSpec, Route } from "../manifest/types.js";

// ── Path constants ────────────────────────────────────────────────────────

export const PATH_OIDC_DISCOVERY = "/.well-known/openid-configuration";
export const PATH_JWKS           = "/.well-known/jwks.json";
export const PATH_WEBFINGER      = "/.well-known/webfinger";
export const PATH_NOSTR_NIP05    = "/.well-known/nostr.json";
export const PATH_OAUTH_TOKEN    = "/oauth/token";

/**
 * Notme-side endpoint for JWT signing. The OIDC token endpoint forwards
 * a canonical JSON payload to this endpoint; notme signs with the
 * cluster master Ed25519 key and returns the compact JWS. Same
 * delegation pattern as `notme-bundle-fetcher.ts`. Cross-repo
 * coordination bead tracks the notme-side endpoint.
 */
export const NOTME_SIGN_JWT_PATH = "/internal/sign-jwt";

const ALL_PATHS = new Set<string>([
  PATH_OIDC_DISCOVERY,
  PATH_JWKS,
  PATH_WEBFINGER,
  PATH_NOSTR_NIP05,
  PATH_OAUTH_TOKEN,
]);

// ── Route ────────────────────────────────────────────────────────────────

export class WellKnownIdentityBridgeRoute implements EdgeRoute {
  constructor(private readonly manifest: Gateway) {}

  match(request: Request): boolean {
    const url = new URL(request.url);
    if (!ALL_PATHS.has(url.pathname)) return false;
    // /oauth/token is POST per RFC 6749 §4.4; the four discovery
    // endpoints are GET. Reject other methods with 404 at the router
    // level so the response is indistinguishable from "no such route."
    if (url.pathname === PATH_OAUTH_TOKEN) return request.method === "POST";
    return request.method === "GET";
  }

  async handle(request: Request, env: Env): Promise<Response> {
    // Identity bridge is opt-in via the same lever as the native
    // Interlace discovery doc: empty actor.fingerprint disables it.
    if (!this.manifest.actor.fingerprint) {
      return new Response("identity bridge disabled", { status: 404 });
    }

    const url = new URL(request.url);
    switch (url.pathname) {
      case PATH_OIDC_DISCOVERY: return this.handleOidcDiscovery(request, env);
      case PATH_JWKS:           return this.handleJwks(request, env);
      case PATH_WEBFINGER:      return this.handleWebFinger(request, env);
      case PATH_NOSTR_NIP05:    return this.handleNostrNip05(request, env);
      case PATH_OAUTH_TOKEN:    return this.handleOauthToken(request, env);
    }
    // Unreachable — match() filters to the five paths above.
    return new Response("not found", { status: 404 });
  }

  // ── /.well-known/openid-configuration ───────────────────────────────────

  private handleOidcDiscovery(request: Request, _env: Env): Response {
    const base = baseUrl(request);
    const doc = {
      issuer:                                base,
      jwks_uri:                              `${base}${PATH_JWKS}`,
      token_endpoint:                        `${base}${PATH_OAUTH_TOKEN}`,
      // The cluster master is Ed25519. RFC 8037 registers `EdDSA` as the
      // JWS `alg` value for Ed25519/Ed448 signatures.
      id_token_signing_alg_values_supported: ["EdDSA"],
      subject_types_supported:               ["public"],
      // Phase 1 has no authorization-code flow; clients receive an
      // id_token directly via client_credentials. Adding `code` is its
      // own ADR + bead.
      response_types_supported:              ["id_token"],
      grant_types_supported:                 ["client_credentials"],
    };
    return jsonResponse(doc);
  }

  // ── /.well-known/jwks.json ─────────────────────────────────────────────

  private handleJwks(_request: Request, env: Env): Response {
    const masterB64 = readEnvString(env, this.manifest.actor.pubkeyBinding);
    if (!masterB64) {
      // The pubkey binding is unset — without it we can't publish a
      // verification key, so the IdP isn't operational. 503 matches the
      // ca-bundle-cache `CaUnavailableError` convention.
      return new Response("jwks: master pubkey binding unset", { status: 503 });
    }
    // RFC 8037 §2: EdDSA key in JWK form. `x` is the base64url-no-pad
    // encoding of the raw public key bytes. The stored binding may use
    // base64-standard (mirroring CABundle.keys per cloister-c614ae);
    // convert to base64url for spec compliance.
    const x = base64StdToBase64Url(masterB64);
    const jwk = {
      kty: "OKP",
      crv: "Ed25519",
      x,
      // `kid` derives from the cluster's actor fingerprint so external
      // verifiers can pin a stable identifier; the fingerprint is
      // already a sha256:<hex> string. RFC 7517 §4.5 permits any
      // case-sensitive string as `kid`.
      kid: this.manifest.actor.fingerprint,
      alg: "EdDSA",
      use: "sig",
    };
    return jsonResponse({ keys: [jwk] });
  }

  // ── /.well-known/webfinger ─────────────────────────────────────────────

  private handleWebFinger(request: Request, _env: Env): Response {
    const url = new URL(request.url);
    const resource = url.searchParams.get("resource");
    if (!resource) {
      // RFC 7033 §4.2 — server MUST return 400 if `resource` is missing.
      return new Response("webfinger: missing resource parameter", { status: 400 });
    }
    // The cluster's WebFinger account is `acct:cluster@<host>`. We
    // accept any host matching the request — the cluster doesn't
    // mediate identity for other hosts, and refusing to lookup other
    // identities is the safe default per RFC 7033 §4.4.
    const expected = `acct:cluster@${url.host}`;
    if (resource !== expected) {
      // RFC 7033 §4.4 — 404 for an unknown account.
      return new Response("webfinger: unknown account", { status: 404 });
    }
    const base = baseUrl(request);
    const jrd = {
      subject: expected,
      links: [
        {
          // OIDC discovery link relation, RFC + OpenID Connect Discovery
          // 1.0 §2. Mastodon-flavored verification typically uses
          // `http://webfinger.net/rel/profile-page`, which isn't
          // applicable for a cluster; we surface the OIDC issuer
          // instead so clients can chain to /.well-known/openid-
          // configuration.
          rel:  "http://openid.net/specs/connect/1.0/issuer",
          href: base,
        },
        {
          // Self-link per RFC 7033 §8.4.
          rel:  "self",
          type: "application/jrd+json",
          href: `${base}${PATH_WEBFINGER}?resource=${encodeURIComponent(expected)}`,
        },
      ],
    };
    // RFC 7033 §4.2 — content-type MUST be `application/jrd+json`.
    return new Response(JSON.stringify(jrd, null, 2), {
      status: 200,
      headers: {
        "content-type":                "application/jrd+json; charset=utf-8",
        // RFC 7033 §5 — cross-origin access. WebFinger queries from
        // browsers (e.g. Mastodon's federation UI) require CORS.
        "access-control-allow-origin": "*",
        "cache-control":               "public, max-age=300, must-revalidate",
      },
    });
  }

  // ── /.well-known/nostr.json ────────────────────────────────────────────

  private handleNostrNip05(request: Request, env: Env): Response {
    // NIP-05 takes an optional `?name=<local>` query. The spec allows a
    // server to ignore unknown names; clients query for a specific name
    // before treating the response as a binding. We expose a single
    // identity — `cluster` — keyed off the same actor surface as the
    // other formats.
    const url = new URL(request.url);
    const requestedName = url.searchParams.get("name");
    const masterB64 = readEnvString(env, this.manifest.actor.pubkeyBinding);
    if (!masterB64) {
      return new Response("nostr: master pubkey binding unset", { status: 503 });
    }
    // NIP-05 maps `name → pubkey-hex` (raw 32-byte Ed25519/secp256k1 key
    // encoded as 64 lowercase hex chars). The published surface here
    // uses the Ed25519 master pubkey — Nostr canonically uses
    // secp256k1, but the spec doesn't constrain the curve, only the
    // encoding. Consumers that strictly require secp256k1 will reject
    // this entry; that's fine — they fall back to other discovery.
    const pubHex = base64StdToHex(masterB64);
    const names = requestedName === null || requestedName === "cluster"
      ? { cluster: pubHex }
      : {};  // unknown name → empty mapping (NIP-05 §"Showing just the public key")
    const body = { names, relays: {} as Record<string, string[]> };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        // NIP-05 §"Allowing access from JavaScript apps" — wildcard
        // CORS is REQUIRED so browser-based clients can discover the
        // mapping.
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=300, must-revalidate",
      },
    });
  }

  // ── /oauth/token ───────────────────────────────────────────────────────

  private async handleOauthToken(request: Request, env: Env): Promise<Response> {
    // RFC 6749 §4.4.2 — client_credentials request body is
    // application/x-www-form-urlencoded.
    const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
    if (!contentType.startsWith("application/x-www-form-urlencoded")) {
      return oauthError("invalid_request", "content-type must be application/x-www-form-urlencoded", 400);
    }
    let form: URLSearchParams;
    try {
      form = new URLSearchParams(await request.text());
    } catch {
      return oauthError("invalid_request", "could not parse form body", 400);
    }
    const grantType = form.get("grant_type");
    if (grantType !== "client_credentials") {
      // RFC 6749 §5.2 — `unsupported_grant_type` is the canonical code.
      return oauthError("unsupported_grant_type", `grant_type "${grantType ?? ""}" not supported`, 400);
    }
    // `scope` is optional per §4.4.2 — pass it through to the JWT
    // claims so downstream resources can enforce it. `audience` is an
    // OIDC core extension; default to the issuer if unset.
    const requestedScope = form.get("scope") ?? "";
    const base = baseUrl(request);
    const audience = form.get("audience") ?? base;

    // Build JWT header + payload. JWS compact (RFC 7515 §3.1) is
    // `b64url(header).b64url(payload).b64url(sig)`.
    const nowSec = Math.floor(Date.now() / 1000);
    const ttlSec = 300;  // matches manifest.policy.maxCertLifetimeSeconds default
    const header = {
      alg: "EdDSA",
      typ: "JWT",
      kid: this.manifest.actor.fingerprint,
    };
    const payload: Record<string, unknown> = {
      iss:   base,
      aud:   audience,
      sub:   this.manifest.actor.fingerprint,
      iat:   nowSec,
      exp:   nowSec + ttlSec,
    };
    if (requestedScope) payload.scope = requestedScope;

    const headerB64u   = base64UrlEncodeUtf8(JSON.stringify(header));
    const payloadB64u  = base64UrlEncodeUtf8(JSON.stringify(payload));
    const signingInput = `${headerB64u}.${payloadB64u}`;

    // Delegate the actual Ed25519 sign to notme. The contract is:
    //   POST /internal/sign-jwt
    //   body: { signing_input: "<header>.<payload>" }
    //   resp: { signature: "<base64url>" }
    // Notme's SigningAuthority DO owns the master private key — that
    // key is born in CF and never leaves notme. cloister forwards the
    // signing-input bytes, gets back the signature, and assembles the
    // JWS compact form locally. Same delegation pattern as
    // src/storage/notme-bundle-fetcher.ts.
    const signature = await fetchJwtSignature(env, signingInput);
    if (signature === null) {
      // Notme unreachable, returned non-200, or returned a malformed
      // response. 503 with `temporarily_unavailable` per RFC 6749 §5.2.
      return oauthError(
        "temporarily_unavailable",
        "token signing service unavailable",
        503,
      );
    }

    const jwt = `${signingInput}.${signature}`;
    const body = {
      access_token: jwt,
      token_type:   "Bearer",
      expires_in:   ttlSec,
      ...(requestedScope ? { scope: requestedScope } : {}),
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        "content-type":  "application/json; charset=utf-8",
        // RFC 6749 §5.1 — token responses MUST NOT be cached.
        "cache-control": "no-store",
        "pragma":        "no-cache",
      },
    });
  }
}

// ── Capability synthesis (currently unused publicly but kept for parity) ──

/**
 * Aggregate capability names across the manifest's mcp routes. Mirrors
 * the projection in `src/routes/well-known.ts:synthesize` so the
 * identity bridge can expose the same set if/when an OIDC `scope_values`
 * field needs to be advertised; not surfaced today.
 */
export function capabilityNames(manifest: Gateway): readonly string[] {
  return manifest.routes.flatMap(routeCapabilityNames);
}

function routeCapabilityNames(route: Route): readonly string[] {
  if (!("mcp" in route.kind)) return [];
  return route.kind.mcp.backends.flatMap(backendCapabilityNames);
}

function backendCapabilityNames(backend: Backend): readonly string[] {
  const tools: readonly McpToolSpec[] = pickTools(backend);
  return tools.map((t) => t.name);
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

// ── Notme delegation ─────────────────────────────────────────────────────

/**
 * POST the signing-input bytes to notme's `/internal/sign-jwt` endpoint
 * and return the base64url signature. Returns `null` on any failure;
 * caller maps null → 503 so the OAuth error stays out of the failure
 * detail (no signing-key oracle).
 *
 * Exported for testability — tests can stub the env.NOTME service
 * binding directly, but exposing the helper also lets unit tests
 * assert the contract independently.
 */
export async function fetchJwtSignature(
  env: Env,
  signingInput: string,
): Promise<string | null> {
  try {
    const upstream = `https://notme-bot${NOTME_SIGN_JWT_PATH}`;
    const res = await env.NOTME.fetch(new Request(upstream, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signing_input: signingInput }),
    }));
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    if (typeof body !== "object" || body === null) return null;
    const sig = (body as Record<string, unknown>).signature;
    if (typeof sig !== "string" || sig.length === 0) return null;
    // Defensive: signature MUST be base64url (no padding) per RFC 7515.
    // Reject anything containing `+`, `/`, or `=` — that'd produce an
    // invalid JWS compact form.
    if (/[+/=]/.test(sig)) return null;
    return sig;
  } catch {
    // lint-allow-silent: validate predicate — null = invalid signature format
    return null;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function baseUrl(request: Request): string {
  // Compute the issuer URL from the inbound Request — workerd /
  // Cloudflare Workers populate request.url with the public-facing
  // origin, so this is the canonical issuer for the deployment.
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

function readEnvString(env: Env, binding: string): string | undefined {
  if (!binding) return undefined;
  const v = (env as unknown as Record<string, unknown>)[binding];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: {
      "content-type":  "application/json; charset=utf-8",
      "cache-control": "public, max-age=300, must-revalidate",
    },
  });
}

function oauthError(code: string, description: string, status: number): Response {
  // RFC 6749 §5.2 — error response is a JSON object with `error` (and
  // optional `error_description`). Status is 400/401/503 depending on
  // case; `temporarily_unavailable` is 503.
  return new Response(
    JSON.stringify({ error: code, error_description: description }),
    {
      status,
      headers: {
        "content-type":  "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

/** Convert base64-standard (with `+`, `/`, `=`) to base64url (no pad). */
function base64StdToBase64Url(s: string): string {
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64-standard → lowercase hex. */
function base64StdToHex(s: string): string {
  const bin = atob(s);
  let out = "";
  for (let i = 0; i < bin.length; i++) {
    out += bin.charCodeAt(i).toString(16).padStart(2, "0");
  }
  return out;
}

/** UTF-8 encode a string, then base64url (no pad). */
function base64UrlEncodeUtf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
