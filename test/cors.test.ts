/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect } from "vitest";
import { pickAllowedOrigin } from "../src/cors.js";

function req(origin?: string): Request {
  return new Request("http://x/mcp", {
    headers: origin ? { Origin: origin } : {},
  });
}

describe("pickAllowedOrigin (default = wildcard)", () => {
  it("echoes Origin when env unset", () => {
    expect(pickAllowedOrigin(req("https://notme.bot"), undefined)).toBe(
      "https://notme.bot",
    );
  });

  it("returns '*' when no Origin and env unset", () => {
    expect(pickAllowedOrigin(req(), undefined)).toBe("*");
  });

  it("treats explicit '*' the same as unset", () => {
    expect(pickAllowedOrigin(req("https://notme.bot"), "*")).toBe(
      "https://notme.bot",
    );
  });

  it("treats whitespace as unset", () => {
    expect(pickAllowedOrigin(req("https://x"), "   ")).toBe("https://x");
  });
});

describe("pickAllowedOrigin (allowlist)", () => {
  const list = "https://notme.bot,http://localhost:*";

  it("echoes an allowed origin verbatim", () => {
    expect(pickAllowedOrigin(req("https://notme.bot"), list)).toBe(
      "https://notme.bot",
    );
  });

  it("echoes any localhost port via :* glob", () => {
    expect(pickAllowedOrigin(req("http://localhost:8787"), list)).toBe(
      "http://localhost:8787",
    );
    expect(pickAllowedOrigin(req("http://localhost:3000"), list)).toBe(
      "http://localhost:3000",
    );
  });

  it("returns 'null' for a disallowed origin", () => {
    expect(pickAllowedOrigin(req("https://evil.example"), list)).toBe("null");
  });

  it("rejects localhost over https when only http is configured", () => {
    expect(pickAllowedOrigin(req("https://localhost:8787"), list)).toBe("null");
  });

  it("requires exact host match — subdomains are not allowed", () => {
    expect(pickAllowedOrigin(req("https://api.notme.bot"), list)).toBe("null");
  });

  it("ignores empty list entries from trailing commas", () => {
    expect(
      pickAllowedOrigin(req("https://notme.bot"), "https://notme.bot,,"),
    ).toBe("https://notme.bot");
  });

  it("falls back to first configured entry when no Origin header is sent", () => {
    expect(pickAllowedOrigin(req(), list)).toBe("https://notme.bot");
  });

  it("rejects non-numeric tail after :*", () => {
    // pattern http://localhost:* requires a *port number*, not arbitrary text
    expect(pickAllowedOrigin(req("http://localhost:abc"), list)).toBe("null");
  });

  it("accepts a single fixed origin entry", () => {
    expect(pickAllowedOrigin(req("https://only.example"), "https://only.example")).toBe(
      "https://only.example",
    );
    expect(pickAllowedOrigin(req("https://other.example"), "https://only.example")).toBe(
      "null",
    );
  });
});
