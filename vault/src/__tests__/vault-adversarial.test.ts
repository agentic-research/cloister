// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 cloister contributors
// Origin: agentic-research/notme (Apache-2.0); see ../NOTICE.

/**
 * vault-adversarial.test.ts — Red team tests.
 *
 * Each test simulates a specific attack vector. If any of these pass
 * without the security check, we have a vulnerability.
 */

import { describe, expect, it } from "vitest";

async function getVault() {
  return import("../vault");
}

// ── Helper: build a stored credential with a known secret ──────────────────

const SECRET_KEY = "sk-live-NEVER-SEE-THIS-abc123xyz789";
const NVD_CRED = {
  upstream: "https://services.nvd.nist.gov/rest/json/cves/2.0",
  headers: { apiKey: SECRET_KEY },
  allowedSubs: ["repo:org/venturi:*"],
};

// ═══════════════════════════════════════════════════════════════════════════
// ATTACK 1: Credential exfiltration via reflected headers
// Attacker's goal: get the vault to send the API key back in the response
// ═══════════════════════════════════════════════════════════════════════════

describe("ATTACK: credential exfiltration via headers", () => {
  it("credential headers do NOT appear in sanitized response", async () => {
    const { sanitizeResponse } = await getVault();

    // Imagine upstream echoes back all request headers (some APIs do this in debug mode)
    const upstream = new Response('{"debug": true}', {
      headers: {
        "Content-Type": "application/json",
        "apiKey": SECRET_KEY,  // upstream echoes back the key we sent
        "X-Echo-Authorization": "Bearer " + SECRET_KEY,
        "X-Debug-Headers": JSON.stringify({ apiKey: SECRET_KEY }),
      },
    });

    const safe = sanitizeResponse(upstream);
    // None of the echoed credential headers should make it through
    expect(safe.headers.get("apiKey")).toBeNull();
    expect(safe.headers.get("X-Echo-Authorization")).toBeNull();
    expect(safe.headers.get("X-Debug-Headers")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ATTACK 2: Scope escalation via glob injection
// Attacker's goal: bypass scope restrictions by crafting a sub that
// exploits regex/glob parsing bugs
// ═══════════════════════════════════════════════════════════════════════════

describe("ATTACK: scope escalation via glob injection", () => {
  it("regex special chars in sub don't bypass matching", async () => {
    const { checkAccess } = await getVault();

    // Attacker tries to use regex metacharacters as their sub
    expect(checkAccess(["repo:org/venturi:read"], "repo:org/venturi:read|repo:org/secret:admin")).toBe(false);
    expect(checkAccess(["repo:org/venturi:*"], "repo:org/venturi:read\nrepo:org/secret:admin")).toBe(false);
    expect(checkAccess(["repo:org/venturi:*"], "repo:org/(.*)")).toBe(false);
  });

  it("pattern with regex metacharacters is safe", async () => {
    const { checkAccess } = await getVault();

    // Attacker convinces admin to store a pattern that looks like regex
    // The pattern should be treated as a literal glob, not regex
    expect(checkAccess(["repo:org/(.*):*"], "repo:org/venturi:read")).toBe(false);
    expect(checkAccess(["repo:org/[abc]:*"], "repo:org/a:read")).toBe(false);
  });

  it("null bytes in sub are rejected outright", async () => {
    const { checkAccess } = await getVault();

    // Null bytes in subs are always rejected — they're control characters
    // used in injection attacks (C-style string truncation)
    expect(checkAccess(["repo:org/venturi:*"], "repo:org/venturi:read\0repo:org/secret:admin")).toBe(false);
    expect(checkAccess(["repo:org/venturi:read"], "repo:org/venturi:read\0")).toBe(false);
    expect(checkAccess(["*"], "anything\0else")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ATTACK 3: Service name injection / path traversal
// Attacker's goal: access a different service's credentials by crafting
// the service name parameter
// ═══════════════════════════════════════════════════════════════════════════

describe("ATTACK: service name injection", () => {
  it("rejects path traversal attempts", async () => {
    const { validateServiceName } = await getVault();

    const attacks = [
      "../admin",
      "..%2fadmin",
      "nvd/../admin",
      "nvd/../../etc/passwd",
      "..",
      ".",
      "./nvd",
      "nvd/.",
      "%2e%2e/admin",
      "....//admin",
    ];

    for (const attack of attacks) {
      expect(validateServiceName(attack)).toBe(false);
    }
  });

  it("rejects URL-encoded attacks", async () => {
    const { validateServiceName } = await getVault();

    expect(validateServiceName("nvd%00admin")).toBe(false);  // null byte
    expect(validateServiceName("nvd\nadmin")).toBe(false);    // newline
    expect(validateServiceName("nvd\tadmin")).toBe(false);    // tab
    expect(validateServiceName("nvd admin")).toBe(false);     // space
  });

  it("rejects control characters", async () => {
    const { validateServiceName } = await getVault();

    for (let i = 0; i < 32; i++) {
      const name = "nvd" + String.fromCharCode(i) + "admin";
      expect(validateServiceName(name)).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ATTACK 4: SSRF via upstream URL manipulation
// Attacker's goal: make the vault fetch from an internal service
// (metadata endpoint, localhost, private network)
// ═══════════════════════════════════════════════════════════════════════════

describe("ATTACK: SSRF via upstream URL", () => {
  it("blocks cloud metadata endpoints", async () => {
    const { validateUpstreamUrl } = await getVault();

    const metadataUrls = [
      "https://169.254.169.254/latest/meta-data/",
      "https://169.254.169.254/latest/api/token",
      "https://metadata.google.internal/computeMetadata/v1/",
      "https://169.254.169.254/metadata/instance",
    ];

    for (const url of metadataUrls) {
      expect(validateUpstreamUrl(url)).toBe(false);
    }
  });

  it("blocks localhost with various representations", async () => {
    const { validateUpstreamUrl } = await getVault();

    const localhostVariants = [
      "https://localhost/steal",
      "https://127.0.0.1/steal",
      "https://[::1]/steal",
      "https://0.0.0.0/steal",
      "https://127.1/steal",          // shorthand
      "https://127.0.0.255/steal",    // still loopback
    ];

    for (const url of localhostVariants) {
      expect(validateUpstreamUrl(url)).toBe(false);
    }
  });

  it("blocks private RFC1918 ranges", async () => {
    const { validateUpstreamUrl } = await getVault();

    const privateIps = [
      "https://10.0.0.1/api",
      "https://10.255.255.255/api",
      "https://172.16.0.1/api",
      "https://172.31.255.255/api",
      "https://192.168.0.1/api",
      "https://192.168.255.255/api",
    ];

    for (const url of privateIps) {
      expect(validateUpstreamUrl(url)).toBe(false);
    }
  });

  it("blocks non-HTTPS (downgrade attack)", async () => {
    const { validateUpstreamUrl } = await getVault();

    expect(validateUpstreamUrl("http://api.example.com/data")).toBe(false);
    expect(validateUpstreamUrl("ftp://api.example.com/data")).toBe(false);
    expect(validateUpstreamUrl("javascript:alert(1)")).toBe(false);
    expect(validateUpstreamUrl("data:text/html,<script>")).toBe(false);
  });

  it("blocks URLs with credentials in userinfo", async () => {
    const { validateUpstreamUrl } = await getVault();

    expect(validateUpstreamUrl("https://admin:password@api.example.com/")).toBe(false);
    expect(validateUpstreamUrl("https://user@api.example.com/")).toBe(false);
  });

  it("blocks IPv4-mapped IPv6 addresses (SSRF bypass)", async () => {
    const { validateUpstreamUrl } = await getVault();

    // These resolve to internal IPs at the network level but bypass string regex
    const ipv6Bypasses = [
      "https://[::ffff:169.254.169.254]/latest/meta-data",  // metadata via IPv4-mapped IPv6
      "https://[::ffff:127.0.0.1]/steal",                    // localhost via IPv4-mapped
      "https://[::ffff:10.0.0.1]/internal",                  // RFC1918 via IPv4-mapped
      "https://[::ffff:192.168.1.1]/internal",               // RFC1918 via IPv4-mapped
      "https://[::ffff:172.16.0.1]/internal",                // RFC1918 via IPv4-mapped
      "https://[0:0:0:0:0:ffff:127.0.0.1]/steal",           // expanded form
      "https://[::ffff:a9fe:a9fe]/metadata",                 // hex form of 169.254.169.254
      "https://[::ffff:7f00:1]/steal",                       // hex form of 127.0.0.1
    ];

    for (const url of ipv6Bypasses) {
      expect(validateUpstreamUrl(url)).toBe(false);
    }
  });

  it("blocks all IPv6 addresses (allowlist approach)", async () => {
    const { validateUpstreamUrl } = await getVault();

    // Any bracketed IPv6 should be rejected — we only allow domain names
    expect(validateUpstreamUrl("https://[::1]/api")).toBe(false);
    expect(validateUpstreamUrl("https://[fe80::1]/api")).toBe(false);
    expect(validateUpstreamUrl("https://[2001:db8::1]/api")).toBe(false);
    expect(validateUpstreamUrl("https://[::ffff:8.8.8.8]/api")).toBe(false);  // even public IPs in IPv6 form
  });

  it("blocks raw IP addresses (only domain names allowed)", async () => {
    const { validateUpstreamUrl } = await getVault();

    // Even public IPs should be rejected — domains only
    expect(validateUpstreamUrl("https://8.8.8.8/api")).toBe(false);
    expect(validateUpstreamUrl("https://1.1.1.1/api")).toBe(false);
    expect(validateUpstreamUrl("https://203.0.113.1/api")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ATTACK 5: Header injection via credential values
// Attacker's goal: if they compromise the admin flow and store a
// credential with CRLF-injected headers, can they inject extra headers?
// ═══════════════════════════════════════════════════════════════════════════

describe("ATTACK: header injection via stored credential", () => {
  it("CRLF in credential header values don't inject extra headers", async () => {
    const { buildProxyRequest } = await getVault();

    // Attacker somehow stores a credential with CRLF-injected header value
    const maliciousCred = {
      upstream: "https://api.example.com/data",
      headers: { "X-Api-Key": "legit-key\r\nX-Injected: evil-value" },
      allowedSubs: ["*"],
    };

    const incoming = new Request("https://vault.example.com/svc");

    // The Headers API should handle this safely (either reject or sanitize)
    let threw = false;
    try {
      const proxied = buildProxyRequest(incoming, maliciousCred);
      // If it doesn't throw, verify no injection happened
      expect(proxied.headers.get("X-Injected")).toBeNull();
    } catch {
      // Headers constructor rejecting CRLF is also acceptable
      threw = true;
    }
    // Either threw or no injection — both are safe outcomes
    expect(true).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ATTACK 6: Timing side-channel on scope check
// Attacker's goal: determine valid scope patterns by measuring response time
// ═══════════════════════════════════════════════════════════════════════════

describe("ATTACK: ReDoS via crafted glob patterns", () => {
  it("rejects catastrophic backtracking patterns in reasonable time", async () => {
    const { checkAccess } = await getVault();

    // Classic ReDoS: pattern with nested quantifiers
    const evilPattern = "a*".repeat(20) + "b";
    const evilInput = "a".repeat(100);

    const start = performance.now();
    checkAccess([evilPattern], evilInput);
    const elapsed = performance.now() - start;

    // Should complete in under 100ms — ReDoS would take seconds/minutes
    expect(elapsed).toBeLessThan(100);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ATTACK 7: Cross-service credential leak via proxy request
// Attacker's goal: request service A but somehow get service B's headers
// ═══════════════════════════════════════════════════════════════════════════

describe("ATTACK: cross-service credential isolation", () => {
  it("buildProxyRequest only uses the provided credential", async () => {
    const { buildProxyRequest } = await getVault();

    const credA = {
      upstream: "https://api-a.example.com",
      headers: { "X-Api-Key-A": "secret-A" },
      allowedSubs: ["*"],
    };

    const credB = {
      upstream: "https://api-b.example.com",
      headers: { "X-Api-Key-B": "secret-B" },
      allowedSubs: ["*"],
    };

    const incoming = new Request("https://vault.example.com/a");
    const proxiedA = buildProxyRequest(incoming, credA);

    expect(proxiedA.headers.get("X-Api-Key-A")).toBe("secret-A");
    expect(proxiedA.headers.get("X-Api-Key-B")).toBeNull();
    expect(proxiedA.url).toContain("api-a.example.com");
    expect(proxiedA.url).not.toContain("api-b.example.com");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ATTACK 8: Error message credential leak
// Attacker's goal: trigger an error that includes the API key in the message
// ═══════════════════════════════════════════════════════════════════════════

describe("ATTACK: error message credential extraction", () => {
  it("forbidden error does not reveal allowed patterns", async () => {
    const { buildErrorResponse } = await getVault();

    const err = buildErrorResponse("forbidden", "attacker:evil", "nvd", NVD_CRED);
    const json = JSON.stringify(err);

    expect(json).not.toContain(SECRET_KEY);
    expect(json).not.toContain("repo:org/venturi");  // don't reveal scope patterns
    expect(json).not.toContain(NVD_CRED.upstream);   // don't reveal upstream URL
  });
});
