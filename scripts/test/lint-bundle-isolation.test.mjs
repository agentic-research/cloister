// scripts/test/lint-bundle-isolation.test.mjs
//
// Run with:  node --import tsx --test scripts/test/lint-bundle-isolation.test.mjs
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
// the `cluster` const; the lint loads it via the tsx loader. config.capnp
// parsing is unchanged.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve, dirname, join as tmpResolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const LINT_SCRIPT = resolve(REPO_ROOT, "scripts/lint-bundle-isolation.mjs");
const TSX_LOADER = fileURLToPath(import.meta.resolve("tsx"));

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

function runLint(workDir, clusterTsPath, lockfilePath) {
  // Invoke Node with an absolute tsx loader path so tmpdir cwd scenarios
  // do not depend on package discovery or the tsx CLI's IPC server.
  //
  // CLUSTER_TS env-var pins the synthesized fixture; without it the
  // script would default-resolve to <cwd>/src/generated/cluster.ts
  // which is also fine here, but the explicit env-var keeps the
  // contract visible.
  const env = { ...process.env, CLUSTER_TS: clusterTsPath ?? "" };
  // ADR-0038 Inv 10: point at a fixture lockfile so the test controls which
  // inputs carry oci — never the repo's real cluster.lock.toml. Unset →
  // Inv 10 reads the repo lockfile (fine: existing fixtures set bundle
  // images, so Inv 10 stays silent on them regardless).
  if (lockfilePath !== undefined) env.CLOISTER_LOCKFILE = lockfilePath;
  return spawnSync(process.execPath, ["--import", TSX_LOADER, LINT_SCRIPT], {
    cwd: workDir,
    env,
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
function clusterTs({ bundles, wires = [], inputs = [], routes = [] }) {
  const cluster = {
    metadata: { name: "test", version: "0.0.1" },
    // ADR-0034 / Inv 7: routes optionally include tenantDispatch. Each
    // entry takes { kind: { tenantDispatch: { tenants: [...] } } }; the
    // tenants list is operator-declared rows pairing tenant names with
    // routing predicates + service-binding targets.
    routes: routes.map((r) => ({
      path: r.path ?? "/",
      kind: r.kind ?? { health: null },
    })),
    bundles: bundles.map(({
      name,
      tier,
      workerdServiceName = "",
      holdsCredential = [],
      hypervisorRationale,
      perTenant = false,
      confinement,
      image = `${name}:test`,
      // Inv 13 (cloister-54b834) requires every external bundle to declare a
      // mode. Defaulted here so the ~30 fixtures that predate the invariant
      // stay valid manifests without each restating an unrelated field — the
      // helper's job is to produce a well-formed cluster unless a test is
      // deliberately malforming one. Tests exercising Inv 13 pass "" or a bogus
      // value explicitly.
      executionMode = "process",
      // ADR-0062: "process" now requires a rationale, and the helper's default
      // mode IS "process" — so ~30 fixtures that predate the rule would all
      // start failing on a field none of them is about. Defaulted for the same
      // reason executionMode is. Tests exercising the rule pass "" explicitly.
      executionModeRationale = "test exemption rationale",
    }) => ({
      name,
      description: `${name} test bundle`,
      tier,
      workerdServiceName,
      holdsCredential,
      hypervisorRationale: hypervisorRationale ?? (tier === "hypervisor"
        ? "test hypervisor rationale"
        : ""),
      // cloister-cedcf3 Phase 1: perTenant defaults false; tests override
      // by passing perTenant: true on a bundle in the fixture.
      perTenant,
      // cloister-a34edc: Inv 11 confinement facet — tests pass a malformed
      // confinement to exercise the §2-4 validity checks.
      ...(confinement ? { confinement } : {}),
      kind: {
        external: {
          image,
          executionMode,
          executionModeRationale,
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
      if (b.durableObjectNamespace) {
        // Either a bare class-name string (common case — same-Worker DO
        // class) or an object { className, serviceName } exercising the
        // discouraged-but-legal cross-worker designator form (Inv 12 test
        // coverage for the serviceName escape hatch).
        const don = b.durableObjectNamespace;
        if (typeof don === "string") {
          return `    ( name = "${b.name}", durableObjectNamespace = "${don}" ),`;
        }
        const svcLine = don.serviceName ? `, serviceName = "${don.serviceName}"` : "";
        return `    ( name = "${b.name}", durableObjectNamespace = ( className = "${don.className}"${svcLine} ) ),`;
      }
      throw new Error(`unknown binding kind in test fixture: ${JSON.stringify(b)}`);
    }).join("\n");
    // capnp doesn't allow trailing commas in struct literals, so omit the
    // bindings block entirely when empty.
    const bindingsBlock = bindings ? `\n  bindings = [\n${bindings}\n  ],` : "";
    const goLine = w.globalOutbound ? `\n  globalOutbound = "${w.globalOutbound}",` : "";
    // Inv 12 fixture support: durableObjectNamespaces = [ { className, uniqueKey } ].
    const namespaces = (w.durableObjectNamespaces ?? []).map(
      (ns) => `    ( className = "${ns.className}", uniqueKey = "${ns.uniqueKey ?? `${ns.className}-v1`}", enableSql = true ),`,
    ).join("\n");
    const namespacesBlock = namespaces ? `\n  durableObjectNamespaces = [\n${namespaces}\n  ],` : "";
    return `const ${ident(w.name)}Worker :Workerd.Worker = (
  compatibilityDate = "2025-01-01",
  modules = [ ( name = "worker", esModule = embed "dist/index.js" ) ],${bindingsBlock}${namespacesBlock}${goLine}
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

test("Inv 11 — a malformed confinement facet (non-canonical fs, bad wildcard, privileged port) is rejected", () => {
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [
        { name: "cloister-router", tier: "hypervisor", workerdServiceName: "cloister" },
        {
          name: "alpha",
          tier: "cluster",
          confinement: {
            fs: { allow: [{ path: "relative/not-absolute", mode: "rw" }] }, // §2: not absolute
            network: { allowHosts: ["api.*.example.com"] }, // §3: wildcard not leading "*."
            port: { bind: 80, address: "" }, // §4: privileged port
            credentialSource: "",
          },
        },
      ],
    }),
    configCapnp: configCapnp({
      workers: [{ name: "cloister", bindings: [], globalOutbound: "internet" }],
      services: [{ name: "internet", network: { allow: ["public"] } }],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.equal(r.status, 1, `expected Inv 11 violation, got status=${r.status}\n${r.stderr}`);
    assert.match(r.stderr, /Inv 11/);
    assert.match(r.stderr, /confinement/);
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
        // Inv 12: the VAULT_STORE binding above names class "CredentialVault" —
        // it must resolve to a declared durableObjectNamespaces entry.
        durableObjectNamespaces: [{ className: "CredentialVault" }],
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
  const r = spawnSync(process.execPath, ["--import", TSX_LOADER, LINT_SCRIPT], {
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

test("Inv 6 (cloister-93132f / C2) — sharesWorkerdWith cluster-tier-on-hypervisor bypass is rejected", () => {
  // Adversarial cycle 2026-06-22 caught: operator declares
  // `sharesWorkerdWith=["notme"]` (notme is on the hypervisor bundle)
  // without explicit workerdId + without trustedTier=true. Pre-fix:
  // the explicit-workerdId-on-hypervisor check only fired when
  // workerdId was explicitly declared, so this bypass passed silently
  // → cluster-tier tool code lands inside the hypervisor workerd.
  // Post-fix: the resolved-workerdId check fires regardless of which
  // rung resolved the binding (here: sharesWorkerdWith-transitive).
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [{ name: "cloister-router", tier: "hypervisor", workerdServiceName: "cloister" }],
      inputs: [
        { name: "notme", workerdId: "cloister-router", trustedTier: true },
        // The attack: evil-tool wants in to the trusted workerd, but
        // declares cluster-tier (trustedTier=false), no explicit
        // workerdId. Uses sharesWorkerdWith=["notme"] to ride along.
        { name: "evil-tool", sharesWorkerdWith: ["notme"], trustedTier: false },
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
    assert.match(r.stderr, /evil-tool/);
    // Resolution rung tag in the error message helps the operator
    // see which lookup path led to the trust grant.
    assert.match(r.stderr, /sharesWorkerdWith-transitive|gateway-fallback|same-name/);
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

// ── ADR-0034 / cloister-ce936e: Inv 7 tenantDispatch ↔ workerd alignment ──

test("Inv 7 — no tenantDispatch route → no-op (back-compat for single-tenant)", () => {
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [
        { name: "cloister-router", tier: "hypervisor", workerdServiceName: "cloister" },
      ],
      // No routes; pre-ADR-0034 single-tenant shape.
    }),
    configCapnp: configCapnp({
      workers: [{ name: "cloister", bindings: [] }],
      services: [{ name: "internet", network: { allow: ["public"] } }],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.equal(r.status, 0, `pre-ADR-0034 single-tenant should pass; stderr:\n${r.stderr}`);
    assert.match(r.stdout, /0 tenantDispatch route\(s\)/);
  } finally {
    scenario.cleanup();
  }
});

test("Inv 7 — tenantDispatch row whose binding has no [[wires]] entry is rejected", () => {
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [
        { name: "cloister-router", tier: "hypervisor", workerdServiceName: "cloister" },
      ],
      routes: [
        {
          path: "/",
          kind: {
            tenantDispatch: {
              tenants: [
                { name: "alice", mode: "sni", matchValue: "alice.example", binding: "T_ALICE_ORPHAN" },
              ],
            },
          },
        },
      ],
    }),
    configCapnp: configCapnp({
      workers: [{ name: "cloister", bindings: [] }],
      services: [{ name: "internet", network: { allow: ["public"] } }],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.equal(r.status, 1, "orphan tenant-dispatch binding should fail");
    assert.match(r.stderr, /Inv 7/);
    assert.match(r.stderr, /T_ALICE_ORPHAN/);
    assert.match(r.stderr, /does not resolve to any/);
  } finally {
    scenario.cleanup();
  }
});

test("Inv 7 — tenantDispatch row with matching input.tenancy.workerdId is accepted", () => {
  // alice's binding wires to a bundle named "alice"; an input declares
  // tenancy.workerdId="alice" (must match a bundle name per Inv 6).
  // The chain is well-formed: row.name "alice" matches the input's
  // workerdId, the wire's `to` bundle is "alice", and Inv 6's
  // bundle-existence check is satisfied.
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [
        { name: "cloister-router", tier: "hypervisor", workerdServiceName: "cloister" },
        { name: "alice",           tier: "cluster" },
      ],
      wires: [
        { from: "cloister-router", to: "alice", binding: "T_ALICE" },
      ],
      inputs: [
        { name: "alice", workerdId: "alice", trustedTier: false },
      ],
      routes: [
        {
          path: "/",
          kind: {
            tenantDispatch: {
              tenants: [
                { name: "alice", mode: "sni", matchValue: "alice.example", binding: "T_ALICE" },
              ],
            },
          },
        },
      ],
    }),
    configCapnp: configCapnp({
      workers: [
        { name: "cloister", bindings: [] },
        { name: "alice", bindings: [] },
      ],
      services: [{ name: "internet", network: { allow: ["public"] } }],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.equal(r.status, 0, `well-formed tenant-dispatch chain should pass; stderr:\n${r.stderr}`);
    assert.match(r.stdout, /1 tenantDispatch route\(s\)/);
  } finally {
    scenario.cleanup();
  }
});

test("Inv 7 — tenant name mismatched against input workerdId is rejected (with inputs declared)", () => {
  // Operator wires alice's binding to bundle "bob", but the dispatch
  // row says binding T_ALICE for tenant "alice". The bundle's hosted
  // input declares workerdId="bob" (per Inv 6 requirement). Row name
  // "alice" doesn't match any input's workerdId on the target bundle.
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [
        { name: "cloister-router", tier: "hypervisor", workerdServiceName: "cloister" },
        { name: "bob",             tier: "cluster" },
      ],
      wires: [
        { from: "cloister-router", to: "bob", binding: "T_ALICE" },
      ],
      inputs: [
        // Input on bundle "bob" declares workerdId="bob".
        { name: "bob", workerdId: "bob", trustedTier: false },
      ],
      routes: [
        {
          path: "/",
          kind: {
            tenantDispatch: {
              tenants: [
                { name: "alice", mode: "sni", matchValue: "alice.example", binding: "T_ALICE" },
              ],
            },
          },
        },
      ],
    }),
    configCapnp: configCapnp({
      workers: [
        { name: "cloister", bindings: [] },
        { name: "bob", bindings: [] },
      ],
      services: [{ name: "internet", network: { allow: ["public"] } }],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.equal(r.status, 1, "mismatched tenant↔workerdId chain should fail");
    assert.match(r.stderr, /Inv 7/);
    assert.match(r.stderr, /alice/);
    assert.match(r.stderr, /workerdId="alice"/);
  } finally {
    scenario.cleanup();
  }
});

test("Inv 7 — empty inputs[] skips alignment check (recipe demos without full inputs)", () => {
  // recipes/multi-tenant-smoke/ demonstrates the routing primitive
  // without declaring inputs — Inv 7 should be lenient here so the
  // recipe lints clean.
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [
        { name: "cloister-router", tier: "hypervisor", workerdServiceName: "cloister" },
        { name: "alice-bundle",    tier: "cluster" },
      ],
      wires: [
        { from: "cloister-router", to: "alice-bundle", binding: "T_ALICE" },
      ],
      // inputs: [] — recipe shape
      routes: [
        {
          path: "/",
          kind: {
            tenantDispatch: {
              tenants: [
                { name: "alice", mode: "sni", matchValue: "alice.example", binding: "T_ALICE" },
              ],
            },
          },
        },
      ],
    }),
    configCapnp: configCapnp({
      workers: [
        { name: "cloister", bindings: [] },
        { name: "alice-bundle", bindings: [] },
      ],
      services: [{ name: "internet", network: { allow: ["public"] } }],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.equal(r.status, 0, `recipe-shape (no inputs) should pass Inv 7; stderr:\n${r.stderr}`);
  } finally {
    scenario.cleanup();
  }
});

// ── ADR-0034 / cloister-cedcf3: Inv 8 perTenant ↔ tenantDispatch ────────

test("Inv 8 — no perTenant bundles → no-op (back-compat for pre-cedcf3 deployments)", () => {
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [
        { name: "cloister-router", tier: "hypervisor", workerdServiceName: "cloister" },
      ],
      // No perTenant bundles; pre-cedcf3 shape.
    }),
    configCapnp: configCapnp({
      workers: [{ name: "cloister", bindings: [] }],
      services: [{ name: "internet", network: { allow: ["public"] } }],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.equal(r.status, 0, `pre-cedcf3 deployment should pass; stderr:\n${r.stderr}`);
    assert.match(r.stdout, /0 perTenant bundle\(s\)/);
  } finally {
    scenario.cleanup();
  }
});

test("Inv 8 — perTenant=true bundle WITHOUT any tenantDispatch route is rejected", () => {
  // Operator declared `perTenant=true` but no [[routes]] kind="tenantDispatch"
  // exists. The perTenant flag is operationally meaningless without a
  // routing layer — lint surfaces the typo / forgotten-route case.
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [
        { name: "cloister-router", tier: "hypervisor", workerdServiceName: "cloister" },
        { name: "rosary",          tier: "cluster", perTenant: true },
      ],
      // No tenantDispatch route — the gap Inv 8 catches.
    }),
    configCapnp: configCapnp({
      workers: [
        { name: "cloister", bindings: [] },
        { name: "rosary",   bindings: [] },
      ],
      services: [{ name: "internet", network: { allow: ["public"] } }],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.equal(r.status, 1, "perTenant without tenantDispatch should fail");
    assert.match(r.stderr, /Inv 8/);
    assert.match(r.stderr, /perTenant = true/);
    assert.match(r.stderr, /rosary/);
    assert.match(r.stderr, /NO tenantDispatch route/);
  } finally {
    scenario.cleanup();
  }
});

test("Inv 8 — perTenant=true bundle WITH a tenantDispatch route is accepted", () => {
  // Well-formed: operator declared perTenant=true AND a tenantDispatch
  // route exists. Phase 2 of cedcf3 will add the stricter check that
  // at least one row binds to this bundle; today existence is enough.
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [
        { name: "cloister-router", tier: "hypervisor", workerdServiceName: "cloister" },
        { name: "rosary",          tier: "cluster", perTenant: true },
      ],
      wires: [
        { from: "cloister-router", to: "rosary", binding: "T_ROSARY" },
      ],
      routes: [
        {
          path: "/",
          kind: {
            tenantDispatch: {
              tenants: [
                { name: "alice", mode: "sni", matchValue: "alice.example", binding: "T_ROSARY" },
              ],
            },
          },
        },
      ],
    }),
    configCapnp: configCapnp({
      workers: [
        { name: "cloister", bindings: [] },
        { name: "rosary",   bindings: [] },
      ],
      services: [{ name: "internet", network: { allow: ["public"] } }],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.equal(r.status, 0, `well-formed perTenant+tenantDispatch should pass; stderr:\n${r.stderr}`);
    assert.match(r.stdout, /1 perTenant bundle\(s\)/);
  } finally {
    scenario.cleanup();
  }
});

// ── ADR-0034 / cloister-cedcf3: Inv 9 perTenant ↔ tenantDispatch binding chain ──

test("Inv 9 — perTenant bundle with NO incoming wire matching any tenantDispatch binding is rejected", () => {
  // Operator declared perTenant + tenantDispatch, but the
  // tenantDispatch row's binding wires to a DIFFERENT bundle than the
  // perTenant one. Inv 8 passes (route exists); Inv 9 catches the
  // wrong-route case.
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [
        { name: "cloister-router", tier: "hypervisor", workerdServiceName: "cloister" },
        { name: "rosary",          tier: "cluster", perTenant: true },
        { name: "other",           tier: "cluster" }, // not perTenant
      ],
      wires: [
        // Wire goes to OTHER, not rosary — broken chain.
        { from: "cloister-router", to: "other", binding: "T_ALICE" },
      ],
      routes: [
        {
          path: "/",
          kind: {
            tenantDispatch: {
              tenants: [
                { name: "alice", mode: "sni", matchValue: "alice.example", binding: "T_ALICE" },
              ],
            },
          },
        },
      ],
    }),
    configCapnp: configCapnp({
      workers: [
        { name: "cloister", bindings: [] },
        { name: "rosary",   bindings: [] },
        { name: "other",    bindings: [] },
      ],
      services: [{ name: "internet", network: { allow: ["public"] } }],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.equal(r.status, 1, "perTenant bundle with no matching dispatch wire should fail");
    assert.match(r.stderr, /Inv 9/);
    assert.match(r.stderr, /rosary/);
    assert.match(r.stderr, /no \[\[wires\]\] entry whose binding is referenced/);
  } finally {
    scenario.cleanup();
  }
});

test("Inv 9 — perTenant bundle WITH a wire whose binding is referenced by tenantDispatch is accepted", () => {
  // Well-formed chain:
  //   tenantDispatch row.binding "T_ROSARY"
  //     ↔ [[wires]].binding "T_ROSARY" (to=rosary)
  //       ↔ perTenant bundle "rosary"
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [
        { name: "cloister-router", tier: "hypervisor", workerdServiceName: "cloister" },
        { name: "rosary",          tier: "cluster", perTenant: true },
      ],
      wires: [
        { from: "cloister-router", to: "rosary", binding: "T_ROSARY" },
      ],
      routes: [
        {
          path: "/",
          kind: {
            tenantDispatch: {
              tenants: [
                { name: "alice", mode: "sni", matchValue: "alice.example", binding: "T_ROSARY" },
              ],
            },
          },
        },
      ],
    }),
    configCapnp: configCapnp({
      workers: [
        { name: "cloister", bindings: [] },
        { name: "rosary",   bindings: [] },
      ],
      services: [{ name: "internet", network: { allow: ["public"] } }],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.equal(r.status, 0, `well-formed chain should pass Inv 9; stderr:\n${r.stderr}`);
  } finally {
    scenario.cleanup();
  }
});

test("Inv 9 — multiple tenantDispatch rows all sharing the same binding to a perTenant bundle is accepted", () => {
  // Operator deploys per-tenant rsry; alice + bob + carol all dispatch
  // to the same binding T_ROSARY (which gets emitted as per-tenant
  // instances by emit-compose Phase 2). Inv 9 checks at-least-one-match
  // semantics, so this aggregated shape is fine.
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [
        { name: "cloister-router", tier: "hypervisor", workerdServiceName: "cloister" },
        { name: "rosary",          tier: "cluster", perTenant: true },
      ],
      wires: [
        { from: "cloister-router", to: "rosary", binding: "T_ROSARY" },
      ],
      routes: [
        {
          path: "/",
          kind: {
            tenantDispatch: {
              tenants: [
                { name: "alice", mode: "sni", matchValue: "alice.example", binding: "T_ROSARY" },
                { name: "bob",   mode: "sni", matchValue: "bob.example",   binding: "T_ROSARY" },
                { name: "carol", mode: "sni", matchValue: "carol.example", binding: "T_ROSARY" },
              ],
            },
          },
        },
      ],
    }),
    configCapnp: configCapnp({
      workers: [
        { name: "cloister", bindings: [] },
        { name: "rosary",   bindings: [] },
      ],
      services: [{ name: "internet", network: { allow: ["public"] } }],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.equal(r.status, 0, `multi-tenant dispatching to same perTenant bundle should pass; stderr:\n${r.stderr}`);
  } finally {
    scenario.cleanup();
  }
});

test("Inv 9 — perTenant bundle with NO incoming wires at all is rejected with clear message", () => {
  // Edge case: operator declared perTenant=true but forgot the wire
  // entirely. Without wires, the bundle is unreachable from cloister-
  // router. Inv 4 may also flag, but Inv 9 makes the perTenant-specific
  // failure path explicit.
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [
        { name: "cloister-router", tier: "hypervisor", workerdServiceName: "cloister" },
        { name: "rosary",          tier: "cluster", perTenant: true },
      ],
      // No wires at all.
      routes: [
        {
          path: "/",
          kind: {
            tenantDispatch: {
              tenants: [
                { name: "alice", mode: "sni", matchValue: "alice.example", binding: "T_ROSARY" },
              ],
            },
          },
        },
      ],
    }),
    configCapnp: configCapnp({
      workers: [
        { name: "cloister", bindings: [] },
        { name: "rosary",   bindings: [] },
      ],
      services: [{ name: "internet", network: { allow: ["public"] } }],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.equal(r.status, 1, "perTenant bundle with no wires should fail Inv 9");
    assert.match(r.stderr, /Inv 9/);
    assert.match(r.stderr, /\(none\)/); // empty incoming wires list rendered
  } finally {
    scenario.cleanup();
  }
});

test("Inv 8 — MULTIPLE perTenant bundles all flagged when no tenantDispatch route", () => {
  // If 3 bundles declare perTenant=true and no tenantDispatch route
  // exists, lint emits 3 violations (one per bundle) — operator sees
  // the full set, not just the first.
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [
        { name: "cloister-router", tier: "hypervisor", workerdServiceName: "cloister" },
        { name: "rosary",          tier: "cluster", perTenant: true },
        { name: "mache",           tier: "cluster", perTenant: true },
        { name: "llo",             tier: "cluster", perTenant: true },
      ],
    }),
    configCapnp: configCapnp({
      workers: [
        { name: "cloister", bindings: [] },
        { name: "rosary",   bindings: [] },
        { name: "mache",    bindings: [] },
        { name: "llo",      bindings: [] },
      ],
      services: [{ name: "internet", network: { allow: ["public"] } }],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.equal(r.status, 1, "3 perTenant bundles with no dispatch route should fail");
    assert.match(r.stderr, /rosary/);
    assert.match(r.stderr, /mache/);
    assert.match(r.stderr, /llo/);
  } finally {
    scenario.cleanup();
  }
});

// ── Inv 13 (ADR-0048): executionMode declared, and implementable ──────────

const INV13_CONFIG = {
  workers: [{ name: "cloister", bindings: [], globalOutbound: "internet" }],
  services: [{ name: "internet", network: { allow: ["public"] } }],
};

test("Inv 13 — an external bundle with NO executionMode is a violation (fail, not warn)", () => {
  // cloister-54b834. Four of five shipped bundles left this ambient, and it was
  // not merely undocumented: emit-host-launch-plan REQUIRES microvm|process and
  // throws otherwise, so `task runtime:plan` could not emit for any of them and
  // nothing said so until someone tried. Fail-level because there is no
  // legitimate in-between — "unstated" is the answer being kept out of the
  // manifest, not a third mode.
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [
        { name: "cloister-router", tier: "hypervisor", workerdServiceName: "cloister" },
        { name: "svc", tier: "cluster", image: "svc:1", executionMode: "" },
      ],
    }),
    configCapnp: configCapnp(INV13_CONFIG),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.notEqual(r.status, 0, "a missing executionMode must FAIL");
    assert.match(r.stderr, /Inv 13/);
    assert.match(r.stderr, /declares no executionMode/);
  } finally {
    scenario.cleanup();
  }
});

test("Inv 13 — an executionMode the host runtime does not implement is a violation", () => {
  // The runtime "selects exactly and never substitutes a weaker backend", so an
  // unimplemented mode must not silently degrade to process.
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [
        { name: "cloister-router", tier: "hypervisor", workerdServiceName: "cloister" },
        { name: "svc", tier: "cluster", image: "svc:1", executionMode: "gvisor" },
      ],
    }),
    configCapnp: configCapnp(INV13_CONFIG),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.notEqual(r.status, 0, "an unknown executionMode must FAIL");
    assert.match(r.stderr, /executionMode "gvisor"/);
  } finally {
    scenario.cleanup();
  }
});

test("Inv 13 — both implemented modes are accepted", () => {
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [
        { name: "cloister-router", tier: "hypervisor", workerdServiceName: "cloister", executionMode: "process" },
        { name: "vm", tier: "cluster", image: "vm:1", executionMode: "microvm" },
        { name: "proc", tier: "cluster", image: "proc:1", executionMode: "process" },
      ],
    }),
    configCapnp: configCapnp(INV13_CONFIG),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.doesNotMatch(r.stderr, /Inv 13/, `both modes must pass:\n${r.stderr}`);
  } finally {
    scenario.cleanup();
  }
});

test("Inv 13 — the SHIPPED tree declares an executionMode on every external bundle", async () => {
  // The rail must hold against the real manifest, not only fixtures — otherwise
  // it could be enforcing a shape nothing conforms to.
  const { cluster } = await import(pathToFileURL(resolve(REPO_ROOT, "src/generated/cluster.ts")).href);
  const external = (cluster.bundles ?? []).filter((b) => "external" in b.kind);
  assert.ok(external.length >= 4, `sanity: expected several external bundles, got ${external.length}`);
  const undeclared = external
    .filter((b) => !["microvm", "process"].includes(b.kind.external.executionMode))
    .map((b) => b.name);
  assert.deepEqual(undeclared, [], `these ship without a usable executionMode: ${undeclared}`);
});

// ── Inv 10 (ADR-0038): bundle image derivable from packages[].oci ─────────

const INV10_CONFIG = {
  workers: [{ name: "cloister", bindings: [], globalOutbound: "internet" }],
  services: [{ name: "internet", network: { allow: ["public"] } }],
};

test("Inv 10 — image-less external bundle with no derivable oci → warn (non-fatal)", () => {
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [
        { name: "cloister-router", tier: "hypervisor", workerdServiceName: "cloister" },
        { name: "mache", tier: "cluster", image: "" },
      ],
    }),
    configCapnp: configCapnp(INV10_CONFIG),
  });
  try {
    // Nonexistent lockfile → empty oci map → not derivable.
    const r = runLint(scenario.workDir, scenario.clusterTsPath, resolve(scenario.workDir, "no-such.lock.toml"));
    assert.equal(r.status, 0, `Inv 10 is warn-level (non-fatal); got ${r.status}\n${r.stderr}`);
    assert.match(r.stderr, /Inv 10/);
    assert.match(r.stderr, /has no image/);
    assert.match(r.stderr, /"mache"/);
  } finally {
    scenario.cleanup();
  }
});

test("Inv 10 — image-less external bundle with a linked input's oci is clean (derivable)", () => {
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [
        { name: "cloister-router", tier: "hypervisor", workerdServiceName: "cloister" },
        { name: "mache", tier: "cluster", image: "" },
      ],
      inputs: [{ name: "mache" }], // empty workerdId → same-name rung → colocates to "mache"
    }),
    configCapnp: configCapnp(INV10_CONFIG),
  });
  try {
    const lockfile = resolve(scenario.workDir, "cluster.lock.toml");
    writeFileSync(lockfile,
      'schema = "cloister/lockfile/v1"\ncluster = "test"\nversion = "0.0.1"\n' +
      '[inputs.mache]\nref = "github://test/mache@main"\nresolved = "0.13.0"\n' +
      'sha256 = "sha256:aa"\nfetched_from = "file:///x"\nsigner = ""\nbytes = 10\n' +
      '[inputs.mache.oci]\nidentifier = "ghcr.io/agentic-research/mache"\nversion = "0.13.0"\n',
    );
    const r = runLint(scenario.workDir, scenario.clusterTsPath, lockfile);
    assert.equal(r.status, 0, `expected clean; got ${r.status}\n${r.stderr}`);
    assert.doesNotMatch(r.stderr, /Inv 10/, "an oci-derivable bundle must not warn");
  } finally {
    scenario.cleanup();
  }
});

test("Inv 10 — a hand-set image that DISAGREES with the input's resolved oci warns", () => {
  // cloister-cb735c. Setting `image` used to `continue` past the invariant, so
  // hand-setting the field was what turned the check off — and the one bundle
  // that restated an image was the only one nothing verified. Measured on the
  // real tree: rosary carried "rosary:0.7.0" while the lockfile had resolved
  // ghcr.io/agentic-research/rosary:0.8.1 to a digest and upstream was 0.10.0.
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [
        { name: "cloister-router", tier: "hypervisor", workerdServiceName: "cloister" },
        { name: "rosary", tier: "cluster", image: "rosary:0.7.0" },
      ],
      inputs: [{ name: "rosary" }],
    }),
    configCapnp: configCapnp(INV10_CONFIG),
  });
  try {
    const lockfile = resolve(scenario.workDir, "cluster.lock.toml");
    writeFileSync(lockfile,
      'schema = "cloister/lockfile/v1"\ncluster = "test"\nversion = "0.0.1"\n' +
      '[inputs.rosary]\nref = "github://test/rosary@main"\nresolved = "0.8.1"\n' +
      'sha256 = "sha256:aa"\nfetched_from = "file:///x"\nsigner = ""\nbytes = 10\n' +
      '[inputs.rosary.oci]\nidentifier = "ghcr.io/agentic-research/rosary"\nversion = "0.8.1"\n',
    );
    const r = runLint(scenario.workDir, scenario.clusterTsPath, lockfile);
    assert.equal(r.status, 0, `Inv 10 stays warn-level; got ${r.status}\n${r.stderr}`);
    assert.match(r.stderr, /Inv 10/);
    assert.match(r.stderr, /hand-sets image "rosary:0\.7\.0"/);
    assert.match(r.stderr, /ghcr\.io\/agentic-research\/rosary:0\.8\.1/);
  } finally {
    scenario.cleanup();
  }
});

test("Inv 10 — a hand-set image that AGREES with the resolved oci is clean", () => {
  // The check must be about disagreement, not about the field being present.
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [
        { name: "cloister-router", tier: "hypervisor", workerdServiceName: "cloister" },
        { name: "rosary", tier: "cluster", image: "ghcr.io/agentic-research/rosary:0.8.1" },
      ],
      inputs: [{ name: "rosary" }],
    }),
    configCapnp: configCapnp(INV10_CONFIG),
  });
  try {
    const lockfile = resolve(scenario.workDir, "cluster.lock.toml");
    writeFileSync(lockfile,
      'schema = "cloister/lockfile/v1"\ncluster = "test"\nversion = "0.0.1"\n' +
      '[inputs.rosary]\nref = "github://test/rosary@main"\nresolved = "0.8.1"\n' +
      'sha256 = "sha256:aa"\nfetched_from = "file:///x"\nsigner = ""\nbytes = 10\n' +
      '[inputs.rosary.oci]\nidentifier = "ghcr.io/agentic-research/rosary"\nversion = "0.8.1"\n',
    );
    const r = runLint(scenario.workDir, scenario.clusterTsPath, lockfile);
    assert.equal(r.status, 0, `expected clean; got ${r.status}\n${r.stderr}`);
    assert.doesNotMatch(r.stderr, /Inv 10/, "an agreeing image must not warn");
  } finally {
    scenario.cleanup();
  }
});

test("Inv 10 — a ROUTER's own image is not compared against the inputs it routes", () => {
  // The false positive the first draft produced. Colocation means "this bundle
  // ROUTES this input", not "this bundle IS this input's container". A router
  // legitimately hand-sets its own locally-built image while hosting inputs
  // whose oci resolves to something else entirely; demanding they match would
  // force cloister's router to claim ley-line-open's image.
  //
  // The discriminator is the convention mache and rosary both follow: a bundle
  // that IS an input's container carries that input's NAME.
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [
        { name: "cloister-router", tier: "hypervisor", workerdServiceName: "cloister" },
        { name: "some-router", tier: "cluster", image: "cloister:0.1.0" },
      ],
      inputs: [{ name: "llo", workerdId: "some-router" }],
    }),
    configCapnp: configCapnp(INV10_CONFIG),
  });
  try {
    const lockfile = resolve(scenario.workDir, "cluster.lock.toml");
    writeFileSync(lockfile,
      'schema = "cloister/lockfile/v1"\ncluster = "test"\nversion = "0.0.1"\n' +
      '[inputs.llo]\nref = "github://test/llo@main"\nresolved = "v0.13.0"\n' +
      'sha256 = "sha256:aa"\nfetched_from = "file:///x"\nsigner = ""\nbytes = 10\n' +
      '[inputs.llo.oci]\nidentifier = "ghcr.io/agentic-research/ley-line-open"\nversion = "v0.13.0"\n',
    );
    const r = runLint(scenario.workDir, scenario.clusterTsPath, lockfile);
    assert.equal(r.status, 0, `expected clean; got ${r.status}\n${r.stderr}`);
    assert.doesNotMatch(r.stderr, /hand-sets image/, "a router must not be asked to claim a routed input's image");
  } finally {
    scenario.cleanup();
  }
});

test("Inv 10 — image-less gateway bundle can derive oci from fallback-colocated input", () => {
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [
        { name: "cloister-router", tier: "hypervisor", workerdServiceName: "cloister", image: "" },
      ],
      // Empty workerdId + no same-name bundle exercises resolveTenancy rung 3:
      // emit-compose colocates the input on the first hypervisor/gateway.
      inputs: [{ name: "mache" }],
    }),
    configCapnp: configCapnp(INV10_CONFIG),
  });
  try {
    const lockfile = resolve(scenario.workDir, "cluster.lock.toml");
    writeFileSync(lockfile,
      'schema = "cloister/lockfile/v1"\ncluster = "test"\nversion = "0.0.1"\n' +
      '[inputs.mache]\nref = "github://test/mache@main"\nresolved = "0.13.0"\n' +
      'sha256 = "sha256:aa"\nfetched_from = "file:///x"\nsigner = ""\nbytes = 10\n' +
      '[inputs.mache.oci]\nidentifier = "ghcr.io/agentic-research/mache"\nversion = "0.13.0"\n',
    );
    const r = runLint(scenario.workDir, scenario.clusterTsPath, lockfile);
    assert.equal(r.status, 0, `expected clean; got ${r.status}\n${r.stderr}`);
    assert.doesNotMatch(r.stderr, /Inv 10/, "gateway fallback-colocated oci must not warn");
  } finally {
    scenario.cleanup();
  }
});

test("Inv 10 — external bundle with an operator image never warns (image wins, no oci needed)", () => {
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [
        { name: "cloister-router", tier: "hypervisor", workerdServiceName: "cloister" },
        { name: "mache", tier: "cluster", image: "mache:0.13.0" },
      ],
    }),
    configCapnp: configCapnp(INV10_CONFIG),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath, resolve(scenario.workDir, "no-such.lock.toml"));
    assert.equal(r.status, 0, `expected clean; got ${r.status}\n${r.stderr}`);
    assert.doesNotMatch(r.stderr, /Inv 10/);
  } finally {
    scenario.cleanup();
  }
});

// ── Inv 12 (cloister-f9d473): bundle DO binding → durableObjectNamespaces ──
//
// The bead's grounding scenario: a bundle Worker declares a
// durableObjectNamespace binding naming a class, but config.capnp's
// durableObjectNamespaces list never declares that class — the binding
// resolves at capnp-eval time (capnp doesn't cross-check this) but would
// fail (or misbehave) at request time. Nothing previously checked the
// chain `bundle DO binding → durableObjectNamespaces entry`.

test("Inv 12 — DO binding naming an undeclared class is rejected", () => {
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
        bindings: [
          { name: "CH_BOARD", durableObjectNamespace: "CanonicalHoursBoardObject" },
        ],
        // durableObjectNamespaces deliberately omitted — the class the
        // binding names above is never declared.
      }],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.equal(r.status, 1, `expected Inv 12 violation, got status=${r.status}\nstdout:${r.stdout}`);
    assert.match(r.stderr, /Inv 12/);
    assert.match(r.stderr, /CH_BOARD/);
    assert.match(r.stderr, /CanonicalHoursBoardObject/);
    assert.match(r.stderr, /no matching durableObjectNamespaces entry/);
  } finally {
    scenario.cleanup();
  }
});

test("Inv 12 — DO binding whose class IS declared in durableObjectNamespaces passes", () => {
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
        bindings: [
          { name: "BEAD_STORE", durableObjectNamespace: "BeadStore" },
        ],
        durableObjectNamespaces: [{ className: "BeadStore", uniqueKey: "test-beads-v1" }],
      }],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.equal(r.status, 0, `expected clean lint, got status=${r.status}\nstderr:${r.stderr}`);
  } finally {
    scenario.cleanup();
  }
});

test("Inv 12 — multiple DO bindings, only one undeclared, is flagged precisely", () => {
  // Two bindings on the same worker; only the second names an undeclared
  // class. The violation message must name the RIGHT binding + class,
  // not just fire generically.
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
        bindings: [
          { name: "BEAD_STORE", durableObjectNamespace: "BeadStore" },
          { name: "CH_DPOP_LEDGER", durableObjectNamespace: "DpopReplayLedgerObject" },
        ],
        durableObjectNamespaces: [{ className: "BeadStore", uniqueKey: "test-beads-v1" }],
      }],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.equal(r.status, 1, `expected Inv 12 violation, got status=${r.status}`);
    assert.match(r.stderr, /Inv 12/);
    assert.match(r.stderr, /CH_DPOP_LEDGER/);
    assert.match(r.stderr, /DpopReplayLedgerObject/);
    // The well-formed BEAD_STORE binding must NOT also be flagged.
    assert.doesNotMatch(r.stderr, /"BEAD_STORE"[^\n]*no matching durableObjectNamespaces/);
  } finally {
    scenario.cleanup();
  }
});

test("Inv 12 — cross-worker serviceName designator resolves against the NAMED worker's namespaces", () => {
  // workerd's discouraged-but-legal escape hatch: a durableObjectNamespace
  // designator can name a different Worker's service via `serviceName`.
  // Inv 12 must check the class against THAT worker's durableObjectNamespaces,
  // not the binding-declaring worker's.
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [
        { name: "cloister-router", tier: "hypervisor", workerdServiceName: "cloister" },
        { name: "other-worker", tier: "hypervisor", workerdServiceName: "other-worker" },
      ],
    }),
    configCapnp: configCapnp({
      workers: [
        {
          name: "cloister",
          bindings: [
            {
              name: "REMOTE_DO",
              durableObjectNamespace: { className: "RemoteThing", serviceName: "other-worker" },
            },
          ],
        },
        {
          name: "other-worker",
          bindings: [],
          durableObjectNamespaces: [{ className: "RemoteThing", uniqueKey: "remote-v1" }],
        },
      ],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.equal(r.status, 0, `expected clean lint (declared on the named worker), got status=${r.status}\nstderr:${r.stderr}`);
  } finally {
    scenario.cleanup();
  }
});

test("Inv 12 — cross-worker serviceName naming a nonexistent worker is rejected", () => {
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [{ name: "cloister-router", tier: "hypervisor", workerdServiceName: "cloister" }],
    }),
    configCapnp: configCapnp({
      workers: [{
        name: "cloister",
        bindings: [
          {
            name: "REMOTE_DO",
            durableObjectNamespace: { className: "RemoteThing", serviceName: "ghost-worker" },
          },
        ],
      }],
    }),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.equal(r.status, 1, `expected Inv 12 violation, got status=${r.status}`);
    assert.match(r.stderr, /Inv 12/);
    assert.match(r.stderr, /ghost-worker/);
  } finally {
    scenario.cleanup();
  }
});

// ── Inv 14: the producer's per-bundle facts vs what cluster.toml restates ──
//
// cloister-d8e8fb. cluster.toml hand-restates tier, kind and the wire fact
// (httpPort / ipcSocket) for notme's two bundles. Nothing checked them, which is
// the same shape cloister-cb735c measured for images — two statements of one
// fact, only one of which tracks the upstream. Inv 10 rails the image half.

test("Inv 14 holds on the SHIPPED tree — not just on fixtures", async () => {
  // Non-vacuity of the useful kind: the invariant is asserted against the real
  // cluster.toml and the real lockfile, so it cannot pass by describing a
  // fixture that agrees by construction.
  const r = spawnSync(process.execPath, ["--import", TSX_LOADER, LINT_SCRIPT], {
    cwd: REPO_ROOT, encoding: "utf8",
  });
  assert.equal(r.status, 0, `the shipped tree must satisfy Inv 14:\n${r.stdout}${r.stderr}`);
  assert.doesNotMatch(`${r.stdout}${r.stderr}`, /Inv 14/, "no Inv 14 warning on the shipped tree");
});

test("Inv 14 FIRES when the operator's value disagrees with the producer's", async () => {
  // The falsifier. Without this the test above is satisfied by an invariant
  // that never looks at anything.
  const { readFileSync, writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(tmpResolve(tmpdir(), "inv14-"));
  try {
    const lockPath = tmpResolve(dir, "cluster.lock.toml");
    // Round-tripping through a TOML parser and writer just to produce a
    // deliberately-WRONG file would add a serializer dependency to say the
    // same thing.
    //
    // lint-allow-rawparse: this CORRUPTS a fixture rather than reading a fact.
    // The lint guards against an under-matching pattern silently reporting
    // CLEAN; here under-matching makes the flip a no-op, which the
    // assert.notEqual below catches loudly.
    const lock = readFileSync(resolve(REPO_ROOT, "cluster.lock.toml"), "utf8");
    // Flip the PRODUCER's side, leaving cluster.toml untouched — so the
    // disagreement is unambiguous and the operator surface is not mutated.
    const flipped = lock.replace(/declaredHttpPort = [0-9_]+/, "declaredHttpPort = 9999");
    assert.notEqual(flipped, lock, "the fixture must actually contain a declared port to flip");
    writeFileSync(lockPath, flipped);

    const r = spawnSync(process.execPath, ["--import", TSX_LOADER, LINT_SCRIPT], {
      cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, CLOISTER_LOCKFILE: lockPath },
    });
    const out = `${r.stdout}${r.stderr}`;
    assert.match(out, /Inv 14/, "a disagreeing fact must be reported");
    assert.match(out, /httpPort/, "…naming the field that disagrees");
    assert.match(out, /9999/, "…and both values, so the operator can decide which is right");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Inv 14 treats an ABSENT fact as not-stated, never as disagreement", async () => {
  // A producer may legitimately declare fewer facts than the operator
  // configures. Reporting that as drift would make the rail fire on every input
  // that declares only an image — noise that gets the rail turned off.
  const { readFileSync, writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(tmpResolve(tmpdir(), "inv14-absent-"));
  try {
    const lockPath = tmpResolve(dir, "cluster.lock.toml");
    // lint-allow-rawparse: same as above — this STRIPS lines to build a
    // deliberately-incomplete fixture, rather than reading a fact to decide
    // something. Under-matching here weakens the fixture, and the assertion it
    // feeds would then fail rather than silently pass.
    const lock = readFileSync(resolve(REPO_ROOT, "cluster.lock.toml"), "utf8");
    const stripped = lock.replace(/^\s*declared[A-Za-z]+ = .*$/gm, "");
    assert.notEqual(stripped, lock, "the fixture must actually have declared facts to strip");
    writeFileSync(lockPath, stripped);

    const r = spawnSync(process.execPath, ["--import", TSX_LOADER, LINT_SCRIPT], {
      cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, CLOISTER_LOCKFILE: lockPath },
    });
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /Inv 14/, "absent ≠ disagrees");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── ADR-0062: `process` is an exemption, not a posture ─────────────────────
//
// Inv 13 already forced every external bundle to DECLARE a mode, and that
// worked — before it, four of five left the facet ambient. What they declared
// is what these cover: the rail accepted "process" exactly as readily as
// "microvm", so a rail meant to surface the answer instead ratified the wrong
// one. Two bundles holding the cluster's highest-value secrets (the Signet
// master CA; the bridge cert) ran unisolated with NO reason recorded — and
// nobody had decided that. Being made to write the field is what revealed it.

test("ADR-0062 — `process` with no rationale is a violation", () => {
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [
        { name: "cloister-router", tier: "hypervisor", workerdServiceName: "cloister" },
        { name: "svc", tier: "cluster", image: "svc:1", executionMode: "process", executionModeRationale: "" },
      ],
    }),
    configCapnp: configCapnp(INV13_CONFIG),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.notEqual(r.status, 0, "an unjustified exemption must FAIL");
    assert.match(r.stderr, /with no executionModeRationale/);
    // The message has to carry the WHY, or the next reader re-derives it.
    assert.match(r.stderr, /NO ISOLATION/);
  } finally {
    scenario.cleanup();
  }
});

test("ADR-0062 — whitespace is not a rationale", () => {
  // The cheapest way to defeat a presence check is a space. Presence is all a
  // rail can check — it cannot judge an argument — so it must at least not be
  // satisfiable by nothing.
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [
        { name: "cloister-router", tier: "hypervisor", workerdServiceName: "cloister" },
        { name: "svc", tier: "cluster", image: "svc:1", executionMode: "process", executionModeRationale: "   " },
      ],
    }),
    configCapnp: configCapnp(INV13_CONFIG),
  });
  try {
    assert.notEqual(runLint(scenario.workDir, scenario.clusterTsPath).status, 0);
  } finally {
    scenario.cleanup();
  }
});

test("ADR-0062 — `microvm` needs no rationale, because it IS the posture", () => {
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [
        { name: "cloister-router", tier: "hypervisor", workerdServiceName: "cloister" },
        { name: "svc", tier: "cluster", image: "svc:1", executionMode: "microvm", executionModeRationale: "" },
      ],
    }),
    configCapnp: configCapnp(INV13_CONFIG),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.doesNotMatch(r.stderr, /executionModeRationale/,
      "requiring a reason to be SAFE would invert the rule");
  } finally {
    scenario.cleanup();
  }
});

test("ADR-0062 — the exemption COUNT is reported, not just individual failures", () => {
  // A cluster where most bundles opt out of isolation should say so out loud.
  // Silence read as health for as long as it took someone to read the manifest
  // by hand — which is how four-of-five went unnoticed.
  const scenario = makeScenario({
    clusterTs: clusterTs({
      bundles: [
        { name: "cloister-router", tier: "hypervisor", workerdServiceName: "cloister" },
        { name: "svc", tier: "cluster", image: "svc:1", executionMode: "process", executionModeRationale: "stated" },
      ],
    }),
    configCapnp: configCapnp(INV13_CONFIG),
  });
  try {
    const r = runLint(scenario.workDir, scenario.clusterTsPath);
    assert.match(r.stderr, /isolation exemptions:/,
      "a justified exemption is still an exemption and must stay visible");
  } finally {
    scenario.cleanup();
  }
});
