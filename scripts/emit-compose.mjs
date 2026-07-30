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
 *   - Empty `workerdId` with no same-name bundle falls back to the first
 *     hypervisor/gateway bundle (back-compat all-in-one convention).
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

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { writeGeneratedFile } from "./write-generated.mjs";
import { parse as parseToml } from "@iarna/toml";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveBundleImage } from "./lib/oci-artifact.mjs";

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
export function emitCompose(cluster, ociByInput = new Map(), opts = {}) {
  const ociByBundle = opts.ociByBundle ?? new Map();
  // CLOISTER_DO_BIND: when set to a host path, /data/do is mounted from host
  // bind-mounts rooted there (one subdir per store) instead of named docker
  // volumes — making the cluster's data an owned, backup-able, dev:securevol-
  // encryptable file tree on the host. Unset → named volumes (default).
  const doBindPath = opts.doBindPath || "";
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
        emitBundleContainer(lines, b, cluster, colocation, tenant, perTenantDoVolumes, ociByInput, doBindPath, ociByBundle);
      }
    } else {
      emitBundleContainer(lines, b, cluster, colocation, null, perTenantDoVolumes, ociByInput, doBindPath, ociByBundle);
    }
  }

  lines.push(`volumes:`);
  lines.push(`  cloister-uds:`);
  lines.push(`    driver: local`);
  // tmpfs with /tmp semantics (mode 1777), and BOTH halves are load-bearing.
  //
  // The comment here used to say "tmpfs is fine — UDS sockets are ephemeral"
  // while emitting a plain local volume: a stated intent the code did not
  // implement. The consequence was measured (cloister-047b06) — `docker compose
  // up` started all five containers and rosary immediately died:
  //
  //     Error: binding UDS at /run/cloister-uds/rosary.sock
  //     Caused by: Permission denied (os error 13)
  //
  // A default local volume is created root:root 0755. The bundles that must
  // bind sockets in it do not run as root, and they do not agree on a uid
  // either — rosary and cloister-router are 65532, notme and notme-proxy are
  // 1000, mache uses a named user. So there is no single owner to chown to.
  //
  // 1777 is the answer Unix already has for exactly this: a shared directory
  // where any uid may create an entry and only the entry's owner may remove it
  // — /tmp semantics. Preferred over an init container that chowns, because
  // that would need a shell-bearing image (every image here is distroless) and
  // would add an unpinned dependency to a tree whose whole posture is
  // digest-pinned images.
  //
  // tmpfs rather than a disk-backed volume because a socket has no business
  // surviving a restart: a stale socket file from a previous run is a bind
  // failure waiting to happen, not state worth keeping.
  lines.push(`    driver_opts:`);
  lines.push(`      type: tmpfs`);
  lines.push(`      device: tmpfs`);
  lines.push(`      o: "mode=1777"`);
  if (!doBindPath) {
    lines.push(`  cloister-do:`);
    lines.push(`    driver: local`);
    lines.push(`    # SQLite DO storage — survives container restarts; backup target`);
  }
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
 * Resolve a bundle's container image (ADR-0038 precedence):
 *   1. non-empty operator `ext.image` wins (mirror, fork, pinned digest);
 *   2. else derive from the first linked input's self-declared oci package
 *      — `<identifier>@<digest>` when digest-pinned, else
 *      `<identifier>:<version>`, else bare `<identifier>` (registry default);
 *   3. else warn loudly and return the (empty) `ext.image` — `compose up`
 *      fails, not this emitter, and a blank image is never shipped silently.
 */
function resolveBundleImageOrWarn(ext, colocatedInputs, ociByInput, bundleName, ociByBundle = new Map()) {
  const image = resolveBundleImage(ext.image, colocatedInputs, ociByInput, bundleName, ociByBundle);
  if (image) return image;
  console.warn(
    `emit-compose: bundle "${bundleName}" has no image — no operator ext.image ` +
    `and no packages[].oci from a linked input (${colocatedInputs.join(", ") || "none"}). ` +
    `Set image in cluster.toml or add an oci package to the input's server.json (ADR-0038).`,
  );
  return ext.image;
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
/**
 * A YAML double-quoted scalar, escaped.
 *
 * This file builds compose YAML by string concatenation, interpolating values
 * straight into `"..."`. Any value containing a `"` terminates the scalar early
 * and produces a file that is not YAML at all.
 *
 * It happened: a bundle description carrying the sentence
 *
 *     executionMode is deliberately "process", not "microvm"
 *
 * emitted a label line that `docker compose` refused with
 * `did not find expected key`, and `task cluster:up` could not start the
 * cluster at all (cloister-cb735c).
 *
 * Not fixed by "don't put quotes in descriptions" — that is a rule a human has
 * to remember on every edit of a free-text field, which is the class of thing
 * this repo keeps deleting. Escaping at the emitter fixes every field at once,
 * including the ones nobody has typed a quote into yet.
 *
 * JSON.stringify is the correct primitive here rather than a hand-rolled
 * replace: YAML 1.2's double-quoted style is deliberately a superset of JSON
 * string escaping, so a JSON string literal is always a valid YAML scalar —
 * and it handles backslashes, control characters and newlines, not just the
 * quote that happened to break first.
 */
function yamlStr(value) {
  return JSON.stringify(String(value));
}

function emitBundleContainer(lines, b, cluster, colocation, tenant, perTenantDoVolumes, ociByInput = new Map(), doBindPath = "", ociByBundle = new Map()) {
  const ext = b.kind.external;
  const colocatedInputs = colocation.get(b.name) ?? [];
  const serviceName = tenant ? `${b.name}-${tenant.name}` : b.name;
  const containerName = `cloister-${serviceName}`;
  // ADR-0038: operator ext.image wins; else derive from a linked input's
  // self-declared packages[].oci; else a loud warning + empty image.
  const image = resolveBundleImageOrWarn(ext, colocatedInputs, ociByInput, b.name, ociByBundle);

  lines.push(`  ${serviceName}:`);
  lines.push(`    image: ${image}`);
  lines.push(`    pull_policy: never`);
  lines.push(`    container_name: ${containerName}`);
  lines.push(`    labels:`);
  lines.push(`      - ${yamlStr(`cloister.bundle=${b.name}`)}`);
  lines.push(`      - ${yamlStr(`cloister.tier=${b.tier}`)}`);
  lines.push(`      - ${yamlStr(`cloister.description=${image} — ${b.description}`)}`);
  if (colocatedInputs.length > 0) {
    lines.push(`      - ${yamlStr(`cloister.colocated-inputs=${colocatedInputs.join(",")}`)}`);
  }
  if (b.perTenant === true) {
    lines.push(`      - "cloister.per-tenant=true"`);
  }
  if (tenant) {
    lines.push(`      - ${yamlStr(`cloister.tenant=${tenant.name}`)}`);
    lines.push(`      - ${yamlStr(`cloister.dispatch-mode=${tenant.mode}`)}`);
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
  const doPath = cluster.storage.doStoragePath || "/var/lib/cloister/do";
  if (b.name === "cloister-router") {
    // doBindPath set → host bind-mount (owned/backup-able/encryptable);
    // else the named docker volume (default). Same in-container path.
    const src = doBindPath ? `${doBindPath}/cloister-router` : "cloister-do";
    lines.push(`      - ${src}:${doPath}`);
  }
  // Per-tenant DO store — one per (bundle, tenant) pair at the same
  // in-container path. Named volume (offboard: `docker volume rm
  // cloister-do-<bundle>-<tenant>`), or a host bind subdir under
  // CLOISTER_DO_BIND. Per cedcf3 Phase 3 piece 2.
  if (tenant) {
    if (doBindPath) {
      lines.push(`      - ${doBindPath}/${b.name}-${tenant.name}:${doPath}`);
    } else {
      const doVol = `cloister-do-${b.name}-${tenant.name}`;
      perTenantDoVolumes?.add(doVol);
      lines.push(`      - ${doVol}:${doPath}`);
    }
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

  // ADR-0038: load each input's self-declared oci image from the lockfile
  // (resolve-inputs records packages[].oci there). Absent lockfile / no oci
  // → empty map → emitCompose falls back to the operator's ext.image as
  // before (fully back-compat).
  const ociByInput = new Map();
  const ociByBundle = new Map();
  const LOCKFILE = process.env.CLOISTER_LOCKFILE ?? resolve(REPO, "cluster.lock.toml");
  if (existsSync(LOCKFILE)) {
    try {
      const lock = parseToml(readFileSync(LOCKFILE, "utf8"));
      for (const [name, row] of Object.entries(lock.inputs ?? {})) {
        if (row && typeof row === "object" && row.oci && row.oci.identifier) {
          ociByInput.set(name, row.oci);
        }
        for (const b of row?.ociBundles ?? []) {
          if (b && typeof b === "object" && b.bundle && b.identifier) ociByBundle.set(b.bundle, b);
        }
      }
    } catch (e) {
      console.warn(`emit-compose: could not read oci packages from ${LOCKFILE}: ${e.message}`);
    }
  }

  let body;
  try {
    body = emitCompose(cluster, ociByInput, { doBindPath: process.env.CLOISTER_DO_BIND || "", ociByBundle });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeGeneratedFile(OUTPUT, body);
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
