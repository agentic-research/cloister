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
 *   node cli/lib/cluster/emit-compose.mjs
 *   → writes cluster.compose.yaml in the repo root.
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { writeGeneratedFile } from "../atomic-write.mjs";
import { parse as parseToml } from "smol-toml";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import { ociPins, parseImageRef, resolveBundleImage } from "../oci-artifact.mjs";
import { PUBLISH_ADDRESS, connectionEdgeOf, edgePortsOf, httpEdgeOf, networkExposure, publishedPort, networkPlan, networksFor } from "./http-networks.mjs";
import { assertWiresRun, composeView } from "./compose-placement.mjs";
import { STRENGTHS, envSource } from "./connections.mjs";
import { bindPath, bundleServices, dialPath, socketMountsFor, socketPlan, tenantInstances } from "./socket-dirs.mjs";
import { composeWorkspaceMount, workspaceAccess } from "./workspace.mjs";
import { startedAsScript } from "../started-as-script.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = resolve(__dirname, "../../..");

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

/**
 * Every connection with a target in the compose env is one this emitter
 * lowers, or it says why not, by name. Nothing is left as an env row with no
 * network behind it.
 */
function assertConnectionsLowered(netPlan, view, services) {
  for (const edge of netPlan.edges.filter((e) => e.declaredAs === "connection")) {
    const where = `emit-compose: connection "${edge.connection}" (${edge.from} → ${edge.to}) for env "${view.env}"`;
    if (edge.kind === "unjoined") {
      const gone = view.skipped.find((s) => s.name === edge.missing);
      throw new Error(
        `${where} has an end compose does not run: "${edge.missing}" is not a service here` +
          (gone ? ` because ${gone.reason}` : ": it runs inside the gateway and has no container") +
          `. An edge across two placements needs a broker that nothing lowers yet`,
      );
    }
    if (edge.kind === "unaddressed") throw new Error(`${where} cannot be addressed: ${edge.reason}`);
    if (edge.minStrength === "") continue;
    const { undeclared, network } = networkExposure(edge, netPlan, services);
    const strength = undeclared.length ? "none" : "capability";
    if (STRENGTHS.indexOf(strength) < STRENGTHS.indexOf(edge.minStrength)) {
      throw new Error(`${where}: minStrength "${edge.minStrength}" is not met. ${undeclared.map((s) => `"${s}"`).join(" and ")} shares the network namespace of an end and so is on network ${network} too, which makes the edge's strength "none"`);
    }
  }
}

// ── Compose YAML emitter ─────────────────────────────────────────────────

/**
 * Emit the cluster.compose.yaml body as a string. Pure function — no
 * I/O, no process.exit. Throws if tenancy resolution finds violations.
 *
 * Exported for tests.
 */
export function emitCompose(declared, ociByInput = new Map(), opts = {}) {
  // What compose runs: the external bundles placed `compose` in the compose
  // env. Everything below reads this view, not the cluster as declared, so a
  // bundle that is not run is not mounted, attached, or handed an address.
  const view = composeView(declared, opts.env);
  assertWiresRun(view);
  const cluster = view.cluster;
  const ociByBundle = opts.ociByBundle ?? new Map();
  const warn = opts.warn ?? console.warn;
  // ADR-0083: the lock's pins for operator images, and every image this file
  // cannot pin, which its header names.
  const pins = { images: opts.images ?? new Map(), unpinned: new Map() };
  // CLOISTER_DO_BIND: when set to a host path, /data/do is mounted from host
  // bind-mounts rooted there (one subdir per store) instead of named docker
  // volumes — making the cluster's data an owned, backup-able, dev:securevol-
  // encryptable file tree on the host. Unset → named volumes (default).
  const doBindPath = opts.doBindPath || "";
  // Tenancy is a statement about the whole cluster: an input may be hosted by
  // a bundle that compose does not run.
  const { colocation, violations } = resolveTenancy(declared);
  if (violations.length > 0) {
    const msg = violations
      .map((v) => `  - input "${v.input}": ${v.problem}`)
      .join("\n");
    throw new Error(
      `emit-compose: ${violations.length} tenancy violation(s):\n${msg}`,
    );
  }

  const lines = [];
  lines.push(`# AUTO-GENERATED by cloister cluster generate. Do NOT edit by hand.`);
  lines.push(`# Regenerate via \`cloister cluster generate\` after editing cluster.toml.`);
  lines.push(`#`);
  lines.push(`# Cluster: ${cluster.metadata.name} v${cluster.metadata.version}`);
  lines.push(`# ${cluster.bundles.length} bundle(s), ${cluster.wires.length} wire(s)`);
  if ((cluster.inputs ?? []).length > 0) {
    lines.push(`# ${cluster.inputs.length} input(s); tenancy resolved per ADR-0030 §A5`);
  }
  if (view.legacy) {
    lines.push(`#`);
    lines.push(`# No bundle declares a placement, so every external bundle is run here.`);
    lines.push(`# Once one does, only bundles placed "compose" for env "${view.env}" are.`);
  } else {
    lines.push(`#`);
    lines.push(`# Runs the bundles placed "compose" for env "${view.env}".`);
    for (const s of view.skipped) lines.push(`# Not run: ${s.name} — ${s.reason}.`);
  }
  const headerEnd = lines.length;
  lines.push(``);
  lines.push(`name: ${cluster.metadata.name}`);
  lines.push(``);
  lines.push(`services:`);

  // Per-tenant DO volume names collected during bundle emission
  // (cedcf3 Phase 3 piece 2). The `volumes:` section at the end of
  // the YAML must declare each one. Set keeps emission deterministic
  // (insertion order) without duplicates.
  const perTenantDoVolumes = new Set();
  // One volume per socket directory, mounted only into the bundles that
  // bind in it or have a wire to one that does (ADR-0075 §4.1).
  const udsPlan = socketPlan(cluster);
  // One network per wire carried over HTTP, joining its two ends and no
  // one else; no service is left on compose's shared `default` (ADR-0075 §6).
  const netPlan = networkPlan(cluster, view.env);
  assertConnectionsLowered(netPlan, view, bundleServices(cluster));

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
    const tenants = b.perTenant === true ? tenantInstances(b.name, cluster) : [];
    if (tenants.length > 0) {
      for (const tenant of tenants) {
        emitBundleContainer(lines, b, cluster, colocation, tenant, perTenantDoVolumes, ociByInput, doBindPath, ociByBundle, warn, udsPlan, netPlan, pins);
      }
    } else {
      emitBundleContainer(lines, b, cluster, colocation, null, perTenantDoVolumes, ociByInput, doBindPath, ociByBundle, warn, udsPlan, netPlan, pins);
    }
  }
  lines.splice(headerEnd, 0, ...unpinnedHeader(pins.unpinned));

  const topVolumes = [];
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
  for (const d of udsPlan.dirs) {
    topVolumes.push(`  ${d.volume}:`);
    topVolumes.push(`    # ${d.dir} — held by ${d.holders.join(", ")}`);
    topVolumes.push(`    driver: local`);
    topVolumes.push(`    driver_opts:`);
    topVolumes.push(`      type: tmpfs`);
    topVolumes.push(`      device: tmpfs`);
    topVolumes.push(`      o: "mode=1777"`);
  }
  if (!doBindPath) {
    topVolumes.push(`  cloister-do:`);
    topVolumes.push(`    driver: local`);
    topVolumes.push(`    # SQLite DO storage — survives container restarts; backup target`);
  }
  // Per-tenant DO volumes — one per (perTenant bundle, tenant) pair.
  // Operator offboarding is mechanically atomic: `docker volume rm
  // cloister-do-<bundle>-<tenant>`. Per cedcf3 Phase 3 piece 2.
  for (const name of perTenantDoVolumes) {
    topVolumes.push(`  ${name}:`);
    topVolumes.push(`    driver: local`);
    topVolumes.push(`    # Per-tenant SQLite DO storage; isolated per (bundle, tenant). Backup/offboard target.`);
  }
  // A cluster with no socket and a bind-mounted store declares no volume:
  // an empty `volumes:` key is not a mapping, and compose refuses it.
  if (topVolumes.length > 0) lines.push(`volumes:`, ...topVolumes);
  if (netPlan.networks.length > 0) {
    if (topVolumes.length > 0) lines.push(``);
    lines.push(`networks:`);
    for (const n of netPlan.networks) {
      lines.push(`  ${n.name}:`);
      lines.push(`    # ${n.for}`);
      lines.push(`    driver: bridge`);
    }
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
function resolveBundleImageOrWarn(ext, colocatedInputs, ociByInput, bundleName, ociByBundle = new Map(), warn = console.warn, images = new Map()) {
  const image = resolveBundleImage(ext.image, colocatedInputs, ociByInput, bundleName, ociByBundle, images);
  if (image) return image;
  warn(
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
 * declares it). The bundle's socket directory is still mounted so
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

function emitBundleContainer(lines, b, cluster, colocation, tenant, perTenantDoVolumes, ociByInput = new Map(), doBindPath = "", ociByBundle = new Map(), warn = console.warn, udsPlan = socketPlan(cluster), netPlan = networkPlan(cluster), pins = { images: new Map(), unpinned: new Map() }) {
  const ext = b.kind.external;
  const colocatedInputs = colocation.get(b.name) ?? [];
  const serviceName = tenant ? `${b.name}-${tenant.name}` : b.name;
  const containerName = `cloister-${serviceName}`;
  // ADR-0038: operator ext.image wins; else derive from a linked input's
  // self-declared packages[].oci; else a loud warning + empty image. Either
  // way the lock's digest is what runs when it pins one (ADR-0083 §1).
  const image = resolveBundleImageOrWarn(ext, colocatedInputs, ociByInput, b.name, ociByBundle, warn, pins.images);
  if (image && !parseImageRef(image).digest) {
    pins.unpinned.set(image, [...(pins.unpinned.get(image) ?? []), serviceName]);
  }

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

  // A container is on the networks of its own wires and no others. One
  // that joins another's namespace is on that one's networks instead.
  const nsHost = netPlan.hosts.get(b.name) ?? "";
  if (nsHost) {
    lines.push(`    network_mode: ${yamlStr(`service:${nsHost}`)}`);
  } else {
    lines.push(`    networks:`);
    for (const n of networksFor(serviceName, netPlan)) lines.push(`      - ${n}`);
  }

  // A port reaches the host only if the bundle declares it with
  // `expose = "edge"` (ADR-0069 §2: the one value that means "also from
  // outside"). `httpPort` alone is where a wire reaches the bundle and says
  // nothing about the host, so it is not published, and the file says so.
  //
  // Published on the host's loopback only, as `cluster up` does for an
  // `edge` port. A port published on every interface is reachable from
  // EVERY container through the host's address, whatever network that
  // container is on, which would undo the per-wire networks above. An
  // operator who wants the port on the LAN says so in a compose overlay.
  const edge = edgePortsOf(b);
  if (edge.length > 0 && nsHost) {
    throw new Error(`emit-compose: bundle "${b.name}" declares ${edge.map((p) => `port "${p.name}"`).join(", ")} with expose = "edge", but it runs inside "${nsHost}"'s network namespace and has no ports of its own to publish. Declare the port on "${nsHost}"`);
  }
  if (edge.length > 0 && !tenant) {
    lines.push(`    ports:`);
    for (const p of edge) lines.push(`      - ${publishedPort(p.port, p.port)}`);
  } else if (edge.length > 0) {
    // Every tenant's instance would ask for the same host port.
    lines.push(`    # not published: ${edge.map((p) => p.port).join(", ")} — one host port cannot serve every tenant's instance`);
  }
  if (ext.httpPort > 0 && !nsHost && !edge.some((p) => p.port === ext.httpPort)) {
    lines.push(`    # not published: httpPort ${ext.httpPort} is reached through this bundle's wires only. A [[bundles.ports]] row for it with expose = "edge" publishes it on ${PUBLISH_ADDRESS}`);
  }

  const mounts = socketMountsFor(serviceName, udsPlan).map((d) => `${d.volume}:${d.dir}`);
  const doPath = cluster.storage.doStoragePath || "/var/lib/cloister/do";
  if (b.name === "cloister-router") {
    // doBindPath set → host bind-mount (owned/backup-able/encryptable);
    // else the named docker volume (default). Same in-container path.
    const src = doBindPath ? `${doBindPath}/cloister-router` : "cloister-do";
    mounts.push(`${src}:${doPath}`);
  }
  // Per-tenant DO store — one per (bundle, tenant) pair at the same
  // in-container path. Named volume (offboard: `docker volume rm
  // cloister-do-<bundle>-<tenant>`), or a host bind subdir under
  // CLOISTER_DO_BIND. Per cedcf3 Phase 3 piece 2.
  if (tenant) {
    if (doBindPath) {
      mounts.push(`${doBindPath}/${b.name}-${tenant.name}:${doPath}`);
    } else {
      const doVol = `cloister-do-${b.name}-${tenant.name}`;
      perTenantDoVolumes?.add(doVol);
      mounts.push(`${doVol}:${doPath}`);
    }
  }
  // A declared workspace is given here, at the path every placement uses
  // (ADR-0078).
  const workspace = workspaceAccess(b);
  if (mounts.length > 0 || workspace !== "") {
    lines.push(`    volumes:`);
    for (const m of mounts) lines.push(`      - ${m}`);
    if (workspace !== "") lines.push(...composeWorkspaceMount(workspace));
  }

  const envVars = [];
  for (const w of cluster.wires) {
    if (w.from !== b.name) continue;
    const target = cluster.bundles.find((x) => x.name === w.to);
    if (target && "external" in target.kind && target.kind.external.ipcSocket) {
      // The path comes from the socket plan, the same one the volumes are
      // mounted from: the tenant's own socket when this wire's binding maps
      // to exactly one dispatch row, else the bundle's declared ipcSocket
      // (a binding several tenants share is the operator's dispatch shape,
      // not ours to second-guess).
      envVars.push(`${w.binding}=${dialPath(w, udsPlan)}`);
    } else {
      // Over HTTP: the address is the one the network plan carries it at.
      const http = httpEdgeOf(w, netPlan);
      if (http) envVars.push(`${w.binding}=${http.address}`);
    }
  }
  if (tenant) {
    envVars.push(`TENANT_ID=${tenant.name}`);
    envVars.push(`TENANT_MODE=${tenant.mode}`);
    envVars.push(`TENANT_MATCH_VALUE=${tenant.matchValue}`);
    // TENANT_SOCKET tells this per-tenant container where to bind its
    // UDS: a directory of the tenant's own, mounted into this container
    // and into the bundles whose wire reaches this tenant, and into no
    // other tenant's container (ADR-0075 §5).
    const ownSocket = bindPath(serviceName, udsPlan);
    if (ownSocket) envVars.push(`TENANT_SOCKET=${ownSocket}`);
  }
  for (const e of ext.env) {
    const source = envSource(e);
    const where = `emit-compose: bundle "${b.name}" env "${e.name}"`;
    if (source === "secret") {
      // Written as an empty value this would start the service with the
      // variable set to nothing, and nothing would say so.
      throw new Error(`${where} takes its value from secret "${e.secret}", and compose has no secret store cloister writes to. Set it in a compose overlay, or give the row a literal value`);
    }
    if (source === "connection") {
      const edge = connectionEdgeOf(b.name, e.connection, netPlan);
      if (!edge) throw new Error(`${where} is bound to connection "${e.connection}", which has no target for env "${netPlan.env}"`);
      if (edge.address === "") {
        throw new Error(`${where}: connection "${e.connection}" speaks "${edge.appProtocol}", which has no URL form here. Set the variable with a literal value for this placement (it is reached at ${edge.hostPort})`);
      }
      envVars.push(`${e.name}=${edge.address}${e.path ?? ""}`);
      continue;
    }
    envVars.push(`${e.name}=${e.value}`);
  }
  if (envVars.length > 0) {
    lines.push(`    environment:`);
    for (const e of envVars) lines.push(`      - ${JSON.stringify(e)}`);
  }
  lines.push(``);
}

/**
 * The header lines naming each image this file cannot pin by digest, with the
 * services that run it (ADR-0083 §3). Empty when every image is pinned.
 */
function unpinnedHeader(unpinned) {
  if (unpinned.size === 0) return [];
  return [
    `#`,
    `# Not pinned by digest, so each runs whatever its tag names when compose starts it (ADR-0083):`,
    ...[...unpinned].map(([image, services]) => `#   - ${image} (${services.join(", ")})`),
    `# \`cloister cluster resolve\` pins an image that names a registry. A bare name is a local build,`,
    `# which a committed file cannot pin.`,
  ];
}

// ── CLI ──────────────────────────────────────────────────────────────────

export function parseOciPins(lockText) {
  return ociPins(parseToml(lockText));
}

export async function main(_argv = process.argv.slice(2), deps = {}) {
  const env = deps.env ?? process.env;
  const log = deps.log ?? console.log;
  const errLog = deps.errLog ?? console.error;
  const INPUT_PATH = env.CLUSTER_TS ?? resolve(REPO, "src/generated/cluster.ts");
  const OUTPUT = env.COMPOSE_OUTPUT ?? resolve(REPO, "cluster.compose.yaml");

  if (!existsSync(INPUT_PATH)) {
    errLog("emit-compose: failed to load cluster manifest");
    errLog(`  tried: ${INPUT_PATH}`);
    errLog("  run `cloister cluster generate` first");
    return 1;
  }

  let mod;
  try {
    mod = await tsImport(pathToFileURL(INPUT_PATH).href, { parentURL: import.meta.url });
  } catch (error) {
    errLog("emit-compose: failed to import cluster manifest");
    errLog(error?.message ?? error);
    return 1;
  }
  const cluster = mod.cluster;

  // Validate via the hand-authored validator. Imported lazily so the
  // pure-function path above stays import-free.
  const { validateCluster } = await tsImport(
    pathToFileURL(resolve(REPO, "src/manifest/cluster-types.ts")).href,
    { parentURL: import.meta.url },
  );
  validateCluster(cluster);

  // ADR-0038: load each input's self-declared oci image from the lockfile
  // (resolve-inputs records packages[].oci there). Absent lockfile / no oci
  // → empty map → emitCompose falls back to the operator's ext.image as
  // before (fully back-compat).
  let ociByInput = new Map();
  let ociByBundle = new Map();
  let images = new Map();
  const LOCKFILE = env.CLOISTER_LOCKFILE ?? resolve(REPO, "cluster.lock.toml");
  if (existsSync(LOCKFILE)) {
    try {
      ({ ociByInput, ociByBundle, images } = parseOciPins(readFileSync(LOCKFILE, "utf8")));
    } catch (e) {
      errLog(`emit-compose: could not read oci packages from ${LOCKFILE}: ${e.message}`);
    }
  }

  let body;
  try {
    body = emitCompose(cluster, ociByInput, { doBindPath: env.CLOISTER_DO_BIND || "", ociByBundle, images });
  } catch (e) {
    errLog(e.message);
    return 1;
  }

  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeGeneratedFile(OUTPUT, body);
  const rel = OUTPUT.replace(REPO + "/", "");
  log(`emit-compose: wrote ${rel}`);
  const externalCount = cluster.bundles.filter((b) => "external" in b.kind).length;
  const inputCount = (cluster.inputs ?? []).length;
  log(
    `emit-compose:   ${externalCount} external bundle(s)` +
      (inputCount > 0 ? `, ${inputCount} input(s) co-located by tenancy` : ""),
  );
  return 0;
}

const invokedDirectly = startedAsScript(import.meta.url);
if (invokedDirectly) {
  process.exitCode = await main();
}
