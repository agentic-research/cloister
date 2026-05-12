// scripts/test/lint-bundle-isolation.test.mjs
//
// Run with:  node --test scripts/test/lint-bundle-isolation.test.mjs
//
// Synthesizes a bad/good cluster+config pair in a tmpdir, points the
// lint script at it, asserts exit code + violation messages. The real
// project manifests are checked by a separate regression test that
// runs the lint script against the live cwd.
//
// Lives under scripts/test/ (not test/) because vitest pool-workers
// runs the workerd vitest pool, which has no `node:child_process` and
// can't spawn the lint script. The plugin-hooks tests do the same.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const LINT_SCRIPT = resolve(REPO_ROOT, "scripts/lint-bundle-isolation.mjs");

// ── Test harness ──────────────────────────────────────────────────────────

/**
 * Build a tmpdir containing:
 *
 *   <tmp>/cloister/manifest/cluster.capnp   ← symlink to real schema
 *   <tmp>/work/cluster.capnp                 ← test's consumer manifest
 *   <tmp>/work/config.capnp                  ← test's workerd config
 *   <tmp>/work/dist/index.js                 ← embed stub
 *   <tmp>/work/node_modules                  ← symlink to real node_modules
 *                                              (so the lint script's
 *                                              workerd schema lookup works)
 *
 * Returns { dir, workDir }. Caller invokes the lint with cwd=workDir
 * and env.CLOISTER_SCHEMA_ROOT=dir.
 */
function makeScenario({ clusterCapnp, configCapnp }) {
  const dir = mkdtempSync(resolve(tmpdir(), "lint-bundle-isolation-"));
  const cloisterDir = resolve(dir, "cloister");
  const manifestDir = resolve(cloisterDir, "manifest");
  const workDir = resolve(dir, "work");

  mkdirSync(manifestDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  mkdirSync(resolve(workDir, "dist"), { recursive: true });

  // Symlink the real manifest schema in (so capnp's
  // `import "/cloister/manifest/cluster.capnp"` resolves).
  symlinkSync(
    resolve(REPO_ROOT, "manifest/cluster.capnp"),
    resolve(manifestDir, "cluster.capnp"),
  );
  // Symlink node_modules so workerd.capnp is reachable.
  symlinkSync(
    resolve(REPO_ROOT, "node_modules"),
    resolve(workDir, "node_modules"),
  );

  writeFileSync(resolve(workDir, "cluster.capnp"), clusterCapnp);
  writeFileSync(resolve(workDir, "config.capnp"), configCapnp);
  writeFileSync(resolve(workDir, "dist/index.js"), "/* stub */");

  return {
    dir,
    workDir,
    cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

function runLint(workDir, schemaRoot) {
  return spawnSync("node", [LINT_SCRIPT], {
    cwd: workDir,
    env: { ...process.env, CLOISTER_SCHEMA_ROOT: schemaRoot },
    encoding: "utf8",
  });
}

// ── Fixture builders ──────────────────────────────────────────────────────

const CLUSTER_HEADER = `
@0xb1b1b1b1b1b1b1b2;
using Cluster = import "/cloister/manifest/cluster.capnp";

const cluster :Cluster.Cluster = (
  metadata = ( name = "test", version = "0.0.1" ),
  bundles = [`;

const CLUSTER_FOOTER = `  ],
  wires = [WIRES_PLACEHOLDER],
  storage = ( doStoragePath = "/data/do" ),
);
`;

function clusterCapnp({ bundles, wires = [] }) {
  const bundleBlocks = bundles.map(({ name, tier }) => `
    ( name = "${name}",
      description = "${name} test bundle",
      tier = ${tier},
      kind = (external = (
        image = "${name}:test",
        ipcSocket = "/run/cloister-uds/${name}.sock",
        httpPort = 0,
        args = [], env = [],
      )),
    ),`).join("");
  const wireBlocks = wires.map(({ from, to, binding }) =>
    `( from = "${from}", to = "${to}", binding = "${binding}", transport = (uds = void) )`,
  ).join(", ");
  return CLUSTER_HEADER + bundleBlocks + "\n" +
    CLUSTER_FOOTER.replace("WIRES_PLACEHOLDER", wireBlocks);
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
    clusterCapnp: clusterCapnp({
      bundles: [{ name: "cloister-router", tier: "hypervisor" }],
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
    const r = runLint(scenario.workDir, scenario.dir);
    assert.equal(r.status, 0, `expected clean lint pass, got: ${r.stderr}\nstdout:${r.stdout}`);
    assert.match(r.stdout, /clean ✓/);
  } finally {
    scenario.cleanup();
  }
});

test("Inv 1 — cluster-tier worker with internet-bound globalOutbound is rejected", () => {
  const scenario = makeScenario({
    clusterCapnp: clusterCapnp({
      bundles: [{ name: "tool-x", tier: "cluster" }],
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
    const r = runLint(scenario.workDir, scenario.dir);
    assert.equal(r.status, 1, `expected violation, got status=${r.status}\nstdout:${r.stdout}\nstderr:${r.stderr}`);
    assert.match(r.stderr, /Inv 1/);
    assert.match(r.stderr, /unrestricted egress/);
  } finally {
    scenario.cleanup();
  }
});

test("Inv 2 — non-vault bundle with VAULT_KEK_SECRET is rejected", () => {
  const scenario = makeScenario({
    clusterCapnp: clusterCapnp({
      bundles: [{ name: "rogue", tier: "cluster" }],
    }),
    configCapnp: configCapnp({
      workers: [{
        name: "rogue",
        bindings: [{ name: "VAULT_KEK_SECRET", text: "leaked" }],
      }],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.dir);
    assert.equal(r.status, 1, `expected violation, got status=${r.status}\nstderr:${r.stderr}`);
    assert.match(r.stderr, /Inv 2/);
    assert.match(r.stderr, /VAULT_KEK_SECRET/);
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
    clusterCapnp: clusterCapnp({
      bundles: [
        { name: "tool-y", tier: "cluster" },
        { name: "other",  tier: "cluster" },
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
    const r = runLint(scenario.workDir, scenario.dir);
    assert.equal(r.status, 1, `expected violation, got status=${r.status}\nstderr:${r.stderr}`);
    assert.match(r.stderr, /Inv 4/);
    assert.match(r.stderr, /orphan binding/);
  } finally {
    scenario.cleanup();
  }
});

test("Inv 4 — cluster-tier worker with wired service binding passes", () => {
  const scenario = makeScenario({
    clusterCapnp: clusterCapnp({
      bundles: [
        { name: "tool-z", tier: "cluster" },
        { name: "other",  tier: "cluster" },
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
    const r = runLint(scenario.workDir, scenario.dir);
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
    clusterCapnp: clusterCapnp({
      bundles: [{ name: "tool-w", tier: "cluster" }],
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
    const r = runLint(scenario.workDir, scenario.dir);
    assert.equal(r.status, 0, `expected clean lint, got status=${r.status}\nstderr:${r.stderr}\nstdout:${r.stdout}`);
  } finally {
    scenario.cleanup();
  }
});

test("hypervisor bundle is exempt from Inv 1 (globalOutbound to internet OK)", () => {
  const scenario = makeScenario({
    clusterCapnp: clusterCapnp({
      bundles: [{ name: "cloister-router", tier: "hypervisor" }],
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
    const r = runLint(scenario.workDir, scenario.dir);
    assert.equal(r.status, 0, `hypervisor should bypass Inv 1; got: ${r.stderr}`);
  } finally {
    scenario.cleanup();
  }
});

test("regression — the live cloister manifests pass the lint", () => {
  const r = spawnSync("node", [LINT_SCRIPT], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CLOISTER_SCHEMA_ROOT: process.env.CLOISTER_SCHEMA_ROOT ?? resolve(REPO_ROOT, ".."),
    },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `live manifests should lint clean; stderr:\n${r.stderr}\nstdout:\n${r.stdout}`);
  assert.match(r.stdout, /clean ✓/);
});
