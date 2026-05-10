/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it } from "vitest";
import { validateCluster, type Bundle, type Cluster, type Wire } from "../../src/manifest/cluster-types.js";

// ── Helpers ──────────────────────────────────────────────────────────────

function bundle(name: string, over: Partial<Bundle> = {}): Bundle {
  return {
    name,
    description: `${name} test bundle`,
    tier: "cluster",
    kind: { external: {
      image: `${name}:test`,
      ipcSocket: `/run/cloister-uds/${name}.sock`,
      httpPort: 0,
      args: [],
      env: [],
    }},
    ...over,
  };
}

function wire(from: string, to: string, binding: string): Wire {
  return { from, to, binding, transport: { uds: null } };
}

function cluster(over: Partial<Cluster> = {}): Cluster {
  return {
    metadata: { name: "test-cluster", version: "0.0.1" },
    bundles:  [],
    wires:    [],
    storage:  { doStoragePath: "/var/lib/cloister/do" },
    ...over,
  };
}

// ── happy path ───────────────────────────────────────────────────────────

describe("validateCluster — happy path", () => {
  it("accepts an empty cluster", () => {
    expect(() => validateCluster(cluster())).not.toThrow();
  });

  it("accepts a cluster with bundles + wires + storage", () => {
    expect(() => validateCluster(cluster({
      bundles: [
        bundle("cloister-router", { tier: "hypervisor" }),
        bundle("mache"),
        bundle("rosary"),
      ],
      wires: [
        wire("cloister-router", "mache",  "MACHE_BUNDLE"),
        wire("cloister-router", "rosary", "ROSARY_BUNDLE"),
      ],
    }))).not.toThrow();
  });

  it("accepts mixed tier classification", () => {
    expect(() => validateCluster(cluster({
      bundles: [
        bundle("router", { tier: "hypervisor" }),
        bundle("tool",   { tier: "cluster" }),
      ],
    }))).not.toThrow();
  });
});

// ── metadata validation ─────────────────────────────────────────────────

describe("validateCluster — metadata", () => {
  it("rejects missing metadata.name", () => {
    expect(() => validateCluster(cluster({
      metadata: { name: "", version: "0.0.1" },
    }))).toThrow(/metadata.name is required/);
  });

  it("rejects missing metadata.version", () => {
    expect(() => validateCluster(cluster({
      metadata: { name: "x", version: "" },
    }))).toThrow(/metadata.version is required/);
  });
});

// ── bundle validation ───────────────────────────────────────────────────

describe("validateCluster — bundles", () => {
  it("rejects bundle with empty name", () => {
    expect(() => validateCluster(cluster({
      bundles: [bundle("")],
    }))).toThrow(/name is required/);
  });

  it("rejects duplicate bundle names", () => {
    expect(() => validateCluster(cluster({
      bundles: [bundle("mache"), bundle("mache")],
    }))).toThrow(/duplicate name "mache"/);
  });

  it("rejects unknown tier", () => {
    expect(() => validateCluster(cluster({
      bundles: [bundle("x", { tier: "magical" as unknown as "cluster" })],
    }))).toThrow(/unknown tier "magical"/);
  });
});

// ── wire validation ─────────────────────────────────────────────────────

describe("validateCluster — wires", () => {
  it("rejects wire with empty from/to/binding", () => {
    expect(() => validateCluster(cluster({
      bundles: [bundle("a")],
      wires: [wire("", "a", "BINDING")],
    }))).toThrow(/from\/to\/binding all required/);

    expect(() => validateCluster(cluster({
      bundles: [bundle("a")],
      wires: [wire("a", "", "BINDING")],
    }))).toThrow(/from\/to\/binding all required/);

    expect(() => validateCluster(cluster({
      bundles: [bundle("a"), bundle("b")],
      wires: [wire("a", "b", "")],
    }))).toThrow(/from\/to\/binding all required/);
  });

  it("rejects wire `from` referencing undeclared bundle", () => {
    expect(() => validateCluster(cluster({
      bundles: [bundle("a")],
      wires: [wire("ghost", "a", "BINDING")],
    }))).toThrow(/from "ghost" references undeclared bundle/);
  });

  it("rejects wire `to` referencing undeclared bundle", () => {
    expect(() => validateCluster(cluster({
      bundles: [bundle("a")],
      wires: [wire("a", "ghost", "BINDING")],
    }))).toThrow(/to "ghost" references undeclared bundle/);
  });

  it("rejects self-wire (bundle wiring to itself)", () => {
    expect(() => validateCluster(cluster({
      bundles: [bundle("a")],
      wires: [wire("a", "a", "SELF_BINDING")],
    }))).toThrow(/self-wire on "a" not allowed/);
  });
});

// ── consumer manifest sanity ────────────────────────────────────────────

describe("the generated cluster.ts (consumer manifest)", () => {
  it("loads + validates without errors", async () => {
    const { cluster: real } = await import("../../src/generated/cluster.js");
    expect(() => validateCluster(real)).not.toThrow();
  });

  it("declares the four expected bundles", async () => {
    const { cluster: real } = await import("../../src/generated/cluster.js");
    const names = real.bundles.map(b => b.name).sort();
    expect(names).toEqual(["cloister-router", "mache", "notme-identity", "rosary"]);
  });

  it("declares three wires originating at cloister-router", async () => {
    const { cluster: real } = await import("../../src/generated/cluster.js");
    expect(real.wires.length).toBe(3);
    expect(real.wires.every(w => w.from === "cloister-router")).toBe(true);
  });

  it("storage path set to the documented default", async () => {
    const { cluster: real } = await import("../../src/generated/cluster.js");
    expect(real.storage.doStoragePath).toBe("/var/lib/cloister/do");
  });
});
