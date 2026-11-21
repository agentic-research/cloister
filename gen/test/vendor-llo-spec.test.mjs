// SPDX-License-Identifier: AGPL-3.0-or-later
//
// gen/vendor-llo-spec.mjs copies ley-line-open's spec files into cloister. The
// comparison against LLO itself runs in CI's llo-checked job, against a clone
// at the pinned tag. These run everywhere, with no LLO checkout: the shipped
// fixtures agree with the vendoring table and their own digests, and the
// vendoring logic does what it says against a stand-in repository.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { LLO_SPECS, parseVectors, pinnedTag, vendorLloSpecs, vendoredFrom } from "../vendor-llo-spec.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Every file under `dir`, relative to it. */
function filesUnder(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path).map((p) => join(name, p)) : [name];
  });
}

test("each vendored directory holds exactly the files the table lists, each at its digest, from the pinned release", () => {
  for (const { spec, into, files } of LLO_SPECS) {
    const dir = resolve(ROOT, into);
    const text = readFileSync(join(dir, "VECTORS.sha256"), "utf8");
    assert.equal(vendoredFrom(text)?.tag, pinnedTag(), `${into} is headed by the pinned release`);
    const rows = parseVectors(text);
    assert.deepEqual(rows.map((r) => r.path), files, `${into}/VECTORS.sha256 lists the table's files for ${spec}`);
    for (const r of rows) assert.equal(sha256(readFileSync(join(dir, r.path))), r.sha256, `${into}/${r.path}`);
    const present = filesUnder(dir).filter((f) => f !== "VECTORS.sha256" && f !== "README.md").sort();
    assert.deepEqual(present, [...files].sort(), `${into} holds nothing the table does not list`);
  }
});

/** A stand-in for ley-line-open: one spec, one tagged release. */
function standIn({ tamper = false } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "llo-standin-"));
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } });
  git("init", "-q");
  const spec = join(repo, "rs/ll-core/schema-spec/demo/v1");
  mkdirSync(join(spec, "test-vectors"), { recursive: true });
  const vector = '{"case":"one"}\n';
  writeFileSync(join(spec, "test-vectors/one.json"), vector);
  writeFileSync(join(spec, "schema.json"), '{"type":"object"}\n');
  // LLO's own digest list covers the vector, not the schema, as confinement/v1's does.
  writeFileSync(join(spec, "VECTORS.sha256"), `${tamper ? "0".repeat(64) : sha256(Buffer.from(vector))}  test-vectors/one.json\n`);
  git("add", "-A");
  git("commit", "-q", "-m", "release");
  git("tag", "v9.9.9");
  return { repo, commit: git("rev-parse", "HEAD").trim() };
}

const DEMO = [{ spec: "demo/v1", into: "fixtures/llo-demo-v1", files: ["schema.json", "test-vectors/one.json"] }];

test("it writes each file from the release's commit, headed by the release, and --check then agrees", () => {
  const { repo, commit } = standIn();
  const root = mkdtempSync(join(tmpdir(), "llo-vendored-"));
  const opts = { tag: "v9.9.9", commit, root, specs: DEMO, net: false };
  const first = vendorLloSpecs(repo, opts);
  assert.deepEqual(first.written.sort(), ["fixtures/llo-demo-v1/VECTORS.sha256", "fixtures/llo-demo-v1/schema.json", "fixtures/llo-demo-v1/test-vectors/one.json"]);
  const vectors = readFileSync(join(root, "fixtures/llo-demo-v1/VECTORS.sha256"), "utf8");
  assert.deepEqual(vendoredFrom(vectors), { tag: "v9.9.9", commit });
  assert.deepEqual(vendorLloSpecs(repo, { ...opts, check: true }).differs, []);
  assert.deepEqual(vendorLloSpecs(repo, opts).written, [], "a second run writes nothing");
});

test("--check names a vendored file that is not the release's", () => {
  const { repo, commit } = standIn();
  const root = mkdtempSync(join(tmpdir(), "llo-vendored-"));
  const opts = { tag: "v9.9.9", commit, root, specs: DEMO, net: false };
  vendorLloSpecs(repo, opts);
  writeFileSync(join(root, "fixtures/llo-demo-v1/schema.json"), '{"type":"string"}\n');
  assert.deepEqual(vendorLloSpecs(repo, { ...opts, check: true }).differs, ["fixtures/llo-demo-v1/schema.json"]);
});

test("a file that does not match LLO's own VECTORS.sha256 is refused, not vendored", () => {
  const { repo, commit } = standIn({ tamper: true });
  const root = mkdtempSync(join(tmpdir(), "llo-vendored-"));
  assert.throws(() => vendorLloSpecs(repo, { tag: "v9.9.9", commit, root, specs: DEMO, net: false }), /demo\/v1\/test-vectors\/one\.json at v9\.9\.9 does not match LLO's own VECTORS\.sha256/);
  assert.deepEqual(filesUnder(root).map((f) => relative(root, join(root, f))), [], "nothing was written");
});

test("a malformed VECTORS.sha256 line is an error, not a shorter list", () => {
  assert.throws(() => parseVectors("abc  file\n"), /unparseable VECTORS\.sha256 line/);
  assert.deepEqual(parseVectors(`# header\n\n${"a".repeat(64)}  x.json\n`), [{ sha256: "a".repeat(64), path: "x.json" }]);
});
