// src/routes/vault-proxy.ts — `cloister/credential-isolation/v1` route.
//
// Stub module. Defines the type surface against which failing tests
// link; impl is "not implemented" until the phased plan in
// docs/plans/credential-isolation-capability.md walks it green.
//
// Spec: cloister-spec/credential-isolation/v1/
// ADR: docs/adr/0024-credential-isolation-capability.md
// Tracking: cloister-8f57f0

import { checkAccess } from "../../vault/src/vault.js";
import type { VerifiedLease } from "../routes/lease-middleware.js";

/**
 * Discriminated union of injection strategies per
 * cloister-spec/credential-isolation/v1/wire/injection-strategies.md.
 * Closed-by-design in v1; adding a strategy requires a spec extension.
 */
export type InjectionStrategy =
  | { kind: "authorizationBearer" }
  | { kind: "authorizationBasic" }
  | { kind: "headerNamed"; name: string }
  | { kind: "queryParam"; name: string }
  | { kind: "bodyField"; path: string };

/**
 * Per-service config the proxy consumes — either from a manifest
 * extension (Phase 11) or, until then, from a side-channel
 * TOML file at cloister-spec/credential-isolation/v1/example-services.toml.
 */
export interface VaultProxyService {
  /** Logical service name, e.g. "openai". Matches the path segment. */
  name: string;
  /** Upstream base URL, e.g. "https://api.openai.com". */
  upstreamBaseUrl: string;
  /** Where the credential is injected into the upstream request. */
  injection: InjectionStrategy;
  /**
   * Glob list applied when a credential is added without explicit
   * allowedSubs (e.g. `[ "skill/openai/*" ]`).
   */
  defaultAllowedSubs: string[];
  /** Per-(peerFp, service) bucket. 0 = unlimited (NOT recommended). */
  rateLimitPerMinute: number;
}

/**
 * Upstream fetcher seam. The route's composition root supplies a
 * concrete fetcher (the global `fetch`, or a service-binding fetcher
 * for in-cluster upstreams); tests supply a mock. The handler never
 * dials directly so identity-isolation tests + integration tests can
 * pin the exact outbound request shape.
 */
export interface UpstreamFetcher {
  fetch: (request: Request) => Promise<Response>;
}

/**
 * What the route gets after middleware passes. The lease is verified
 * upstream by `src/routes/lease-middleware.ts` per ADR-0007. The
 * credential lookup happens at route entry too (keyed by peerFp +
 * service); the handler is pure over its inputs.
 */
export interface VaultProxyRequest {
  request: Request;
  service: string;
  upstreamPath: string;
  verifiedLease: VerifiedLease | null;
  serviceConfig: VaultProxyService | null;
  /** Credential bytes for the matched (peerFp, service). null if no cred is stored. */
  storedCredential: string | null;
  /** Optional username pair for `authorizationBasic` injection (else service.name). */
  storedUsername?: string;
  /** Upstream fetcher (production wires global fetch; tests pass a mock). */
  upstream: UpstreamFetcher;
}

/**
 * The proxy handler. Returns the upstream response streamed through,
 * with a signed Interlace-Receipt header attached.
 *
 * Conformance shape: cloister-spec/credential-isolation/v1/wire/proxy-envelope.md
 *
 * Phase 1 — identity gates only:
 *
 *   - `verifiedLease === null`  → 401 (lease invalid / missing / replayed
 *                                / past clock-skew bound; upstream
 *                                middleware collapses ALL of those to
 *                                a null lease before we see it).
 *   - `serviceConfig === null`  → 404 (service not declared in manifest).
 *   - `peerFp ∉ allowedSubs`    → 403 (caller not authorized for this
 *                                service; glob-matched via checkAccess).
 *
 * All three rejection paths return the SAME constant-time JSON body
 * (CONSTANT_TIME_ERROR_BODY) so a probing client cannot distinguish
 * "service missing" from "I'm not authorized" from "lease invalid" —
 * enumeration-oracle closure mirrored from vault DO's §9.4.b
 * collapse (cloister-aa9376).
 *
 * Phases 2+ (header injection, query/body injection, streaming,
 * receipts, rate limit, no-leak invariants) replace the success-path
 * `throw` below.
 */
export async function vaultProxyHandler(
  req: VaultProxyRequest,
): Promise<Response> {
  if (req.verifiedLease === null) return rejection(401);
  if (req.serviceConfig === null) return rejection(404);
  if (!checkAccess(req.serviceConfig.defaultAllowedSubs, req.verifiedLease.peerFp)) {
    return rejection(403);
  }
  // No stored credential for this (peerFp, service) → 404 with same
  // constant-shape body. From a probing client's POV this is
  // indistinguishable from "service not declared," preserving the
  // §9.4.b enumeration-oracle invariant.
  if (req.storedCredential === null) return rejection(404);

  return proxyToUpstream(req, req.storedCredential, req.serviceConfig);
}

/**
 * Phase 2 — apply the configured injection strategy + forward to
 * upstream. The credential goes UPSTREAM only; the caller-facing
 * response is the upstream's response unmodified (the "client never
 * observes the stored credential" invariant relies on the upstream
 * being trusted not to echo, which is the contract operators sign
 * up for when they declare a service in the manifest).
 *
 * Phases 3+ add query-param + body-field injection, streaming
 * pass-through, receipts, rate limit, and the no-leak defense in depth.
 */
async function proxyToUpstream(
  req: VaultProxyRequest,
  credential: string,
  cfg: VaultProxyService,
): Promise<Response> {
  const upstreamUrl = cfg.upstreamBaseUrl.replace(/\/+$/, "") + req.upstreamPath;
  const upstreamHeaders = new Headers(req.request.headers);
  // Strip ALL Interlace lease headers — they're cloister-internal,
  // never forwarded to a credentialed upstream (separate trust
  // boundary; the upstream sees a freshly-injected credential, not
  // the caller's peer identity).
  for (const key of Array.from(upstreamHeaders.keys())) {
    if (key.toLowerCase().startsWith("x-interlace-")) {
      upstreamHeaders.delete(key);
    }
  }
  applyInjection(upstreamHeaders, cfg.injection, credential, req.storedUsername ?? cfg.name);
  const upstreamReq = new Request(upstreamUrl, {
    method:  req.request.method,
    headers: upstreamHeaders,
    body:    methodCanHaveBody(req.request.method) ? req.request.body : undefined,
  });
  return req.upstream.fetch(upstreamReq);
}

function applyInjection(
  headers: Headers,
  strategy: InjectionStrategy,
  credential: string,
  username: string,
): void {
  switch (strategy.kind) {
    case "authorizationBearer":
      headers.set("Authorization", `Bearer ${credential}`);
      return;
    case "authorizationBasic": {
      const pair = `${username}:${credential}`;
      // btoa is the workerd-native base64 encoder for ASCII strings.
      headers.set("Authorization", `Basic ${btoa(pair)}`);
      return;
    }
    case "headerNamed":
      headers.set(strategy.name, credential);
      return;
    case "queryParam":
    case "bodyField":
      // Phase 3 — implemented when the query/body tests come back online.
      throw new Error(
        `cloister/credential-isolation/v1: injection.kind=${strategy.kind} not yet implemented (Phase 3)`,
      );
  }
}

function methodCanHaveBody(method: string): boolean {
  const m = method.toUpperCase();
  return m !== "GET" && m !== "HEAD";
}

function rejection(status: 401 | 403 | 404): Response {
  return new Response(CONSTANT_TIME_ERROR_BODY, {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Parse `/vault/proxy/<service>/<rest...>` into a service + upstream
 * path. Returns null if the path doesn't match the proxy shape.
 *
 * This is the only piece small enough to land in Phase 0 — the type
 * surface for tests to assert against. The handler stays a stub.
 */
export function parseVaultProxyPath(
  pathname: string,
): { service: string; upstreamPath: string } | null {
  const PREFIX = "/vault/proxy/";
  if (!pathname.startsWith(PREFIX)) return null;
  const tail = pathname.slice(PREFIX.length);
  const firstSlash = tail.indexOf("/");
  if (firstSlash === -1) {
    // /vault/proxy/<service> with no upstream path — valid; upstream
    // path is "/" (the upstream's root resource).
    return tail.length === 0
      ? null
      : { service: tail, upstreamPath: "/" };
  }
  const service = tail.slice(0, firstSlash);
  const upstreamPath = tail.slice(firstSlash); // includes leading slash
  if (service.length === 0) return null;
  return { service, upstreamPath };
}

/**
 * Constant-time error body shape — same JSON for 401/403/404 to
 * prevent the proxy from being used as an enumeration oracle for
 * which credentials are stored. Per
 * cloister-spec/credential-isolation/v1/wire/proxy-envelope.md.
 */
export const CONSTANT_TIME_ERROR_BODY = JSON.stringify({
  error: "unauthorized",
  reason: "credential not available or caller not authorized",
});

/**
 * The receipt commitment shape. Per
 * cloister-spec/credential-isolation/v1/wire/receipt-commitment.md
 * (which lands in Phase 5).
 *
 * MUST NOT include the credential value, request body, response body,
 * query string, or allowedSubs list.
 */
export interface ProxyCallReceipt {
  capability: "cloister/credential-isolation/v1";
  peerFp: string;
  service: string;
  upstreamStatus: number;
  upstreamUrlPath: string;
  requestSizeBytes: number;
  responseSizeBytes: number;
  wallClockMs: number;
  tsMs: number;
  nonceHex: string;
}
