// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Prompt-injection failure-mode demo (cloister-74ce00).
//
// What this test demonstrates:
//
//   A bundle that has been fully compromised — running attacker code
//   inside its own V8 isolate — cannot exfiltrate credentials outside
//   its slice grant. The substrate layer (vault's allowedSubs check
//   plus the envelope encryption) denies access; plaintext credential
//   bytes never enter the compromised isolate's heap.
//
// What "compromised" means here: the attacker has complete control of
// the bundle's JS heap and can call any binding the bundle has. The
// substrate's guarantee is *not* that the bundle behaves; it's that
// the things the bundle CANNOT do are the things that matter for
// confidentiality.
//
// The four scenarios this test exercises, per ADR-0013:
//
//   1. In-slice read: compromised bundle reads its OWN slice's
//      credential → permitted (proves the gate isn't accidentally
//      blanket-denying everything).
//
//   2. Out-of-slice read: compromised bundle attempts to read ANOTHER
//      slice's credential → denied at the vault gate. The credential
//      bytes never appear in the caller's response, even at debug log
//      level (vault's buildErrorResponse deliberately omits the cred
//      param's value).
//
//   3. Glob injection: compromised bundle attempts to escape its slice
//      by smuggling glob metacharacters in its identity string →
//      vault rejects the malformed identity. Closes the "attacker
//      controls the sub claim" oracle.
//
//   4. Sealed-at-rest property: even with full read access to vault's
//      backing storage (the SQLite-on-DO bytes), an attacker without
//      the KEK can't recover plaintext. This is what makes the
//      "compromised bundle reads vault.sqlite" scenario non-fatal.
//
// References:
//   - ADR-0013 (slice-grant enforcement) — the architectural model
//   - ADR-0010 (vault + bundle clusters) — the framing this demo loads
//   - vault/src/vault.ts — checkAccess + buildErrorResponse (the gate)
//   - vault/src/crypto.ts — envelope encryption (the at-rest property)
//   - notme/docs/design/009-identity-gated-runtime.md — substrate model

import { describe, expect, it } from "vitest";
import {
  checkAccess,
  buildErrorResponse,
  type StoredCredential,
} from "../../vault/src/vault.js";
import {
  deriveKEK,
  encrypt,
  decrypt,
  type SealedCredential,
} from "../../vault/src/crypto.js";

// ── Test fixture: two credentials, distinguishable slices ─────────────────
//
// In a real deployment the slice grants would be `bundle:test-app:*`
// style identities matched against the service-binding caller's
// identity (which workerd surfaces via Rpc.Stub context). For this
// test we exercise the gate directly with the identity strings.

const testAppCred: StoredCredential = {
  upstream: "https://test-app.example.test/v1",
  // In production these would be sealed; vault.proxyRequest is the
  // path that decrypts inside the DO. Here we test the gate, not the
  // crypto.
  headers: { "x-api-key": "TEST-APP-API-KEY-PLAINTEXT-OK-IN-TEST-FIXTURE" },
  allowedSubs: ["bundle:test-app:*"],
};

const githubPatCred: StoredCredential = {
  upstream: "https://api.github.com",
  headers: { "Authorization": "Bearer GITHUB-PAT-MUST-NEVER-LEAK-TO-TEST-APP" },
  allowedSubs: ["bundle:trusted-tool:*"],
};

// ── Scenario 1: in-slice access succeeds ──────────────────────────────────
//
// A single happy-path identity proves the gate isn't blanket-deny, but
// only against ONE shape. Parametrize over the range of legitimate
// identities the substrate is expected to mint so that regressions in
// glob semantics (trailing colon, empty suffix, case sensitivity,
// nearby-but-different prefixes) get caught.
//
// The glob implementation in vault/src/vault.ts uses prefix-match-then-
// suffix-match via String.startsWith / endsWith — case-SENSITIVE.
// These cases pin the load-bearing properties of that implementation.

describe("prompt-injection demo — scenario 1: in-slice read", () => {
  // Glob `bundle:test-app:*` — what should match.
  const inSliceCases: Array<{ identity: string; reason: string }> = [
    { identity: "bundle:test-app:malicious-payload", reason: "canonical bundle-instance identity" },
    { identity: "bundle:test-app:probe",             reason: "different instance, same bundle name" },
    { identity: "bundle:test-app:a",                 reason: "single-char suffix — `*` matches one or more chars" },
    { identity: "bundle:test-app:nested:dispatch",   reason: "colon-segmented instance path; `*` is greedy across segment boundaries" },
    { identity: "bundle:test-app:",                  reason: "empty suffix — `*` matches the empty string; substrate may mint this as a default-instance form" },
  ];

  for (const { identity, reason } of inSliceCases) {
    it(`permits "${identity}" (${reason})`, () => {
      expect(checkAccess(testAppCred.allowedSubs, identity)).toBe(true);
    });
  }

  // The flip side of "in-slice": identities that LOOK close to the
  // pattern but are NOT in the slice. These prove the glob isn't
  // matching too permissively.
  const nearMissCases: Array<{ identity: string; reason: string }> = [
    { identity: "bundle:test-app",                   reason: "missing trailing colon — pattern requires `bundle:test-app:` exactly" },
    { identity: "bundle:test-applepie:foo",          reason: "extended-prefix attack — `test-applepie` ⊃ `test-app` as bytes; pattern needs the colon delimiter" },
    { identity: "BUNDLE:TEST-APP:foo",               reason: "case-sensitive match — uppercase bundle name is NOT the same identity" },
    { identity: "bundle:test-app",                   reason: "no colon at all between bundle name and instance — different shape entirely" },
    { identity: "prefix-bundle:test-app:foo",        reason: "smuggled prefix in front of the pattern — anchored match required" },
    { identity: "",                                  reason: "empty identity must never match a non-trivial pattern" },
  ];

  for (const { identity, reason } of nearMissCases) {
    it(`denies near-miss "${identity}" (${reason})`, () => {
      expect(checkAccess(testAppCred.allowedSubs, identity)).toBe(false);
    });
  }

  it("the cross-slice credential remains untouchable by the same probe set", () => {
    // Sanity: every in-slice identity above is for testAppCred. None of
    // them should accidentally satisfy githubPatCred's pattern.
    for (const { identity } of inSliceCases) {
      expect(
        checkAccess(githubPatCred.allowedSubs, identity),
        `identity "${identity}" must NOT cross into the github-pat slice`,
      ).toBe(false);
    }
  });
});

// ── Scenario 2: out-of-slice access denied, no credential leak ───────────

describe("prompt-injection demo — scenario 2: out-of-slice read", () => {
  it("compromised bundle CANNOT access credentials outside its slice", () => {
    const compromisedBundleIdentity = "bundle:test-app:malicious-payload";

    const allowed = checkAccess(githubPatCred.allowedSubs, compromisedBundleIdentity);

    expect(allowed,
      "out-of-slice access must be denied — this is the load-bearing claim").toBe(false);
  });

  it("the denial response does not contain the credential bytes", () => {
    // buildErrorResponse takes the credential as an argument but
    // deliberately ignores it (see vault.ts:120-124). This test pins
    // that contract: even if a future refactor accidentally surfaces
    // _cred, the assertion will fail loudly.
    const response = buildErrorResponse(
      "forbidden",
      "bundle:test-app:malicious-payload",
      "github-pat",
      githubPatCred,
    );

    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain("GITHUB-PAT-MUST-NEVER-LEAK-TO-TEST-APP");
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("api.github.com");

    // The response should be the minimum useful for the caller —
    // error type + service name. Nothing else.
    expect(response).toEqual({ error: "forbidden", service: "github-pat" });
  });
});

// ── Scenario 3: glob-injection / control-char escape attempts ────────────
//
// An attacker who controls the sub claim might try to smuggle a glob
// that matches everything, or embed newlines to break the matcher.
// checkAccess rejects those.

describe("prompt-injection demo — scenario 3: identity injection", () => {
  it("identity strings containing control chars are rejected", () => {
    // Newline injection — the kind of attack that works against
    // naive line-oriented matchers.
    const attackerIdentity = "bundle:test-app:legit\nbundle:trusted-tool:fake";

    const inSliceOk    = checkAccess(testAppCred.allowedSubs, attackerIdentity);
    const outSliceOk   = checkAccess(githubPatCred.allowedSubs, attackerIdentity);

    expect(inSliceOk,    "newline-injected identity must NOT pass own-slice check").toBe(false);
    expect(outSliceOk,   "newline-injected identity must NOT pass cross-slice check").toBe(false);
  });

  it("null-byte injection in identity is rejected", () => {
    const attackerIdentity = "bundle:test-app:legit\x00bundle:trusted-tool:fake";

    expect(checkAccess(testAppCred.allowedSubs, attackerIdentity)).toBe(false);
    expect(checkAccess(githubPatCred.allowedSubs, attackerIdentity)).toBe(false);
  });

  it("a wildcard in the IDENTITY does not bypass the gate", () => {
    // Critical: the gate compares PATTERNS (allowedSubs) against
    // VALUES (identity). The identity is the value, never the pattern.
    // If an attacker could put "*" in their identity and have it match
    // the credential's restrictive allowedSubs, the model fails.
    const allowed = checkAccess(githubPatCred.allowedSubs, "*");

    expect(allowed,
      "an identity of literal '*' must not satisfy an allowedSubs pattern").toBe(false);
  });
});

// ── Scenario 4: sealed-at-rest — credential bytes are encrypted ──────────
//
// Even if the attacker gets read access to vault's underlying SQLite
// (e.g. by escaping the bundle isolate via some unrelated bug — the
// kind of defense-in-depth scenario the §13 priority list cares
// about), the credentials in the DB are AES-GCM ciphertext. Without
// the KEK (which lives in the vault Worker's env and never touches
// the bundle isolate), the bytes are noise.

describe("prompt-injection demo — scenario 4: sealed at rest", () => {
  it("vault entries are encrypted; raw SQLite bytes don't leak plaintext", async () => {
    const kek = await deriveKEK("test-vault-secret-NEVER-real-production");

    const sealed: SealedCredential = await encrypt(
      { "Authorization": "Bearer GITHUB-PAT-MUST-NEVER-LEAK-TO-TEST-APP" },
      kek,
    );

    // The sealed envelope is what the DO writes to SQLite.
    const rawDiskBytes = JSON.stringify(sealed);

    expect(rawDiskBytes).not.toContain("GITHUB-PAT-MUST-NEVER-LEAK-TO-TEST-APP");
    expect(rawDiskBytes).not.toContain("Bearer");
    expect(rawDiskBytes).not.toContain("Authorization");

    // Sanity: with the KEK, decryption recovers the original.
    const recovered = await decrypt(sealed, kek);
    expect(recovered).toEqual({
      "Authorization": "Bearer GITHUB-PAT-MUST-NEVER-LEAK-TO-TEST-APP",
    });
  });

  it("a different KEK cannot decrypt a credential sealed under another KEK", async () => {
    const kekA = await deriveKEK("vault-secret-A");
    const kekB = await deriveKEK("vault-secret-B-totally-different");

    const sealed = await encrypt({ "x-key": "secret-value" }, kekA);

    // AES-GCM authenticated decryption fails (throws) when the key
    // is wrong — that's the property we depend on.
    await expect(decrypt(sealed, kekB)).rejects.toThrow();
  });
});

// ── Substrate-level guarantees (documented, not test-exercised here) ─────
//
// The two non-tested guarantees this demo claims are properties of
// the workerd config, not of the JS code:
//
//   - `fetch()` is undefined inside a compromised tool-bundle Worker
//     because its config entry omits `globalOutbound`. Workerd makes
//     this impossible to bypass from JS — the function isn't there to
//     monkey-patch around.
//
//   - The bundle has no access to vault's KEK env var (different
//     binding map per Worker per ADR-0013).
//
// Both are enforced by the runtime configuration, not the test
// harness. The test for them is a lint pass over the workerd config:
// any Worker tagged `tier: cluster` (per cluster.capnp) must NOT
// declare `globalOutbound` and must NOT have vault's secret env vars
// in its binding list. Filed as a follow-up bead since the bundle
// Worker template doesn't ship yet (no workerd-bundle has been
// declared in cluster.capnp — it's a schema-reserved kind per
// cloister-be0607).
