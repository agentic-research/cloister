// Contract tests for the package-level `cloister` command dispatcher.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";

import { main as cliMain } from "../../cli/index.mjs";

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

function fakeRuntimeSource() {
  return `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
writeFileSync(process.env.RUNTIME_ARGV_RECORD, JSON.stringify(argv));
const storage = {
  schema: "cloister/runtime-storage-status/v1",
  provider: "compatibility",
  maturity: "experimental",
  state: "notPrepared",
  backend: "krunvmCompatibility",
  storageVolume: "/Volumes/krunvm",
  capacity: null,
  trackedRuns: 0,
  runningRuns: 0,
};
if (argv[0] === "status") console.log(JSON.stringify(storage));
if (argv[0] === "doctor") console.log(JSON.stringify({
  schema: "cloister/host-runtime/doctor/v1",
  process: { available: false },
  microvm: { available: false, krunvm: false, buildah: false },
  storage,
}));
`;
}

test("top-level help names the real command surface", () => {
  const r = run(["--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /cloister init/);
  assert.match(r.stdout, /cloister add/);
  assert.match(r.stdout, /cloister artifacts pull/);
  assert.match(r.stdout, /cloister runtime plan/);
  assert.match(r.stdout, /cloister runtime storage init/);
  assert.match(r.stdout, /--color <auto\|always\|never>/);
  assert.match(r.stdout, /--no-color/);
});

test("LLO storage init provisions over UDS without invoking the krunvm helper", async () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const output = [];
  stdout.on("data", (chunk) => output.push(chunk.toString()));
  const status = await cliMain(
    ["runtime", "storage", "init", "--backend", "microVm", "--idempotency-key", "p-1"],
    {
      env: { CLOISTER_LLO_CONTROL_SOCKET: "/run/llo.sock" },
      stdout,
      stderr,
      lloProvision: async (...args) => {
        assert.deepEqual(args.slice(0, 3), ["/run/llo.sock", "microVm", "p-1"]);
        return { provisioned: true };
      },
    },
  );
  assert.equal(status, 0);
  assert.deepEqual(JSON.parse(output.join("")), { provisioned: true });
});

test("invalid global color values fail with usage before command dispatch", () => {
  const r = run(["skills", "--color", "sometimes", "list"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--color requires one of: auto, always, never/);
});

test("global color mode applies after the command name", () => {
  const colored = run(["artifacts", "--color", "always", "pull", "--print"]);
  assert.equal(colored.status, 0, colored.stderr);
  assert.match(colored.stdout, /\x1b\[/);

  const plain = run(["artifacts", "--color", "never", "pull", "--print"]);
  assert.equal(plain.status, 0, plain.stderr);
  assert.doesNotMatch(plain.stdout, /\x1b\[/);
});

test("runtime operator commands delegate exact arguments to one Rust seam", () => {
  const temp = mkdtempSync(resolve(tmpdir(), "cloister-runtime-cli-"));
  const record = resolve(temp, "argv.json");
  const fake = resolve(temp, "fake-runtime.mjs");
  writeFileSync(fake, fakeRuntimeSource());
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

test("runtime command names the first-party install command when no provider exists", () => {
  const temp = mkdtempSync(resolve(tmpdir(), "cloister-runtime-missing-"));
  const result = run(["runtime", "doctor"], {
    CLOISTER_LIBEXEC_DIR: temp,
    CLOISTER_HOST_RUNTIME_BIN: "",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /The execution runtime is not installed/);
  assert.match(result.stderr, /cloister runtime install/);
  assert.doesNotMatch(result.stderr, /task |runtime:build|rs\/target/);
});

test("runtime help is available before the provider is installed", () => {
  const temp = mkdtempSync(resolve(tmpdir(), "cloister-runtime-help-"));
  const result = run(["runtime", "doctor", "--help"], {
    CLOISTER_LIBEXEC_DIR: temp,
    CLOISTER_HOST_RUNTIME_BIN: "",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: cloister runtime doctor/);
  assert.doesNotMatch(result.stderr, /runtime install|not installed/i);
});

test("runtime command executes the digest-verified provider artifact", () => {
  const temp = mkdtempSync(resolve(tmpdir(), "cloister-runtime-provider-"));
  const record = resolve(temp, "argv.json");
  const fake = resolve(temp, "cloister-host-runtime");
  writeFileSync(fake, fakeRuntimeSource());
  chmodSync(fake, 0o755);
  const digest = createHash("sha256").update(readFileSync(fake)).digest("hex");
  mkdirSync(temp, { recursive: true });
  writeFileSync(resolve(temp, "runtime-provider.json"), JSON.stringify({
    schema: "cloister/runtime-provider/v1",
    provider: "compatibility",
    maturity: "experimental",
    transport: "subprocess",
    apiVersion: "cloister/compatibility-runtime/v1",
    backends: ["nativeNonoCompatibility", "krunvmCompatibility"],
    artifacts: {
      nativeHelper: { file: "cloister-host-runtime", sha256: digest },
      hostRuntime: { file: "cloister-host-runtime", sha256: digest },
    },
  }));

  const result = run(["runtime", "doctor"], {
    CLOISTER_LIBEXEC_DIR: temp,
    CLOISTER_HOST_RUNTIME_BIN: "",
    RUNTIME_ARGV_RECORD: record,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(record, "utf8")), ["doctor"]);
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
