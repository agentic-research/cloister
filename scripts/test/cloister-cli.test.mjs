// Contract tests for the package-level `cloister` command dispatcher.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const PACKAGE = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"));
const CLI = resolve(REPO_ROOT, PACKAGE.bin.cloister);

test("the installed command enters through the product-owned CLI tree", () => {
  assert.equal(PACKAGE.bin.cloister, "./bin/cloister.mjs");
  assert.match(
    readFileSync(resolve(REPO_ROOT, "bin/cloister.mjs"), "utf8"),
    /\.\.\/cli\/index\.mjs/,
  );
});

function run(args, env = {}) {
  return spawnSync("node", [CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("top-level help names the real command surface", () => {
  const r = run(["--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /cloister init/);
  assert.match(r.stdout, /cloister add/);
  assert.match(r.stdout, /cloister artifacts pull/);
  assert.match(r.stdout, /cloister runtime plan/);
  assert.match(r.stdout, /cloister runtime storage init/);
});

test("runtime operator commands delegate exact arguments to one Rust seam", () => {
  const temp = mkdtempSync(resolve(tmpdir(), "cloister-runtime-cli-"));
  const record = resolve(temp, "argv.json");
  const fake = resolve(temp, "fake-runtime.mjs");
  writeFileSync(
    fake,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.RUNTIME_ARGV_RECORD, JSON.stringify(process.argv.slice(2)));
process.exit(0);
`,
  );
  chmodSync(fake, 0o755);
  const env = {
    CLOISTER_HOST_RUNTIME_BIN: fake,
    RUNTIME_ARGV_RECORD: record,
  };
  const cases = [
    [["runtime", "run", "/tmp/plan.json"], ["run", "/tmp/plan.json"]],
    [["runtime", "doctor"], ["doctor"]],
    [["runtime", "storage", "status"], ["status"]],
    [["runtime", "storage", "gc", "--yes"], ["gc", "--yes"]],
  ];
  for (const [args, expected] of cases) {
    const result = run(args, env);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(record, "utf8")), expected);
  }
});

test("runtime command never falls back when the configured binary is missing", () => {
  const result = run(["runtime", "doctor"], {
    CLOISTER_HOST_RUNTIME_BIN: "/missing/cloister-host-runtime",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /CLOISTER_HOST_RUNTIME_BIN/);
});

// Sparsebundles are an APFS/hdiutil concept, so this subcommand is macOS-only
// by design. Assert the branch this host actually takes rather than skipping
// off macOS: asserting nothing on Linux is exactly what let the unconditional
// `status === 0` below pass on dev machines and fail on CI.
test("runtime storage init previews on macOS and refuses elsewhere", () => {
  const r = run(["runtime", "storage", "init", "--print"]);
  if (process.platform === "darwin") {
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /krunvm storage plan/);
    assert.match(r.stdout, /host storage unchanged/);
  } else {
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /macOS-only/);
  }
});

test("unknown top-level command fails with usage", () => {
  const r = run(["surprise"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown command/);
});

test("artifacts pull dispatches to the lockfile-backed preview", () => {
  const r = run(["artifacts", "pull", "--print"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Artifacts requested by cluster\.lock\.toml/);
  assert.match(r.stdout, /mache.*sha256:/);
});

test("runtime plan emits the digest-pinned Mache microVM contract", () => {
  const r = run(["runtime", "plan", "mache", "--workspace", REPO_ROOT]);
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(r.stdout);
  assert.equal(plan.bundle, "mache");
  assert.equal(plan.mode, "microvm");
  assert.equal(plan.artifact.entrypoint, "/usr/local/bin/mache");
  assert.match(plan.artifact.digest, /^sha256:[0-9a-f]{64}$/);
});
