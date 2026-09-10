/// <reference types="@cloudflare/vitest-pool-workers/types" />
//
// The rejection-shape invariant for /vault/proxy/*, made executable
// (cloister-d97415 follow-on; formalizes the "third observation" recorded on
// cloister-1b2961 as prose).
//
// ── Why this file exists ─────────────────────────────────────────────────────
//
// cloister-1b2961 asked why `parseVaultProxyPath` returns a bare `null` for
// both reject kinds instead of a discriminated union. The answer is a security
// property: every rejection on this surface must be indistinguishable, so the
// proxy cannot be used to enumerate which services exist or which credentials
// are stored. That answer lived only in a doc comment and a test header.
//
// This repo's own rule is that an invariant with no rail is a comment. The
// invariant is behavioural, not structural — it is about what the bytes on the
// wire look like — so it is asserted here against the real handler rather than
// grepped for in source.
//
// ── What the invariant actually is, precisely ────────────────────────────────
//
// Not "everything returns 404". `vaultProxyHandler` deliberately uses three
// statuses, and the distinctions it DOES draw are the ones an authenticated
// caller is entitled to:
//
//   401  no verified lease                     (caller is unauthenticated)
//   403  lease valid, peer not in allowedSubs  (caller is known and refused)
//   404  service not declared  ── collapsed ── (the oracle-relevant pair)
//   404  no stored credential  ──┘
//
// The load-bearing collapse is the 404 pair: "that service does not exist" and
// "it exists and you have no credential for it" MUST be byte-identical, or an
// authenticated peer can enumerate the service table. src/routes/vault-proxy.ts
// says so in a comment citing threat-model §9.4.b; these tests are what keep it
// true.
//
// The body is constant across ALL rejection statuses too — that is what makes
// adding a discriminated reject kind a regression rather than a feature.

import { describe, expect, it } from "vitest";
import { CONSTANT_TIME_ERROR_BODY, parseVaultProxyPath } from "../../src/routes/vault-proxy";

/**
 * Read a response fully into a comparable shape: status is kept separate so a
 * test can assert "same bytes, different status" precisely.
 */
async function shapeOf(res: Response) {
  return {
    body: await res.text(),
    headers: [...res.headers.entries()]
      .map(([k, v]) => [k.toLowerCase(), v] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  };
}

describe("the 404 collapse — the oracle-relevant pair", () => {
  it("service-not-declared and no-stored-credential are byte-identical", async () => {
    const { vaultProxyHandler } = await import("../../src/routes/vault-proxy");

    const base = {
      request: new Request("http://cloister/vault/proxy/openai/v1/x", { method: "POST" }),
      service: "openai",
      upstreamPath: "/v1/x",
      verifiedLease: {
        peerFp: "sha256:p", scope: "proxy:openai", epoch: 1, certFp: "c",
        nonce: new Uint8Array(16), serverTs: Date.now(),
        certDer: new Uint8Array(0), sig: new Uint8Array(64),
      },
      upstream: { fetch: async () => new Response("upstream", { status: 200 }) },
    };

    // (a) service not declared at all
    const noService = await vaultProxyHandler({
      ...base, serviceConfig: null, storedCredential: null,
    } as never);

    // (b) service declared, caller allowed, but no credential stored
    const noCredential = await vaultProxyHandler({
      ...base,
      serviceConfig: {
        name: "openai", upstreamBaseUrl: "https://openai.example",
        injection: { kind: "authorizationBearer" },
        defaultAllowedSubs: ["sha256:p"], rateLimitPerMinute: 60,
      },
      storedCredential: null,
    } as never);

    expect(noService.status).toBe(404);
    expect(noCredential.status).toBe(404);
    // The whole point: an attacker holding a valid lease learns nothing about
    // which services exist from the difference between these two responses.
    expect(await shapeOf(noService)).toEqual(await shapeOf(noCredential));
  });
});

describe("the rejection body is constant across every rejection status", () => {
  it("401, 403 and 404 all carry CONSTANT_TIME_ERROR_BODY", async () => {
    const { vaultProxyHandler } = await import("../../src/routes/vault-proxy");
    const cfg = {
      name: "openai", upstreamBaseUrl: "https://openai.example",
      injection: { kind: "authorizationBearer" },
      defaultAllowedSubs: ["sha256:allowed"], rateLimitPerMinute: 60,
    };
    const lease = (fp: string) => ({
      peerFp: fp, scope: "proxy:openai", epoch: 1, certFp: "c",
      nonce: new Uint8Array(16), serverTs: Date.now(),
      certDer: new Uint8Array(0), sig: new Uint8Array(64),
    });
    const base = {
      request: new Request("http://cloister/vault/proxy/openai/v1/x", { method: "POST" }),
      service: "openai",
      upstreamPath: "/v1/x",
      upstream: { fetch: async () => new Response("upstream", { status: 200 }) },
    };

    const cases: Array<[number, unknown]> = [
      [401, { ...base, verifiedLease: null,               serviceConfig: cfg,  storedCredential: "sk" }],
      [403, { ...base, verifiedLease: lease("sha256:nope"), serviceConfig: cfg, storedCredential: "sk" }],
      [404, { ...base, verifiedLease: lease("sha256:allowed"), serviceConfig: null, storedCredential: null }],
    ];

    for (const [status, req] of cases) {
      const res = await vaultProxyHandler(req as never);
      expect(res.status, `expected ${status}`).toBe(status);
      // A discriminated reject kind would show up here as a differing body.
      expect(await res.text()).toBe(CONSTANT_TIME_ERROR_BODY);
    }
  });
});

describe("parseVaultProxyPath exposes no reject kind", () => {
  // The structural half of the same invariant: the parser must not hand a
  // caller something it could accidentally surface. `null` is the whole API.
  it.each([
    ["/vault/read/openai/secret", "malformed_path (wrong prefix)"],
    ["/vault/proxy/OpenAI/v1/foo", "malformed_service (uppercase)"],
    ["/vault/proxy/", "empty service"],
  ])("%s rejects as bare null — %s", (path) => {
    const got = parseVaultProxyPath(path);
    expect(got).toBeNull();
    // Not `toBeFalsy()`: an object carrying a `kind` would be truthy, and the
    // point is that no such object exists to be leaked.
    expect(typeof got).toBe("object");
  });
});
