#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The reproducibility rail for the demo images (cloister-2af014): build both
// images from a CLEAN export of the committed tree (`git archive HEAD`, so
// nothing local leaks in), then require each image digest to equal the pin in
// every committed demo lock that names it. Exits 1 on any difference, naming
// it. Needs melange + apko (+ a container runtime for melange on macOS), so
// it is `task demo:images:check`, not part of `task lint`.
//
// Usage: node check-images.mjs [--ref <git ref>] (default HEAD)

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";

const HERE = import.meta.dirname;
const REPO = resolve(HERE, "../../..");
const refFlag = process.argv.indexOf("--ref");
const ref = refFlag >= 0 ? process.argv[refFlag + 1] : "HEAD";
if (!ref || ref.startsWith("--")) {
  console.error("check-images: --ref needs a git ref (e.g. --ref HEAD)");
  process.exit(2);
}
const LOCKS = {
  microvm: ["dolt", "orders"],
  "microvm-published": ["orders"],
};

const work = mkdtempSync(join(tmpdir(), "demo-images-"));
try {
  const tree = join(work, "tree");
  execFileSync("mkdir", ["-p", tree]);
  // A clean checkout of the committed demo: exactly what another clone builds.
  const archive = execFileSync("git", ["-C", REPO, "archive", ref, "tools/dolt-grpc-demo"]);
  execFileSync("tar", ["-xf", "-", "-C", tree], { input: archive });
  const out = join(work, "out");
  execFileSync("sh", [join(tree, "tools/dolt-grpc-demo/microvm/build-images.sh"), out], { stdio: "inherit" });

  const built = {};
  for (const image of ["dolt", "orders"]) {
    const index = JSON.parse(readFileSync(join(out, image, "index.json"), "utf8"));
    if (!Array.isArray(index.manifests) || index.manifests.length !== 1) {
      throw new Error(`${image}: expected exactly one manifest in the built index.json, found ${index.manifests?.length ?? "none"}`);
    }
    built[image] = index.manifests[0].digest;
  }
  const failures = [];
  for (const [demo, images] of Object.entries(LOCKS)) {
    const lock = parseToml(execFileSync("git", ["-C", REPO, "show", `${ref}:tools/dolt-grpc-demo/${demo}/cluster.lock.toml`], { encoding: "utf8" }));
    for (const image of images) {
      const pinned = lock.inputs?.[image]?.oci?.digest;
      const line = `${demo}/${image}: built ${built[image]}, ${demo}/cluster.lock.toml pins ${pinned}`;
      console.log(`${pinned === built[image] ? "ok  " : "DIFF"} ${line}`);
      if (pinned !== built[image]) failures.push(line);
    }
  }
  if (failures.length) {
    console.error(
      `check-images: ${failures.length} image(s) did not reproduce the committed pin. ` +
        "The digests also depend on the builder: build-images.sh refuses a melange or apko " +
        "version other than the one pinned there, but a build run as a user other than " +
        `uid 501 / gid 20 (this one: uid ${process.getuid()} / gid ${process.getgid()}) records ` +
        "different file owners (tools/dolt-grpc-demo/microvm/README.md, reproducibility " +
        "limit; cloister-426cb8).",
    );
    process.exit(1);
  }
  console.log("check-images: both images reproduce the committed pins");
} finally {
  rmSync(work, { recursive: true, force: true });
}
