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

import { describe, expect, it } from "vitest";
import {
  parseVaultProxyPath,
  vaultProxyHandler,
  CONSTANT_TIME_ERROR_BODY,
  type UpstreamFetcher,
  type VaultProxyRequest,
  type VaultProxyService,
} from "../../src/routes/vault-proxy.js";

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
  };
}

/**
 * mockUpstream — Phase 2 fetcher mock. Captures the outbound Request
 * for header assertions + returns a configurable Response. Phases 3+
 * extend with chunked/SSE/disconnect modes.
 */
function mockUpstream(opts: {
  status?:       number;
  responseBody?: string;
  contentType?:  string;
} = {}): UpstreamFetcher & { lastRequest: Request | null } {
  const captured: { lastRequest: Request | null } = { lastRequest: null };
  return {
    get lastRequest() { return captured.lastRequest; },
    set lastRequest(v) { captured.lastRequest = v; },
    fetch: async (req: Request): Promise<Response> => {
      captured.lastRequest = req;
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

