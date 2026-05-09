// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 cloister contributors
// Origin: agentic-research/notme (Apache-2.0); see ../NOTICE.

/**
 * vault-security.test.ts — Security hardening tests for the credential vault.
 *
 * These test the threat model: a malicious caller tries to exfiltrate
 * credentials, leak internal info, or abuse the proxy.
 */

import { describe, expect, it } from "vitest";

async function getVault() {
  return import("../vault");
}

// ── Header stripping: no caller auth leaks to upstream ─────────────────────

describe("header stripping", () => {
  const cred = {
    upstream: "https://api.example.com/data",
    headers: { "X-Api-Key": "secret-123" },
    allowedSubs: ["*"],
  };

  const sensitiveHeaders = [
    ["Authorization", "Bearer user-token"],
    ["X-Client-Cert", "-----BEGIN CERTIFICATE-----"],
    ["DPoP", "eyJhbGciOiJFUzI1NiJ9.proof"],
    ["Cookie", "notme_session=abc123"],
    ["cookie", "notme_session=abc123"],  // lowercase
  ];

  for (const [header, value] of sensitiveHeaders) {
    it(`strips ${header} from proxied request`, async () => {
      const { buildProxyRequest } = await getVault();
      const incoming = new Request("https://vault.example.com/svc", {
        headers: { [header]: value },
      });
      const proxied = buildProxyRequest(incoming, cred);
      expect(proxied.headers.get(header)).toBeNull();
    });
  }

  // CF-injected headers that should NOT reach upstream
  const cfHeaders = [
    ["CF-Connecting-IP", "1.2.3.4"],
    ["CF-Ray", "abc123-SJC"],
    ["CF-Visitor", '{"scheme":"https"}'],
    ["CF-IPCountry", "US"],
    ["X-Forwarded-For", "1.2.3.4, 5.6.7.8"],
    ["X-Forwarded-Proto", "https"],
    ["CF-Worker", "vault.example.com"],
    ["X-Real-IP", "1.2.3.4"],
  ];

  for (const [header, value] of cfHeaders) {
    it(`strips CF header ${header} from proxied request`, async () => {
      const { buildProxyRequest } = await getVault();
      const incoming = new Request("https://vault.example.com/svc", {
        headers: { [header]: value },
      });
      const proxied = buildProxyRequest(incoming, cred);
      expect(proxied.headers.get(header)).toBeNull();
    });
  }

  it("still injects credential headers after stripping", async () => {
    const { buildProxyRequest } = await getVault();
    const incoming = new Request("https://vault.example.com/svc", {
      headers: {
        Authorization: "Bearer steal-me",
        "CF-Connecting-IP": "1.2.3.4",
        Accept: "application/json",
      },
    });
    const proxied = buildProxyRequest(incoming, cred);

    // Credential headers injected
    expect(proxied.headers.get("X-Api-Key")).toBe("secret-123");
    // Safe headers preserved
    expect(proxied.headers.get("Accept")).toBe("application/json");
    // Sensitive headers stripped
    expect(proxied.headers.get("Authorization")).toBeNull();
    expect(proxied.headers.get("CF-Connecting-IP")).toBeNull();
  });
});

// ── Glob matching edge cases ───────────────────────────────────────────────

describe("glob edge cases", () => {
  it("does not allow partial prefix match without glob", async () => {
    const { checkAccess } = await getVault();
    // "repo:org/venturi" should NOT match "repo:org/venturi-fork"
    expect(checkAccess(["repo:org/venturi"], "repo:org/venturi-fork")).toBe(false);
  });

  it("empty sub never matches", async () => {
    const { checkAccess } = await getVault();
    expect(checkAccess(["*"], "")).toBe(true);  // wildcard matches empty
    expect(checkAccess(["repo:*"], "")).toBe(false);  // glob requires prefix
  });

  it("glob does not enable regex injection", async () => {
    const { checkAccess } = await getVault();
    // A malicious pattern with regex special chars should be escaped
    expect(checkAccess(["repo:org/a.b"], "repo:org/axb")).toBe(false);  // . is literal, not regex
    expect(checkAccess(["repo:org/a.b"], "repo:org/a.b")).toBe(true);
  });

  it("double-star is treated as single wildcard", async () => {
    const { checkAccess } = await getVault();
    // ** should just work like two consecutive wildcards = match anything
    expect(checkAccess(["repo:**"], "repo:anything/deep/path")).toBe(true);
  });
});

// ── Service name validation ────────────────────────────────────────────────

describe("service name validation", () => {
  it("rejects service names with path traversal", async () => {
    const { validateServiceName } = await getVault();
    expect(validateServiceName("../etc/passwd")).toBe(false);
    expect(validateServiceName("..")).toBe(false);
    expect(validateServiceName("./nvd")).toBe(false);
    expect(validateServiceName("nvd/../other")).toBe(false);
  });

  it("rejects service names with slashes", async () => {
    const { validateServiceName } = await getVault();
    expect(validateServiceName("a/b")).toBe(false);
    expect(validateServiceName("/nvd")).toBe(false);
    expect(validateServiceName("nvd/")).toBe(false);
  });

  it("rejects empty service name", async () => {
    const { validateServiceName } = await getVault();
    expect(validateServiceName("")).toBe(false);
  });

  it("accepts valid service names", async () => {
    const { validateServiceName } = await getVault();
    expect(validateServiceName("nvd")).toBe(true);
    expect(validateServiceName("github")).toBe(true);
    expect(validateServiceName("my-api-v2")).toBe(true);
    expect(validateServiceName("api_key_store")).toBe(true);
  });
});

// ── SSRF prevention ────────────────────────────────────────────────────────

describe("upstream URL validation", () => {
  it("rejects non-https upstream URLs", async () => {
    const { validateUpstreamUrl } = await getVault();
    expect(validateUpstreamUrl("http://api.example.com")).toBe(false);
    expect(validateUpstreamUrl("ftp://api.example.com")).toBe(false);
    expect(validateUpstreamUrl("file:///etc/passwd")).toBe(false);
  });

  it("rejects localhost/internal upstream URLs", async () => {
    const { validateUpstreamUrl } = await getVault();
    expect(validateUpstreamUrl("https://localhost/api")).toBe(false);
    expect(validateUpstreamUrl("https://127.0.0.1/api")).toBe(false);
    expect(validateUpstreamUrl("https://[::1]/api")).toBe(false);
    expect(validateUpstreamUrl("https://169.254.169.254/latest/meta-data")).toBe(false);
    expect(validateUpstreamUrl("https://metadata.google.internal/")).toBe(false);
  });

  it("rejects private network upstream URLs", async () => {
    const { validateUpstreamUrl } = await getVault();
    expect(validateUpstreamUrl("https://10.0.0.1/api")).toBe(false);
    expect(validateUpstreamUrl("https://172.16.0.1/api")).toBe(false);
    expect(validateUpstreamUrl("https://192.168.1.1/api")).toBe(false);
  });

  it("accepts valid public HTTPS upstream URLs", async () => {
    const { validateUpstreamUrl } = await getVault();
    expect(validateUpstreamUrl("https://services.nvd.nist.gov/rest/json/cves/2.0")).toBe(true);
    expect(validateUpstreamUrl("https://api.github.com/repos")).toBe(true);
    expect(validateUpstreamUrl("https://api.example.com/v1/data")).toBe(true);
  });
});

// ── No credential exposure in errors ───────────────────────────────────────

// ── Response sanitization: strip upstream info leaks ────────────────────────

describe("response sanitization", () => {
  it("strips upstream infrastructure headers", async () => {
    const { sanitizeResponse } = await getVault();

    const upstream = new Response('{"data": "ok"}', {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Server": "nginx/1.24.0",
        "X-Powered-By": "Express",
        "X-Request-Id": "abc-123-internal",
        "X-Amzn-RequestId": "aws-internal-id",
        "Set-Cookie": "upstream_session=abc; Path=/",
        "Via": "1.1 proxy.upstream.com",
        "Alt-Svc": 'h3=":443"',
        "Strict-Transport-Security": "max-age=31536000",
        "X-Cache": "HIT",
      },
    });

    const safe = sanitizeResponse(upstream);
    expect(safe.headers.get("Content-Type")).toBe("application/json");
    expect(safe.headers.get("Server")).toBeNull();
    expect(safe.headers.get("X-Powered-By")).toBeNull();
    expect(safe.headers.get("X-Request-Id")).toBeNull();
    expect(safe.headers.get("X-Amzn-RequestId")).toBeNull();
    expect(safe.headers.get("Set-Cookie")).toBeNull();
    expect(safe.headers.get("Via")).toBeNull();
    expect(safe.headers.get("Alt-Svc")).toBeNull();
    expect(safe.headers.get("Strict-Transport-Security")).toBeNull();
    expect(safe.headers.get("X-Cache")).toBeNull();
  });

  it("preserves status code from upstream", async () => {
    const { sanitizeResponse } = await getVault();

    const r404 = sanitizeResponse(new Response("not found", { status: 404 }));
    expect(r404.status).toBe(404);

    const r200 = sanitizeResponse(new Response("ok", { status: 200 }));
    expect(r200.status).toBe(200);
  });

  it("preserves response body", async () => {
    const { sanitizeResponse } = await getVault();

    const body = JSON.stringify({ cves: [{ id: "CVE-2026-1234" }] });
    const safe = sanitizeResponse(new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json", "Server": "gunicorn" },
    }));

    const text = await safe.text();
    expect(text).toBe(body);
  });

  it("only allows explicit safe headers through", async () => {
    const { sanitizeResponse } = await getVault();

    const upstream = new Response("ok", {
      headers: {
        "Content-Type": "text/plain",
        "Content-Length": "2",
        "Cache-Control": "no-cache",
        "ETag": '"abc123"',
        "X-RateLimit-Remaining": "99",
        "X-Totally-Custom": "should-be-stripped",
      },
    });

    const safe = sanitizeResponse(upstream);
    expect(safe.headers.get("Content-Type")).toBe("text/plain");
    // Unknown headers should be stripped
    expect(safe.headers.get("X-Totally-Custom")).toBeNull();
  });
});

describe("credential secrecy", () => {
  it("error messages never contain credential values", async () => {
    const { buildErrorResponse } = await getVault();

    const cred = {
      upstream: "https://api.example.com",
      headers: { apiKey: "super-secret-key-12345" },
      allowedSubs: ["repo:org/specific:*"],
    };

    // Simulate various error scenarios
    const errors = [
      buildErrorResponse("forbidden", "user:alice", "nvd", cred),
      buildErrorResponse("not_found", "user:alice", "unknown", null),
      buildErrorResponse("upstream_error", "user:alice", "nvd", cred),
    ];

    for (const err of errors) {
      const text = JSON.stringify(err);
      expect(text).not.toContain("super-secret-key-12345");
      expect(text).not.toContain(cred.headers.apiKey);
    }
  });
});
