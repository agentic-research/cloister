// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 cloister contributors

/**
 * denial-audit.test.ts — unit tests for `buildDenialAuditEntry`
 * (cloister-fb1ea2, migrated from notme-6a4a45).
 *
 * The §9.4.b enumeration-oracle invariant says the WIRE BODY of a
 * vault denial must be constant-shape so a probing caller can't
 * distinguish "no credential" from "credential exists, ACL denies."
 * The structured denial-audit emit is the OTHER half of that bargain:
 * the operator-facing log records the distinguishable reason
 * INTERNALLY so brute-force probing, substrate degradation, and
 * healthy-but-strict denial can be told apart in `wrangler tail`.
 *
 * These tests pin the shape contract — bucketed cardinality on
 * fingerprints (so an attacker rotating identifiers can't blow up
 * the log volume), required `ts`, optional fields actually optional.
 */

import { describe, expect, it } from "vitest";
import { buildDenialAuditEntry } from "../handler.js";

describe("buildDenialAuditEntry", () => {
  it("emits event + ts; all other fields optional", () => {
    const entry = buildDenialAuditEntry({ event: "rate_limited" });
    expect(entry.event).toBe("rate_limited");
    expect(typeof entry.ts).toBe("number");
    expect(entry.ts).toBeGreaterThan(0);
    expect(entry.subjectFp).toBeUndefined();
    expect(entry.callerSub).toBeUndefined();
    expect(entry.service).toBeUndefined();
    expect(entry.reason).toBeUndefined();
    expect(entry.retryAfterSec).toBeUndefined();
  });

  it("truncates long subjectFp + callerSub to bound log cardinality", () => {
    // 16-char prefix + ellipsis matches the notme closing playbook.
    // Without truncation, an attacker rotating WIMSE URIs blows up
    // the metrics backend through this log channel.
    const longFp = "abcdef0123456789abcdef0123456789"; // 32 chars
    const entry = buildDenialAuditEntry({
      event: "credential_denied",
      subjectFp: longFp,
      callerSub: longFp,
    });
    expect(entry.subjectFp).toBe("abcdef0123456789…");
    expect(entry.callerSub).toBe("abcdef0123456789…");
  });

  it("preserves short identifiers without truncation", () => {
    // Below the 16-char threshold = no ellipsis. Lets debugging logs
    // stay readable when subjectFp is already a short bundle name.
    const entry = buildDenialAuditEntry({
      event: "service_undeclared",
      subjectFp: "short-fp",
    });
    expect(entry.subjectFp).toBe("short-fp");
  });

  it("preserves service / reason / retryAfterSec verbatim", () => {
    // Service names are part of the operator's manifest; they're
    // already bounded cardinality. retryAfterSec is a small int.
    // No truncation; these go in as-is.
    const entry = buildDenialAuditEntry({
      event: "rate_limited",
      service: "openai",
      reason: "burst gate exhausted",
      retryAfterSec: 5,
    });
    expect(entry.service).toBe("openai");
    expect(entry.reason).toBe("burst gate exhausted");
    expect(entry.retryAfterSec).toBe(5);
  });

  it("supports all VaultDenialEvent variants exhaustively", () => {
    // Anti-regression for the type union — if a new variant lands in
    // handler.ts without updating this list, the test still passes
    // (we just don't exercise the new one), but the TypeScript
    // compiler errors here will surface a removed/renamed variant.
    const events: Array<Parameters<typeof buildDenialAuditEntry>[0]["event"]> = [
      "rate_limited",
      "rate_limited_burst",
      "credential_missing",
      "credential_denied",
      "lease_failed",
      "service_undeclared",
      "manifest_deny",
      "store_unavailable",
    ];
    for (const event of events) {
      const entry = buildDenialAuditEntry({ event });
      expect(entry.event).toBe(event);
    }
  });

  it("serializes to JSON without throwing (smoke test for log emission)", () => {
    // Callers `console.log(JSON.stringify(buildDenialAuditEntry(...)))`,
    // so the returned object must be serializable. Tests no field
    // smuggles a non-serializable value (e.g. a circular ref or
    // a Date object that the truncation logic mishandles).
    const entry = buildDenialAuditEntry({
      event: "credential_denied",
      subjectFp: "wimse://notme.bot/repo/foo/bar",
      callerSub: "wimse://notme.bot/agent/baz",
      service: "stripe",
      reason: "ACL deny",
    });
    const serialized = JSON.stringify(entry);
    expect(serialized).toContain('"event":"credential_denied"');
    expect(serialized).toContain('"service":"stripe"');
    expect(serialized).toContain('"ts":');
  });
});
