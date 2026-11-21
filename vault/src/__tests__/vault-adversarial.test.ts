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
  credential: SECRET_KEY,
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
  // Was `expect(true).toBe(true)` whichever way it went. Now both places a
  // line break could get in refuse it.
  it("a credential holding CR or LF is refused when stored", async () => {
    const { validateCredentialPayload } = await getVault();
    for (const credential of ["legit-key\r\nX-Injected: evil-value", "a\nb", "a\rb", "a\u0000b"]) {
      const v = validateCredentialPayload({ credential, allowedSubs: ["*"] });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toMatch(/CR, LF or NUL/);
    }
  });

  it("and refused again if one reaches the injection, instead of ending the header", async () => {
    const { injectCredential, InjectionRefused } = await import("../inject");
    expect(() => injectCredential({
      injection: { kind: "headerNamed", name: "X-Api-Key" },
      credential: "legit-key\r\nX-Injected: evil-value",
      username: "svc",
      upstreamBase: "https://api.example.com",
      request: { method: "GET", upstreamPath: "", search: "", headers: [] },
    })).toThrow(InjectionRefused);
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
  it("the injection uses only the credential and upstream it is given", async () => {
    const { injectCredential } = await import("../inject");
    const out = injectCredential({
      injection: { kind: "headerNamed", name: "X-Api-Key-A" },
      credential: "secret-A",
      username: "a",
      upstreamBase: "https://api-a.example.com",
      request: { method: "GET", upstreamPath: "/a", search: "", headers: [["X-Api-Key-B", "secret-B"]] },
    });
    expect(out.url).toBe("https://api-a.example.com/a");
    expect(out.headers).toContainEqual(["x-api-key-a", "secret-A"]);
    // A header the caller sent is the caller's, not another service's vault entry.
    expect(out.headers.filter(([, v]) => v === "secret-B")).toEqual([["x-api-key-b", "secret-B"]]);
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

// ═══════════════════════════════════════════════════════════════════════════
// ATTACK 9: Credential-payload DoS via an oversized payload (cloister-21b5eb)
// Attacker's goal: putCredential with a megabyte secret, blocking the
// single-threaded vault DO on encrypt + SQL write while queueing every
// co-resident call. Closed by validateCredentialPayload at the input
// boundary. Per dos-friend pilot finding F4.
// ═══════════════════════════════════════════════════════════════════════════

describe("ATTACK: credential-payload DoS", () => {
  it("rejects an oversized secret", async () => {
    const { validateCredentialPayload, CREDENTIAL_LIMITS } = await getVault();
    const oversized = "x".repeat(CREDENTIAL_LIMITS.MAX_CREDENTIAL_BYTES + 1);
    const v = validateCredentialPayload({ credential: oversized, allowedSubs: [] });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/credential too long/);
  });

  it("rejects an oversized username", async () => {
    const { validateCredentialPayload, CREDENTIAL_LIMITS } = await getVault();
    const v = validateCredentialPayload({
      credential: "k",
      username: "u".repeat(CREDENTIAL_LIMITS.MAX_USERNAME_BYTES + 1),
      allowedSubs: [],
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/username too long/);
  });

  it("rejects an empty secret", async () => {
    const { validateCredentialPayload } = await getVault();
    const v = validateCredentialPayload({ credential: "", allowedSubs: [] });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/non-empty/);
  });

  it("rejects too many allowedSubs", async () => {
    const { validateCredentialPayload, CREDENTIAL_LIMITS } = await getVault();
    const subs = Array.from(
      { length: CREDENTIAL_LIMITS.MAX_ALLOWED_SUBS_COUNT + 1 },
      (_, i) => `repo:x/y${i}:*`,
    );
    const v = validateCredentialPayload({ credential: "k", allowedSubs: subs });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/too many allowedSubs/);
  });

  it("accepts realistic credential shapes (NVD-shaped)", async () => {
    const { validateCredentialPayload } = await getVault();
    const v = validateCredentialPayload(NVD_CRED);
    expect(v.ok).toBe(true);
  });

  it("counts bytes in UTF-8, not code units", async () => {
    const { validateCredentialPayload, CREDENTIAL_LIMITS } = await getVault();
    // 💀 is 4 bytes in UTF-8. ceil(MAX/4)+1 chars exceeds the cap.
    const chars = Math.ceil(CREDENTIAL_LIMITS.MAX_CREDENTIAL_BYTES / 4) + 1;
    const v = validateCredentialPayload({ credential: "💀".repeat(chars), allowedSubs: [] });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/credential too long/);
  });
});
