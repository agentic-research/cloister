/// <reference types="@cloudflare/vitest-pool-workers/types" />
//
// Failing TDD baseline for `cloister/credential-isolation/v1`
// (cloister-8f57f0). These tests describe the spec; impl makes them
// turn green phase-by-phase per docs/plans/credential-isolation-
// capability.md.
//
// Phase 0 commits this file with every test failing (stub module
// throws "not implemented"). DO NOT mark tests `.skip()` or
// `.todo()` to chase a green run — that defeats the TDD signal.
// Tests are red until each phase ships them green.
//
// Spec: cloister-spec/credential-isolation/v1/

import { beforeEach, describe, expect, it } from "vitest";
import {
  parseVaultProxyPath,
  vaultProxyHandler,
  CONSTANT_TIME_ERROR_BODY,
  REQUIRED_ERROR_HEADERS,
  __resetRateBuckets,
  errorResponse,
  type MetricEmitter,
  type ProxyCallReceipt,
  type ReceiptEmitter,
  type UpstreamFetcher,
  type VaultProxyRequest,
  type VaultProxyService,
} from "../../src/routes/vault-proxy.js";
import { VaultProxyRoute } from "../../src/routes/vault-proxy-route.js";

// Phase 6 + 7 — rate-limit state is module-scoped; reset between
// every test so per-test budget assertions are deterministic.
beforeEach(() => {
  __resetRateBuckets();
});

// ── Phase 0: path parser (the only piece small enough to land NOT-failing) ─

describe("parseVaultProxyPath — Phase 0 (only piece that ships green in the scaffolding commit)", () => {
  it("parses /vault/proxy/openai/v1/chat/completions", () => {
    expect(parseVaultProxyPath("/vault/proxy/openai/v1/chat/completions")).toEqual({
      service: "openai",
      upstreamPath: "/v1/chat/completions",
    });
  });

  it("parses /vault/proxy/anthropic/v1/messages", () => {
    expect(parseVaultProxyPath("/vault/proxy/anthropic/v1/messages")).toEqual({
      service: "anthropic",
      upstreamPath: "/v1/messages",
    });
  });

  it("treats /vault/proxy/openai as upstream root", () => {
    expect(parseVaultProxyPath("/vault/proxy/openai")).toEqual({
      service: "openai",
      upstreamPath: "/",
    });
  });

  it("returns null for paths outside the /vault/proxy/ prefix", () => {
    expect(parseVaultProxyPath("/health")).toBeNull();
    expect(parseVaultProxyPath("/mcp")).toBeNull();
    expect(parseVaultProxyPath("/vault/admin")).toBeNull();
    expect(parseVaultProxyPath("/")).toBeNull();
  });

  it("returns null for /vault/proxy/ with no service", () => {
    expect(parseVaultProxyPath("/vault/proxy/")).toBeNull();
    expect(parseVaultProxyPath("/vault/proxy/")).toBeNull();
  });
});

// ── Phase 1: identity gates (constant-time 401/403/404 shape) ─────────────

describe("Phase 1 — identity gates (Interlace lease verification + allowedSubs)", () => {
  it("returns 401 when no Interlace headers present", async () => {
    const req = makeProxyRequest({ withLease: false });
    await expectFailingWithBody(req, 401, CONSTANT_TIME_ERROR_BODY);
  });

  it("returns 401 when lease signature fails verification", async () => {
    const req = makeProxyRequest({ withLease: true, badSig: true });
    await expectFailingWithBody(req, 401, CONSTANT_TIME_ERROR_BODY);
  });

  it("returns 401 when lease nonce is replayed", async () => {
    const req = makeProxyRequest({ withLease: true, replayNonce: true });
    await expectFailingWithBody(req, 401, CONSTANT_TIME_ERROR_BODY);
  });

  it("returns 401 when lease ts is outside MAX_CLOCK_SKEW_MS bound", async () => {
    const req = makeProxyRequest({ withLease: true, skewMs: 120_000 });
    await expectFailingWithBody(req, 401, CONSTANT_TIME_ERROR_BODY);
  });

  it("returns 404 when valid lease + service NOT in manifest", async () => {
    const req = makeProxyRequest({ withLease: true, service: "nonexistent" });
    await expectFailingWithBody(req, 404, CONSTANT_TIME_ERROR_BODY);
  });

  it("returns 403 when valid lease + service exists + peerFp NOT in allowedSubs", async () => {
    const req = makeProxyRequest({
      withLease: true,
      peerFp: "sha256:wrong-skill",
      service: "openai",
      allowedSubs: ["sha256:other-skill"],
    });
    await expectFailingWithBody(req, 403, CONSTANT_TIME_ERROR_BODY);
  });

  it("401, 403, and 404 return BYTE-IDENTICAL response bodies (enumeration oracle)", async () => {
    // The point of the constant-time error: an attacker probing
    // /vault/proxy/<service> cannot distinguish "service missing" from
    // "service present but I'm not allowed" from "lease invalid". All
    // three return the same JSON.
    const unauth = await vaultProxyHandler(makeProxyRequest({ withLease: false })).catch((r) => r as Response);
    const forbidden = await vaultProxyHandler(makeProxyRequest({
      withLease: true, peerFp: "x", service: "openai", allowedSubs: ["y"],
    })).catch((r) => r as Response);
    const notfound = await vaultProxyHandler(makeProxyRequest({
      withLease: true, service: "nonexistent",
    })).catch((r) => r as Response);
    const [b1, b2, b3] = await Promise.all([unauth.text(), forbidden.text(), notfound.text()]);
    expect(b1).toEqual(b2);
    expect(b2).toEqual(b3);
  });
});

// ── Phase 2: header injection (Bearer / Basic / named header) ─────────────

describe("Phase 2 — header injection (authorizationBearer, authorizationBasic, headerNamed)", () => {
  it("authorizationBearer: upstream receives Authorization: Bearer <stored>", async () => {
    const upstream = mockUpstream();
    const req = makeProxyRequest({
      withLease: true,
      service: "openai",
      injection: { kind: "authorizationBearer" },
      storedCredential: "sk-abc123",
      upstream,
    });
    await vaultProxyHandler(req);
    expect(upstream.lastRequest?.headers.get("Authorization")).toBe("Bearer sk-abc123");
  });

  it("authorizationBasic: upstream receives Authorization: Basic <b64(user:secret)>", async () => {
    const upstream = mockUpstream();
    const req = makeProxyRequest({
      withLease: true,
      service: "internal-svc",
      injection: { kind: "authorizationBasic" },
      storedCredential: "secret123",
      storedUsername: "operator",
      upstream,
    });
    await vaultProxyHandler(req);
    const expected = "Basic " + btoa("operator:secret123");
    expect(upstream.lastRequest?.headers.get("Authorization")).toBe(expected);
  });

  it("headerNamed { name: 'x-api-key' }: upstream receives x-api-key: <stored>", async () => {
    const upstream = mockUpstream();
    const req = makeProxyRequest({
      withLease: true,
      service: "anthropic",
      injection: { kind: "headerNamed", name: "x-api-key" },
      storedCredential: "sk-ant-xyz",
      upstream,
    });
    await vaultProxyHandler(req);
    expect(upstream.lastRequest?.headers.get("x-api-key")).toBe("sk-ant-xyz");
  });

  it("client NEVER observes the stored credential in response body", async () => {
    const upstream = mockUpstream({ responseBody: '{"choices":[{"text":"hi"}]}' });
    const req = makeProxyRequest({
      withLease: true,
      service: "openai",
      injection: { kind: "authorizationBearer" },
      storedCredential: "sk-leak-bait",
      upstream,
    });
    const res = await vaultProxyHandler(req);
    const body = await res.text();
    expect(body).not.toContain("sk-leak-bait");
  });

  it("client NEVER observes the stored credential in response headers", async () => {
    const upstream = mockUpstream();
    const req = makeProxyRequest({
      withLease: true,
      service: "openai",
      injection: { kind: "authorizationBearer" },
      storedCredential: "sk-leak-bait-headers",
      upstream,
    });
    const res = await vaultProxyHandler(req);
    for (const [_name, value] of res.headers) {
      expect(value).not.toContain("sk-leak-bait-headers");
    }
  });
});

// ── Phase 3: query + body injection ───────────────────────────────────────

describe("Phase 3 — query + body injection", () => {
  it("queryParam: upstream URL has ?api_key=<stored>", async () => {
    const upstream = mockUpstream();
    const req = makeProxyRequest({
      withLease: true,
      service: "google",
      injection: { kind: "queryParam", name: "api_key" },
      storedCredential: "ya29.abc",
      upstream,
    });
    await vaultProxyHandler(req);
    expect(upstream.lastRequest?.url).toContain("api_key=ya29.abc");
  });

  it("queryParam URL-encodes the credential value correctly", async () => {
    const upstream = mockUpstream();
    const req = makeProxyRequest({
      withLease: true,
      service: "exotic",
      injection: { kind: "queryParam", name: "k" },
      storedCredential: "value with spaces & ampersands",
      upstream,
    });
    await vaultProxyHandler(req);
    expect(upstream.lastRequest?.url).toContain("k=value%20with%20spaces%20%26%20ampersands");
  });

  it("bodyField (top-level): upstream JSON body merges in stored cred", async () => {
    const upstream = mockUpstream();
    const req = makeProxyRequest({
      withLease: true,
      service: "oauth-svc",
      injection: { kind: "bodyField", path: "client_secret" },
      storedCredential: "topsecret",
      requestBody: JSON.stringify({ client_id: "abc", grant_type: "client_credentials" }),
      upstream,
    });
    await vaultProxyHandler(req);
    const sent = JSON.parse(await upstream.lastRequest!.text());
    expect(sent.client_secret).toBe("topsecret");
    expect(sent.client_id).toBe("abc"); // existing fields preserved
  });

  it("bodyField (nested path): merges in 'auth.client_secret'", async () => {
    const upstream = mockUpstream();
    const req = makeProxyRequest({
      withLease: true,
      service: "nested-oauth",
      injection: { kind: "bodyField", path: "auth.client_secret" },
      storedCredential: "deepsecret",
      requestBody: JSON.stringify({ auth: { client_id: "abc" }, scope: "read" }),
      upstream,
    });
    await vaultProxyHandler(req);
    const sent = JSON.parse(await upstream.lastRequest!.text());
    expect(sent.auth.client_secret).toBe("deepsecret");
    expect(sent.auth.client_id).toBe("abc");
    expect(sent.scope).toBe("read");
  });
});

// ── Phase 4: streaming + chunked + client disconnect ──────────────────────

describe("Phase 4 — streaming pass-through", () => {
  it("upstream chunked transfer-encoding streams to client without buffering", async () => {
    const chunks = ["one ", "two ", "three"];
    const upstream = mockUpstream({ chunked: chunks });
    const req = makeProxyRequest({
      withLease: true,
      service: "stream-svc",
      injection: { kind: "authorizationBearer" },
      storedCredential: "x",
      upstream,
    });
    const res = await vaultProxyHandler(req);
    const seen: string[] = [];
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      seen.push(decoder.decode(value));
    }
    expect(seen.length).toBeGreaterThan(1); // streamed, not buffered into one chunk
    expect(seen.join("")).toBe("one two three");
  });

  it("upstream SSE event stream forwards event-by-event", async () => {
    const events = ["data: chunk-1\n\n", "data: chunk-2\n\n", "data: [DONE]\n\n"];
    const upstream = mockUpstream({ sse: events, contentType: "text/event-stream" });
    const req = makeProxyRequest({
      withLease: true,
      service: "sse-svc",
      injection: { kind: "authorizationBearer" },
      storedCredential: "x",
      upstream,
    });
    const res = await vaultProxyHandler(req);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    const body = await res.text();
    for (const ev of events) expect(body).toContain(ev);
  });

  it("client disconnect aborts upstream request mid-flight", async () => {
    const ctrl = new AbortController();
    const upstream = mockUpstream({ delayMs: 5000 });
    const req = makeProxyRequest({
      withLease: true,
      service: "slow-svc",
      injection: { kind: "authorizationBearer" },
      storedCredential: "x",
      upstream,
      requestSignal: ctrl.signal,
    });
    const handlerPromise = vaultProxyHandler(req);
    ctrl.abort();
    await handlerPromise.catch(() => {});
    expect(upstream.aborted).toBe(true);
  });
});

// ── Phase 5: audit receipts (commit + MUST-NOT-commit invariants) ─────────

describe("Phase 5 — Interlace receipts on every proxy call", () => {
  it("emits receipt on success", async () => {
    const receipts = mockReceiptEmitter();
    const upstream = mockUpstream({ status: 200 });
    const req = makeProxyRequest({
      withLease: true, service: "openai",
      injection: { kind: "authorizationBearer" }, storedCredential: "x",
      upstream, receipts,
    });
    await vaultProxyHandler(req);
    expect(receipts.emitted.length).toBe(1);
  });

  it("emits receipt on error (upstream 5xx)", async () => {
    const receipts = mockReceiptEmitter();
    const upstream = mockUpstream({ status: 502 });
    const req = makeProxyRequest({
      withLease: true, service: "openai",
      injection: { kind: "authorizationBearer" }, storedCredential: "x",
      upstream, receipts,
    });
    await vaultProxyHandler(req);
    expect(receipts.emitted.length).toBe(1);
    expect(receipts.emitted[0]!.upstreamStatus).toBe(502);
  });

  it("receipt commits to expected fields", async () => {
    const receipts = mockReceiptEmitter();
    const upstream = mockUpstream({ status: 200, responseBody: "hello" });
    const req = makeProxyRequest({
      withLease: true, service: "openai",
      injection: { kind: "authorizationBearer" }, storedCredential: "sk-x",
      peerFp: "sha256:test-peer", upstream, receipts,
    });
    await vaultProxyHandler(req);
    const r = receipts.emitted[0]!;
    expect(r.capability).toBe("cloister/credential-isolation/v1");
    expect(r.peerFp).toBe("sha256:test-peer");
    expect(r.service).toBe("openai");
    expect(r.upstreamStatus).toBe(200);
    expect(typeof r.requestSizeBytes).toBe("number");
    expect(typeof r.responseSizeBytes).toBe("number");
    expect(typeof r.wallClockMs).toBe("number");
  });

  it("receipt MUST NOT commit to credential value", async () => {
    const receipts = mockReceiptEmitter();
    const upstream = mockUpstream();
    const req = makeProxyRequest({
      withLease: true, service: "openai",
      injection: { kind: "authorizationBearer" }, storedCredential: "sk-leak-bait-in-receipt",
      upstream, receipts,
    });
    await vaultProxyHandler(req);
    const serialized = JSON.stringify(receipts.emitted[0]);
    expect(serialized).not.toContain("sk-leak-bait-in-receipt");
  });

  it("receipt MUST NOT commit to upstream request body", async () => {
    const receipts = mockReceiptEmitter();
    const upstream = mockUpstream();
    const sensitiveBody = "user-pii-payload-12345";
    const req = makeProxyRequest({
      withLease: true, service: "openai",
      injection: { kind: "authorizationBearer" }, storedCredential: "x",
      requestBody: sensitiveBody, upstream, receipts,
    });
    await vaultProxyHandler(req);
    const serialized = JSON.stringify(receipts.emitted[0]);
    expect(serialized).not.toContain(sensitiveBody);
  });

  it("receipt MUST NOT commit to query string", async () => {
    const receipts = mockReceiptEmitter();
    const upstream = mockUpstream();
    const req = makeProxyRequest({
      withLease: true, service: "openai",
      injection: { kind: "authorizationBearer" }, storedCredential: "x",
      requestPathQuery: "?user_id=PII-token", upstream, receipts,
    });
    await vaultProxyHandler(req);
    const serialized = JSON.stringify(receipts.emitted[0]);
    expect(serialized).not.toContain("PII-token");
  });
});

// ── Phase 6: per-(peerFp, service) rate limit ─────────────────────────────

describe("Phase 6 — per-(peerFp, service) rate limit", () => {
  it("returns 429 when bucket exhausted", async () => {
    const upstream = mockUpstream();
    const config: Partial<VaultProxyService> = { rateLimitPerMinute: 2 };
    const reqs = [1, 2, 3].map(() =>
      makeProxyRequest({
        withLease: true, service: "rate-limited",
        injection: { kind: "authorizationBearer" }, storedCredential: "x",
        peerFp: "sha256:hot-peer", upstream, serviceConfigOverride: config,
      })
    );
    const responses = await Promise.all(reqs.map((r) => vaultProxyHandler(r).catch((e) => e as Response)));
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
  });

  it("rate limit does NOT leak across (peerFp, service) tuples", async () => {
    const upstream = mockUpstream();
    const config: Partial<VaultProxyService> = { rateLimitPerMinute: 1 };
    const r1 = await vaultProxyHandler(makeProxyRequest({
      withLease: true, service: "iso", injection: { kind: "authorizationBearer" },
      storedCredential: "x", peerFp: "sha256:peer-A", upstream, serviceConfigOverride: config,
    })).catch((e) => e as Response);
    const r2 = await vaultProxyHandler(makeProxyRequest({
      withLease: true, service: "iso", injection: { kind: "authorizationBearer" },
      storedCredential: "x", peerFp: "sha256:peer-B", upstream, serviceConfigOverride: config,
    })).catch((e) => e as Response);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });
});

// ── Phase 7: no-plaintext-leak invariants ─────────────────────────────────

describe("Phase 7 — no-plaintext-leak invariants", () => {
  it("error response (502 upstream) does NOT include credential", async () => {
    const upstream = mockUpstream({ status: 502, responseBody: "upstream error" });
    const req = makeProxyRequest({
      withLease: true, service: "openai",
      injection: { kind: "authorizationBearer" }, storedCredential: "sk-leak-bait-on-error",
      upstream,
    });
    const res = await vaultProxyHandler(req);
    const body = await res.text();
    expect(body).not.toContain("sk-leak-bait-on-error");
  });

  it("metric labels do NOT include credential value", async () => {
    const metrics = mockMetricEmitter();
    const upstream = mockUpstream();
    const req = makeProxyRequest({
      withLease: true, service: "openai",
      injection: { kind: "authorizationBearer" }, storedCredential: "sk-leak-bait-in-metrics",
      upstream, metrics,
    });
    await vaultProxyHandler(req);
    for (const m of metrics.emitted) {
      for (const v of Object.values(m.labels)) {
        expect(String(v)).not.toContain("sk-leak-bait-in-metrics");
      }
    }
  });
});

// ── Test helpers (intentionally simple — they're not the spec) ──────────

/**
 * Phase 1 + Phase 2 options surface. Phases 3+ add their own fields
 * here as they ship; keeping the type narrow at each phase keeps
 * unused-import warnings out of tsc.
 */
interface MakeProxyRequestOpts {
  withLease?: boolean;
  badSig?: boolean;
  replayNonce?: boolean;
  skewMs?: number;
  service?: string;
  peerFp?: string;
  allowedSubs?: string[];
  injection?: VaultProxyService["injection"];
  storedCredential?: string;
  storedUsername?: string;
  requestBody?: string;
  requestPathQuery?: string;
  requestSignal?: AbortSignal;
  upstream?: ReturnType<typeof mockUpstream>;
  receipts?: ReturnType<typeof mockReceiptEmitter>;
  metrics?: ReturnType<typeof mockMetricEmitter>;
  serviceConfigOverride?: Partial<VaultProxyService>;
}
/**
 * Phase 1 — synthesize a VaultProxyRequest reflecting the test options.
 *
 * The real upstream lease middleware collapses every authentication
 * failure (missing headers, bad sig, replayed nonce, clock skew) into
 * `verifiedLease: null` before the handler ever sees it. The helper
 * models that collapse: any of `{ withLease: false, badSig: true,
 * replayNonce: true, skewMs > MAX_CLOCK_SKEW_MS }` → null lease.
 *
 * Manifest lookup: `service: "nonexistent"` → null serviceConfig.
 * Any other service name resolves to a synthesized VaultProxyService
 * using the supplied (or default) injection + allowedSubs + storedCred.
 *
 * Phases 2+ extend this helper as those phases ship — the
 * upstream/receipts/metrics fields go unused in Phase 1.
 */
const MAX_CLOCK_SKEW_MS = 60_000;

function makeProxyRequest(opts: MakeProxyRequestOpts = {}): VaultProxyRequest {
  const service = opts.service ?? "openai";
  const peerFp  = opts.peerFp  ?? "sha256:test-peer";

  const leaseInvalid =
    opts.withLease === false ||
    opts.badSig === true ||
    opts.replayNonce === true ||
    (opts.skewMs !== undefined && Math.abs(opts.skewMs) > MAX_CLOCK_SKEW_MS);

  const verifiedLease = leaseInvalid
    ? null
    : {
        peerFp,
        scope:    `proxy:${service}`,
        epoch:    1,
        certFp:   "test-cert-fp",
        nonce:    new Uint8Array(16),
        serverTs: Date.now(),
        certDer:  new Uint8Array(0),
        sig:      new Uint8Array(64),
      };

  const serviceConfig: VaultProxyService | null =
    service === "nonexistent"
      ? null
      : {
          name:               service,
          upstreamBaseUrl:    `https://${service}.example`,
          injection:          opts.injection          ?? { kind: "authorizationBearer" },
          defaultAllowedSubs: opts.allowedSubs        ?? [peerFp],
          rateLimitPerMinute: 60,
          ...(opts.serviceConfigOverride ?? {}),
        };

  return {
    request:          new Request(`http://cloister/vault/proxy/${service}${opts.requestPathQuery ?? "/"}`, {
      method: "POST",
      body:   opts.requestBody,
      signal: opts.requestSignal,
    }),
    service,
    upstreamPath:     opts.requestPathQuery ?? "/",
    verifiedLease,
    serviceConfig,
    storedCredential: opts.storedCredential ?? null,
    storedUsername:   opts.storedUsername,
    upstream:         opts.upstream ?? noopUpstream(),
    receipts:         opts.receipts,
    metrics:          opts.metrics,
  };
}

function mockReceiptEmitter(): ReceiptEmitter & { emitted: ProxyCallReceipt[] } {
  const emitted: ProxyCallReceipt[] = [];
  return {
    emitted,
    emit: (r) => { emitted.push(r); },
  };
}

function mockMetricEmitter(): MetricEmitter & {
  emitted: Array<{ name: string; labels: Record<string, string | number> }>;
} {
  const emitted: Array<{ name: string; labels: Record<string, string | number> }> = [];
  return {
    emitted,
    emit: (m) => { emitted.push(m); },
  };
}

/**
 * mockUpstream — fetcher mock. Captures the outbound Request for
 * header/URL/body assertions + returns a configurable Response.
 *
 * Modes:
 *   - default: 200 with `responseBody` text + `contentType` JSON
 *   - `chunked: string[]` — emits each item as a separate ReadableStream
 *     chunk (Phase 4 streaming pass-through)
 *   - `sse: string[]` — same shape; content-type forced to text/event-stream
 *     when not otherwise specified
 *   - `delayMs: number` — waits up to delayMs OR until the request
 *     signal fires; sets `aborted = true` on abort (Phase 4
 *     client-disconnect)
 */
function mockUpstream(opts: {
  status?:       number;
  responseBody?: string;
  contentType?:  string;
  chunked?:      string[];
  sse?:          string[];
  delayMs?:      number;
} = {}): UpstreamFetcher & { lastRequest: Request | null; aborted: boolean } {
  const captured: { lastRequest: Request | null; aborted: boolean } = {
    lastRequest: null,
    aborted: false,
  };
  return {
    get lastRequest() { return captured.lastRequest; },
    set lastRequest(v) { captured.lastRequest = v; },
    get aborted() { return captured.aborted; },
    set aborted(v) { captured.aborted = v; },
    fetch: async (req: Request): Promise<Response> => {
      captured.lastRequest = req;

      // Honor abort BEFORE producing the body so client-disconnect
      // is observable mid-flight.
      if (opts.delayMs !== undefined) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, opts.delayMs);
          if (req.signal) {
            const onAbort = (): void => {
              captured.aborted = true;
              clearTimeout(timer);
              reject(new Error("aborted"));
            };
            if (req.signal.aborted) {
              onAbort();
            } else {
              req.signal.addEventListener("abort", onAbort, { once: true });
            }
          }
        });
      }

      const chunks = opts.chunked ?? opts.sse;
      if (chunks !== undefined) {
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          async start(controller): Promise<void> {
            for (const c of chunks) {
              controller.enqueue(encoder.encode(c));
              // Yield so the consumer reads each chunk separately
              // (not coalesced by the runtime into one Uint8Array).
              await new Promise((r) => setTimeout(r, 0));
            }
            controller.close();
          },
        });
        return new Response(body, {
          status:  opts.status ?? 200,
          headers: { "content-type": opts.contentType ?? "application/octet-stream" },
        });
      }

      return new Response(opts.responseBody ?? "", {
        status:  opts.status ?? 200,
        headers: { "content-type": opts.contentType ?? "application/json" },
      });
    },
  };
}

/** A no-op upstream used by Phase 1 tests that never reach the success path. */
function noopUpstream(): UpstreamFetcher {
  return {
    fetch: async () => new Response("", { status: 200 }),
  };
}

async function expectFailingWithBody(
  req: VaultProxyRequest,
  status: number,
  body: string,
): Promise<void> {
  const res = await vaultProxyHandler(req).catch((e) => e as Response);
  expect(res.status).toBe(status);
  expect(await res.text()).toBe(body);
}

// ── cloister-6eba0a sub-fix: required error headers ─────────────────────
//
// `wire/error-responses.md` § "Header invariants on error paths" MUST
// every error site set `Cache-Control: no-store` (closes the convergence
// from the 2026-05-18 cycle: DoS F4 + Oracle O5 + Bundle F5). Pin the
// `errorResponse` helper that all sites now route through.

describe("errorResponse — required headers per wire/error-responses.md", () => {
  it("sets cache-control: no-store on every emission (closes DoS F4 / Oracle O5 / Bundle F5)", () => {
    const res = errorResponse(404, '{"error":"not_found"}');
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("sets content-type: application/json", () => {
    const res = errorResponse(401, '{"error":"unauthorized"}');
    expect(res.headers.get("content-type")).toBe("application/json");
  });

  it("sets x-content-type-options: nosniff", () => {
    const res = errorResponse(500, '{"error":"oops"}');
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("passes the supplied status + body through verbatim", async () => {
    const res = errorResponse(429, '{"error":"rate_limited","service":"openai"}');
    expect(res.status).toBe(429);
    expect(await res.text()).toBe('{"error":"rate_limited","service":"openai"}');
  });

  it("merges extra headers (e.g. retry-after on 429) without losing the required set", () => {
    const res = errorResponse(429, '{"error":"rate_limited"}', { "retry-after": "7" });
    expect(res.headers.get("retry-after")).toBe("7");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toBe("application/json");
  });

  it("exports REQUIRED_ERROR_HEADERS as the canonical set (so other modules don't drift)", () => {
    expect(REQUIRED_ERROR_HEADERS["cache-control"]).toBe("no-store");
    expect(REQUIRED_ERROR_HEADERS["content-type"]).toBe("application/json");
    expect(REQUIRED_ERROR_HEADERS["x-content-type-options"]).toBe("nosniff");
  });

  it("emits cache-control: no-store on the lease-verifier failure path (route-level)", async () => {
    // Smoke-check that route-level error sites use the helper.
    const route = new VaultProxyRoute({
      leaseVerifier: async () => ({ ok: false, status: 401 as const }),
    });
    const res = await route.handle(
      new Request("http://x/vault/proxy/openai/v1/chat"),
      {} as never,
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

