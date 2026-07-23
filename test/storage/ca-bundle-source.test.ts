/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it } from "vitest";
import { resolveCABundle } from "../../src/storage/ca-bundle-source.js";
import { CaUnavailableError } from "../../src/storage/ca-bundle-cache.js";
import type { Env } from "../../src/types.js";

// resolveCABundle is the fail-closed seam for the lease gate's trust anchor
// (cloister-d2db6d, ADR-0053). Its no-anchor guard had NO direct test: a
// mutation probe that deleted the `throw` and instead called getCABundle with
// an EMPTY rootPubkey — which makes ca-bundle-cache SKIP signature verification
// entirely — survived the full 1396-test suite. The behaviour was correct and
// asserted only by a comment. These tests pin it.

/** Minimal Env; the throwing paths never reach a binding. */
function envWith(over: Partial<Record<string, unknown>> = {}): Env {
  return over as unknown as Env;
}

describe("resolveCABundle — fail-closed trust anchor", () => {
  it("throws CaUnavailableError when there is NO anchor at all", async () => {
    // Neither the dev CA seam nor a pinned root pubkey. Falling through here
    // would reach getCABundle with an empty rootPubkey, i.e. an UNVERIFIED
    // bundle — the exact regression this guard exists to prevent.
    await expect(resolveCABundle(envWith({}), Date.now())).rejects.toThrow(CaUnavailableError);
  });

  it("throws when CLOISTER_MODE=dev but no DEV_CA_MASTER and no root pubkey", async () => {
    // Dev mode alone must not conjure a trust anchor — ADR-0053 rule 3 only
    // turns the GATE off; it never fabricates a CA bundle.
    await expect(
      resolveCABundle(envWith({ CLOISTER_MODE: "dev" }), Date.now()),
    ).rejects.toThrow(CaUnavailableError);
  });

  it("names the two ways to supply an anchor, so the failure is actionable", async () => {
    await expect(resolveCABundle(envWith({}), Date.now())).rejects.toThrow(/INTERLACE_ROOT_PUBKEY/);
    await expect(resolveCABundle(envWith({}), Date.now())).rejects.toThrow(/DEV_CA_MASTER/);
  });

  it("returns the static dev bundle when CLOISTER_MODE=dev + DEV_CA_MASTER are both set", async () => {
    // The positive case: a real anchor exists, so it must NOT throw. This is
    // what stops the guard from being trivially satisfiable by always throwing.
    const bundle = await resolveCABundle(
      envWith({ CLOISTER_MODE: "dev", DEV_CA_MASTER: "ZGV2LW1hc3Rlci1wdWJrZXktYjY0", DEV_CA_EPOCH: "7" }),
      Date.now(),
    );
    expect(bundle.epoch).toBe(7);
    expect(bundle.keys[bundle.keyId]).toBe("ZGV2LW1hc3Rlci1wdWJrZXktYjY0");
  });
});
