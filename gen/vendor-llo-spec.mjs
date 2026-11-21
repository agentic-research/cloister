#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// gen/vendor-llo-spec.mjs — copy the ley-line-open spec files cloister tests
// against, from the release cloister pins, and check that the copies are
// still those files.
//
//   node gen/vendor-llo-spec.mjs <ley-line-open checkout>          write
//   node gen/vendor-llo-spec.mjs --check <ley-line-open checkout>  compare
//
// LLO owns these contracts (leyline-schema-spec): the confinement/v1 schema,
// execution/v1, credential-isolation/v1 and leyline-net/v1 vectors. cloister
// keeps copies so its tests run without an LLO checkout. A copy is only worth
// having while it is the pinned release's. Two of them were not: the
// confinement schema and the execution vectors were still v0.21.1's and
// v0.29.0's when cloister pinned v0.30.0, because nothing re-vendored them on a
// bump and the one check that compared them by tag ran only when an LLO
// checkout happened to sit beside cloister, which CI never has.
//
// So every copy is made here, and only here:
//
//   - each file is read from git at the pinned release's commit (`git show
//     <commit>:<path>`), never from a working tree, so the checkout may be on
//     any branch;
//   - where LLO's own VECTORS.sha256 lists a file, the file must match it;
//   - each fixture directory gets a VECTORS.sha256 of exactly what was copied,
//     headed by the release and commit it came from. The tests read their case
//     list from it, and lint:upstream-pins reads its release as a channel, so a
//     bump that skipped this fails there;
//   - `task llo:bump` runs it, and CI runs `--check` against a fresh clone of
//     LLO at the pinned tag (the llo-vendored job), so the comparison is never
//     skipped for want of a checkout.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { writeGeneratedFile } from "../cli/lib/atomic-write.mjs";
import { vendorNetVectors } from "./vendor-llo-net-vectors.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SPEC_ROOT = "rs/ll-core/schema-spec";

/**
 * Every spec cloister vendors, the files it takes, and where they go. A file
 * added to a list here is vendored on the next run; one added to a fixture
 * directory by hand is refused by the tests, which read the list from the
 * generated VECTORS.sha256.
 */
export const LLO_SPECS = Object.freeze([
  {
    spec: "confinement/v1",
    into: "test/fixtures/llo-confinement-v1",
    files: ["confinement.schema.json"],
  },
  {
    spec: "execution/v1",
    into: "test/fixtures/llo-execution-v1",
    files: [
      "test-vectors/canonical-run.json",
      "test-vectors/oci-resources.json",
      "test-vectors/rootfs-manifest.json",
      "test-vectors/run-id.json",
    ],
  },
  {
    spec: "credential-isolation/v1",
    into: "test/fixtures/llo-credential-isolation-v1",
    files: [
      "test-vectors/adversarial-credential-leak.json",
      "test-vectors/adversarial-malformed-envelope.json",
      "test-vectors/adversarial-tamper-canonical.json",
      "test-vectors/error-responses.json",
      "test-vectors/injection-collision.json",
      "test-vectors/injection-fixtures.json",
      "test-vectors/path-parsing.json",
      "test-vectors/proxy-envelope-canonical.json",
      "test-vectors/receipt-commitment.json",
      "test-vectors/reserved-response-headers.json",
    ],
  },
]);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * A VECTORS.sha256: `<64 hex>  <path>` per line; `#` comments and blank lines
 * skipped. Throws on any other line, so a malformed manifest is not read as a
 * shorter one.
 *
 * @returns {{sha256: string, path: string}[]}
 */
export function parseVectors(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t.length === 0 || t.startsWith("#")) continue;
    const m = /^([0-9a-f]{64})\s+(\S.*)$/.exec(t);
    if (!m) throw new Error(`unparseable VECTORS.sha256 line: ${line}`);
    rows.push({ sha256: m[1], path: m[2] });
  }
  return rows;
}

const HEADER = /^# ley-line-open (\S+) ([0-9a-f]{40}) /m;

/** The release a generated VECTORS.sha256 says it was vendored from, or null. */
export function vendoredFrom(text) {
  const m = HEADER.exec(text);
  return m ? { tag: m[1], commit: m[2] } : null;
}

/** The files and VECTORS.sha256 of one spec at `commit`, as they would be written. */
function render(lloRoot, entry, { tag, commit }) {
  const show = (path) => execFileSync("git", ["-C", lloRoot, "show", `${commit}:${SPEC_ROOT}/${entry.spec}/${path}`], { maxBuffer: 32 * 1024 * 1024 });
  let upstream = new Map();
  try {
    upstream = new Map(parseVectors(show("VECTORS.sha256").toString("utf8")).map((r) => [r.path, r.sha256]));
  } catch (error) {
    // lint-allow-silent: a spec with no digest list is anchored by the commit alone;
    // any other failure to read one is a real error and is rethrown.
    if (!/does not exist|exists on disk, but not in/.test(String(error.stderr ?? error.message))) throw error;
  }
  const files = {};
  for (const path of entry.files) {
    const bytes = show(path);
    const digest = sha256(bytes);
    if (upstream.has(path) && upstream.get(path) !== digest) {
      throw new Error(`vendor-llo-spec: ${entry.spec}/${path} at ${tag} does not match LLO's own VECTORS.sha256`);
    }
    files[path] = { bytes, digest };
  }
  const vectors = [
    `# ley-line-open ${tag} ${commit} ${SPEC_ROOT}/${entry.spec}`,
    "# Generated by gen/vendor-llo-spec.mjs. Do not edit: `task llo:bump` re-vendors it.",
    ...Object.entries(files).map(([path, { digest }]) => `${digest}  ${path}`),
    "",
  ].join("\n");
  return { files, vectors };
}

/**
 * Write (or, with `check`, compare) every spec's vendored copy at the pinned
 * release.
 *
 * @param {string} lloRoot a ley-line-open checkout that has `commit`
 * @param {{tag: string, commit: string, check?: boolean, dry?: boolean, root?: string, specs?: readonly object[], net?: boolean}} at
 *   `root`, `specs` and `net` exist for gen/test/vendor-llo-spec.test.mjs, which
 *   vendors from a stand-in repository into a scratch directory.
 * @returns {{written: string[], differs: string[]}} paths relative to `root`
 */
export function vendorLloSpecs(lloRoot, { tag, commit, check = false, dry = false, root = ROOT, specs = LLO_SPECS, net = true }) {
  const written = [];
  const differs = [];
  for (const entry of specs) {
    const { files, vectors } = render(lloRoot, entry, { tag, commit });
    const outputs = [
      ...Object.entries(files).map(([path, { bytes }]) => [join(entry.into, path), bytes]),
      [join(entry.into, "VECTORS.sha256"), Buffer.from(vectors)],
    ];
    for (const [rel, bytes] of outputs) {
      const abs = resolve(root, rel);
      const same = existsSync(abs) && Buffer.compare(readFileSync(abs), bytes) === 0;
      if (same) continue;
      if (check) differs.push(rel);
      else {
        if (!dry) writeGeneratedFile(abs, bytes);
        written.push(rel);
      }
    }
  }
  // The leyline-net vectors are one JSON bundle, built by their own module.
  if (net) {
    const vectors = vendorNetVectors(lloRoot, { tag, commit, dry: dry || check });
    if (!vectors.unchanged) (check ? differs : written).push("test/wire/fixtures/llo-net-vectors.json");
  }
  return { written, differs };
}

/** The ley-line-open release cloister pins: schema-bridge.lock.json's version. */
export function pinnedTag() {
  return JSON.parse(readFileSync(resolve(ROOT, "schema-bridge.lock.json"), "utf8")).version;
}

function main(argv) {
  const check = argv.includes("--check");
  const lloRoot = argv.find((a) => !a.startsWith("--"));
  if (!lloRoot) {
    console.error("usage: node gen/vendor-llo-spec.mjs [--check] <ley-line-open checkout>");
    process.exit(2);
  }
  const tag = pinnedTag();
  const commit = execFileSync("git", ["-C", lloRoot, "rev-parse", `${tag}^{commit}`], { encoding: "utf8" }).trim();
  const { written, differs } = vendorLloSpecs(lloRoot, { tag, commit, check });
  if (check) {
    for (const rel of differs) console.error(`vendor-llo-spec: ${rel} is not ley-line-open ${tag}'s. Run \`node gen/vendor-llo-spec.mjs <checkout>\` (or \`task llo:bump\`)`);
    if (differs.length) process.exit(1);
    console.log(`vendor-llo-spec: OK — every vendored file is ley-line-open ${tag}'s (${commit.slice(0, 12)})`);
    return;
  }
  console.log(`vendor-llo-spec: ${written.length ? `wrote ${written.join(", ")}` : "every vendored file already current"} (ley-line-open ${tag}, ${commit.slice(0, 12)})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
