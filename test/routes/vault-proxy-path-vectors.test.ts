/// <reference types="@cloudflare/vitest-pool-workers/types" />
//
// Conformance for credential-isolation/v1's path-parsing vectors (cloister-1b2961),
// driven by LLO's published cases rather than a hand-copy of them.
//
// Two of the four cases were real divergences when this landed:
//
//   1. `/vault/proxy/openai` (service root, no trailing slash) — the vector
//      pins upstreamPath "" ; cloister returned "/".
//   2. `/vault/proxy/OpenAI/v1/foo` — the vector requires rejection
//      (`malformed_service`); cloister had no character-class check at all and
//      returned {service:"OpenAI", upstreamPath:"/v1/foo"}.
//
// ── On changing the service-root value, which cloister had pinned ────────────
//
// cloister's own test asserted upstreamPath === "/" for the service root, so
// this is a deliberate cloister choice against a published vector, not an
// oversight. It is safe to change because it is unobservable on the upstream
// wire: the value is concatenated as
// `cfg.upstreamBaseUrl.replace(/\/+$/, "") + upstreamPath`, and
// `new URL("https://api.openai.com")` and `new URL("https://api.openai.com/")`
// both normalize to href "https://api.openai.com/" with pathname "/". Verified
// before making the change.
//
// What it DOES change is that `/vault/proxy/openai` and `/vault/proxy/openai/`
// become distinguishable — under "/" they parsed identically. The receipt's
// `upstreamUrlPath` records the parsed value, so the two now produce distinct
// receipts. That is the more faithful reading of the request.
//
// ── On the reject KIND, deliberately not implemented ─────────────────────────
//
// The vectors carry `expected_reject_kind` (`malformed_path` vs
// `malformed_service`) and `parseVaultProxyPath` returns a bare `null` for
// both, so the two are indistinguishable by return value. That is NOT fixed
// here, and the reason is a security property rather than effort: cloister
// collapses every rejection on this surface into one constant-time 404 body
// (CONSTANT_TIME_ERROR_BODY) precisely so the proxy cannot be used as an
// enumeration oracle for which services exist. A discriminated reject kind is
// fine internally but must never reach the response, so adding one buys
// nothing the vectors can observe and adds a channel that has to be kept
// closed. Tracked as the residue of cloister-1b2961.

import { describe, expect, it } from "vitest";
import pathVectors from "../fixtures/llo-credential-isolation-v1/test-vectors/path-parsing.json";
import { parseVaultProxyPath } from "../../src/routes/vault-proxy";

describe("LLO path-parsing vectors", () => {
  it("vendors the cases this suite claims to drive", () => {
    expect(pathVectors.vectors.length).toBe(4);
    expect(pathVectors.version).toBe("cloister/credential-isolation/v1");
  });

  for (const c of pathVectors.vectors) {
    it(`${c.name}: ${c.expected_result}`, () => {
      const got = parseVaultProxyPath(c.inputs.path);

      if (c.expected_result === "reject") {
        // Both reject kinds collapse to null — see the header note on why the
        // kind is deliberately not surfaced.
        expect(got).toBeNull();
        return;
      }

      expect(got).not.toBeNull();
      expect(got!.service).toBe(c.expected_service);
      expect(got!.upstreamPath).toBe(c.expected_upstream_path);
    });
  }
});

describe("service-name grammar [a-z0-9][a-z0-9._-]{0,62}", () => {
  // The vector rejects uppercase with a stated rationale worth preserving:
  // "case-sensitivity in service names would create lookup hazards (manifest
  // entries are lowercase by convention; accepting OpenAI would either
  // silently miss the openai entry or silently equate them, both bad)."
  it.each(["OpenAI", "Openai", "oPenai"])("rejects uppercase %s", (svc) => {
    expect(parseVaultProxyPath(`/vault/proxy/${svc}/v1/foo`)).toBeNull();
  });

  it.each(["openai", "a", "anthropic", "svc-1", "svc_1", "svc.1", "0penai"])(
    "accepts %s",
    (svc) => {
      expect(parseVaultProxyPath(`/vault/proxy/${svc}/v1/foo`)?.service).toBe(svc);
    },
  );

  it.each(["-lead", "_lead", ".lead"])("rejects %s — first char must be alnum", (svc) => {
    expect(parseVaultProxyPath(`/vault/proxy/${svc}/v1/foo`)).toBeNull();
  });

  it.each(["sv c", "sv%20c", "sv+c", "sv@c", "sv/c/extra"])(
    "rejects %s — character outside the class",
    (svc) => {
      // `sv/c/extra` is the interesting one: the slash makes `sv` the service,
      // which IS valid — so this asserts the split happens before the grammar
      // check, not that the whole segment is scanned.
      const got = parseVaultProxyPath(`/vault/proxy/${svc}`);
      if (svc === "sv/c/extra") expect(got?.service).toBe("sv");
      else expect(got).toBeNull();
    },
  );

  it("enforces the 63-character ceiling", () => {
    const ok = "a".repeat(63);
    const tooLong = "a".repeat(64);
    expect(parseVaultProxyPath(`/vault/proxy/${ok}/x`)?.service).toBe(ok);
    expect(parseVaultProxyPath(`/vault/proxy/${tooLong}/x`)).toBeNull();
  });
});

describe("shapes cloister already handled, which must not regress", () => {
  it("keeps the leading slash on a real upstream path", () => {
    expect(parseVaultProxyPath("/vault/proxy/anthropic/v1/messages")).toEqual({
      service: "anthropic",
      upstreamPath: "/v1/messages",
    });
  });

  it("returns null outside the /vault/proxy/ prefix", () => {
    for (const p of ["/health", "/mcp", "/vault/admin", "/"]) {
      expect(parseVaultProxyPath(p)).toBeNull();
    }
  });

  it("returns null for the prefix with no service", () => {
    expect(parseVaultProxyPath("/vault/proxy/")).toBeNull();
  });
});
