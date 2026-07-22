// Table-driven tests for resolveLeaseGate — the ADR-0053 authority-source
// resolver (cloister-220c9d). Pure over env, so no workerd needed.

import { describe, expect, it } from "vitest";
import { resolveLeaseGate } from "../../src/routes/lease-gate.js";
import {
  gateAndVerify,
  ERR_UNAUTHENTICATED,
  ERR_CA_UNAVAILABLE,
} from "../../src/routes/lease-middleware.js";
import type { Env } from "../../src/types.js";

// Only the three fields resolveLeaseGate reads matter; cast the partial.
function env(partial: Partial<Env>): Env {
  return partial as Env;
}

describe("resolveLeaseGate (ADR-0053)", () => {
  const cases: Array<{ name: string; env: Partial<Env>; mode: "off" | "enforce" }> = [
    { name: "rule 1: dev + DEV_CA_MASTER → enforce (static dev bundle)",
      env: { CLOISTER_MODE: "dev", DEV_CA_MASTER: "k" }, mode: "enforce" },
    { name: "rule 2: dev + INTERLACE_ROOT_PUBKEY → enforce (local notme)",
      env: { CLOISTER_MODE: "dev", INTERLACE_ROOT_PUBKEY: "k" }, mode: "enforce" },
    { name: "rule 3: dev + no authority → off (the ONLY off)",
      env: { CLOISTER_MODE: "dev" }, mode: "off" },
    { name: "rule 3: dev + EMPTY anchor → off (empty == unset)",
      env: { CLOISTER_MODE: "dev", INTERLACE_ROOT_PUBKEY: "" }, mode: "off" },
    { name: "rule 4: prod + INTERLACE_ROOT_PUBKEY → enforce",
      env: { INTERLACE_ROOT_PUBKEY: "k" }, mode: "enforce" },
    { name: "rule 5: prod + no authority → enforce (fail-closed, NOT silent-off)",
      env: {}, mode: "enforce" },
    { name: "rule 5: prod + EMPTY anchor → enforce (THE empty-value fix)",
      env: { INTERLACE_ROOT_PUBKEY: "" }, mode: "enforce" },
    { name: "rule 6: prod + DEV_CA_MASTER only → enforce (devCaBundle ignores it)",
      env: { DEV_CA_MASTER: "k" }, mode: "enforce" },
    { name: "CLOISTER_MODE=prod is not dev → enforce",
      env: { CLOISTER_MODE: "prod" }, mode: "enforce" },
    { name: "CLOISTER_MODE=staging is not dev → enforce",
      env: { CLOISTER_MODE: "staging", INTERLACE_ROOT_PUBKEY: "" }, mode: "enforce" },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(resolveLeaseGate(env(c.env)).mode).toBe(c.mode);
    });
  }

  it("the empty-value footgun is closed: an empty anchor is 'off' ONLY under CLOISTER_MODE=dev", () => {
    // Prod (no CLOISTER_MODE=dev) with an empty/absent anchor must enforce —
    // this is the exact case that used to silently serve unauthenticated.
    expect(resolveLeaseGate(env({ INTERLACE_ROOT_PUBKEY: "" })).mode).toBe("enforce");
    expect(resolveLeaseGate(env({})).mode).toBe("enforce");
    // The same emptiness is a deliberate dev opt-out only when dev is explicit.
    expect(resolveLeaseGate(env({ CLOISTER_MODE: "dev", INTERLACE_ROOT_PUBKEY: "" })).mode).toBe("off");
  });
});

// gateAndVerify — the flow middleware. The pre-verify branches (off / deny /
// fail-closed) need no crypto; the enforce→verify path is covered end-to-end by
// the route integration tests (mcp-auth, vault-proxy-dev-mode, oci, disclosure).
describe("gateAndVerify (ADR-0053 flow)", () => {
  const req = new Request("http://x/mcp", { method: "POST", body: "{}" });
  const verify = { req, body: "{}", id: 1, method: "ping", params: undefined };

  it("dev opt-out (no authority), default → { off } (pass-through routes proceed)", async () => {
    const v = await gateAndVerify(env({ CLOISTER_MODE: "dev" }), 0, verify);
    expect(v.kind).toBe("off");
  });

  it("dev opt-out (no authority) + denyWhenOff → reject ERR_UNAUTHENTICATED (vault denies)", async () => {
    const v = await gateAndVerify(env({ CLOISTER_MODE: "dev" }), 0, verify, { denyWhenOff: true });
    expect(v.kind).toBe("reject");
    if (v.kind === "reject") expect(v.code).toBe(ERR_UNAUTHENTICATED);
  });

  it("prod + no authority (rule 5) → reject ERR_CA_UNAVAILABLE (fails closed, never off)", async () => {
    const v = await gateAndVerify(env({}), 0, verify);
    expect(v.kind).toBe("reject");
    if (v.kind === "reject") expect(v.code).toBe(ERR_CA_UNAVAILABLE);
  });
});
