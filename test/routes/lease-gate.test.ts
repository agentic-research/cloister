// Table-driven tests for resolveLeaseGate — the ADR-0053 authority-source
// resolver (cloister-220c9d). Pure over env, so no workerd needed.

import { afterEach, describe, expect, it, vi } from "vitest";
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

// ADR-0085: every refusal through the one gate is recorded, once, as a
// structured event, and the verdict the caller turns into its response is
// unchanged. The event never carries header material.
describe("gateAndVerify records every refusal (ADR-0085)", () => {
  afterEach(() => vi.restoreAllMocks());

  const recorded = (spy: ReturnType<typeof vi.spyOn>) =>
    spy.mock.calls.map((args) => JSON.parse(String(args[0]))).filter((e) => e.target === "lease_gate");

  it("a deny-when-off refusal is one event naming the route, method, scope and code", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const req = new Request("http://x/vault/proxy/svc/v1?x=1", { method: "POST", body: "{}" });
    const v = await gateAndVerify(env({ CLOISTER_MODE: "dev" }), 0, { req, body: "{}", id: 1, method: "ping", params: undefined }, { denyWhenOff: true });
    expect(v.kind).toBe("reject");
    expect(recorded(warn)).toEqual([{
      target: "lease_gate", op: "verify", outcome: "refused",
      code: ERR_UNAUTHENTICATED, reason: "authentication required",
      route: "/vault/proxy/svc/v1", method: "ping", scope: "unknown:ping",
    }]);
  });

  it("failing closed for want of a CA bundle is recorded", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const req = new Request("http://x/mcp", { method: "POST", body: "{}" });
    await gateAndVerify(env({}), 0, { req, body: "{}", id: 1, method: "tools/list", params: undefined });
    const events = recorded(warn);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ code: ERR_CA_UNAVAILABLE, reason: "CA bundle unavailable", scope: "tools:list" });
  });

  it("a pass-through gate records nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const req = new Request("http://x/mcp", { method: "POST", body: "{}" });
    const v = await gateAndVerify(env({ CLOISTER_MODE: "dev" }), 0, { req, body: "{}", id: 1, method: "ping", params: undefined });
    expect(v.kind).toBe("off");
    expect(recorded(warn)).toEqual([]);
  });

  it("a verifier refusal is recorded with its reason, and none of the request's header bytes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const req = new Request("http://x/mcp", {
      method: "POST", body: "{}",
      headers: { Authorization: "Signet CERTBYTES", "X-Signet-Sig": "SIGBYTES", "X-Signet-Nonce": "NONCEBYTES", "X-Signet-Ts": "not-a-number" },
    });
    const v = await gateAndVerify(env({ CLOISTER_MODE: "dev", DEV_CA_MASTER: "a".repeat(64) }), 0, { req, body: "{}", id: 1, method: "tools/list", params: undefined });
    expect(v.kind).toBe("reject");
    const events = recorded(warn);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: "refused", route: "/mcp", method: "tools/list", scope: "tools:list" });
    if (v.kind === "reject") expect(events[0]).toMatchObject({ code: v.code, reason: v.message });
    // The verifier refused, not the CA-bundle step before it.
    expect(events[0].reason).toMatch(/^lease auth header malformed: /);
    for (const material of ["CERTBYTES", "SIGBYTES", "NONCEBYTES"]) expect(JSON.stringify(events[0])).not.toContain(material);
  });
});
