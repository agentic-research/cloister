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

// ── perTenant fanout (cedcf3 Phase 2 piece 2) ────────────────────────────

/**
 * Resolve the tenant rows that should fan out into per-tenant
 * containers for a perTenant=true bundle. Walks the Inv-9 binding-
 * correlation chain in reverse:
 *
 *   bundle.name === wire.to
 *      → wire.binding
 *      → tenantDispatch row.binding match
 *      → tenant row
 *
 * Returns the matched rows in dispatch-table declaration order.
 * Returns [] if no chain links exist — lint Inv 8 + Inv 9 should
 * have caught that case before this script runs; this code falls
 * back to single-emission rather than fail-late.
 *
 * The shared-binding case (all tenants share one `binding` per the
 * docs/reference/tenancy-model.md §"Operator opt-in shape" example)
 * means one wire entry yields N tenants here. The per-tenant-binding
 * case (operator declares N wires + N matching dispatch rows) also
 * works: each wire matches its corresponding row.
 *
 * Per cloister-cedcf3 Phase 2 piece 2.
 */
function perTenantInstancesFor(bundleName, cluster) {
  const incomingBindings = new Set(
    cluster.wires.filter((w) => w.to === bundleName).map((w) => w.binding),
  );
  if (incomingBindings.size === 0) return [];
  const rows = [];
  for (const route of cluster.routes ?? []) {
    if (!("tenantDispatch" in route.kind)) continue;
    for (const row of route.kind.tenantDispatch.tenants) {
      if (incomingBindings.has(row.binding)) rows.push(row);
    }
  }
  return rows;
}

/**
 * Derive a per-tenant ipcSocket path from a base socket + tenant name
 * by inserting `.<tenant>` before the extension:
 *
 *   /run/cloister-uds/tenant.sock + "alice"
 *     → /run/cloister-uds/tenant.alice.sock
 *
 * The shared `cloister-uds:` named volume is mounted into every
 * container, so per-tenant sockets coexist on the same volume without
 * filesystem-namespace collisions, and the router can reach each
 * tenant's bind point through the same path the per-tenant container
 * publishes. Bind point is the in-container path; the router sees the
 * SAME path because the volume is shared.
 *
 * If the base socket has no extension, the tenant tag is appended
 * with a `.` separator. Empty base returns the tag with a `.sock`
 * extension as a safe default.
 *
 * Per cloister-cedcf3 Phase 3.
 */
function perTenantSocketPath(baseSocket, tenantName) {
  if (!baseSocket) return `.${tenantName}.sock`;
  const lastSlash = baseSocket.lastIndexOf("/");
  const dir = lastSlash >= 0 ? baseSocket.slice(0, lastSlash + 1) : "";
  const file = lastSlash >= 0 ? baseSocket.slice(lastSlash + 1) : baseSocket;
  const lastDot = file.lastIndexOf(".");
  if (lastDot <= 0) return `${dir}${file}.${tenantName}`;
  const stem = file.slice(0, lastDot);
  const ext = file.slice(lastDot);
  return `${dir}${stem}.${tenantName}${ext}`;
}

/**
 * Resolve the per-tenant socket path the SOURCE side of a wire should
 * use to reach its perTenant target. Walks dispatch routes to find the
 * unique tenant row whose binding matches this wire's binding; if
 * exactly one row matches, returns the derived per-tenant socket. If
 * zero or multiple rows match, returns null and the caller falls back
 * to the bundle's declared ipcSocket (the operator opted into a shared
 * binding shape — the dispatch path is their responsibility).
 *
 * Per cloister-cedcf3 Phase 3.
 */
function perTenantSocketForWire(wire, cluster, targetBundle) {
  if (targetBundle?.perTenant !== true) return null;
  if (!("external" in targetBundle.kind)) return null;
  const baseSocket = targetBundle.kind.external.ipcSocket;
  if (!baseSocket) return null;
  let matched = null;
  for (const route of cluster.routes ?? []) {
    if (!("tenantDispatch" in route.kind)) continue;
    for (const row of route.kind.tenantDispatch.tenants) {
      if (row.binding === wire.binding) {
        if (matched) return null; // ambiguous (shared binding); operator owns dispatch
        matched = row;
      }
    }
  }
  if (!matched) return null;
  return perTenantSocketPath(baseSocket, matched.name);
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

  // Per-tenant DO volume names collected during bundle emission
  // (cedcf3 Phase 3 piece 2). The `volumes:` section at the end of
  // the YAML must declare each one. Set keeps emission deterministic
  // (insertion order) without duplicates.
  const perTenantDoVolumes = new Set();

  for (const b of cluster.bundles) {
    if (!("external" in b.kind)) {
      // workerd-bundle kind is in-process; nothing to emit at the
      // compose level — it runs inside the cloister-router service.
      continue;
    }
    // perTenant=true bundles fan out to one container per matching
    // tenantDispatch row (cedcf3 Phase 2 piece 2). If the chain
    // resolves to zero rows (shouldn't — lint Inv 8 + Inv 9 catch
    // that), fall back to single-emission.
    const tenants = b.perTenant === true ? perTenantInstancesFor(b.name, cluster) : [];
    if (tenants.length > 0) {
      for (const tenant of tenants) {
        emitBundleContainer(lines, b, cluster, colocation, tenant, perTenantDoVolumes);
      }
    } else {
      emitBundleContainer(lines, b, cluster, colocation, null, perTenantDoVolumes);
    }
  }

  lines.push(`volumes:`);
  lines.push(`  cloister-uds:`);
  lines.push(`    driver: local`);
  lines.push(`    # tmpfs is fine — UDS sockets are ephemeral; recreated on container start`);
  lines.push(`  cloister-do:`);
  lines.push(`    driver: local`);
  lines.push(`    # SQLite DO storage — survives container restarts; backup target`);
  // Per-tenant DO volumes — one per (perTenant bundle, tenant) pair.
  // Operator offboarding is mechanically atomic: `docker volume rm
  // cloister-do-<bundle>-<tenant>`. Per cedcf3 Phase 3 piece 2.
  for (const name of perTenantDoVolumes) {
    lines.push(`  ${name}:`);
    lines.push(`    driver: local`);
    lines.push(`    # Per-tenant SQLite DO storage; isolated per (bundle, tenant). Backup/offboard target.`);
  }

  return lines.join("\n") + "\n";
}

/**
 * Emit a single compose service block for one bundle instance. If
 * `tenant` is non-null, this is a perTenant fanout instance — the
 * service + container names get the `-<tenant.name>` suffix, the
 * environment gets `TENANT_ID` + `TENANT_MODE` + `TENANT_MATCH_VALUE`
 * + `TENANT_SOCKET` (Phase 3 piece 1), and the container mounts its
 * own `cloister-do-<bundle>-<tenant>` volume (Phase 3 piece 2 — added
 * to the `perTenantDoVolumes` Set so the top-level `volumes:` section
 * declares it). The shared `cloister-uds:` volume is still mounted so
 * the router can reach each tenant's per-tenant UDS path.
 *
 * Source-side wires targeting this bundle get their env vars rewritten
 * by `perTenantSocketForWire` when the binding maps to exactly one
 * dispatch row (Phase 3 piece 3).
 *
 * Per cloister-cedcf3 Phase 2 piece 2 + Phase 3 pieces 1, 2, 3.
 */
function emitBundleContainer(lines, b, cluster, colocation, tenant, perTenantDoVolumes) {
  const ext = b.kind.external;
  const colocatedInputs = colocation.get(b.name) ?? [];
  const serviceName = tenant ? `${b.name}-${tenant.name}` : b.name;
  const containerName = `cloister-${serviceName}`;

  lines.push(`  ${serviceName}:`);
  lines.push(`    image: ${ext.image}`);
  lines.push(`    pull_policy: never`);
  lines.push(`    container_name: ${containerName}`);
  lines.push(`    labels:`);
  lines.push(`      - "cloister.bundle=${b.name}"`);
  lines.push(`      - "cloister.tier=${b.tier}"`);
  lines.push(`      - "cloister.description=${ext.image} — ${b.description}"`);
  if (colocatedInputs.length > 0) {
    lines.push(`      - "cloister.colocated-inputs=${colocatedInputs.join(",")}"`);
  }
  if (b.perTenant === true) {
    lines.push(`      - "cloister.per-tenant=true"`);
  }
  if (tenant) {
    lines.push(`      - "cloister.tenant=${tenant.name}"`);
    lines.push(`      - "cloister.dispatch-mode=${tenant.mode}"`);
    lines.push(`      - "cloister.dispatch-match=${tenant.matchValue}"`);
  }

  if (ext.args.length > 0) {
    lines.push(`    command:`);
    for (const a of ext.args) lines.push(`      - ${JSON.stringify(a)}`);
  }

  if (b.name === "mache") {
    lines.push(`    network_mode: "service:cloister-router"`);
  }

  // Port forwards (only the lead instance gets host-port binding when
  // we'd otherwise collide — per-tenant containers don't bind host
  // ports by default; operators add explicit ports: in their compose
  // overlay if they want per-tenant TCP exposure).
  if (ext.httpPort > 0 && b.name !== "mache" && !tenant) {
    lines.push(`    ports:`);
    lines.push(`      - "${ext.httpPort}:${ext.httpPort}"`);
  }

  lines.push(`    volumes:`);
  lines.push(`      - cloister-uds:/run/cloister-uds`);
  if (b.name === "cloister-router") {
    lines.push(`      - cloister-do:${cluster.storage.doStoragePath || "/var/lib/cloister/do"}`);
  }
  // Per-tenant DO volume — one named volume per (bundle, tenant) pair,
  // mounted at the same in-container path the router uses for its
  // cloister-do mount. Operator offboarding is `docker volume rm
  // cloister-do-<bundle>-<tenant>`. Per cedcf3 Phase 3 piece 2.
  if (tenant) {
    const doVol = `cloister-do-${b.name}-${tenant.name}`;
    perTenantDoVolumes?.add(doVol);
    lines.push(`      - ${doVol}:${cluster.storage.doStoragePath || "/var/lib/cloister/do"}`);
  }

  const envVars = [];
  for (const w of cluster.wires) {
    if (w.from !== b.name) continue;
    const target = cluster.bundles.find((x) => x.name === w.to);
    if (target && "external" in target.kind && target.kind.external.ipcSocket) {
      // Per-tenant socket derivation (cedcf3 Phase 3): if the target
      // bundle is perTenant=true AND this wire's binding maps to
      // exactly one dispatch row, derive the per-tenant socket path so
      // the router reaches the right tenant's bind point. Ambiguous
      // bindings (shared across rows) fall through to the bundle's
      // declared ipcSocket — that's the operator's shared-dispatch
      // shape, not ours to second-guess.
      const perTenantSocket = perTenantSocketForWire(w, cluster, target);
      envVars.push(`${w.binding}=${perTenantSocket ?? target.kind.external.ipcSocket}`);
    } else if (target && "external" in target.kind && target.kind.external.httpPort > 0) {
      if (w.to === "mache") {
        envVars.push(`${w.binding}=http://127.0.0.1:${target.kind.external.httpPort}`);
      } else {
        envVars.push(`${w.binding}=http://${w.to}:${target.kind.external.httpPort}`);
      }
    }
  }
  if (tenant) {
    envVars.push(`TENANT_ID=${tenant.name}`);
    envVars.push(`TENANT_MODE=${tenant.mode}`);
    envVars.push(`TENANT_MATCH_VALUE=${tenant.matchValue}`);
    // TENANT_SOCKET tells this per-tenant container where to bind its
    // UDS so it's reachable from the router via the shared cloister-uds
    // volume at the matching path (perTenantSocketForWire on the source
    // side derives the same path from the wire binding). Per cedcf3
    // Phase 3.
    if (b.kind.external.ipcSocket) {
      envVars.push(`TENANT_SOCKET=${perTenantSocketPath(b.kind.external.ipcSocket, tenant.name)}`);
    }
  }
  for (const e of ext.env) envVars.push(`${e.name}=${e.value}`);
  if (envVars.length > 0) {
    lines.push(`    environment:`);
    for (const e of envVars) lines.push(`      - ${JSON.stringify(e)}`);
  }
  lines.push(``);
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
