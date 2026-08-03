// SPDX-License-Identifier: AGPL-3.0-or-later
//
// receipt-guard — refuse to emit a proxy receipt that commits to forbidden
// material (cloister-d7216a). Per
// leyline-schema-spec/credential-isolation/v1/README.md
// §"MUST NOT commit (security-load-bearing)".
//
// ── Why this exists when the receipt is already a closed type ────────────────
//
// `ProxyCallReceipt` is a fixed interface built as a typed object literal, so a
// credential cannot reach a receipt today without someone editing both. That is
// a structural guarantee, and it is invisible to LLO's conformance vectors,
// which require a *runtime* refusal. It is also invisible to the metrics arm of
// the same emitter, whose labels are assembled from call arguments and which
// `ProxyCallReceipt` does not constrain at all — that arm is guarded only by a
// prose comment today ("NEVER include the credential value, request body,
// query string, or upstream URL fragments"). This repo's own rule is that an
// invariant with no rail is a comment; this is the rail.
//
// ── Deny by category, not by the five names the vectors happen to test ───────
//
// LLO's adversarial-credential-leak.json pins five field names. The README
// forbids five CATEGORIES, and two of them — the upstream response body and any
// query-string component — have no vector case at all. A guard written against
// the tested names would pass every vector and still leak a response body, so
// the categories are the specification here and the vectors are the regression
// floor.
//
// The credential category is explicitly "in any form (raw, hashed, partial,
// length)", which exact-name matching cannot express: `credential_value`,
// `credentialValue`, `cred_hash` and `credential_b64` are the same leak. So the
// credential family is matched by SUBSTRING on a normalized name, the same
// technique `src/obs/log.ts` already uses to redact secret-shaped log fields.
//
// ── Deny-list, not allow-list, and why ──────────────────────────────────────
//
// An allow-list over `ProxyCallReceipt`'s ten fields would be strictly stronger
// for cloister's own emission. It cannot drive LLO's vectors: their rows are
// snake_case (`peer_fp_hex`, `upstream_status`) where cloister's are camelCase,
// so an allow-list would reject the vector's SAFE fields and report the wrong
// name — the vectors pin *which* field is named, not merely that one was. A
// deny-list is convention-agnostic and is what a second implementation with its
// own field naming can actually satisfy. Callers wanting the stronger property
// should keep building receipts as closed literals; this guard is the floor.

/**
 * Substrings that make a field name forbidden regardless of the rest of it.
 * Compared against a normalized (lower-cased, separator-stripped) name, so
 * `credential_value`, `credentialValue` and `CREDENTIAL-VALUE` all match.
 *
 * Covers README category 1 ("the credential value, in any form") plus the
 * adjacent secret-material names a receipt has no business carrying. Kept in
 * step with `SECRET_FIELD_MARKERS` in `src/obs/log.ts` — same threat, different
 * response (that redacts a value, this refuses the whole row).
 */
export const FORBIDDEN_RECEIPT_FIELD_MARKERS: readonly string[] = [
  // `cred`, not `credential`: the category is the credential "in any form
  // (raw, hashed, partial, length)", and `cred_hash` is a hashed credential
  // that `credential` does not match. Over-rejection is the safe direction on
  // this surface — a false positive fails closed and surfaces immediately,
  // because cloister's own receipt is a closed literal whose ten field names
  // are asserted clean in the companion test.
  "cred",
  "apikey",
  "secret",
  "token",
  "password",
  "passphrase",
  "privatekey",
  "authorization",
  "cookie",
] as const;

/**
 * Exact (normalized) field names that are forbidden without being
 * secret-shaped. These are the README categories that name a specific artifact
 * rather than a class of material.
 */
export const FORBIDDEN_RECEIPT_FIELD_NAMES: readonly string[] = [
  // README category 2 — the upstream's request body (may contain user PII).
  "requestbody",
  "reqbody",
  "body",
  // README category 3 — the upstream's response body. No vector covers this.
  "responsebody",
  "respbody",
  // README category 4 — any query-string component. No vector covers this.
  "query",
  "querystring",
  "queryparams",
  "searchparams",
  // README category 5 — the credential's allowedSubs policy. A receipt that
  // committed to it would turn the audit chain into a "list every peer
  // authorized for this service" oracle.
  "allowedsubs",
] as const;

/** Lower-case and drop separators so naming conventions cannot evade the check. */
function normalize(name: string): string {
  return name.toLowerCase().replace(/[_\-.\s]/g, "");
}

/**
 * The first forbidden field in `row`, by its ORIGINAL key name, or `null` when
 * the row is clean.
 *
 * Returns the original spelling rather than the normalized form because the
 * name is what an operator reads in the refusal log, and LLO's vectors pin it
 * (`expected_forbidden_field`).
 *
 * Shallow by design: `ProxyCallReceipt` is a flat scalar record, and a nested
 * object in a receipt is itself a shape violation that the type prevents. A
 * deep walk would invite passing arbitrary structures through the guard as if
 * that were supported.
 */
export function findForbiddenReceiptField(row: Record<string, unknown>): string | null {
  for (const key of Object.keys(row)) {
    const n = normalize(key);
    if (FORBIDDEN_RECEIPT_FIELD_NAMES.includes(n)) return key;
    if (FORBIDDEN_RECEIPT_FIELD_MARKERS.some((marker) => n.includes(marker))) return key;
  }
  return null;
}
