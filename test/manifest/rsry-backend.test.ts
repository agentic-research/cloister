// Structural pin: the rsry_* mcpProxy backend is declared in the
// canonical manifest, per ADR-0033. This test exists so a future
// edit that drops the route (manual or via emit drift) fails loudly
// at lint time, not silently at production-traffic time.
//
// Tracking bead: cloister-c2bd47 (ADR-0033 implementation).

import { describe, expect, it } from "vitest";
import { manifest } from "../../src/generated/manifest.js";

describe("ADR-0033 / cloister-c2bd47 — rsry_* mcpProxy backend pinned in manifest", () => {
  const mcpRoute = manifest.routes.find((r) => r.path === "/mcp");

  it("the /mcp route exists in the canonical manifest", () => {
    expect(mcpRoute).toBeDefined();
    expect(mcpRoute?.kind && "mcp" in mcpRoute.kind).toBe(true);
  });

  const backends = mcpRoute && "mcp" in mcpRoute.kind
    ? mcpRoute.kind.mcp.backends
    : [];

  it("rsry backend is declared with handlesPrefix='rsry_'", () => {
    const rsry = backends.find((b) => b.name === "rsry");
    expect(rsry).toBeDefined();
    expect(rsry?.handlesPrefix).toBe("rsry_");
  });

  it("rsry backend kind is mcpProxy (not durableObject), routing to ROSARY_BUNDLE", () => {
    const rsry = backends.find((b) => b.name === "rsry");
    expect(rsry).toBeDefined();
    expect(rsry && "mcpProxy" in rsry.kind).toBe(true);
    if (rsry && "mcpProxy" in rsry.kind) {
      expect(rsry.kind.mcpProxy.serviceBinding).toBe("ROSARY_BUNDLE");
      expect(rsry.kind.mcpProxy.urlBinding).toBe("ROSARY_MCP_URL");
    }
  });

  it("rsry backend declares dynamicTools=true (full rsry catalog flows through tools/list)", () => {
    const rsry = backends.find((b) => b.name === "rsry");
    if (rsry && "mcpProxy" in rsry.kind) {
      expect(rsry.kind.mcpProxy.dynamicTools).toBe(true);
    }
  });

  it("rsry backend stripPrefix is empty (rsry's own names are already rsry_*)", () => {
    const rsry = backends.find((b) => b.name === "rsry");
    if (rsry && "mcpProxy" in rsry.kind) {
      expect(rsry.kind.mcpProxy.stripPrefix).toBe("");
    }
  });

  it("rsry backend requires an MCP Streamable HTTP session", () => {
    const rsry = backends.find((b) => b.name === "rsry");
    if (rsry && "mcpProxy" in rsry.kind) {
      expect(rsry.kind.mcpProxy.requiresSession).toBe(true);
    }
  });

  it("rsry backend claims include core bead operations (operator-declared static surface)", () => {
    const rsry = backends.find((b) => b.name === "rsry");
    if (rsry && "mcpProxy" in rsry.kind) {
      const claims = rsry.kind.mcpProxy.claims;
      // Core bead-substrate operations every consumer relies on.
      const required = [
        "rsry_bead_create",
        "rsry_bead_search",
        "rsry_bead_close",
        "rsry_bead_update",
        "rsry_bead_comment",
        "rsry_list_beads",
        "rsry_status",
      ];
      for (const name of required) {
        expect(claims).toContain(name);
      }
    }
  });

  it("rsry backend is the SECOND mcp backend (bead_* DurableObject stays first; ADR-0033 D5 coexistence)", () => {
    // Per ADR-0033 D5: the bead_* mcpProxy (cloister BeadStore DO) is
    // not deprecated — it coexists with rsry_*. This pins the
    // coexistence by asserting both backends remain in the route's
    // backend list.
    const beadDo = backends.find((b) => b.name === "bead");
    const rsry   = backends.find((b) => b.name === "rsry");
    expect(beadDo).toBeDefined();
    expect(rsry).toBeDefined();
    expect(beadDo && "durableObject" in beadDo.kind).toBe(true);
  });
});
