#!/usr/bin/env node
/**
 * Emit a docker-compose.yaml (containerd/podman/nerdctl-compatible)
 * from `src/generated/cluster.ts`. First deployment-shape emitter for
 * cloister-be0607a; tenancy-aware per ADR-0030 §A1 + §A5 (cloister-0ecb6c).
 *
 * Pipeline:
 *   src/generated/cluster.ts → this script → cluster.compose.yaml
 *
 * Tenancy resolution (ADR-0030 §A5):
 *   - Each `cluster.inputs[]` carries a `tenancy` declaration.
 *   - `tenancy.workerdId` MUST resolve to a `cluster.bundles[].name`
 *     (else the emitter fails — operator must declare the bundle that
 *     hosts this input).
 *   - Empty `workerdId` defaults to the bundle whose name matches the
 *     input's `name` (single-tenant convention).
 *   - The emitter annotates each compose service with the co-located
 *     input names via `cloister.colocated-inputs` labels.
 *   - Multi-instantiation (one workerd per declared tenant under
 *     `mode = "per-tenant"`) is deferred to vault-1 (cloister-0ffb3f)
 *     which lands the first concrete per-tenant Worker.
 *
 * Targets the OCI compose spec — no docker-specific directives. Works
 * with:
 *   nerdctl compose up    (containerd directly)
 *   podman compose up     (daemonless)
 *   docker compose up     (Docker Desktop / colima / docker)
 *
 * Usage:
 *   node scripts/emit-compose.mjs
 *   → writes cluster.compose.yaml in the repo root.
 */

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = resolve(__dirname, "..");

// ── Tenancy resolution ───────────────────────────────────────────────────

/**
 * Resolve every input's tenancy.workerdId to a bundle name. Three
 * fallback rungs:
 *
 *   1. Explicit `tenancy.workerdId` set → that bundle hosts it.
 *      Violation if the named bundle doesn't exist.
 *   2. Empty `tenancy.workerdId` + a bundle exists with the SAME NAME
 *      as the input → that bundle hosts it (the "external" convention:
 *      `[inputs.mache]` matches the `[[bundles]] name="mache"` entry).
 *   3. Empty `tenancy.workerdId` + no same-name bundle → fall back to
 *      the gateway / hypervisor-tier bundle. This is the back-compat
 *      "all in one" path per ADR-0030 §"NOT a forced-multi-workerd
 *      substrate" — pre-ADR-0030 cluster.toml has inputs that compose
 *      into the router workerd implicitly, and that remains valid.
 *
 * If rung 3 finds NO hypervisor-tier bundle either, the operator's
 * cluster is genuinely incomplete — surface as a violation.
 *
 * Returns a `{workerdId → [inputName, ...]}` map for co-location labels,
 * plus a list of violations (operator errors).
 *
 * Exported for tests.
 */
export function resolveTenancy(cluster) {
  const bundles = cluster.bundles ?? [];
  const bundleNames = new Set(bundles.map((b) => b.name));
  // Identify the gateway bundle for rung-3 back-compat fallback. The
  // hypervisor-tier bundle is the conventional gateway/router host;
  // there's typically only one per deployment. If multiple exist, pick
  // the first declared (operators can override via explicit workerdId).
  const gateway = bundles.find((b) => b.tier === "hypervisor");
  const gatewayName = gateway?.name ?? null;

  const violations = [];
  const colocation = new Map(); // workerdId → [inputName, ...]

  for (const input of cluster.inputs ?? []) {
    const declaredWorkerdId = input.tenancy?.workerdId ?? "";
    let workerdId;
    if (declaredWorkerdId !== "") {
      // Rung 1: explicit declaration.
      workerdId = declaredWorkerdId;
      if (!bundleNames.has(workerdId)) {
        violations.push({
          input: input.name,
          declaredWorkerdId,
          resolvedWorkerdId: workerdId,
          problem: `tenancy.workerdId "${workerdId}" does not match any bundle name — operator must declare the bundle that hosts this input`,
        });
        continue;
      }
    } else if (bundleNames.has(input.name)) {
      // Rung 2: same-name bundle exists.
      workerdId = input.name;
    } else if (gatewayName !== null) {
      // Rung 3: back-compat fallback to the gateway bundle.
      workerdId = gatewayName;
    } else {
      // No fallback path — operator's cluster is genuinely incomplete.
      violations.push({
        input: input.name,
        declaredWorkerdId,
        resolvedWorkerdId: "",
        problem: `no bundle hosts this input — declare a [[bundles]] entry with tier="hypervisor" (the gateway) or set tenancy.workerdId on the input`,
      });
      continue;
    }
    if (!colocation.has(workerdId)) colocation.set(workerdId, []);
    colocation.get(workerdId).push(input.name);
  }

  return { colocation, violations };
}

// ── Compose YAML emitter ─────────────────────────────────────────────────

/**
 * Emit the cluster.compose.yaml body as a string. Pure function — no
 * I/O, no process.exit. Throws if tenancy resolution finds violations.
 *
 * Exported for tests.
 */
export function emitCompose(cluster) {
  const { colocation, violations } = resolveTenancy(cluster);
  if (violations.length > 0) {
    const msg = violations
      .map((v) => `  - input "${v.input}": ${v.problem}`)
      .join("\n");
    throw new Error(
      `emit-compose: ${violations.length} tenancy violation(s):\n${msg}`,
    );
  }

  const lines = [];
  lines.push(`# AUTO-GENERATED by scripts/emit-compose.mjs. Do NOT edit by hand.`);
  lines.push(`# Regenerate via \`task cluster:emit\` after editing cluster.toml.`);
  lines.push(`#`);
  lines.push(`# Cluster: ${cluster.metadata.name} v${cluster.metadata.version}`);
  lines.push(`# ${cluster.bundles.length} bundle(s), ${cluster.wires.length} wire(s)`);
  if ((cluster.inputs ?? []).length > 0) {
    lines.push(`# ${cluster.inputs.length} input(s); tenancy resolved per ADR-0030 §A5`);
  }
  lines.push(``);
  lines.push(`name: ${cluster.metadata.name}`);
  lines.push(``);
  lines.push(`services:`);

  for (const b of cluster.bundles) {
    if (!("external" in b.kind)) {
      // workerd-bundle kind is in-process; nothing to emit at the
      // compose level — it runs inside the cloister-router service.
      continue;
    }
    const ext = b.kind.external;
    const colocatedInputs = colocation.get(b.name) ?? [];
    lines.push(`  ${b.name}:`);
    lines.push(`    image: ${ext.image}`);
    lines.push(`    pull_policy: never`);
    lines.push(`    container_name: cloister-${b.name}`);
    lines.push(`    labels:`);
    lines.push(`      - "cloister.bundle=${b.name}"`);
    lines.push(`      - "cloister.tier=${b.tier}"`);
    lines.push(`      - "cloister.description=${ext.image} — ${b.description}"`);
    // ADR-0030 §A5: emit co-located input labels for observability.
    // The label is a comma-joined list; empty means no inputs declare
    // this workerd as their host.
    if (colocatedInputs.length > 0) {
      lines.push(`      - "cloister.colocated-inputs=${colocatedInputs.join(",")}"`);
    }

    // Entrypoint args
    if (ext.args.length > 0) {
      lines.push(`    command:`);
      for (const a of ext.args) lines.push(`      - ${JSON.stringify(a)}`);
    }

    if (b.name === "mache") {
      lines.push(`    network_mode: "service:cloister-router"`);
    }

    // Port forwards (only for bundles with TCP listeners)
    if (ext.httpPort > 0 && b.name !== "mache") {
      lines.push(`    ports:`);
      lines.push(`      - "${ext.httpPort}:${ext.httpPort}"`);
    }

    // Volumes: every bundle gets the UDS dir + the DO storage path.
    lines.push(`    volumes:`);
    lines.push(`      - cloister-uds:/run/cloister-uds`);
    if (b.name === "cloister-router") {
      lines.push(`      - cloister-do:${cluster.storage.doStoragePath || "/var/lib/cloister/do"}`);
    }

    // Environment: wire bindings + bundle-declared env
    const envVars = [];
    for (const w of cluster.wires) {
      if (w.from !== b.name) continue;
      const target = cluster.bundles.find((x) => x.name === w.to);
      if (target && "external" in target.kind && target.kind.external.ipcSocket) {
        envVars.push(`${w.binding}=${target.kind.external.ipcSocket}`);
      } else if (target && "external" in target.kind && target.kind.external.httpPort > 0) {
        if (w.to === "mache") {
          envVars.push(`${w.binding}=http://127.0.0.1:${target.kind.external.httpPort}`);
        } else {
          envVars.push(`${w.binding}=http://${w.to}:${target.kind.external.httpPort}`);
        }
      }
    }
    for (const e of ext.env) envVars.push(`${e.name}=${e.value}`);
    if (envVars.length > 0) {
      lines.push(`    environment:`);
      for (const e of envVars) lines.push(`      - ${JSON.stringify(e)}`);
    }
    lines.push(``);
  }

  lines.push(`volumes:`);
  lines.push(`  cloister-uds:`);
  lines.push(`    driver: local`);
  lines.push(`    # tmpfs is fine — UDS sockets are ephemeral; recreated on container start`);
  lines.push(`  cloister-do:`);
  lines.push(`    driver: local`);
  lines.push(`    # SQLite DO storage — survives container restarts; backup target`);

  return lines.join("\n") + "\n";
}

// ── CLI ──────────────────────────────────────────────────────────────────

async function runCLI() {
  const INPUT_PATH = process.env.CLUSTER_TS ?? resolve(REPO, "src/generated/cluster.ts");
  const OUTPUT = process.env.COMPOSE_OUTPUT ?? resolve(REPO, "cluster.compose.yaml");

  if (!existsSync(INPUT_PATH)) {
    console.error("emit-compose: failed to load cluster manifest");
    console.error(`  tried: ${INPUT_PATH}`);
    console.error("  did you run `task cluster:toml`?");
    process.exit(1);
  }

  const mod = await import(pathToFileURL(INPUT_PATH).href).catch((e) => {
    console.error("emit-compose: failed to import cluster manifest");
    console.error(e?.message ?? e);
    process.exit(1);
  });
  const cluster = mod.cluster;

  // Validate via the hand-authored validator. Imported lazily so the
  // pure-function path above stays import-free.
  const { validateCluster } = await import(
    pathToFileURL(resolve(REPO, "src/manifest/cluster-types.ts")).href
  );
  validateCluster(cluster);

  let body;
  try {
    body = emitCompose(cluster);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, body);
  const rel = OUTPUT.replace(REPO + "/", "");
  console.log(`emit-compose: wrote ${rel}`);
  const externalCount = cluster.bundles.filter((b) => "external" in b.kind).length;
  const inputCount = (cluster.inputs ?? []).length;
  console.log(
    `emit-compose:   ${externalCount} external bundle(s)` +
      (inputCount > 0 ? `, ${inputCount} input(s) co-located by tenancy` : ""),
  );
}

const invokedDirectly = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (invokedDirectly) {
  runCLI();
}
