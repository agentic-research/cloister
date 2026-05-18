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
 * Phase 5 — audit receipts seam. The handler emits exactly one
 * `ProxyCallReceipt` per call (success OR upstream error), capturing
 * only non-sensitive metadata: capability + peerFp + service +
 * upstreamStatus + sizes + wall-clock + tsMs + nonceHex. The
 * receipt MUST NOT carry credential bytes, request body, query
 * string, or response bytes — those are spec-pinned by the
 * "no-leak" Phase 5 tests + the Phase 7 follow-up invariants.
 */
export interface ReceiptEmitter {
  emit: (receipt: ProxyCallReceipt) => void;
}

/**
 * Phase 7 — metric emitter seam. The handler emits exactly one
 * `(name, labels)` pair per call. Labels are bounded-cardinality
 * non-secret metadata: `service`, `peer_fp` (cert fingerprint, NOT
 * credential), `status`, `injection_kind`. NEVER includes the
 * credential value, request body, query string, or upstream URL
 * fragments — pinned by the Phase 7 "metric labels do NOT include
 * credential" test.
 */
export interface MetricEmitter {
  emit: (metric: { name: string; labels: Record<string, string | number> }) => void;
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
  /** Optional receipt emitter — when present, one receipt per call (Phase 5). */
  receipts?: ReceiptEmitter;
  /** Optional metric emitter — when present, one metric per call (Phase 7). */
  metrics?: MetricEmitter;
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

  // Phase 6 — per-(peerFp, service) rate limit. 429 is distinct
  // from the constant-shape 401/403/404 because reaching this gate
  // means the caller already passed identity + scope + credential
  // checks — they're authorized, just being slowed. No additional
  // oracle is leaked vs. the 200 they'd otherwise get.
  if (!consumeRateBudget(req.verifiedLease.peerFp, req.serviceConfig)) {
    return new Response(
      JSON.stringify({ error: "rate_limited", service: req.serviceConfig.name }),
      { status: 429, headers: { "content-type": "application/json" } },
    );
  }

  return proxyWithReceipt(req, req.storedCredential, req.serviceConfig);
}

/**
 * Phase 6 — per-(peerFp, service) fixed-window rate limit. Module-
 * scoped Map keyed by `${peerFp}::${service}` so two distinct peers
 * (or one peer hitting two distinct services) get independent
 * buckets. Window is 60s rolling. `rateLimitPerMinute = 0` is
 * documented as "unlimited" and skips the gate.
 *
 * Fixed window is simpler than token bucket and adequate for the
 * defense-in-depth role: per-(peerFp, service) rate limits AREN'T
 * the primary cost shield (the verified-lease pipeline + the
 * per-service rateLimitPerMinute config + upstream's own rate
 * limits all sit in front); this gate exists so a single
 * compromised peer can't burn down a service's upstream-side budget
 * without the operator noticing.
 */
const RATE_BUCKETS = new Map<string, { count: number; windowStart: number }>();
const RATE_WINDOW_MS = 60 * 1000;

function consumeRateBudget(peerFp: string, cfg: VaultProxyService): boolean {
  if (cfg.rateLimitPerMinute <= 0) return true;
  const key = `${peerFp}::${cfg.name}`;
  const now = Date.now();
  let bucket = RATE_BUCKETS.get(key);
  if (bucket === undefined || (now - bucket.windowStart) >= RATE_WINDOW_MS) {
    bucket = { count: 0, windowStart: now };
    RATE_BUCKETS.set(key, bucket);
  }
  if (bucket.count >= cfg.rateLimitPerMinute) return false;
  bucket.count += 1;
  return true;
}

/** Test-only — clears the rate-limit state between tests. */
export function __resetRateBuckets(): void {
  RATE_BUCKETS.clear();
}

/**
 * Phase 5 — wrap `proxyToUpstream` with measure-and-emit. One
 * receipt per call regardless of outcome (success, upstream 5xx,
 * thrown). The receipt commits only non-sensitive metadata; the
 * helpers `requestSizeFromHeaders` + `peekResponseSize` use
 * content-length when available and fall back to 0 (an unknown size
 * is information about the body, but it's not credential bytes —
 * acceptable per spec).
 */
async function proxyWithReceipt(
  req: VaultProxyRequest,
  credential: string,
  cfg: VaultProxyService,
): Promise<Response> {
  const peerFp = req.verifiedLease!.peerFp;
  const startMs = Date.now();
  const reqSize = requestSizeFromHeaders(req.request);
  let status = 0;
  let respSize = 0;
  try {
    const res = await proxyToUpstream(req, credential, cfg);
    status = res.status;
    respSize = peekResponseSize(res);
    return res;
  } finally {
    if (req.receipts) {
      const receipt: ProxyCallReceipt = {
        capability:       "cloister/credential-isolation/v1",
        peerFp,
        service:          cfg.name,
        upstreamStatus:   status,
        // Path-only, NO query string (Phase 5 no-leak invariant) —
        // strip everything from `?` onward; query params can carry
        // PII / tokens / user-supplied secrets.
        upstreamUrlPath:  req.upstreamPath.split("?")[0],
        requestSizeBytes: reqSize,
        responseSizeBytes: respSize,
        wallClockMs:      Date.now() - startMs,
        tsMs:             startMs,
        nonceHex:         generateNonceHex(),
      };
      req.receipts.emit(receipt);
    }
    if (req.metrics) {
      // Phase 7 — bounded-cardinality labels only. NEVER include
      // the credential value, request body, query string, or
      // upstream URL fragments.
      req.metrics.emit({
        name: "vault_proxy_call",
        labels: {
          service:        cfg.name,
          peer_fp:        peerFp,
          status:         status,
          injection_kind: cfg.injection.kind,
        },
      });
    }
  }
}

function requestSizeFromHeaders(r: Request): number {
  const cl = r.headers.get("content-length");
  if (cl !== null) {
    const n = Number.parseInt(cl, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }
  return 0;
}

function peekResponseSize(r: Response): number {
  const cl = r.headers.get("content-length");
  if (cl !== null) {
    const n = Number.parseInt(cl, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }
  return 0;
}

function generateNonceHex(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
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
  const baseUrl = cfg.upstreamBaseUrl.replace(/\/+$/, "") + req.upstreamPath;
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

  const strategy = cfg.injection;
  const username = req.storedUsername ?? cfg.name;

  // ── header-shaped strategies (Phase 2) ─────────────────────────────
  if (
    strategy.kind === "authorizationBearer" ||
    strategy.kind === "authorizationBasic" ||
    strategy.kind === "headerNamed"
  ) {
    applyHeaderInjection(upstreamHeaders, strategy, credential, username);
    return req.upstream.fetch(buildUpstreamRequest(baseUrl, req, upstreamHeaders, undefined));
  }

  // ── queryParam (Phase 3) ───────────────────────────────────────────
  if (strategy.kind === "queryParam") {
    const url = appendQueryParam(baseUrl, strategy.name, credential);
    return req.upstream.fetch(buildUpstreamRequest(url, req, upstreamHeaders, undefined));
  }

  // ── bodyField (Phase 3) ────────────────────────────────────────────
  if (strategy.kind === "bodyField") {
    // bodyField is fundamentally incompatible with streaming (need
    // the whole JSON to deep-set); we buffer. Streaming pass-through
    // for the other strategies is preserved.
    const original = await req.request.text();
    const parsed = original.length === 0 ? {} : JSON.parse(original);
    const merged = deepSetPath(parsed, strategy.path, credential);
    upstreamHeaders.set("content-type", "application/json");
    return req.upstream.fetch(buildUpstreamRequest(baseUrl, req, upstreamHeaders, JSON.stringify(merged)));
  }

  // Exhaustiveness — TS narrows `strategy` to `never` here when all
  // arms above are present; if a new InjectionStrategy variant is
  // added without an arm, this throws at runtime (and tsc errors at
  // build) so we don't silently drop strategies.
  const _exhaustive: never = strategy;
  throw new Error(
    `cloister/credential-isolation/v1: unknown injection.kind ${JSON.stringify(_exhaustive)}`,
  );
}

/**
 * Build the outgoing upstream Request. Threads `req.request.signal`
 * (Phase 4 — client-disconnect propagates to the upstream fetch so
 * we don't keep paying for bytes the client will never read). When
 * `overrideBody` is provided (e.g. `bodyField` deep-set result),
 * use it; otherwise stream-pass-through `req.request.body` for
 * methods that allow a body.
 */
function buildUpstreamRequest(
  url: string,
  req: VaultProxyRequest,
  headers: Headers,
  overrideBody: BodyInit | undefined,
): Request {
  const init: RequestInit = {
    method:  req.request.method,
    headers,
    signal:  req.request.signal,
  };
  if (overrideBody !== undefined) {
    init.body = overrideBody;
  } else if (methodCanHaveBody(req.request.method)) {
    init.body = req.request.body;
  }
  return new Request(url, init);
}

function applyHeaderInjection(
  headers: Headers,
  strategy: { kind: "authorizationBearer" } | { kind: "authorizationBasic" } | { kind: "headerNamed"; name: string },
  credential: string,
  username: string,
): void {
  switch (strategy.kind) {
    case "authorizationBearer":
      headers.set("Authorization", `Bearer ${credential}`);
      return;
    case "authorizationBasic": {
      // btoa is the workerd-native base64 encoder for ASCII strings.
      headers.set("Authorization", `Basic ${btoa(`${username}:${credential}`)}`);
      return;
    }
    case "headerNamed":
      headers.set(strategy.name, credential);
      return;
  }
}

/**
 * Append a query param to a URL string, encoding the value with
 * `encodeURIComponent` (NOT `URLSearchParams` — the latter encodes
 * spaces as `+`, which some upstream servers reject for credential
 * tokens that legitimately contain `+`).
 */
function appendQueryParam(urlStr: string, name: string, value: string): string {
  const sep = urlStr.includes("?") ? "&" : "?";
  return `${urlStr}${sep}${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
}

/**
 * Deep-set a credential at a dotted path inside a JSON object,
 * returning a new object (no mutation of the input). Intermediate
 * objects are created when missing. The leaf value is the credential
 * string; pre-existing siblings at every level are preserved.
 *
 * `"client_secret"` → top-level key.
 * `"auth.client_secret"` → nested. Two levels.
 */
function deepSetPath(obj: unknown, path: string, value: string): Record<string, unknown> {
  const segments = path.split(".");
  if (segments.length === 0) throw new Error("bodyField path must be non-empty");
  const root: Record<string, unknown> =
    obj !== null && typeof obj === "object" && !Array.isArray(obj)
      ? { ...(obj as Record<string, unknown>) }
      : {};
  let cursor: Record<string, unknown> = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const next = cursor[seg];
    const child: Record<string, unknown> =
      next !== null && typeof next === "object" && !Array.isArray(next)
        ? { ...(next as Record<string, unknown>) }
        : {};
    cursor[seg] = child;
    cursor = child;
  }
  cursor[segments[segments.length - 1]] = value;
  return root;
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
