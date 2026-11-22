#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// dev/compose-up-images.mjs — ADR-0083 §4 against a real engine. The unit
// tests (cli/test/cluster/compose-up.test.mjs) drive a fake one. This runs
// `cloister cluster up` against docker and checks what the containers
// actually run:
//
//   1. a local build runs by the image ID the engine holds when `up` starts
//      it, and its container records that ID beside the labels the committed
//      compose file gives it;
//   2. an image written `name:tag@sha256:…`, the form §1 writes a pin in,
//      runs by its digest;
//   3. a rebuild under the same tag is what the next `up` runs. `up` prints
//      the move, and removes the tag the old build ran under;
//   4. an `up` with nothing rebuilt leaves every container as it was;
//   5. a bare name the engine does not hold is refused by name, nothing new
//      starts, and the running containers are left alone;
//   6. `--locked` refuses a local build by name, since nothing pins it, and
//      starts a cluster whose every image is pinned by digest (ADR-0083 §5).
//
// Needs docker with the compose plugin. Run from the repository root:
// `task smoke:compose-up-images`. KEEP_CLUSTER=1 leaves the containers up.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "bin/cloister.mjs");
// The image compose-hold runs, by the digest it pins; the tag is §1's readable half.
const BASE = "mcr.microsoft.com/cbl-mariner/base/python@sha256:d1dd9c1296ec1a311efc2dd35d74a9c8f2be3c5e264d9a26c847b1123807312c";
const PINNED = BASE.replace("@", ":3@");
// Sleeps until stopped, and stops at once on SIGTERM, so a recreate takes no grace period.
const SLEEP = "import signal, sys, time; signal.signal(signal.SIGTERM, lambda *_: sys.exit(0)); time.sleep(10**9)";
const LOCAL = "cloister-up-e2e:dev";
const ABSENT = "cloister-up-e2e-absent:dev";
const PROJECT = "up-images";

const say = (line) => console.log(`compose-up-images: ${line}`);
let failed = false;
let last = null;
const fail = (line) => { console.error(`compose-up-images: FAIL: ${line}`); failed = true; };
// On a failure, show what the last `cloister cluster` run said.
const check = (ok, line) => {
  if (ok) return say(`ok    ${line}`);
  fail(line);
  if (last) console.error(`  last \`cloister cluster\` run (exit ${last.status}):\n${`${last.stdout}${last.stderr}`.replace(/^/gm, "    | ")}`);
};

const work = mkdtempSync(join(tmpdir(), "cloister-up-images-"));
const env = { ...process.env, COMPOSE_CMD: "docker compose" };
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const tryDocker = (...args) => spawnSync("docker", args, { encoding: "utf8" });
const cluster = (...args) => (last = spawnSync(process.execPath, [CLI, "cluster", ...args, "--dir", work], { encoding: "utf8", env }));
const short = (digest) => digest.slice(0, "sha256:".length + 12);

function build(variant) {
  const dockerfile = `FROM ${BASE}\nLABEL e2e.variant=${variant}\nCMD ${JSON.stringify(["python3", "-c", SLEEP])}\n`;
  execFileSync("docker", ["build", "--quiet", "--tag", LOCAL, "-"], { input: dockerfile, stdio: ["pipe", "ignore", "inherit"] });
  return docker("image", "inspect", "--format", "{{.Id}}", LOCAL);
}

function declare(appImage) {
  writeFileSync(join(work, "cluster.toml"), [
    "[metadata]", `name = "${PROJECT}"`, 'version = "0.1.0"', "", "[storage]", "",
    "[[bundles]]", 'name = "app"', 'kind = "external"', 'tier = "cluster"', "",
    // Its own command too: the base image's default exits at once, and app runs it once it is pinned.
    "[bundles.external]", `image = "${appImage}"`, `args = ${JSON.stringify(["python3", "-c", SLEEP])}`, "",
    "[[bundles]]", 'name = "pinned"', 'kind = "external"', 'tier = "cluster"', "",
    "[bundles.external]", `image = "${PINNED}"`, `args = ${JSON.stringify(["python3", "-c", SLEEP])}`, "",
  ].join("\n"));
  const r = cluster("generate");
  if (r.status !== 0) throw new Error(`cluster generate failed:\n${r.stdout}${r.stderr}`);
}

/** The service's one container, running or not: its ID, its image ID, its labels and whether it runs. */
function running(service) {
  const ids = docker("ps", "-a", "-q", "--filter", `label=com.docker.compose.project=${PROJECT}`, "--filter", `label=com.docker.compose.service=${service}`)
    .split("\n").filter(Boolean);
  if (ids.length !== 1) {
    fail(`expected one ${service} container, found ${ids.length}`);
    return null;
  }
  const [row] = JSON.parse(docker("container", "inspect", ids[0]));
  return { id: row.Id, image: row.Image, labels: row.Config.Labels ?? {}, up: row.State?.Running === true };
}

try {
  docker("pull", "--quiet", BASE);
  tryDocker("image", "rm", "--force", ABSENT);
  const baseDigest = BASE.slice(BASE.indexOf("@") + 1);
  const baseId = docker("image", "inspect", "--format", "{{.Id}}", BASE);

  // 1 and 2: the first run.
  const first = build("a");
  declare(LOCAL);
  let r = cluster("up", "-d");
  check(r.status === 0, `up starts the cluster (exit ${r.status})${r.status === 0 ? "" : `\n${r.stdout}${r.stderr}`}`);
  check(r.stdout.includes(`app: ${LOCAL} runs as ${short(first)} (image ID)`), `up names the local build's ID, ${short(first)}`);
  let app = running("app");
  check(app?.up && app.image === first, `app runs the ID the engine held when up started it (${app?.image})`);
  check(app?.labels["cloister.image.digest"] === first && app?.labels["cloister.image"] === LOCAL && app?.labels["cloister.image.by"] === "id",
    `app's container records the declared image, its ID and how it was resolved (${JSON.stringify(app?.labels)})`);
  check(app?.labels["cloister.bundle"] === "app", "the committed file's own labels are kept beside the record");
  const pinned = running("pinned");
  check(pinned?.up && pinned.image === baseId, `an image written name:tag@sha256 runs by its digest (${pinned?.image})`);
  check(pinned?.labels["cloister.image.digest"] === baseDigest && pinned?.labels["cloister.image.by"] === "pinned", "pinned's container records the digest it ran");

  // 3: a rebuild under the same tag.
  const second = build("b");
  check(second !== first, "the rebuild is a different image");
  r = cluster("up", "-d");
  check(r.status === 0, `up after a rebuild (exit ${r.status})`);
  check(r.stdout.includes(`app: ${LOCAL} runs as ${short(second)} (image ID, moved from ${short(first)})`), "up prints the move");
  app = running("app");
  check(app?.up && app.image === second, "app now runs the rebuild");
  const oldTag = `${LOCAL.split(":")[0]}:${first.replace(":", "-")}`;
  check(r.stdout.includes(`removed ${oldTag}`) && tryDocker("image", "inspect", oldTag).status !== 0, `the tag the old build ran under is gone (${oldTag})`);

  // 4: nothing rebuilt.
  const before = { app: running("app")?.id, pinned: running("pinned")?.id };
  r = cluster("up", "-d");
  check(r.status === 0 && !r.stdout.includes("moved from"), "an up with nothing rebuilt reports no move");
  const after = { app: running("app"), pinned: running("pinned") };
  check(after.app?.up && after.app.id === before.app && after.pinned?.up && after.pinned.id === before.pinned,
    `and leaves every container as it was, running (${JSON.stringify({ before, after: { app: after.app?.id, pinned: after.pinned?.id } })})`);

  // 5: a bare name the engine does not hold.
  declare(ABSENT);
  r = cluster("up", "-d");
  check(r.status === 1, `up refuses a bare name the engine does not hold (exit ${r.status})`);
  check(r.stderr.includes(`image ${ABSENT} (service app) is not on this machine`) && r.stderr.includes("nothing was started"), "the refusal names the image");
  check(tryDocker("image", "inspect", ABSENT).status !== 0, "and nothing was pulled for it");
  const left = running("app");
  check(left?.up && left.id === before.app, "the running containers are left alone");

  // 6: --locked starts only what a digest pins.
  declare(LOCAL);
  r = cluster("up", "-d", "--locked");
  check(r.status === 1 && r.stderr.includes(`image ${LOCAL} (service app) is not pinned by digest`) && r.stderr.includes("nothing was started"),
    `up --locked refuses a local build by name (exit ${r.status})`);
  const still = running("app");
  check(still?.up && still.id === before.app, "and leaves the running containers alone");
  declare(PINNED);
  r = cluster("up", "-d", "--locked");
  check(r.status === 0, `up --locked starts a cluster whose every image is pinned by digest (exit ${r.status})`);
  app = running("app");
  check(app?.up && app.image === baseId && app.labels["cloister.image.by"] === "pinned", "and app runs the pinned digest");
} catch (error) {
  fail(error.message);
} finally {
  if (process.env.KEEP_CLUSTER === "1") {
    say(`left up: ${work}`);
  } else {
    cluster("down");
    for (const row of tryDocker("image", "ls", "--format", "{{.Repository}}:{{.Tag}}", LOCAL.split(":")[0]).stdout.split("\n").filter(Boolean)) {
      tryDocker("image", "rm", row);
    }
    rmSync(work, { recursive: true, force: true });
  }
}

if (failed) process.exit(1);
say("PASS: cluster up runs each image by the content address it resolved when it started it (ADR-0083 §4)");
