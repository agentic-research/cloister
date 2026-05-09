/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it } from "vitest";
import {
  CONSTANT_TIME_ERROR_BODY_LEN,
  constantTimeErrorResponse,
  importHmacKey,
  signCursor,
  verifyCursor,
} from "../../src/storage/disclosure-cursor.js";

const KEY_B64_STD = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";  // 32 bytes
const KEY_B64_URL = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";    // url-no-pad
const OTHER_KEY   = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWY=";  // different 32 bytes

// ── importHmacKey ────────────────────────────────────────────────────────

describe("importHmacKey", () => {
  it("imports a base64-standard 32-byte key", async () => {
    const k = await importHmacKey(KEY_B64_STD);
    expect(k.algorithm.name).toBe("HMAC");
  });

  it("imports a base64url 32-byte key (no padding)", async () => {
    const k = await importHmacKey(KEY_B64_URL);
    expect(k.algorithm.name).toBe("HMAC");
  });
});

// ── signCursor + verifyCursor ────────────────────────────────────────────

describe("signCursor + verifyCursor", () => {
  it("round-trips a valid cursor", async () => {
    const key = await importHmacKey(KEY_B64_STD);
    const original = { peerFp: "sha256:abc", fromSeq: 42, ts: 1_700_000_000_000 };
    const cursor = await signCursor(original, key);
    const decoded = await verifyCursor(cursor, key);
    expect(decoded).toEqual(original);
  });

  it("rejects a cursor signed by a different HMAC key", async () => {
    const keyA = await importHmacKey(KEY_B64_STD);
    const keyB = await importHmacKey(OTHER_KEY);
    const cursor = await signCursor({ peerFp: "x", fromSeq: 1, ts: 1 }, keyA);
    expect(await verifyCursor(cursor, keyB)).toBeNull();
  });

  it("rejects a cursor with a tampered payload", async () => {
    const key = await importHmacKey(KEY_B64_STD);
    const cursor = await signCursor({ peerFp: "x", fromSeq: 1, ts: 1000 }, key);
    const parts = cursor.split(".");
    // Re-encode a different payload but keep the original signature.
    const tampered = parts[0] + ".eyJwZWVyRnAiOiJ4IiwiZnJvbVNlcSI6OTk5LCJ0cyI6MTAwMH0." + parts[2];
    expect(await verifyCursor(tampered, key)).toBeNull();
  });

  it("rejects a cursor with a tampered signature", async () => {
    const key = await importHmacKey(KEY_B64_STD);
    const cursor = await signCursor({ peerFp: "x", fromSeq: 1, ts: 1 }, key);
    const parts = cursor.split(".");
    const tamperedSig = parts[2]!.split("").reverse().join("");
    const tampered = `${parts[0]}.${parts[1]}.${tamperedSig}`;
    expect(await verifyCursor(tampered, key)).toBeNull();
  });

  it("rejects a malformed cursor (missing parts)", async () => {
    const key = await importHmacKey(KEY_B64_STD);
    expect(await verifyCursor("not-a-cursor", key)).toBeNull();
    expect(await verifyCursor("v1.payload", key)).toBeNull();
    expect(await verifyCursor("", key)).toBeNull();
  });

  it("rejects a cursor with the wrong version prefix", async () => {
    const key = await importHmacKey(KEY_B64_STD);
    const cursor = await signCursor({ peerFp: "x", fromSeq: 1, ts: 1 }, key);
    const wrongVersion = cursor.replace(/^v1\./, "v2.");
    expect(await verifyCursor(wrongVersion, key)).toBeNull();
  });

  it("rejects a payload missing required fields", async () => {
    const key = await importHmacKey(KEY_B64_STD);
    // Sign a payload that has only some fields; verify should reject.
    const partial = { peerFp: "x", fromSeq: 1 } as unknown as Parameters<typeof signCursor>[0];
    const cursor = await signCursor(partial, key);
    expect(await verifyCursor(cursor, key)).toBeNull();
  });

  it("is byte-stable: same input -> same cursor (no random nonces)", async () => {
    const key = await importHmacKey(KEY_B64_STD);
    const a = await signCursor({ peerFp: "x", fromSeq: 1, ts: 1 }, key);
    const b = await signCursor({ peerFp: "x", fromSeq: 1, ts: 1 }, key);
    expect(a).toBe(b);
  });

  it("changes when any field changes", async () => {
    const key = await importHmacKey(KEY_B64_STD);
    const base = await signCursor({ peerFp: "x", fromSeq: 1, ts: 1 }, key);
    const diffPeer  = await signCursor({ peerFp: "y", fromSeq: 1, ts: 1 }, key);
    const diffSeq   = await signCursor({ peerFp: "x", fromSeq: 2, ts: 1 }, key);
    const diffTs    = await signCursor({ peerFp: "x", fromSeq: 1, ts: 2 }, key);
    expect(diffPeer).not.toBe(base);
    expect(diffSeq).not.toBe(base);
    expect(diffTs).not.toBe(base);
  });
});

// ── constantTimeErrorResponse ────────────────────────────────────────────

describe("constantTimeErrorResponse", () => {
  it("returns 404 status for every error class", () => {
    expect(constantTimeErrorResponse("not_found").status).toBe(404);
    expect(constantTimeErrorResponse("denied").status).toBe(404);
    expect(constantTimeErrorResponse("bad_cursor").status).toBe(404);
  });

  it("body is exactly CONSTANT_TIME_ERROR_BODY_LEN bytes for every error class", async () => {
    const a = await constantTimeErrorResponse("not_found").text();
    const b = await constantTimeErrorResponse("denied").text();
    const c = await constantTimeErrorResponse("bad_cursor").text();
    expect(a.length).toBe(CONSTANT_TIME_ERROR_BODY_LEN);
    expect(b.length).toBe(CONSTANT_TIME_ERROR_BODY_LEN);
    expect(c.length).toBe(CONSTANT_TIME_ERROR_BODY_LEN);
    // The bodies must be IDENTICAL — not just same length — so an attacker
    // can't distinguish error classes by content.
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("Content-Length header matches body length", () => {
    const r = constantTimeErrorResponse("not_found");
    expect(r.headers.get("content-length")).toBe(String(CONSTANT_TIME_ERROR_BODY_LEN));
  });

  it("uses cache-control: no-store (don't let intermediaries cache the discrimination signal)", () => {
    expect(constantTimeErrorResponse("not_found").headers.get("cache-control")).toBe("no-store");
  });
});
