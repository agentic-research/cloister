/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it } from "vitest";
import {
  ERR_CERT_NOT_IMPL,
  ERR_SCOPE_DENIED,
  canonicalRequestBytes,
  certFingerprint,
  deriveRequestScope,
  leaseErrorResponse,
  parseAuthHeaders,
  scopeAllows,
} from "../../src/routes/lease-middleware.js";

// ── Fixture helpers ──────────────────────────────────────────────────────

function b64(bytes: number[] | Uint8Array): string {
  const arr = Array.isArray(bytes) ? new Uint8Array(bytes) : bytes;
  let bin = "";
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeReq(headers: Record<string, string> = {}, options: RequestInit = {}): Request {
  return new Request("http://x/mcp", { method: "POST", headers, ...options });
}

const VALID_CERT_B64  = b64(new Uint8Array(64).fill(0xAB));
const VALID_SIG_B64   = b64(new Uint8Array(64).fill(0xCD));
const VALID_NONCE_B64 = b64(new Uint8Array(16).fill(0xEF));

function validHeaders(): Record<string, string> {
  return {
    "authorization":  `Signet ${VALID_CERT_B64}`,
    "x-signet-sig":   VALID_SIG_B64,
    "x-signet-ts":    "1700000000000",
    "x-signet-nonce": VALID_NONCE_B64,
  };
}

// ── parseAuthHeaders ─────────────────────────────────────────────────────

describe("parseAuthHeaders", () => {
  it("parses all four headers when present and well-formed", () => {
    const req = makeReq(validHeaders());
    const result = parseAuthHeaders(req);
    if ("kind" in result) throw new Error(`expected ParsedAuthHeaders, got ${result.kind}`);
    expect(result.certDer.length).toBe(64);
    expect(result.sig.length).toBe(64);
    expect(result.ts).toBe(1_700_000_000_000);
    expect(result.nonce.length).toBe(16);
  });

  it("rejects missing Authorization header", () => {
    const h = validHeaders();
    delete h["authorization"];
    const result = parseAuthHeaders(makeReq(h));
    expect(result).toEqual({ kind: "missing_authorization" });
  });

  it("rejects wrong scheme (Bearer instead of Signet)", () => {
    const h = validHeaders();
    h["authorization"] = `Bearer ${VALID_CERT_B64}`;
    const result = parseAuthHeaders(makeReq(h));
    expect(result).toEqual({ kind: "wrong_scheme", scheme: "Bearer" });
  });

  it("rejects Authorization with no space (no scheme)", () => {
    const h = validHeaders();
    h["authorization"] = VALID_CERT_B64;
    const result = parseAuthHeaders(makeReq(h));
    expect(result).toEqual({ kind: "wrong_scheme", scheme: VALID_CERT_B64 });
  });

  it("rejects bad base64 in Authorization", () => {
    const h = validHeaders();
    h["authorization"] = "Signet not!valid!base64!@#";
    const result = parseAuthHeaders(makeReq(h));
    if (!("kind" in result)) throw new Error("expected error");
    expect(result.kind).toBe("bad_base64");
  });

  it("rejects missing X-Signet-Sig", () => {
    const h = validHeaders();
    delete h["x-signet-sig"];
    const result = parseAuthHeaders(makeReq(h));
    expect(result).toEqual({ kind: "missing_signature" });
  });

  it("rejects missing X-Signet-Ts", () => {
    const h = validHeaders();
    delete h["x-signet-ts"];
    const result = parseAuthHeaders(makeReq(h));
    expect(result).toEqual({ kind: "missing_timestamp" });
  });

  it("rejects non-numeric X-Signet-Ts", () => {
    const h = validHeaders();
    h["x-signet-ts"] = "yesterday";
    const result = parseAuthHeaders(makeReq(h));
    expect(result).toEqual({ kind: "missing_timestamp" });
  });

  it("rejects negative or zero X-Signet-Ts", () => {
    const h = validHeaders();
    h["x-signet-ts"] = "0";
    expect(parseAuthHeaders(makeReq(h))).toEqual({ kind: "missing_timestamp" });
    h["x-signet-ts"] = "-100";
    expect(parseAuthHeaders(makeReq(h))).toEqual({ kind: "missing_timestamp" });
  });

  it("rejects missing X-Signet-Nonce", () => {
    const h = validHeaders();
    delete h["x-signet-nonce"];
    const result = parseAuthHeaders(makeReq(h));
    expect(result).toEqual({ kind: "missing_nonce" });
  });
});

// ── canonicalRequestBytes ────────────────────────────────────────────────

describe("canonicalRequestBytes", () => {
  it("produces deterministic bytes for the same inputs", () => {
    const nonce = new Uint8Array(16).fill(0xAB);
    const a = canonicalRequestBytes("POST", "http://x/mcp", 1000, nonce, '{"a":1}');
    const b = canonicalRequestBytes("POST", "http://x/mcp", 1000, nonce, '{"a":1}');
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("changes when any input changes", () => {
    const nonce = new Uint8Array(16).fill(0xAB);
    const base       = canonicalRequestBytes("POST", "http://x/mcp", 1000, nonce, '{"a":1}');
    const diffMethod = canonicalRequestBytes("GET",  "http://x/mcp", 1000, nonce, '{"a":1}');
    const diffUrl    = canonicalRequestBytes("POST", "http://x/health", 1000, nonce, '{"a":1}');
    const diffTs     = canonicalRequestBytes("POST", "http://x/mcp", 1001, nonce, '{"a":1}');
    const diffNonce  = canonicalRequestBytes("POST", "http://x/mcp", 1000, new Uint8Array(16).fill(0xCD), '{"a":1}');
    const diffBody   = canonicalRequestBytes("POST", "http://x/mcp", 1000, nonce, '{"a":2}');

    const baseStr = new TextDecoder().decode(base);
    expect(new TextDecoder().decode(diffMethod)).not.toBe(baseStr);
    expect(new TextDecoder().decode(diffUrl)).not.toBe(baseStr);
    expect(new TextDecoder().decode(diffTs)).not.toBe(baseStr);
    expect(new TextDecoder().decode(diffNonce)).not.toBe(baseStr);
    expect(new TextDecoder().decode(diffBody)).not.toBe(baseStr);
  });

  it("uses LF separators in the documented order", () => {
    const nonce = new Uint8Array(3).fill(0x00);  // base64-encodes to "AAAA" (no padding)
    const bytes = canonicalRequestBytes("POST", "http://x/mcp", 1000, nonce, "BODY");
    const text  = new TextDecoder().decode(bytes);
    expect(text).toBe("POST\nhttp://x/mcp\n1000\nAAAA\nBODY");
  });
});

// ── deriveRequestScope ──────────────────────────────────────────────────

describe("deriveRequestScope", () => {
  it("tools/list → tools:list", () => {
    expect(deriveRequestScope("tools/list", undefined)).toBe("tools:list");
  });

  it("tools/call name=X args.repo=R → X:R", () => {
    expect(deriveRequestScope("tools/call", { name: "bead_create", arguments: { repo: "/r/foo" } }))
      .toBe("bead_create:/r/foo");
  });

  it("tools/call name=X without repo → X:*", () => {
    expect(deriveRequestScope("tools/call", { name: "lsp_hover", arguments: { file: "/a.rs" } }))
      .toBe("lsp_hover:*");
    expect(deriveRequestScope("tools/call", { name: "tools/list" }))
      .toBe("tools/list:*");
  });

  it("tools/call without name → tools:call:no_name", () => {
    expect(deriveRequestScope("tools/call", {})).toBe("tools:call:no_name");
    expect(deriveRequestScope("tools/call", undefined)).toBe("tools:call:no_name");
  });

  it("unknown method → unknown:<method>", () => {
    expect(deriveRequestScope("foo/bar", undefined)).toBe("unknown:foo/bar");
  });
});

// ── scopeAllows ──────────────────────────────────────────────────────────

describe("scopeAllows", () => {
  it("admin '*' allows anything", () => {
    expect(scopeAllows("*", "bead_create:/r/foo")).toBe(true);
    expect(scopeAllows("*", "anything:goes")).toBe(true);
  });

  it("exact match allows", () => {
    expect(scopeAllows("bead_create:/r/foo", "bead_create:/r/foo")).toBe(true);
  });

  it("exact non-match rejects", () => {
    expect(scopeAllows("bead_create:/r/foo", "bead_create:/r/bar")).toBe(false);
    expect(scopeAllows("bead_create:/r/foo", "bead_close:/r/foo")).toBe(false);
  });

  it("'X:*' grants any 'X:something'", () => {
    expect(scopeAllows("bead_create:*", "bead_create:/r/foo")).toBe(true);
    expect(scopeAllows("bead_create:*", "bead_create:/r/bar")).toBe(true);
    expect(scopeAllows("bead_create:*", "bead_create:")).toBe(true);
  });

  it("'X:*' does NOT grant 'Y:something'", () => {
    expect(scopeAllows("bead_create:*", "bead_close:/r/foo")).toBe(false);
  });

  it("'X:*' does NOT grant bare 'X' (must include the colon)", () => {
    expect(scopeAllows("bead_create:*", "bead_create")).toBe(false);
  });
});

// ── leaseErrorResponse ──────────────────────────────────────────────────

describe("leaseErrorResponse", () => {
  it("returns 401 for unauthenticated codes", async () => {
    const res = leaseErrorResponse(1, ERR_CERT_NOT_IMPL, "test");
    expect(res.status).toBe(501);  // 501 = not implemented
  });

  it("returns 403 for scope_denied", async () => {
    const res = leaseErrorResponse(1, ERR_SCOPE_DENIED, "scope mismatch");
    expect(res.status).toBe(403);
  });

  it("body is JSON-RPC error envelope with the right code", async () => {
    const res = leaseErrorResponse("req-123", ERR_SCOPE_DENIED, "scope mismatch");
    const body = await res.json() as { jsonrpc: string; id: string; error: { code: number; message: string } };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe("req-123");
    expect(body.error.code).toBe(ERR_SCOPE_DENIED);
    expect(body.error.message).toBe("scope mismatch");
  });
});

// ── certFingerprint ─────────────────────────────────────────────────────

describe("certFingerprint", () => {
  it("produces a 64-char hex digest", async () => {
    const fp = await certFingerprint(new Uint8Array([1, 2, 3]));
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", async () => {
    const a = await certFingerprint(new Uint8Array([1, 2, 3]));
    const b = await certFingerprint(new Uint8Array([1, 2, 3]));
    expect(a).toBe(b);
  });

  it("changes when input changes", async () => {
    const a = await certFingerprint(new Uint8Array([1, 2, 3]));
    const b = await certFingerprint(new Uint8Array([1, 2, 4]));
    expect(a).not.toBe(b);
  });
});
