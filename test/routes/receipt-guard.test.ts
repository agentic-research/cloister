/// <reference types="@cloudflare/vitest-pool-workers/types" />
//
// Behavioural conformance for credential-isolation/v1's forbidden-receipt-field
// requirement (cloister-d7216a), driven by LLO's published vectors.
//
// The vector's own framing:
//
//   "A conformant implementation MUST refuse to emit a receipt that contains
//    any of the field names in FORBIDDEN_RECEIPT_FIELDS — in any form: raw,
//    hashed, partial, length, base64'd, hex'd. The rejection happens at the
//    receipt-build layer, BEFORE the signature is computed, so a leaky receipt
//    never reaches the signing key."
//
// ── Why the guard is not a list of the five tested names ─────────────────────
//
// The five vector cases are a SUBSET of what the spec forbids. LLO's README
// §"MUST NOT commit (security-load-bearing)" lists five *categories*:
//
//   1. the credential value in any form (raw, hashed, partial, length)
//   2. the upstream's request body        <- tested
//   3. the upstream's response body       <- NOT tested by any vector
//   4. any query string component         <- NOT tested by any vector
//   5. the credential's allowedSubs policy
//
// A guard keyed on the five tested field names passes every vector and still
// leaks a response body or a query string. So the guard is written against the
// README's categories and the vectors are the regression floor, not the
// specification. The suite asserts both: the vectors pass, AND the two
// untested categories are rejected.

import { describe, expect, it } from "vitest";
import leakVectors from "../fixtures/llo-credential-isolation-v1/test-vectors/adversarial-credential-leak.json";
import { findForbiddenReceiptField } from "../../src/routes/receipt-guard";

describe("LLO adversarial-credential-leak vectors", () => {
  it("vendors the cases this suite claims to drive", () => {
    // Guards against the suite passing vacuously if the fixture moves or the
    // shape changes — every assertion below is a no-op over an empty array.
    expect(leakVectors.vectors.length).toBe(5);
    expect(leakVectors.version).toBe("cloister/credential-isolation/v1");
  });

  for (const c of leakVectors.vectors) {
    it(`rejects ${c.name} naming ${c.expected_forbidden_field}`, () => {
      const found = findForbiddenReceiptField(
        c.inputs.receipt_row as Record<string, unknown>,
      );
      // The vector pins WHICH field is reported, not merely that one was —
      // an operator reading the log needs the offending name.
      expect(found).toBe(c.expected_forbidden_field);
      expect(c.expected_reject_kind).toBe("forbidden_field");
    });
  }
});

describe("the categories LLO's README forbids but no vector covers", () => {
  // These are the reason the guard is category-driven. If it were keyed on the
  // five tested names, both of these would pass silently.
  it("rejects an upstream response body (README category 3)", () => {
    expect(findForbiddenReceiptField({ service: "openai", response_body: "..." }))
      .toBe("response_body");
  });

  it("rejects a query string component (README category 4)", () => {
    expect(findForbiddenReceiptField({ service: "openai", query_string: "?k=v" }))
      .toBe("query_string");
  });
});

describe("credential leakage in any form", () => {
  // "in any form: raw, hashed, partial, length, base64'd, hex'd" — a guard
  // matching exact names would miss every one of these renamings.
  it.each([
    "credentialValue",
    "credential_sha256",
    "credential_b64",
    "cred_hash",
    "CREDENTIAL_LENGTH",
    "apiKey",
    "api_key",
    "secret",
    "authorization",
  ])("rejects %s", (field) => {
    expect(findForbiddenReceiptField({ service: "openai", [field]: "x" })).toBe(field);
  });
});

describe("the safe receipt shape is not rejected", () => {
  it("passes cloister's own ProxyCallReceipt fields", () => {
    // The guard must not fire on the shape cloister actually emits, or it
    // would take out the audit chain it exists to protect.
    expect(findForbiddenReceiptField({
      capability:        "cloister/credential-isolation/v1",
      peerFp:            "sha256:abc",
      service:           "openai",
      upstreamStatus:    200,
      upstreamUrlPath:   "/v1/chat/completions",
      requestSizeBytes:  128,
      responseSizeBytes: 4096,
      wallClockMs:       42,
      tsMs:              1700000100000,
      nonceHex:          "deadbeef",
    })).toBeNull();
  });

  it("passes the vector's own safe fields", () => {
    // LLO's rows are snake_case where cloister's are camelCase; the guard must
    // be naming-convention agnostic or it would report the wrong field.
    expect(findForbiddenReceiptField({
      peer_fp_hex:       "aa".repeat(32),
      service:           "openai",
      upstream_status:   200,
      upstream_url_path: "/v1/chat/completions",
    })).toBeNull();
  });

  it("passes an empty row", () => {
    expect(findForbiddenReceiptField({})).toBeNull();
  });
});
