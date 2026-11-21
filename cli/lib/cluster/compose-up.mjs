// SPDX-License-Identifier: AGPL-3.0-or-later
//
// cli/lib/cluster/compose-up.mjs — `cloister cluster up` without --env: the
// compose run, with every image resolved when it starts (ADR-0083 §4).
//
// The committed cluster.compose.yaml is started as it is, with one override
// file beside it. The override names each service's image by a content
// address and records that address on the container. Nothing else in the
// committed file changes, and the first file keeps the cluster root as the
// project directory, so relative paths and `.env` mean what they meant.
// Every compose implementation merges `-f` files, so nothing here depends on
// one of them.
//
// Each image, in order:
//   1. One the compose file writes by digest (cluster.toml's own, or the
//      lock's pin) runs as written, pulled by that digest when it is missing.
//   2. One the engine holds runs by what it holds. That is its registry digest
//      when it came from that repository, and otherwise its image ID, under a
//      tag made from the ID, so a rebuild while compose starts cannot change
//      what runs. ko (`ko.local/…:<digest>`) and Tilt (`:tilt-<hash>`) tag
//      local builds the same way.
//   3. One that names a registry is pulled, with the engine's own
//      credentials, and then runs by its registry digest.
//   4. A bare name the engine does not hold is refused by name, and never
//      pulled. Docker would fetch Docker Hub's `library/<name>`, an image
//      anyone could publish.
// The emitter writes `pull_policy: never`, so compose itself pulls nothing.
//
// The record lives on the container, in labels, so `up` keeps no state file
// (the microVM `up` keeps none either):
//   - `cloister.image`: the image as the compose file names it;
//   - `cloister.image.digest`: the content address that ran;
//   - `cloister.image.by`: how it was resolved.
// The next `up` reads them back, prints each digest that moved, and removes
// the tag the previous local build ran under.

import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { isSha256Digest, parseImageRef } from "../oci-artifact.mjs";

/** The labels a run records on each container. */
export const IMAGE_LABELS = Object.freeze({
  image: "cloister.image",
  digest: "cloister.image.digest",
  by: "cloister.image.by",
});

/** Compose's own label naming a container's project; every implementation here writes it. */
const PROJECT_LABEL = "com.docker.compose.project";
const SERVICE_LABEL = "com.docker.compose.service";

/**
 * The container engine whose image store compose starts from. `CONTAINER_CMD`
 * names it when set, as it does for `cloister artifacts pull`. Otherwise it is
 * the engine the compose command drives: `docker compose` → docker,
 * `docker-compose` → docker.
 */
export function engineFor(compose, env = {}) {
  if (env.CONTAINER_CMD) return env.CONTAINER_CMD;
  const name = basename(compose[0]);
  return name.endsWith("-compose") ? name.slice(0, -"-compose".length) : compose[0];
}

/**
 * The tag a local build runs under: its image ID, so the tag names exactly one
 * set of bytes. `cloister:0.1.0` with ID `sha256:ab…` runs as
 * `cloister:sha256-ab…`.
 */
export function contentTag(ref, id) {
  const { registry, repository } = parseImageRef(ref);
  return `${registry ? `${registry}/` : ""}${repository}:${id.replace(":", "-")}`;
}

/** An image ID as a content address. Podman prints the hex alone. */
function imageId(raw) {
  const id = typeof raw === "string" && /^[0-9a-f]{64}$/.test(raw) ? `sha256:${raw}` : raw;
  return isSha256Digest(id) ? id : null;
}

/** The engine's last words, for a refusal: its stderr, trimmed to a line or two. */
function said(result) {
  const text = String(result.stderr || result.error?.message || "").trim().split("\n").slice(-2).join(" ");
  return text === "" ? "" : ` (${text})`;
}

/** Run a command and collect its output; never throws. */
export function execCollect(bin, args) {
  const r = spawnSync(bin, args, { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error ?? null };
}

/**
 * What the engine holds under `ref`: its image ID and the registry digests it
 * knows it by. Null, with the engine's words, when it holds nothing by that
 * name or cannot be asked.
 */
export function inspectImage(exec, engine, ref) {
  const r = exec(engine, ["image", "inspect", ref]);
  if (r.status !== 0) return { held: null, said: said(r) };
  let rows;
  try {
    rows = JSON.parse(r.stdout);
  } catch (error) {
    return { held: null, said: ` (its image inspect output is not JSON: ${error.message})` };
  }
  const row = Array.isArray(rows) ? rows[0] : null;
  const id = imageId(row?.Id ?? row?.ID);
  if (!id) return { held: null, said: ` (it reported no sha256 image ID for ${ref})` };
  const repoDigests = Array.isArray(row.RepoDigests) ? row.RepoDigests.filter((d) => typeof d === "string") : [];
  return { held: { id, repoDigests }, said: "" };
}

/** The registry digest the engine knows `ref` by, when it came from that repository. */
function registryDigest(ref, repoDigests) {
  const { registry, repository } = parseImageRef(ref);
  const name = registry ? `${registry}/${repository}` : repository;
  for (const entry of repoDigests) {
    const at = entry.lastIndexOf("@");
    if (at > 0 && entry.slice(0, at) === name && isSha256Digest(entry.slice(at + 1))) return entry.slice(at + 1);
  }
  return null;
}

/**
 * The services cluster.compose.yaml starts, with each one's image, and its
 * project name.
 *
 * @returns {{project: string|null, services: Array<{service: string, image: string}>}}
 */
export function composeServices(text) {
  const doc = parseYaml(text) ?? {};
  const services = Object.entries(doc.services ?? {})
    .filter(([, spec]) => typeof spec?.image === "string" && spec.image.trim() !== "")
    .map(([service, spec]) => ({ service, image: spec.image.trim() }))
    .sort((a, b) => (a.service < b.service ? -1 : a.service > b.service ? 1 : 0));
  return { project: typeof doc.name === "string" && doc.name !== "" ? doc.name : null, services };
}

/** An image by its digest alone, for asking the engine about it: `name@sha256:…`. */
function byDigest(image) {
  const { registry, repository, digest } = parseImageRef(image);
  return `${registry ? `${registry}/` : ""}${repository}@${digest}`;
}

/**
 * Resolve every image a run is about to start (ADR-0083 §4).
 *
 * The emitter writes `pull_policy: never`, so compose starts only what the
 * engine already holds, and cloister fetches what it may:
 *   - an image written by digest is pulled by that digest when it is missing,
 *     since a digest names exactly one set of bytes;
 *   - an image that names a registry is pulled by its tag, with the engine's
 *     own credentials, and then runs by the digest the engine records;
 *   - a bare name is never pulled.
 *
 * Every image is inspected before anything changes. A bare name the engine
 * does not hold is refused by name, and then nothing is pulled or tagged for
 * any service. Pulls come next, and last each local build is tagged by its ID.
 *
 * @returns {{resolved: Array<{service, image, run, digest, by}>, failures: string[]}}
 */
export function resolveRunImages(services, { exec, engine }) {
  const failures = [];
  const plan = [];
  for (const { service, image } of services) {
    const ref = parseImageRef(image);
    const asked = ref.digest ? byDigest(image) : image;
    const { held, said: why } = inspectImage(exec, engine, asked);
    if (held || ref.digest || ref.registry) {
      plan.push({ service, image, ref, asked, held });
      continue;
    }
    const hub = ref.repository.includes("/") ? ref.repository : `library/${ref.repository}`;
    failures.push(
      `image ${image} (service ${service}) is not on this machine${why}. It is a bare name, so cloister ` +
      `does not pull it: ${engine} would fetch Docker Hub's ${hub}, an image anyone could publish. ` +
      `Build it here, or name the registry it comes from (ADR-0083 §4)`,
    );
  }
  if (failures.length > 0) return { resolved: [], failures };

  const pulled = new Map();
  for (const step of plan) {
    if (step.held) continue;
    if (!pulled.has(step.asked)) {
      const pull = exec(engine, ["pull", "--quiet", step.asked]);
      pulled.set(step.asked, pull.status === 0 ? inspectImage(exec, engine, step.asked) : { held: null, said: said(pull) });
    }
    const after = pulled.get(step.asked);
    if (after.held) step.held = after.held;
    else failures.push(`image ${step.image} (service ${step.service}) could not be pulled as ${step.asked}${after.said}`);
  }
  if (failures.length > 0) return { resolved: [], failures };

  const resolved = [];
  for (const { service, image, ref, held } of plan) {
    if (ref.digest) {
      resolved.push({ service, image, run: image, digest: ref.digest, by: "pinned" });
      continue;
    }
    const digest = registryDigest(image, held.repoDigests);
    if (digest) {
      // `name:tag@sha256:…`, as §1 writes a pin: the digest runs, the tag stays readable.
      resolved.push({ service, image, run: `${image}@${digest}`, digest, by: "registry" });
      continue;
    }
    const tag = contentTag(image, held.id);
    const r = exec(engine, ["tag", held.id, tag]);
    if (r.status !== 0) {
      failures.push(`image ${image} (service ${service}) could not be tagged ${tag}${said(r)}`);
      continue;
    }
    resolved.push({ service, image, run: tag, digest: held.id, by: "local" });
  }
  return failures.length > 0 ? { resolved: [], failures } : { resolved, failures };
}

/**
 * What the previous run recorded on each service's container, from its
 * labels. Best effort: a run that cannot read them still starts, and simply
 * has nothing to compare against.
 *
 * @returns {Map<string, {image: string, digest: string, by: string}>}
 */
export function previousRecords({ exec, engine, project }) {
  const records = new Map();
  if (!project) return records;
  const ps = exec(engine, ["ps", "-a", "-q", "--filter", `label=${PROJECT_LABEL}=${project}`]);
  if (ps.status !== 0) return records;
  const ids = ps.stdout.split(/\s+/).filter(Boolean);
  if (ids.length === 0) return records;
  const inspected = exec(engine, ["container", "inspect", ...ids]);
  if (inspected.status !== 0) return records;
  let rows;
  try {
    rows = JSON.parse(inspected.stdout);
  } catch {
    // lint-allow-silent: the previous record only informs what `up` prints; without it, nothing is compared.
    return records;
  }
  for (const row of Array.isArray(rows) ? rows : []) {
    const labels = row?.Config?.Labels ?? {};
    const service = labels[SERVICE_LABEL];
    const digest = labels[IMAGE_LABELS.digest];
    if (typeof service === "string" && isSha256Digest(digest)) {
      records.set(service, { image: labels[IMAGE_LABELS.image] ?? "", digest, by: labels[IMAGE_LABELS.by] ?? "" });
    }
  }
  return records;
}

/** The override that names each image by its content address and records it. */
export function runOverride(resolved) {
  const services = Object.fromEntries(resolved.map((r) => [r.service, {
    image: r.run,
    labels: [`${IMAGE_LABELS.image}=${r.image}`, `${IMAGE_LABELS.digest}=${r.digest}`, `${IMAGE_LABELS.by}=${r.by}`],
  }]));
  return [
    "# Written by `cloister cluster up` for one run, and removed when it ends (ADR-0083 §4).",
    "# Each image is named by the content address that runs, and recorded on its container.",
    stringifyYaml({ services }),
  ].join("\n");
}

const short = (digest) => digest.slice(0, "sha256:".length + 12);

/** One line per service: what it runs, how that was resolved, and what moved. */
export function describeRun(resolved, previous) {
  return resolved.map((r) => {
    const before = previous.get(r.service);
    const moved = before && before.digest !== r.digest ? `, moved from ${short(before.digest)}` : "";
    return `  ${r.service}: ${r.image} runs as ${short(r.digest)} (${r.by}${moved})`;
  });
}

/**
 * The tags earlier local builds ran under that no service runs under now. Each
 * is removed once compose has replaced the containers that used it; the image
 * goes with it when nothing else names it, as `docker image prune` would.
 */
export function staleTags(resolved, previous) {
  const current = new Set(resolved.map((r) => r.run));
  const stale = new Set();
  for (const r of resolved) {
    const before = previous.get(r.service);
    if (!before || before.by !== "local" || before.digest === r.digest || !before.image) continue;
    const tag = contentTag(before.image, before.digest);
    if (!current.has(tag)) stale.add(tag);
  }
  return [...stale].sort();
}

/**
 * `cloister cluster up` without --env: resolve, record and start.
 *
 * @param {{root: string, file: string, compose: string[], detach: boolean}} run
 * @returns {Promise<number>} compose's exit status, or 1 when an image cannot be resolved
 */
export async function composeUp({ root, file, compose, detach }, deps = {}) {
  const log = deps.log ?? console.log;
  const errLog = deps.errLog ?? console.error;
  const exec = deps.exec ?? execCollect;
  const spawnImpl = deps.spawn ?? nodeSpawn;
  const engine = engineFor(compose, deps.env ?? process.env);

  const { project, services } = composeServices(readFileSync(file, "utf8"));
  const previous = previousRecords({ exec, engine, project });
  const { resolved, failures } = resolveRunImages(services, { exec, engine });
  if (failures.length > 0) {
    for (const failure of failures) errLog(`cloister cluster up: ${failure}`);
    errLog("cloister cluster up: nothing was started");
    return 1;
  }

  const runDir = mkdtempSync(join(deps.tmpdir ?? tmpdir(), "cloister-up-"));
  const override = join(runDir, "images.compose.yaml");
  writeFileSync(override, runOverride(resolved), { mode: 0o600 });
  const composeArgs = ["-f", file, "-f", override, "up", ...(detach ? ["-d"] : [])];
  log("cloister cluster up: images, resolved now (ADR-0083 §4):");
  for (const line of describeRun(resolved, previous)) log(line);
  log(`cloister cluster up: ${compose.join(" ")} ${composeArgs.join(" ")}`);

  // Compose stops a foreground run on Ctrl-C. Wait for it, so the run's
  // directory is removed and old tags are cleared after it has finished.
  const hold = () => {};
  process.on("SIGINT", hold);
  process.on("SIGTERM", hold);
  const code = await new Promise((done) => {
    const child = spawnImpl(compose[0], [...compose.slice(1), ...composeArgs], { cwd: root, stdio: "inherit" });
    child.on("error", (e) => { errLog(`cloister cluster up: ${e.message}`); done(1); });
    child.on("close", (status) => done(status ?? 0));
  });
  process.off("SIGINT", hold);
  process.off("SIGTERM", hold);
  rmSync(runDir, { recursive: true, force: true });

  for (const tag of staleTags(resolved, previous)) {
    const r = exec(engine, ["image", "rm", tag]);
    if (r.status === 0) log(`cloister cluster up: removed ${tag}, which an earlier build ran under`);
    else log(`cloister cluster up: kept ${tag}${said(r)}`);
  }
  return code;
}
