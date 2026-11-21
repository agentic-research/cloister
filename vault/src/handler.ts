// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 cloister contributors
// Origin: agentic-research/notme (Apache-2.0); see ../NOTICE.

// The vault's denial audit: the structured record logged when the vault
// refuses a call. The request handler that once lived here served the
// standalone vault Worker this library came from; cloister never called it,
// and it built upstream requests a second way, so it went with ADR-0082.

// Denial events the vault emits as structured logs on the rejection
// paths. The wire response stays constant-shape per the §9.4.b
// enumeration-oracle invariant; this internal audit captures the
// distinguishable reason so an operator can tell brute-force probing
// from substrate degradation from healthy-but-strict access denials.
// Per cloister-fb1ea2 (migrated from notme-6a4a45).
export type VaultDenialEvent =
  | "rate_limited"          // sustained token-bucket exhausted
  | "rate_limited_burst"    // concurrent in-flight cap exceeded
  | "credential_missing"    // no row + no row→ACL leakage (both branches collapse to 404)
  | "credential_denied"     // row exists, callerSub not in allowedSubs (wire-collapsed to 404)
  | "credential_upstream_mismatch" // the declared upstream is not the one the credential was stored for (wire 404, ADR-0082 §2)
  | "lease_failed"          // verifyAndUpsertLease returned non-ok (wire 401)
  | "service_undeclared"    // service not in manifest (wire 404)
  | "manifest_deny"         // serviceConfig.defaultAllowedSubs rejected peerFp (wire 404)
  | "store_unavailable";    // selectCredentialStore returned null (wire 503)

// Build a structured denial-audit record. Identifiers are truncated
// to bound cardinality: an attacker rotating `callerSub` values can't
// blow up the metrics backend through this log channel. Use 16-char
// prefix + ellipsis (matches the notme closing playbook pattern).
//
// Caller logs the result; this function never emits. That keeps testing
// trivial (assert on the returned object) and lets call sites choose the
// log destination.
export function buildDenialAuditEntry(input: {
  event: VaultDenialEvent;
  subjectFp?: string;
  callerSub?: string;
  service?: string;
  reason?: string;
  retryAfterSec?: number;
}): {
  event: VaultDenialEvent;
  subjectFp?: string;
  callerSub?: string;
  service?: string;
  reason?: string;
  retryAfterSec?: number;
  ts: number;
} {
  const out: ReturnType<typeof buildDenialAuditEntry> = {
    event: input.event,
    ts: Date.now(),
  };
  if (input.subjectFp !== undefined) {
    out.subjectFp = input.subjectFp.length > 16
      ? input.subjectFp.slice(0, 16) + "…"
      : input.subjectFp;
  }
  if (input.callerSub !== undefined) {
    out.callerSub = input.callerSub.length > 16
      ? input.callerSub.slice(0, 16) + "…"
      : input.callerSub;
  }
  if (input.service !== undefined) out.service = input.service;
  if (input.reason !== undefined) out.reason = input.reason;
  if (input.retryAfterSec !== undefined) out.retryAfterSec = input.retryAfterSec;
  return out;
}
