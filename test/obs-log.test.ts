/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { afterEach, describe, expect, it, vi } from "vitest";
import { logEvent, redactSecrets, REDACTED } from "../src/obs/log.js";

// cloister-bd7e51: the structured operational-log helper. These tests pin the
// three properties the trust surface relies on: a stable {target,op,outcome}
// spine, secret-material redaction, and level→sink routing.

afterEach(() => {
  vi.restoreAllMocks();
});

describe("redactSecrets", () => {
  it("redacts secret-material field names (case-insensitive, substring)", () => {
    const out = redactSecrets({
      authToken: "abc",
      masterKek: "k",
      apiSecret: "s",
      db_password: "p",
      privateKey: "pk",
    });
    expect(out).toEqual({
      authToken: REDACTED,
      masterKek: REDACTED,
      apiSecret: REDACTED,
      db_password: REDACTED,
      privateKey: REDACTED,
    });
  });

  it("leaves public crypto material untouched", () => {
    // pubkey / signature / fingerprint / kid / epoch are NOT secrets — logging
    // them is often necessary for triage and must survive redaction verbatim.
    const fields = {
      pubkey: "ed25519:AAAA",
      signature: "sig",
      fingerprint: "fp",
      kid: "k1",
      epoch: 7,
      status: 503,
    };
    expect(redactSecrets(fields)).toEqual(fields);
  });

  it("does not mutate its input", () => {
    const input = { token: "x", ok: true };
    const copy = { ...input };
    redactSecrets(input);
    expect(input).toEqual(copy);
  });
});

describe("logEvent", () => {
  it("emits one JSON line with target/op/outcome leading the object", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logEvent("warn", { target: "ca_bundle", op: "fetch", outcome: "unavailable", reason: "notme_down" });
    expect(spy).toHaveBeenCalledTimes(1);
    const arg = spy.mock.calls[0]![0] as string;
    // Single parseable JSON object, not a prose string.
    const parsed = JSON.parse(arg);
    expect(parsed).toEqual({ target: "ca_bundle", op: "fetch", outcome: "unavailable", reason: "notme_down" });
    // Spine leads the serialized key order.
    expect(Object.keys(parsed).slice(0, 3)).toEqual(["target", "op", "outcome"]);
  });

  it("redacts secret-material extra fields before emit", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logEvent("error", { target: "vault", op: "vend", outcome: "fail", authToken: "leak-me", subject_fp: "fp1" });
    const parsed = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(parsed.authToken).toBe(REDACTED);
    expect(parsed.subject_fp).toBe("fp1");
  });

  it("routes level to the matching console sink", () => {
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    logEvent("info", { target: "t", op: "o", outcome: "ok" });
    logEvent("warn", { target: "t", op: "o", outcome: "degraded" });
    logEvent("error", { target: "t", op: "o", outcome: "fail" });
    expect(info).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
  });
});
