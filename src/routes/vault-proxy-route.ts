// src/routes/vault-proxy-route.ts — EdgeRoute wrapper for the
// `cloister/credential-isolation/v1` capability (ADR-0024).
//
// Composition root for cloister-8f57f0:
//
//   match(): path starts with `/vault/proxy/`
//   handle():
//     1. Run lease verification (same pattern as McpEdgeRoute) when
//        `INTERLACE_ROOT_PUBKEY` is set — gates ALL access.
//     2. Parse the path via `parseVaultProxyPath` to extract
//        (service, upstreamPath).
//     3. Resolve the service config via the `ServiceResolver` dep.
//     4. Resolve the credential via the `CredentialStore` dep.
//     5. Build a `VaultProxyRequest` and delegate to `vaultProxyHandler`.
//
// The route is composition-root-driven: dependencies are passed in
// (CredentialStore, ServiceResolver, UpstreamFetcher, receipts, metrics)
// so the same class works in production (vault-DO-backed store, global
// fetch) and in tests (in-memory store, mock upstream).
//
// Defaults are SAFE-CLOSED:
//   - empty service registry → every request 404 with constant-shape
//   - in-memory credential store → no production cred lookup until wired
//
// Per cloister-8f57f0 route-mount phase. The handler is feature-complete
// (PRs #29-#32, all 29 baseline tests green); this wraps it into the
// live request-dispatch graph.

import { CaUnavailableError, getCABundle } from "../storage/ca-bundle-cache.js";
import { notmeBundleFetcher } from "../storage/notme-bundle-fetcher.js";
import { verifyAndUpsertLease, type VerifiedLease } from "./lease-middleware.js";
import type { EdgeRoute } from "../router.js";
import type { Env } from "../types.js";
import {
  CONSTANT_TIME_ERROR_BODY,
  parseVaultProxyPath,
  vaultProxyHandler,
  type MetricEmitter,
  type ReceiptEmitter,
  type UpstreamFetcher,
  type VaultProxyRequest,
  type VaultProxyService,
} from "./vault-proxy.js";
import {
  InMemoryCredentialStore,
  type CredentialStore,
} from "./vault-proxy-credential-store.js";

const PATH_PREFIX = "/vault/proxy/";

/**
 * Resolve a service name (`openai`, `anthropic`, ...) to its
 * `VaultProxyService` config. Returns null when the service isn't
 * declared. The route's composition root supplies one — production
 * reads from the manifest (Phase 11), tests pass a Map-backed
 * resolver.
 */
export type ServiceResolver = (serviceName: string) => VaultProxyService | null;

/**
 * Verify the lease on an incoming request. Production wires
 * `verifyAndUpsertLease` via `defaultLeaseVerifier`; tests pass a
 * stub that synthesizes a `VerifiedLease` without standing up a
 * real CA bundle + TrustStore. Returns `null` when no lease is
 * required (`INTERLACE_ROOT_PUBKEY` unset) and the request should
 * be unauthenticated — the handler will still reject because it
 * requires a non-null lease.
 */
export type LeaseVerifier = (
  request: Request,
  env: Env,
  parsed: { service: string; upstreamPath: string } | null,
) => Promise<{ ok: true; lease: VerifiedLease } | { ok: false; status: 401 | 503 }>;

export interface VaultProxyRouteDeps {
  credentials?:   CredentialStore;
  services?:      ServiceResolver;
  upstream?:      UpstreamFetcher;
  receipts?:      ReceiptEmitter;
  metrics?:       MetricEmitter;
  leaseVerifier?: LeaseVerifier;
}

export class VaultProxyRoute implements EdgeRoute {
  private readonly credentials:   CredentialStore;
  private readonly services:      ServiceResolver;
  private readonly upstream:      UpstreamFetcher;
  private readonly receipts?:     ReceiptEmitter;
  private readonly metrics?:      MetricEmitter;
  private readonly leaseVerifier: LeaseVerifier;

  constructor(deps: VaultProxyRouteDeps = {}) {
    this.credentials   = deps.credentials   ?? new InMemoryCredentialStore();
    this.services      = deps.services      ?? (() => null);
    this.upstream      = deps.upstream      ?? { fetch: (r) => fetch(r) };
    this.receipts      = deps.receipts;
    this.metrics       = deps.metrics;
    this.leaseVerifier = deps.leaseVerifier ?? defaultLeaseVerifier;
  }

  match(request: Request): boolean {
    const url = new URL(request.url);
    return url.pathname.startsWith(PATH_PREFIX);
  }

  async handle(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parsed = parseVaultProxyPath(url.pathname);

    // ── lease verification ──────────────────────────────────────
    //
    // The verifier returns ok→VerifiedLease or fail→401/503. We
    // collapse 401 to the constant-shape body to preserve the
    // §9.4.b enumeration-oracle invariant (probing client can't
    // distinguish lease-bad from service-missing).
    const verdict = await this.leaseVerifier(request, env, parsed);
    if (!verdict.ok) {
      return new Response(CONSTANT_TIME_ERROR_BODY, {
        status: verdict.status, headers: { "content-type": "application/json" },
      });
    }
    const verifiedLease = verdict.lease;

    // ── service config + credential lookup ───────────────────────
    const service      = parsed?.service ?? "";
    const upstreamPath = parsed?.upstreamPath ?? "/";
    const serviceConfig = parsed === null ? null : this.services(service);
    const lookup = service !== ""
      ? await this.credentials.resolve(verifiedLease.peerFp, service)
      : null;

    const proxyReq: VaultProxyRequest = {
      request,
      service,
      upstreamPath,
      verifiedLease,
      serviceConfig,
      storedCredential: lookup?.credential ?? null,
      storedUsername:   lookup?.username,
      upstream:         this.upstream,
      receipts:         this.receipts,
      metrics:          this.metrics,
    };
    return vaultProxyHandler(proxyReq);
  }
}

/**
 * Production lease verifier — wraps the full `verifyAndUpsertLease`
 * pipeline. When `INTERLACE_ROOT_PUBKEY` is unset, returns 401 (the
 * safe-closed default: every request needs a lease).
 */
const defaultLeaseVerifier: LeaseVerifier = async (request, env, parsed) => {
  if (!env.INTERLACE_ROOT_PUBKEY) return { ok: false, status: 401 };
  try {
    const nowMs = Date.now();
    const bundle = await getCABundle(notmeBundleFetcher(env), nowMs, {
      rootPubkey: env.INTERLACE_ROOT_PUBKEY,
    });
    const body = request.method === "GET" || request.method === "HEAD"
      ? ""
      : await request.clone().text();
    const verdict = await verifyAndUpsertLease({
      req: request, body, id: 0, method: "vaultProxy",
      params: parsed ?? {}, env, bundle, nowMs,
    });
    if ("code" in verdict) return { ok: false, status: 401 };
    return { ok: true, lease: verdict };
  } catch (e) {
    if (e instanceof CaUnavailableError) return { ok: false, status: 503 };
    throw e;
  }
};
