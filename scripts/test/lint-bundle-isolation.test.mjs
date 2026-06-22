// scripts/test/lint-bundle-isolation.test.mjs
//
// Run with:  pnpm exec tsx --test scripts/test/lint-bundle-isolation.test.mjs
//
// Synthesizes a bad/good cluster+config pair in a tmpdir, points the
// lint script at it, asserts exit code + violation messages. The real
// project manifests are checked by a separate regression test that
// runs the lint script against the live cwd.
//
// Lives under scripts/test/ (not test/) because vitest pool-workers
// runs the workerd vitest pool, which has no `node:child_process` and
// can't spawn the lint script. The plugin-hooks tests do the same.
//
// Post-ADR-0025 / cloister-cf519b: the lint reads cluster shape from
// `src/generated/cluster.ts` (the canonical derived artifact), not
// from `cluster.capnp`. Tests synthesize a TypeScript module exporting
// the `cluster` const; the lint loads it via the tsx loader (invoked
// via `pnpm exec tsx`). config.capnp parsing is unchanged.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const LINT_SCRIPT = resolve(REPO_ROOT, "scripts/lint-bundle-isolation.mjs");
// Resolve tsx via its node_modules/.bin path directly. `pnpm exec tsx`
// fails when cwd is a tmpdir without a package.json (the tests run
// with cwd=workDir so config.capnp resolves at the right place).
const TSX_BIN = resolve(REPO_ROOT, "node_modules/.bin/tsx");

// ── Test harness ──────────────────────────────────────────────────────────

/**
 * Build a tmpdir containing:
 *
 *   <tmp>/work/src/generated/cluster.ts  ← test's cluster shape (TS const)
 *   <tmp>/work/config.capnp              ← test's workerd config
 *   <tmp>/work/dist/index.js             ← embed stub
 *   <tmp>/work/node_modules              ← symlink to real node_modules
 *                                          (so the lint script's
 *                                          workerd schema lookup works)
 *
 * Returns { dir, workDir, clusterTsPath }. Caller invokes the lint
 * with cwd=workDir and env.CLUSTER_TS=clusterTsPath.
 */
function makeScenario({ clusterTs, configCapnp, omitClusterTs = false }) {
  const dir = mkdtempSync(resolve(tmpdir(), "lint-bundle-isolation-"));
  const workDir = resolve(dir, "work");
  const generatedDir = resolve(workDir, "src/generated");

  mkdirSync(workDir, { recursive: true });
  mkdirSync(generatedDir, { recursive: true });
  mkdirSync(resolve(workDir, "dist"), { recursive: true });

  // Symlink node_modules so workerd.capnp is reachable.
  symlinkSync(
    resolve(REPO_ROOT, "node_modules"),
    resolve(workDir, "node_modules"),
  );

  const clusterTsPath = resolve(generatedDir, "cluster.ts");
  if (!omitClusterTs) {
    writeFileSync(clusterTsPath, clusterTs);
  }
  writeFileSync(resolve(workDir, "config.capnp"), configCapnp);
  writeFileSync(resolve(workDir, "dist/index.js"), "/* stub */");

  return {
    dir,
    workDir,
    clusterTsPath,
    cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

function runLint(workDir, clusterTsPath) {
  // Invoke tsx directly via its node_modules/.bin path (not
  // `pnpm exec tsx`, which fails from a tmpdir cwd lacking a
  // package.json). tsx provides the .ts loader the lint script needs
  // to dynamically import the synthesized cluster.ts fixture.
  //
  // CLUSTER_TS env-var pins the synthesized fixture; without it the
  // script would default-resolve to <cwd>/src/generated/cluster.ts
  // which is also fine here, but the explicit env-var keeps the
  // contract visible.
  return spawnSync(TSX_BIN, [LINT_SCRIPT], {
    cwd: workDir,
    env: { ...process.env, CLUSTER_TS: clusterTsPath ?? "" },
    encoding: "utf8",
  });
}

// ── Fixture builders ──────────────────────────────────────────────────────

// Test fixture builder. Each bundle takes:
//   name                — required
//   tier                — required ("hypervisor" | "cluster")
//   workerdServiceName  — optional, defaults to "" (most bundles don't have one)
//   holdsCredential     — optional, defaults to [] (cluster bundles must leave empty)
//   hypervisorRationale — optional, but REQUIRED-non-empty for tier=hypervisor
//                         (lint Inv 3 enforces). Defaults to "test hypervisor
//                         rationale" for hypervisor tier, "" for cluster tier
//                         — tests can override either.
//
// Returns a TS module string exporting `cluster`. Same shape as the
// real src/generated/cluster.ts that toml-to-cluster.mjs emits.
function clusterTs({ bundles, wires = [], inputs = [] }) {
  const cluster = {
    metadata: { name: "test", version: "0.0.1" },
    bundles: bundles.map(({
      name,
      tier,
      workerdServiceName = "",
      holdsCredential = [],
      hypervisorRationale,
    }) => ({
      name,
      description: `${name} test bundle`,
      tier,
      workerdServiceName,
      holdsCredential,
      hypervisorRationale: hypervisorRationale ?? (tier === "hypervisor"
        ? "test hypervisor rationale"
        : ""),
      kind: {
        external: {
          image: `${name}:test`,
          ipcSocket: `/run/cloister-uds/${name}.sock`,
          httpPort: 0,
          args: [],
          env: [],
        },
      },
    })),
    wires: wires.map(({ from, to, binding }) => ({
      from,
      to,
      binding,
      transport: { uds: null },
    })),
    storage: { doStoragePath: "/data/do" },
    // ADR-0030 §A5 inputs with optional tenancy. Pass tenancy = {} to
    // exercise the rung-2 / rung-3 fallbacks; pass {workerdId: "..."} to
    // pin explicit declarations.
    inputs: inputs.map((i) => ({
      name: i.name,
      ref: i.ref ?? `github://test/${i.name}@main`,
      version: i.version ?? "^0.1",
      digest: "",
      from: "",
      provides: [],
      requires: [],
      urlBinding: "",
      serviceBinding: "",
      tenancy: {
        mode: i.mode ?? "",
        workerdId: i.workerdId ?? "",
        trustedTier: i.trustedTier ?? false,
        sharesWorkerdWith: i.sharesWorkerdWith ?? [],
      },
    })),
  };
  // Pure data, no type annotations or imports — tsx loads this as
  // plain JS at runtime.
  return `export const cluster = ${JSON.stringify(cluster, null, 2)};\n`;
}

// capnp identifiers must be camelCase / no hyphens; the service NAME
// (the string) can have hyphens. Map the service name to a sanitized
// identifier for the matching `const <ident>Worker` declaration.
function ident(name) {
  return name.replace(/-([a-zA-Z])/g, (_, c) => c.toUpperCase());
}

function configCapnp({ workers, services = [] }) {
  const svcBlock = workers.map((w) => `    ( name = "${w.name}", worker = .${ident(w.name)}Worker ),`).join("\n");
  const extraSvcBlock = services.map((s) => {
    if (s.network) return `    ( name = "${s.name}", network = ( allow = [${s.network.allow.map(a => `"${a}"`).join(", ")}] ) ),`;
    return `    ( name = "${s.name}", external = ( address = "localhost:0" ) ),`;
  }).join("\n");
  const workerBlocks = workers.map((w) => {
    const bindings = (w.bindings ?? []).map((b) => {
      if (b.service) return `    ( name = "${b.name}", service = "${b.service}" ),`;
      if (b.text !== undefined) return `    ( name = "${b.name}", text = "${b.text}" ),`;
      if (b.durableObjectNamespace) return `    ( name = "${b.name}", durableObjectNamespace = "${b.durableObjectNamespace}" ),`;
      throw new Error(`unknown binding kind in test fixture: ${JSON.stringify(b)}`);
    }).join("\n");
    // capnp doesn't allow trailing commas in struct literals, so omit the
    // bindings block entirely when empty.
    const bindingsBlock = bindings ? `\n  bindings = [\n${bindings}\n  ],` : "";
    const goLine = w.globalOutbound ? `\n  globalOutbound = "${w.globalOutbound}",` : "";
    return `const ${ident(w.name)}Worker :Workerd.Worker = (
  compatibilityDate = "2025-01-01",
  modules = [ ( name = "worker", esModule = embed "dist/index.js" ) ],${bindingsBlock}${goLine}
);`;
  }).join("\n\n");

  return `
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
${svcBlock}
${extraSvcBlock}
  ],
);

${workerBlocks}
`;
}

// ── Tests ─────────────────────────────────────────────────────────────────

test("clean baseline — single hypervisor bundle with no extra bindings", () => {
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [{
        name: "cloister-router",
        tier: "hypervisor",
        workerdServiceName: "cloister",
      }],
      wires: [],
    }),
    configCapnp: configCapnp({
      workers: [{
        name: "cloister",
        bindings: [],
        globalOutbound: "internet",
      }],
      services: [{ name: "internet", network: { allow: ["public"] } }],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.equal(r.status, 0, `expected clean lint pass, got: ${r.stderr}\nstdout:${r.stdout}`);
    assert.match(r.stdout, /clean ✓/);
  } finally {
    scenario.cleanup();
  }
});

test("Inv 1 — cluster-tier worker with internet-bound globalOutbound is rejected", () => {
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [{
        name: "tool-x",
        tier: "cluster",
        workerdServiceName: "tool-x",
      }],
    }),
    configCapnp: configCapnp({
      workers: [{
        name: "tool-x",
        bindings: [],
        globalOutbound: "internet",
      }],
      services: [{ name: "internet", network: { allow: ["public"] } }],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.equal(r.status, 1, `expected violation, got status=${r.status}\nstdout:${r.stdout}\nstderr:${r.stderr}`);
    assert.match(r.stderr, /Inv 1/);
    assert.match(r.stderr, /unrestricted egress/);
  } finally {
    scenario.cleanup();
  }
});

test("Inv 1 (gap 4) — cluster-tier globalOutbound to external-server service is rejected", () => {
  // Per math-friend ADR-0018 review gap 4: a cluster-tier bundle that
  // points globalOutbound at an `external = (...)` service entry
  // bypasses Inv 4's wire/external discipline — any unbound fetch()
  // would reach that target without an authorized binding name.
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [{
        name: "tool-x",
        tier: "cluster",
        workerdServiceName: "tool-x",
      }],
    }),
    configCapnp: configCapnp({
      workers: [{
        name: "tool-x",
        bindings: [],
        globalOutbound: "mache-mcp",
      }],
      services: [{ name: "mache-mcp", external: true }],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.equal(r.status, 1, `expected violation, got status=${r.status}\nstdout:${r.stdout}\nstderr:${r.stderr}`);
    assert.match(r.stderr, /Inv 1/);
    assert.match(r.stderr, /external-server/);
  } finally {
    scenario.cleanup();
  }
});

test("Inv 2 — non-vault bundle with VAULT_KEK_SOURCE is rejected", () => {
  // ADR-0014 v2 (cloister-125199): VAULT_KEK_SECRET was the v1 plaintext
  // text binding; it's been deleted. VAULT_KEK_SOURCE (the URL spec) is
  // the credential binding Inv 2 now guards.
  //
  // The allow-list now comes from cluster.capnp bundles[].holdsCredential
  // — we declare a SEPARATE bundle ("cloister-router") that legitimately
  // holds the credential, then ANOTHER bundle ("rogue") that tries to
  // hold it without being on the allow-list. This exercises the gap-2
  // wiring: the lint reads the allow-list from the manifest, not from a
  // JS constant.
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [
        {
          name: "cloister-router",
          tier: "hypervisor",
          workerdServiceName: "cloister-router",
          holdsCredential: ["VAULT_KEK_SOURCE"],
        },
        {
          name: "rogue",
          tier: "cluster",
          workerdServiceName: "rogue",
        },
      ],
    }),
    configCapnp: configCapnp({
      workers: [{
        name: "rogue",
        bindings: [{ name: "VAULT_KEK_SOURCE", text: "keychain://leaked" }],
      }],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.equal(r.status, 1, `expected violation, got status=${r.status}\nstderr:${r.stderr}`);
    assert.match(r.stderr, /Inv 2/);
    assert.match(r.stderr, /VAULT_KEK_SOURCE/);
  } finally {
    scenario.cleanup();
  }
});

test("Inv 2 (gap 2) — credential allow-list sourced from manifest holdsCredential", () => {
  // Positive: when the bundle DOES declare the binding in holdsCredential,
  // the lint passes. This is the legitimate path that the old hardcoded
  // CREDENTIAL_BINDINGS map could only express by JS edit.
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [{
        name: "vault-holder",
        tier: "hypervisor",
        workerdServiceName: "vault-holder",
        holdsCredential: ["VAULT_KEK_SOURCE", "VAULT_STORE"],
      }],
    }),
    configCapnp: configCapnp({
      workers: [{
        name: "vault-holder",
        bindings: [
          { name: "VAULT_KEK_SOURCE", text: "keychain://test" },
          { name: "VAULT_STORE", durableObjectNamespace: "CredentialVault" },
        ],
      }],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.equal(r.status, 0, `expected clean lint, got status=${r.status}\nstderr:${r.stderr}\nstdout:${r.stdout}`);
  } finally {
    scenario.cleanup();
  }
});

test("Inv 2 (gap 2) — custom credential binding name is enforceable via manifest", () => {
  // Negative: a NEW credential binding name ("MASTER_SK_SOURCE") can be
  // protected without touching the lint script — declare it in
  // holdsCredential on the legitimate bundle and the lint will reject
  // it on any other bundle. This is the architectural property gap 2
  // unlocks: no more JS-side edits to extend the allow-list.
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [
        {
          name: "notme-identity",
          tier: "hypervisor",
          workerdServiceName: "notme-identity",
          holdsCredential: ["MASTER_SK_SOURCE"],
        },
        {
          name: "thief",
          tier: "cluster",
          workerdServiceName: "thief",
        },
      ],
    }),
    configCapnp: configCapnp({
      workers: [{
        name: "thief",
        bindings: [{ name: "MASTER_SK_SOURCE", text: "keychain://stolen" }],
      }],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.equal(r.status, 1, `expected violation, got status=${r.status}\nstderr:${r.stderr}`);
    assert.match(r.stderr, /Inv 2/);
    assert.match(r.stderr, /MASTER_SK_SOURCE/);
  } finally {
    scenario.cleanup();
  }
});

test("Inv 3 (gap 1) — tier=hypervisor without hypervisorRationale is rejected", () => {
  // Per math-friend gap 1: tier=hypervisor inherits Inv 1/2/4 exemptions
  // so promotion must be explicitly justified. The fixture builder
  // defaults rationale to a placeholder; explicitly override to "" to
  // trigger the violation.
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [{
        name: "unjustified-hyper",
        tier: "hypervisor",
        workerdServiceName: "unjustified-hyper",
        hypervisorRationale: "",
      }],
    }),
    configCapnp: configCapnp({
      workers: [{
        name: "unjustified-hyper",
        bindings: [],
      }],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.equal(r.status, 1, `expected violation, got status=${r.status}\nstderr:${r.stderr}`);
    assert.match(r.stderr, /Inv 3/);
    assert.match(r.stderr, /hypervisorRationale/);
  } finally {
    scenario.cleanup();
  }
});

test("Inv 4 — cluster-tier worker with service binding but no wire is rejected (orphan)", () => {
  // Orphan scenario: the binding's target is a network-egress service —
  // NOT a wire in cluster.capnp AND NOT an `external` service (which the
  // cloister-b65a20 carve-out would otherwise treat as legitimate). This
  // is the "neither (a) nor (b)" footgun that Inv 4 exists to catch.
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [
        { name: "tool-y", tier: "cluster", workerdServiceName: "tool-y" },
        { name: "other",  tier: "cluster", workerdServiceName: "" },
      ],
      wires: [], // tool-y → other binding declared in config but missing here
    }),
    configCapnp: configCapnp({
      workers: [{
        name: "tool-y",
        bindings: [{ name: "OTHER_BINDING", service: "other-svc" }],
      }],
      services: [{ name: "other-svc", network: { allow: ["public"] } }],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.equal(r.status, 1, `expected violation, got status=${r.status}\nstderr:${r.stderr}`);
    assert.match(r.stderr, /Inv 4/);
    assert.match(r.stderr, /orphan binding/);
  } finally {
    scenario.cleanup();
  }
});

test("Inv 4 — cluster-tier worker with wired service binding passes", () => {
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [
        { name: "tool-z", tier: "cluster", workerdServiceName: "tool-z" },
        { name: "other",  tier: "cluster", workerdServiceName: "" },
      ],
      wires: [{ from: "tool-z", to: "other", binding: "OTHER_BINDING" }],
    }),
    configCapnp: configCapnp({
      workers: [{
        name: "tool-z",
        bindings: [{ name: "OTHER_BINDING", service: "other-svc" }],
      }],
      services: [{ name: "other-svc", external: true }],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.equal(r.status, 0, `expected clean lint, got status=${r.status}\nstderr:${r.stderr}\nstdout:${r.stdout}`);
  } finally {
    scenario.cleanup();
  }
});

test("Inv 4 — cluster-tier worker with external-server-backed binding passes (cloister-b65a20)", () => {
  // The cloister-b65a20 carve-out: a service binding whose target has an
  // `external = (...)` entry in config.capnp is legitimate — it
  // terminates at a workerd-declared address inside the same bundle,
  // not at another bundle, so no cluster.capnp wire is required.
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [{ name: "tool-w", tier: "cluster", workerdServiceName: "tool-w" }],
      wires: [],
    }),
    configCapnp: configCapnp({
      workers: [{
        name: "tool-w",
        bindings: [{ name: "MACHE_MCP", service: "mache-mcp" }],
      }],
      services: [{ name: "mache-mcp", external: true }],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.equal(r.status, 0, `expected clean lint, got status=${r.status}\nstderr:${r.stderr}\nstdout:${r.stdout}`);
  } finally {
    scenario.cleanup();
  }
});

test("Inv 5 (gap 5) — hypervisor-to-hypervisor service binding without wire is rejected", () => {
  // Per math-friend ADR-0018 review gap 5: once notme-identity lands as
  // a second hypervisor-tier bundle, hypervisor-to-hypervisor topology
  // must remain on the wire diagram. A hypervisor bundle that declares
  // a service binding pointing at another hypervisor bundle without a
  // matching wire is rejected by Inv 5.
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [
        {
          name: "router-a",
          tier: "hypervisor",
          workerdServiceName: "router-a",
        },
        {
          name: "router-b",
          tier: "hypervisor",
          workerdServiceName: "router-b",
        },
      ],
      wires: [], // router-a → router-b binding declared in config but no wire
    }),
    configCapnp: configCapnp({
      workers: [{
        name: "router-a",
        bindings: [{ name: "PEER_HYPER", service: "router-b" }],
      }],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.equal(r.status, 1, `expected violation, got status=${r.status}\nstderr:${r.stderr}`);
    assert.match(r.stderr, /Inv 5/);
    assert.match(r.stderr, /hypervisor/);
  } finally {
    scenario.cleanup();
  }
});

test("Inv 5 (gap 5) — hypervisor-to-hypervisor with matching wire passes", () => {
  // Positive case: same shape, but with the wire declared. This is
  // exactly the topology ADR-0018 ships (cloister-router → notme-identity
  // via NOTME binding).
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [
        {
          name: "router-a",
          tier: "hypervisor",
          workerdServiceName: "router-a",
        },
        {
          name: "router-b",
          tier: "hypervisor",
          workerdServiceName: "router-b",
        },
      ],
      wires: [{ from: "router-a", to: "router-b", binding: "PEER_HYPER" }],
    }),
    configCapnp: configCapnp({
      workers: [{
        name: "router-a",
        bindings: [{ name: "PEER_HYPER", service: "router-b" }],
      }],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.equal(r.status, 0, `expected clean lint, got status=${r.status}\nstderr:${r.stderr}\nstdout:${r.stdout}`);
  } finally {
    scenario.cleanup();
  }
});

test("hypervisor bundle is exempt from Inv 1 (globalOutbound to internet OK)", () => {
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [{
        name: "cloister-router",
        tier: "hypervisor",
        workerdServiceName: "cloister",
      }],
    }),
    configCapnp: configCapnp({
      workers: [{
        name: "cloister",
        bindings: [],
        globalOutbound: "internet",
      }],
      services: [{ name: "internet", network: { allow: ["public"] } }],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.equal(r.status, 0, `hypervisor should bypass Inv 1; got: ${r.stderr}`);
  } finally {
    scenario.cleanup();
  }
});

test("workerdServiceName join key — Worker without matching bundle warns + treats as cluster", () => {
  // Per math-friend gap 3: the workerdServiceName field replaces the
  // hand-edited alias map. A workerd service that has no matching
  // bundle declaration is treated as cluster-tier (strict default)
  // AND surfaces a warning, so the alias-miss case can't silently
  // mis-classify a hypervisor bundle as something else.
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [{
        name: "cloister-router",
        tier: "hypervisor",
        workerdServiceName: "cloister", // service "orphan" is NOT mapped
      }],
    }),
    configCapnp: configCapnp({
      workers: [{
        name: "orphan",
        bindings: [],
        globalOutbound: "internet",
      }],
      services: [{ name: "internet", network: { allow: ["public"] } }],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    // The orphan service should be flagged by Inv 1 (cluster default
    // + internet egress) — this confirms the strict-default semantics.
    assert.equal(r.status, 1, `expected violation due to strict cluster default; got status=${r.status}\nstderr:${r.stderr}`);
    assert.match(r.stderr, /no matching bundle/);
    assert.match(r.stderr, /Inv 1/);
  } finally {
    scenario.cleanup();
  }
});

test("regression — the live cloister manifests pass the lint", () => {
  // Runs via tsx so the script can dynamically import the real
  // src/generated/cluster.ts (post-ADR-0025).
  const r = spawnSync(TSX_BIN, [LINT_SCRIPT], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `live manifests should lint clean; stderr:\n${r.stderr}\nstdout:\n${r.stdout}`);
  assert.match(r.stdout, /clean ✓/);
});

// ── cloister-cf519b regression: lint reads cluster.ts, not cluster.capnp ──

test("cloister-cf519b — lint detects a cluster.ts violation even when no cluster.capnp exists at all", () => {
  // The skeptic-flagged scenario: cluster.toml + cluster.ts have a
  // violation, but lint was reading the stale cluster.capnp. Pre-fix,
  // this test would have failed with exit 2 (toolchain error — capnp
  // eval would fail on a missing source). Post-fix, the lint loads
  // cluster.ts and detects the violation (exit 1).
  //
  // makeScenario writes cluster.ts but NO cluster.capnp; the violation
  // is a cluster-tier bundle with a non-empty holdsCredential (Inv 2 —
  // the credential allow-list is built from manifest holdsCredential,
  // but a cluster-tier bundle holding any credential is itself the
  // ADR-0013 violation we're catching via Inv 2 + the workerd binding
  // shape it forces).
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [
        // legitimate vault holder
        {
          name: "router",
          tier: "hypervisor",
          workerdServiceName: "router",
          holdsCredential: ["MASTER_SK_SOURCE"],
        },
        // a cluster-tier bundle that should NOT hold the credential
        {
          name: "rogue-tool",
          tier: "cluster",
          workerdServiceName: "rogue-tool",
        },
      ],
    }),
    configCapnp: configCapnp({
      workers: [{
        name: "rogue-tool",
        bindings: [{ name: "MASTER_SK_SOURCE", text: "keychain://leaked" }],
      }],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    // Must be a violation (exit 1), NOT a toolchain error (exit 2).
    // Exit 2 would mean the lint tried to read cluster.capnp and
    // failed — which is exactly what cf519b was filed to prevent.
    assert.equal(
      r.status, 1,
      `lint must detect the violation via cluster.ts (exit 1); ` +
        `exit 2 would mean it tried to read cluster.capnp\n` +
        `status=${r.status}\nstderr:\n${r.stderr}\nstdout:\n${r.stdout}`,
    );
    assert.match(r.stderr, /Inv 2/);
    assert.match(r.stderr, /MASTER_SK_SOURCE/);
  } finally {
    scenario.cleanup();
  }
});

// ── Invariant 6 — ADR-0030 §A5 tenancy / workerd-boundary property ──────
//
// Per cloister-104199 (lint-1). These tests pin the contract added on
// top of the existing 5 ADR-0013 invariants. Skip-by-construction for
// pre-ADR-0030 cluster.toml (no inputs declared).

test("Inv 6 — clusters with no inputs trivially pass (back-compat)", () => {
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [{ name: "cloister-router", tier: "hypervisor", workerdServiceName: "cloister" }],
      wires: [],
      inputs: [], // explicit empty
    }),
    configCapnp: configCapnp({
      workers: [{ name: "cloister", bindings: [], globalOutbound: "internet" }],
      services: [{ name: "internet", network: { allow: ["public"] } }],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.equal(r.status, 0, `expected pass; got: ${r.stderr}`);
  } finally { scenario.cleanup(); }
});

test("Inv 6 — input with explicit workerdId pointing at non-existent bundle fails", () => {
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [{ name: "cloister-router", tier: "hypervisor", workerdServiceName: "cloister" }],
      inputs: [{ name: "ghost", workerdId: "phantom-bundle" }],
    }),
    configCapnp: configCapnp({
      workers: [{ name: "cloister", bindings: [], globalOutbound: "internet" }],
      services: [{ name: "internet", network: { allow: ["public"] } }],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Inv 6/);
    assert.match(r.stderr, /phantom-bundle/);
  } finally { scenario.cleanup(); }
});

test("Inv 6 — input with same-name bundle resolves cleanly (rung 2)", () => {
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [
        { name: "cloister-router", tier: "hypervisor", workerdServiceName: "cloister" },
        { name: "mache", tier: "cluster" },
      ],
      inputs: [{ name: "mache" }], // empty workerdId → same-name bundle
    }),
    configCapnp: configCapnp({
      workers: [{ name: "cloister", bindings: [], globalOutbound: "internet" }],
      services: [{ name: "internet", network: { allow: ["public"] } }],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.equal(r.status, 0, `expected pass; got: ${r.stderr}`);
  } finally { scenario.cleanup(); }
});

test("Inv 6 — input with empty workerdId + no same-name bundle falls back to gateway (rung 3)", () => {
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [{ name: "cloister-router", tier: "hypervisor", workerdServiceName: "cloister" }],
      inputs: [{ name: "llo" }], // empty workerdId, no llo bundle → gateway fallback
    }),
    configCapnp: configCapnp({
      workers: [{ name: "cloister", bindings: [], globalOutbound: "internet" }],
      services: [{ name: "internet", network: { allow: ["public"] } }],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.equal(r.status, 0, `expected pass via gateway fallback; got: ${r.stderr}`);
  } finally { scenario.cleanup(); }
});

test("Inv 6 — input with empty workerdId + no gateway + no same-name fails", () => {
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [{ name: "tool-only", tier: "cluster", workerdServiceName: "tool-only" }],
      inputs: [{ name: "orphan" }],
    }),
    configCapnp: configCapnp({
      workers: [{ name: "tool-only", bindings: [], globalOutbound: "internet" }],
      services: [{ name: "internet", network: { allow: ["public"] } }],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    // Other invariants may fire too (tool-only has internet globalOutbound),
    // but Inv 6 must surface in the error list.
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Inv 6/);
    assert.match(r.stderr, /orphan/);
  } finally { scenario.cleanup(); }
});

test("Inv 6 — trustedTier=true on non-hypervisor bundle is rejected", () => {
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [
        { name: "cloister-router", tier: "hypervisor", workerdServiceName: "cloister" },
        { name: "mache", tier: "cluster" },
      ],
      inputs: [{ name: "evil", workerdId: "mache", trustedTier: true }],
    }),
    configCapnp: configCapnp({
      workers: [{ name: "cloister", bindings: [], globalOutbound: "internet" }],
      services: [{ name: "internet", network: { allow: ["public"] } }],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Inv 6/);
    assert.match(r.stderr, /trustedTier=true/);
  } finally { scenario.cleanup(); }
});

test("Inv 6 — explicit workerdId pointing at hypervisor bundle without trustedTier is rejected", () => {
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [{ name: "cloister-router", tier: "hypervisor", workerdServiceName: "cloister" }],
      // explicit workerdId="cloister-router" (hypervisor) but trustedTier not declared
      inputs: [{ name: "sneaky", workerdId: "cloister-router" }],
    }),
    configCapnp: configCapnp({
      workers: [{ name: "cloister", bindings: [], globalOutbound: "internet" }],
      services: [{ name: "internet", network: { allow: ["public"] } }],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Inv 6/);
    assert.match(r.stderr, /trustedTier/);
  } finally { scenario.cleanup(); }
});

test("Inv 6 — trustedTier=true on hypervisor bundle passes", () => {
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [{ name: "cloister-router", tier: "hypervisor", workerdServiceName: "cloister" }],
      inputs: [{ name: "notme", workerdId: "cloister-router", trustedTier: true }],
    }),
    configCapnp: configCapnp({
      workers: [{ name: "cloister", bindings: [], globalOutbound: "internet" }],
      services: [{ name: "internet", network: { allow: ["public"] } }],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.equal(r.status, 0, `expected pass; got: ${r.stderr}`);
  } finally { scenario.cleanup(); }
});

test("Inv 6 — sharesWorkerdWith with non-existent partner is rejected", () => {
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [{ name: "cloister-router", tier: "hypervisor", workerdServiceName: "cloister" }],
      inputs: [
        { name: "a", workerdId: "cloister-router", trustedTier: true, sharesWorkerdWith: ["b"] },
        // input "b" never declared
      ],
    }),
    configCapnp: configCapnp({
      workers: [{ name: "cloister", bindings: [], globalOutbound: "internet" }],
      services: [{ name: "internet", network: { allow: ["public"] } }],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Inv 6/);
    assert.match(r.stderr, /sharesWorkerdWith="b"/);
  } finally { scenario.cleanup(); }
});

test("Inv 6 — sharesWorkerdWith with disagreeing partner workerdId is rejected", () => {
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [
        { name: "cloister-router", tier: "hypervisor", workerdServiceName: "cloister" },
        { name: "side-workerd", tier: "cluster" },
      ],
      inputs: [
        { name: "a", workerdId: "cloister-router", trustedTier: true, sharesWorkerdWith: ["b"] },
        { name: "b", workerdId: "side-workerd" }, // disagrees with a's expectation
      ],
    }),
    configCapnp: configCapnp({
      workers: [{ name: "cloister", bindings: [], globalOutbound: "internet" }],
      services: [{ name: "internet", network: { allow: ["public"] } }],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Inv 6/);
    assert.match(r.stderr, /Co-tenants must share a workerd/);
  } finally { scenario.cleanup(); }
});

test("Inv 6 — sharesWorkerdWith with matching partner workerdId passes", () => {
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [{ name: "cloister-router", tier: "hypervisor", workerdServiceName: "cloister" }],
      inputs: [
        { name: "notme", workerdId: "cloister-router", trustedTier: true, sharesWorkerdWith: ["identity-bridge"] },
        { name: "identity-bridge", workerdId: "cloister-router", trustedTier: true },
      ],
    }),
    configCapnp: configCapnp({
      workers: [{ name: "cloister", bindings: [], globalOutbound: "internet" }],
      services: [{ name: "internet", network: { allow: ["public"] } }],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.equal(r.status, 0, `expected pass; got: ${r.stderr}`);
  } finally { scenario.cleanup(); }
});

test("cloister-cf519b — lint exits 2 with helpful error when cluster.ts is missing", () => {
  // Negative: confirm the missing-cluster.ts path produces a clear
  // toolchain error (exit 2), not a silent pass. Operators should see
  // an actionable message pointing at `task cluster:toml`.
  const scenario = makeScenario({
    clusterTs: "", // ignored — omitClusterTs takes precedence
    omitClusterTs: true,
    configCapnp: configCapnp({
      workers: [{ name: "anything", bindings: [] }],
      services: [{ name: "internet", network: { allow: ["public"] } }],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.equal(r.status, 2, `missing cluster.ts should be a toolchain error (exit 2); got ${r.status}`);
    assert.match(r.stderr, /cluster source not found/);
    assert.match(r.stderr, /task cluster:toml/);
  } finally {
    scenario.cleanup();
  }
});
