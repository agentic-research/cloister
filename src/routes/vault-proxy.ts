// src/routes/vault-proxy.ts — `cloister/credential-isolation/v1` route.
//
// Route handler module. The phased plan in
// docs/plans/credential-isolation-capability.md started with this type
// surface; the success path now injects a vaulted credential, forwards
// the request, streams the upstream response body, and emits call
// telemetry through the route wrapper.
//
// Spec: leyline-schema-spec/credential-isolation/v1/
// ADR: docs/adr/0024-credential-isolation-capability.md
// Tracking: cloister-8f57f0

import { checkAccess } from "../../vault/src/vault.js";
import {
  InjectionRefused,
  injectCredential,
  outboundRequest,
  type Injection,
} from "../../vault/src/inject.js";
import type { VerifiedLease } from "../routes/lease-middleware.js";
import { findForbiddenReceiptField } from "./receipt-guard.js";
import { logEvent } from "../obs/log.js";

/**
 * Discriminated union of injection strategies per
 * leyline-schema-spec/credential-isolation/v1/wire/injection-strategies.md.
 * Closed-by-design in v1; adding a strategy requires a spec extension.
 */
export type InjectionStrategy =
  // The five that inject a credential, computed by the one injection
  // (vault/src/inject.ts, ADR-0082 §1).
  | Injection
  // Audit passthrough (ADR-0040 amendment): inject NOTHING; forward the
  // caller's own request + auth headers and receipt it. For OAuth-subscription
  // harnesses (Claude Code Max) with no key to vault — audit, not custody.
  // Handled at the route level (vault-proxy-route.ts) before credential
  // lookup; never reaches the credential-injecting handler below.
  | { kind: "passthrough" };

/**
 * Per-service config the proxy consumes from the manifest's
 * `Gateway.vaultProxyServices` registry. `cluster.toml` is the operator
 * source of truth and the capnp manifest is emitted from it.
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
 * Conformance shape: leyline-schema-spec/credential-isolation/v1/wire/proxy-envelope.md
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
 * The success path handles header/query/body injection, streaming,
 * receipts, rate limit, and no-leak invariants.
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
    return errorResponse(
      429,
      JSON.stringify({ error: "rate_limited", service: req.serviceConfig.name }),
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
    emitProxyCallTelemetry(req.receipts, req.metrics, {
      peerFp,
      cfg,
      upstreamPath:      req.upstreamPath,
      startMs,
      status,
      requestSizeBytes:  reqSize,
      responseSizeBytes: respSize,
    });
  }
}

/**
 * Forward-path telemetry shim — mirrors `proxyWithReceipt`'s emit
 * shape for the production composition where the route delegates the
 * full Request to vault DO via `CredentialStore.forward`. Closes
 * X-1 from the 2026-05-18 adversarial cycle: pre-shim the forward
 * branch emitted NO receipts + NO metrics, leaving master claim #3
 * (audit-by-receipt) FALSE in production.
 *
 * Per cloister-6e888b. Receipt shape per
 * `leyline-schema-spec/credential-isolation/v1/wire/receipt-commitment.md`.
 */
export async function forwardWithReceipt(
  args: {
    receipts?:         ReceiptEmitter;
    metrics?:          MetricEmitter;
    peerFp:            string;
    cfg:               VaultProxyService;
    upstreamPath:      string;
    requestSizeBytes:  number;
    forward:           () => Promise<Response>;
  },
): Promise<Response> {
  const startMs = Date.now();
  let status = 0;
  let respSize = 0;
  try {
    const res = await args.forward();
    status = res.status;
    respSize = peekResponseSize(res);
    return res;
  } finally {
    emitProxyCallTelemetry(args.receipts, args.metrics, {
      peerFp:            args.peerFp,
      cfg:               args.cfg,
      upstreamPath:      args.upstreamPath,
      startMs,
      status,
      requestSizeBytes:  args.requestSizeBytes,
      responseSizeBytes: respSize,
    });
  }
}

/** Shared between `proxyWithReceipt` + `forwardWithReceipt` — single
 *  source of truth for receipt + metric field shape. */
function emitProxyCallTelemetry(
  receipts: ReceiptEmitter | undefined,
  metrics:  MetricEmitter  | undefined,
  args: {
    peerFp:            string;
    cfg:               VaultProxyService;
    upstreamPath:      string;
    startMs:           number;
    status:            number;
    requestSizeBytes:  number;
    responseSizeBytes: number;
  },
): void {
  if (receipts) {
    const receipt: ProxyCallReceipt = {
      capability:       "cloister/credential-isolation/v1",
      peerFp:           args.peerFp,
      service:          args.cfg.name,
      upstreamStatus:   args.status,
      // Path-only, NO query string (Phase 5 no-leak invariant) —
      // strip everything from `?` onward; query params can carry
      // PII / tokens / user-supplied secrets.
      upstreamUrlPath:  args.upstreamPath.split("?")[0],
      requestSizeBytes: args.requestSizeBytes,
      responseSizeBytes: args.responseSizeBytes,
      wallClockMs:      Date.now() - args.startMs,
      tsMs:             args.startMs,
      nonceHex:         generateNonceHex(),
    };
    // `{ ...receipt }` because `ProxyCallReceipt` is a closed interface with no
    // index signature — spreading gives the guard a plain record without
    // widening the receipt type itself, which is the structural guarantee worth
    // keeping.
    if (refuseIfForbidden({ ...receipt }, "receipt")) return;
    receipts.emit(receipt);
  }
  if (metrics) {
    // Phase 7 — bounded-cardinality labels only. NEVER include
    // the credential value, request body, query string, or
    // upstream URL fragments. That sentence used to be the only
    // thing enforcing it here — labels are assembled from `args`
    // and `ProxyCallReceipt`'s type does not constrain them, so
    // this arm was the weaker of the two. `refuseIfForbidden` is
    // now the rail (cloister-d7216a).
    const labels = {
      service:        args.cfg.name,
      peer_fp:        args.peerFp,
      status:         args.status,
      injection_kind: args.cfg.injection.kind,
    };
    if (refuseIfForbidden(labels, "metric")) return;
    metrics.emit({ name: "vault_proxy_call", labels });
  }
}

/**
 * Gate one telemetry row before it leaves the process. Returns `true` when the
 * row was REFUSED and the caller must not emit it.
 *
 * Refuses rather than throws: `emitProxyCallTelemetry` runs in a `finally`
 * after the upstream response is already in hand, so throwing would convert a
 * successful proxied call into a 500 for what can only be a code change to the
 * receipt shape. Per credential-isolation/v1's vector, the requirement is that
 * a leaky receipt "never reaches the signing key" — dropping it satisfies that;
 * failing the caller's request does not follow from it.
 *
 * Dropping is not silent. A missing receipt is itself meaningful under
 * Interlace §13.2 ("silence is evidence"), so the refusal is logged at error
 * level with the offending field NAME — never its value, which is the material
 * we are refusing to commit in the first place.
 */
function refuseIfForbidden(row: Record<string, unknown>, kind: "receipt" | "metric"): boolean {
  const field = findForbiddenReceiptField(row);
  if (field === null) return false;
  logEvent("error", {
    target:  "vault-proxy",
    op:      `emit-${kind}`,
    outcome: "refused",
    reason:  "forbidden field in telemetry row (credential-isolation/v1)",
    field,
  });
  return true;
}

// ── Default emitters (cloister-6e888b / X-1 production-readiness) ────────
//
// `runtime.ts` wires these by default so the production composition
// emits to wrangler tail / CF Workers Logs without operator config.
// Operators wanting structured telemetry sinks (Logpush, etc.) replace
// these via `VaultProxyRouteDeps.receipts` / `.metrics` overrides at
// composition time.
//
// JSON-per-line, prefixed with `kind:"receipt"|"metric"` so log
// readers can filter by event class.

export function consoleReceiptEmitter(): ReceiptEmitter {
  return {
    emit: (receipt) => {
      // eslint-disable-next-line no-console -- intentional structured emit
      console.log(JSON.stringify({ kind: "receipt", ...receipt }));
    },
  };
}

export function consoleMetricEmitter(): MetricEmitter {
  return {
    emit: (m) => {
      // eslint-disable-next-line no-console -- intentional structured emit
      console.log(JSON.stringify({ kind: "metric", ...m }));
    },
  };
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
 * Phase 2 — inject the credential as the service declares and forward to
 * upstream, through the one injection (vault/src/inject.ts, ADR-0082 §1)
 * that the vault's Durable Object applies too. The credential goes UPSTREAM
 * only; the caller-facing response is the upstream's response unmodified (the
 * "client never observes the stored credential" invariant relies on the
 * upstream being trusted not to echo, which is the contract operators sign up
 * for when they declare a service in the manifest).
 *
 * Header and query strategies stream the body through; `bodyField` buffers by
 * design, because it edits the JSON before it is forwarded. A body that
 * `bodyField` cannot carry the credential in is a 400.
 */
async function proxyToUpstream(
  req: VaultProxyRequest,
  credential: string,
  cfg: VaultProxyService,
): Promise<Response> {
  const strategy = cfg.injection;

  // passthrough is handled at the route level (before credential lookup);
  // it must never reach this credential-injecting path.
  if (strategy.kind === "passthrough") {
    throw new Error(
      "cloister/credential-isolation/v1: passthrough injection must be handled at the route level, not proxyToUpstream",
    );
  }

  let upstreamRequest: Request;
  try {
    const out = injectCredential({
      injection:    strategy,
      credential,
      username:     req.storedUsername ?? cfg.name,
      upstreamBase: cfg.upstreamBaseUrl,
      request: {
        method:       req.request.method,
        upstreamPath: req.upstreamPath,
        search:       new URL(req.request.url).search,
        headers:      req.request.headers,
      },
    });
    upstreamRequest = await outboundRequest(out, req.request);
  } catch (e) {
    if (!(e instanceof InjectionRefused)) throw e;
    return errorResponse(400, JSON.stringify({ error: "bad_request", reason: e.message }));
  }
  return req.upstream.fetch(upstreamRequest);
}

/**
 * Audit passthrough (ADR-0040 amendment) — forward the caller's OWN request to
 * the service upstream, **preserving its auth headers** (e.g. Claude Code Max's
 * OAuth credential in `anthropic-beta` / a bearer), injecting NOTHING. Strips
 * only cloister-internal `x-interlace-*` headers and `host` (the upstream URL
 * sets its own). Streams the response through. The route wraps this in
 * `forwardWithReceipt`, so the call is still on the receipt chain — this is
 * **audit, not custody**: cloister observes + records but holds no credential.
 */
export function passthroughToUpstream(
  cfg: VaultProxyService,
  upstreamPath: string,
  request: Request,
  upstream: UpstreamFetcher,
): Promise<Response> {
  const baseUrl = cfg.upstreamBaseUrl.replace(/\/+$/, "") + upstreamPath;
  const headers = new Headers(request.headers);
  for (const key of Array.from(headers.keys())) {
    const k = key.toLowerCase();
    // Strip cloister-internal lease + hop-by-hop headers — the upstream must
    // NEVER see the Signet lease (`Authorization: Signet`, `x-signet-*`) or the
    // interlace headers. `host` is set by the upstream URL.
    if (
      k.startsWith("x-interlace-") ||
      k.startsWith("x-signet-") ||
      k === "authorization" ||
      k === "host"
    ) {
      headers.delete(key);
    }
  }
  // Restore the harness's own credential: the shim side-channels it to
  // `x-harness-authorization` so it doesn't collide with `Authorization: Signet`
  // on the shim→cloister hop. Put it back on `Authorization` for the upstream.
  const harnessAuth = request.headers.get("x-harness-authorization");
  if (harnessAuth) {
    headers.set("authorization", harnessAuth);
    headers.delete("x-harness-authorization");
  }
  const init: RequestInit = {
    method: request.method,
    headers,
    signal: request.signal,
  };
  if (methodCanHaveBody(request.method)) init.body = request.body;
  return upstream.fetch(new Request(baseUrl, init));
}

function methodCanHaveBody(method: string): boolean {
  const m = method.toUpperCase();
  return m !== "GET" && m !== "HEAD";
}

function rejection(status: 401 | 403 | 404): Response {
  return errorResponse(status, CONSTANT_TIME_ERROR_BODY);
}

/**
 * Parse `/vault/proxy/<service>/<rest...>` into a service + upstream
 * path. Returns null if the path doesn't match the proxy shape.
 *
 * The route wrapper uses this before lease verification so audit logs
 * can include the service name when parsing succeeds.
 */
export function parseVaultProxyPath(
  pathname: string,
): { service: string; upstreamPath: string } | null {
  const PREFIX = "/vault/proxy/";
  if (!pathname.startsWith(PREFIX)) return null;
  const tail = pathname.slice(PREFIX.length);
  const firstSlash = tail.indexOf("/");
  if (firstSlash === -1) {
    // /vault/proxy/<service> with no upstream path. The canonical service-root
    // upstream path is the EMPTY STRING, not "/", per
    // leyline-schema-spec/credential-isolation/v1 path-parsing vectors
    // (happy_service_root_no_trailing_slash). cloister returned "/" here and
    // pinned it in a test; the change is unobservable upstream because the
    // value is concatenated as `baseUrl.replace(/\/+$/,"") + upstreamPath` and
    // both forms normalize to the same URL — but it makes `/vault/proxy/svc`
    // and `/vault/proxy/svc/` distinguishable, which the receipt records.
    return isValidServiceName(tail) ? { service: tail, upstreamPath: "" } : null;
  }
  const service = tail.slice(0, firstSlash);
  const upstreamPath = tail.slice(firstSlash); // includes leading slash
  if (!isValidServiceName(service)) return null;
  return { service, upstreamPath };
}

/**
 * `[a-z0-9][a-z0-9._-]{0,62}` — the service-name grammar from
 * credential-isolation/v1's path-parsing vectors.
 *
 * Case-sensitive by requirement, not by accident. The vector's rationale:
 * "case-sensitivity in service names would create lookup hazards (manifest
 * entries are lowercase by convention; accepting OpenAI would either silently
 * miss the openai entry or silently equate them, both bad)." Rejecting is the
 * only option that is neither silent miss nor silent equate.
 *
 * Rejection is uniform `null` at the call sites, indistinguishable from a
 * malformed prefix. That is deliberate: every rejection on this surface
 * collapses into one constant-time 404 so the proxy cannot be used to
 * enumerate which services exist, so a discriminated reject kind would be a
 * channel that has to be kept closed rather than a feature.
 */
function isValidServiceName(name: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,62}$/.test(name);
}

/**
 * Constant-time error body shape — same JSON for 401/403/404 to
 * prevent the proxy from being used as an enumeration oracle for
 * which credentials are stored. Per
 * leyline-schema-spec/credential-isolation/v1/wire/proxy-envelope.md.
 */
export const CONSTANT_TIME_ERROR_BODY = JSON.stringify({
  error: "unauthorized",
  reason: "credential not available or caller not authorized",
});

/**
 * Canonical body for upstream-failure outcomes (502 / 503). By the
 * time an attacker sees a U-shape they've already passed every
 * access check (lease, scope, service-declaration, allowedSubs), so
 * collapsing 502 (upstream unreachable) + 503 (vault unavailable) +
 * any other 5xx-class transient does NOT leak access info. The
 * collapse closes Oracle O2 (the undocumented `vault_unavailable`
 * shape) from the 2026-05-18 adversarial cycle.
 *
 * Status codes still differentiate the operator signal (502 = we
 * tried + upstream failed; 503 = substrate transient). Only the
 * body bytes collapse.
 */
export const SHAPE_U_ERROR_BODY = JSON.stringify({
  error: "upstream_unavailable",
});

/**
 * Wire-shape collapse for cred-iso/v1 responses. The route layer
 * owns the wire contract; vault DO emits its own debug-friendly
 * bodies (`{error: "not_found", service: ...}`, etc.) which are
 * appropriate for direct DO callers but leak substrate identity +
 * registry membership when forwarded verbatim to the wire (Oracle
 * O1 + O4, 2026-05-18 cycle).
 *
 * Two canonical wire shapes, picked by status code class:
 *
 *   - 401 / 403 / 404 / 429 → CONSTANT_TIME_ERROR_BODY
 *     ("access failure" class — byte-equal so an attacker who
 *     lacks credential context can't distinguish which failure
 *     gate fired)
 *   - 502 / 503 → SHAPE_U_ERROR_BODY ("upstream failure" class —
 *     byte-equal across substrate-vs-network-transient outcomes)
 *
 * 2xx + other statuses pass through verbatim — those are
 * upstream-authored bodies the route just relays.
 *
 * Retry-After + other forward-relevant headers from the source
 * Response are preserved.
 */
/**
 * Response headers the proxy CONTROLS on every response it emits — never
 * copied from upstream. Per credential-isolation/v1
 * `wire/proxy-envelope.md` §"Response" and its reserved-response-headers
 * vector. Compared case-insensitively on the wire (HTTP §3.2).
 *
 * `Interlace-Receipt` is listed because the contract reserves it, NOT because
 * cloister emits it yet — that needs the master Ed25519 signing key the
 * vault-proxy handler does not have (see the known-gap test in
 * test/routes/vault-proxy-reserved-headers.test.ts).
 */
export const RESERVED_RESPONSE_HEADERS: readonly string[] = Object.freeze([
  "Interlace-Receipt",
  "Server",
]);

/**
 * The fixed `Server` value. Overwrites whatever the upstream sent, so a
 * response never advertises which origin actually answered — passing
 * `Server: nginx/1.23` through would make the proxy a fingerprinting oracle
 * for the upstream fleet.
 */
export const PROXY_SERVER_HEADER_VALUE = "cloister/credential-isolation/v1";

export async function collapseWireShape(res: Response): Promise<Response> {
  const status = res.status;
  if (status >= 200 && status < 400) return stampReservedHeaders(res);

  const isAccessFailure   = status === 401 || status === 403 || status === 404 || status === 429;
  const isUpstreamFailure = status === 502 || status === 503;
  if (!isAccessFailure && !isUpstreamFailure) return res;

  // Drain the upstream body so its plaintext doesn't leak via any
  // mistake at a later layer.
  await res.arrayBuffer().catch(() => {});

  const canonicalBody = isAccessFailure ? CONSTANT_TIME_ERROR_BODY : SHAPE_U_ERROR_BODY;
  const extra: Record<string, string> = {};
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter) extra["retry-after"] = retryAfter;
  return stampReservedHeaders(errorResponse(status, canonicalBody, extra));
}

/**
 * Set the proxy-controlled response headers, overwriting anything upstream
 * sent under the same names. Every other header passes through untouched —
 * the vector calls out Content-Type / Content-Length / Transfer-Encoding /
 * Set-Cookie specifically, because body framing breaks if any are mutated.
 *
 * Applied to error responses too. The vector's cases are success-shaped, but
 * `Server` identifies the proxy on every response it emits; a FIXED value
 * cannot leak anything through the constant-time error path, while omitting it
 * there would turn the header into a success-only signal.
 */
function stampReservedHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("Server", PROXY_SERVER_HEADER_VALUE);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * Required headers on every error-emission site across the
 * cloister/credential-isolation/v1 surface. Per
 * `wire/error-responses.md` § "Header invariants on error paths":
 *
 * - `content-type: application/json` — all error bodies are JSON
 * - `cache-control: no-store` — MUST. Prevents intermediary caches
 *   from amortizing oracle-shaped responses across many probers
 *   (closes cloister-aa9376 § 9.4.b at the header layer; was the
 *   convergence cluster across DoS F4 / Oracle O5 / Bundle F5 in
 *   the 2026-05-18 adversarial cycle synthesis as part of X-2)
 * - `x-content-type-options: nosniff` — SHOULD. Prevents
 *   browsers from MIME-sniffing error bodies into different types
 *
 * Use `errorResponse(status, body)` (below) at every error-emission
 * site so the header policy stays in one place.
 */
export const REQUIRED_ERROR_HEADERS = {
  "content-type":            "application/json",
  "cache-control":           "no-store",
  "x-content-type-options":  "nosniff",
} as const;

/**
 * Canonical error-Response builder. Sets `REQUIRED_ERROR_HEADERS`
 * plus any caller-supplied extras (e.g. `retry-after` on 429s).
 * `body` is the already-serialized JSON string (callers already
 * have JSON.stringify in their hot path).
 */
export function errorResponse(
  status: number,
  body: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(body, {
    status,
    headers: { ...REQUIRED_ERROR_HEADERS, ...extraHeaders },
  });
}

/**
 * The receipt commitment shape. Per
 * leyline-schema-spec/credential-isolation/v1/wire/receipt-commitment.md
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
