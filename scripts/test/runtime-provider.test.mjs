// SPDX-License-Identifier: AGPL-3.0-or-later

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { resolveInstallLayout } from "../../cli/lib/install-layout.mjs";
import {
  readProviderRecord,
  resolveProviderArtifact,
} from "../../cli/lib/runtime/provider-record.mjs";
import { installCompatibilityProvider } from "../../cli/lib/runtime/install-compatibility.mjs";
import { hostRuntimeEnv } from "../../cli/lib/runtime/compatibility-client.mjs";
import { resolveMicrovm } from "../../cli/lib/runtime/provider-record.mjs";
import { main as runtimeMain } from "../../cli/commands/runtime.mjs";
import { resolveNativeHelper } from "../../cli/lib/harness/launch.mjs";

function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "cloister-provider-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** Pre-991e65 tests are about the two cargo-built artifacts. Without this they
 * would reach for the real libkrunfw and the real LLO release on a darwin-arm64
 * host, and pass or fail by machine. */
const NO_MICROVM = { findLibkrunfw: () => null };

function fakeCargo(root, calls, { failHost = false } = {}) {
  return async (command, args, options) => {
    calls.push([command, ...args]);
    assert.equal(options.cwd, root);
    if (args.includes("tools/harness-sandbox/Cargo.toml")) {
      const output = join(root, "tools/harness-sandbox/target/release/cloister-harness");
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, "native helper\n");
      chmodSync(output, 0o755);
      return { status: 0 };
    }
    if (args.includes("rs/Cargo.toml")) {
      if (failHost) return { status: 1 };
      const output = join(root, "rs/target/release/cloister-host-runtime");
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, "host runtime\n");
      chmodSync(output, 0o755);
      return { status: 0 };
    }
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };
}

test("install layout has stable XDG-like defaults and explicit overrides", () => {
  const layout = resolveInstallLayout({
    env: {},
    home: "/home/example",
    checkoutRoot: "/src/cloister",
  });
  assert.deepEqual(layout, {
    checkoutRoot: "/src/cloister",
    binDir: "/home/example/.local/bin",
    cliLink: "/home/example/.local/bin/cloister",
    libexecDir: "/home/example/.local/libexec/cloister",
    providerRecord: "/home/example/.local/libexec/cloister/runtime-provider.json",
    nativeHelper: "/home/example/.local/libexec/cloister/cloister-harness",
    hostRuntime: "/home/example/.local/libexec/cloister/cloister-host-runtime",
    krunWorker: "/home/example/.local/libexec/cloister/leyline-krun-worker",
    stateDir: "/home/example/.local/state/cloister",
    casRoot: "/home/example/.local/state/cloister/cas",
    runRoot: "/home/example/.local/state/cloister/run",
  });

  const overridden = resolveInstallLayout({
    env: { CLOISTER_BIN_DIR: "/opt/bin", CLOISTER_LIBEXEC_DIR: "/opt/libexec" },
    home: "/ignored",
    checkoutRoot: "/src/cloister",
  });
  assert.equal(overridden.cliLink, "/opt/bin/cloister");
  assert.equal(overridden.providerRecord, "/opt/libexec/runtime-provider.json");
});

test("compatibility install copies both binaries and writes the provider record last", async (t) => {
  const root = tempRoot(t);
  const layout = resolveInstallLayout({
    env: {
      CLOISTER_BIN_DIR: join(root, "installed/bin"),
      CLOISTER_LIBEXEC_DIR: join(root, "installed/libexec"),
    },
    home: root,
    checkoutRoot: root,
  });
  const calls = [];

  const installed = await installCompatibilityProvider({
    root,
    layout,
    spawn: fakeCargo(root, calls), ...NO_MICROVM,
    platform: "darwin",
  });

  assert.deepEqual(calls, [
    ["cargo", "build", "--release", "--manifest-path", "tools/harness-sandbox/Cargo.toml"],
    ["cargo", "build", "--release", "--manifest-path", "rs/Cargo.toml", "-p", "cloister-host-runtime", "--features", "llo-execution"],
  ]);
  assert.equal(installed.schema, "cloister/runtime-provider/v1");
  assert.equal(installed.provider, "compatibility");
  assert.equal(installed.maturity, "experimental");
  assert.ok(existsSync(layout.providerRecord));

  const fromDisk = readProviderRecord(layout);
  assert.equal(resolveProviderArtifact(fromDisk, "nativeHelper"), layout.nativeHelper);
  assert.equal(resolveProviderArtifact(fromDisk, "hostRuntime"), layout.hostRuntime);
  assert.match(fromDisk.artifacts.nativeHelper.sha256, /^[0-9a-f]{64}$/);
  assert.match(fromDisk.artifacts.hostRuntime.sha256, /^[0-9a-f]{64}$/);
});

test("provider resolution refuses a binary whose bytes changed after install", async (t) => {
  const root = tempRoot(t);
  const layout = resolveInstallLayout({
    env: { CLOISTER_LIBEXEC_DIR: join(root, "libexec") },
    home: root,
    checkoutRoot: root,
  });
  await installCompatibilityProvider({ root, layout, spawn: fakeCargo(root, []), ...NO_MICROVM });
  writeFileSync(layout.hostRuntime, "tampered\n");

  const record = readProviderRecord(layout);
  assert.throws(
    () => resolveProviderArtifact(record, "hostRuntime"),
    /digest mismatch.*hostRuntime/i,
  );
});

test("confined harness launch resolves the native helper from the installed provider", async (t) => {
  const root = tempRoot(t);
  const env = { CLOISTER_LIBEXEC_DIR: join(root, "libexec") };
  const layout = resolveInstallLayout({ env, home: root, checkoutRoot: root });
  await installCompatibilityProvider({ root, layout, spawn: fakeCargo(root, []), ...NO_MICROVM });

  assert.equal(resolveNativeHelper({ root, env }), layout.nativeHelper);
});

test("an explicit native-helper override fails without falling back", () => {
  assert.throws(
    () => resolveNativeHelper({
      root: "/src/cloister",
      env: { CLOISTER_HARNESS_BIN: "/missing/cloister-harness" },
      access: () => { throw new Error("not executable"); },
    }),
    /explicit override must fail closed/i,
  );
});

test("provider selection rejects a record that changes the named compatibility contract", async (t) => {
  const root = tempRoot(t);
  const layout = resolveInstallLayout({
    env: { CLOISTER_LIBEXEC_DIR: join(root, "libexec") },
    home: root,
    checkoutRoot: root,
  });
  await installCompatibilityProvider({ root, layout, spawn: fakeCargo(root, []), ...NO_MICROVM });
  const record = JSON.parse(readFileSync(layout.providerRecord, "utf8"));
  record.transport = "uds";
  writeFileSync(layout.providerRecord, JSON.stringify(record));

  assert.throws(() => readProviderRecord(layout), /transport.*subprocess/i);
});

test("a failed build never publishes a selectable provider record", async (t) => {
  const root = tempRoot(t);
  const layout = resolveInstallLayout({
    env: { CLOISTER_LIBEXEC_DIR: join(root, "libexec") },
    home: root,
    checkoutRoot: root,
  });

  await assert.rejects(
    () => installCompatibilityProvider({
      root,
      layout,
      spawn: fakeCargo(root, [], { failHost: true }),
    }),
    /cloister-host-runtime/i,
  );
  assert.equal(existsSync(layout.providerRecord), false);
});

test("the on-disk provider record contains only relative artifact names", async (t) => {
  const root = tempRoot(t);
  const layout = resolveInstallLayout({
    env: { CLOISTER_LIBEXEC_DIR: join(root, "libexec") },
    home: root,
    checkoutRoot: root,
  });
  await installCompatibilityProvider({ root, layout, spawn: fakeCargo(root, []), ...NO_MICROVM });
  const raw = JSON.parse(readFileSync(layout.providerRecord, "utf8"));
  assert.equal(raw.artifacts.nativeHelper.file, "cloister-harness");
  assert.equal(raw.artifacts.hostRuntime.file, "cloister-host-runtime");
});

test("cloister runtime install selects the named compatibility provider", async (t) => {
  const root = tempRoot(t);
  const calls = [];
  const logs = [];
  const status = await runtimeMain(["install"], {
    root,
    env: {
      CLOISTER_BIN_DIR: join(root, "bin"),
      CLOISTER_LIBEXEC_DIR: join(root, "libexec"),
    },
    log: (line) => logs.push(line),
    errLog: (line) => logs.push(`ERR:${line}`),
    installCompatibilityProvider: async (request) => {
      calls.push(request);
      return { provider: "compatibility", maturity: "experimental" };
    },
  });

  assert.equal(status, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].root, root);
  assert.equal(calls[0].layout.libexecDir, join(root, "libexec"));
  assert.match(logs.join("\n"), /compatibility.*experimental/i);
});

// ── cloister-991e65: the microVM tier is provided by install ────────────────

function microvmFixture(t) {
  const root = tempRoot(t);
  const layout = resolveInstallLayout({
    env: {
      CLOISTER_LIBEXEC_DIR: join(root, "libexec"),
      CLOISTER_STATE_DIR: join(root, "state"),
    },
    home: root,
    checkoutRoot: root,
  });
  const fetched = join(root, "download/leyline-krun-worker");
  mkdirSync(dirname(fetched), { recursive: true });
  writeFileSync(fetched, "krun worker\n");
  const firmware = join(root, "lib/libkrunfw.5.dylib");
  mkdirSync(dirname(firmware), { recursive: true });
  writeFileSync(firmware, "guest kernel\n");
  const fetches = [];
  // LLO's CasVolume::provision, as `cloister-host-runtime provision-cas`
  // returns it (cloister-727354). The real one makes an hdiutil volume.
  const volumeRoot = join(root, "state/cas-volume/mnt/cas");
  const provisions = [];
  const provisionCas = (hostRuntime, stateDir) => {
    provisions.push({ hostRuntime, stateDir });
    mkdirSync(volumeRoot, { recursive: true });
    return {
      casRoot: volumeRoot,
      mountpoint: join(root, "state/cas-volume/mnt"),
      image: join(root, "state/cas-volume/cas.sparsebundle"),
      created: true,
      attached: true,
      sizeCapBytes: 64 << 30,
      filesystem: { caseSensitive: true, normalizationSensitive: false },
    };
  };
  const deps = {
    provisionCas,
    root,
    layout,
    spawn: fakeCargo(root, []),
    platform: "darwin",
    arch: "arm64",
    env: {},
    fetchKrunWorker: async (_root, target) => { fetches.push(target); return fetched; },
    findLibkrunfw: () => firmware,
  };
  return { root, layout, firmware, fetches, deps, volumeRoot, provisions };
}

test("install provides the microVM tier: pinned worker, CAS volume, run root, recorded firmware", async (t) => {
  const { layout, firmware, fetches, deps, volumeRoot, provisions } = microvmFixture(t);
  await installCompatibilityProvider(deps);

  assert.deepEqual(fetches, ["darwin-arm64"]);
  assert.ok(existsSync(layout.krunWorker));
  // The run root sits on the same case-sensitive volume as the CAS root: an
  // ephemeral rootfs is a copy of a CAS tree.
  const runRoot = join(dirname(volumeRoot), "run");
  assert.ok(existsSync(runRoot));
  // The CAS root is the one LLO's volume returned, decided here once
  // (cloister-727354) — not the old <state>/cas directory.
  assert.deepEqual(provisions, [{ hostRuntime: layout.hostRuntime, stateDir: layout.stateDir }]);
  assert.equal(existsSync(layout.casRoot), false, "the pre-volume store is not created any more");
  const record = readProviderRecord(layout);
  assert.equal(record.microvm.krunWorker.file, "leyline-krun-worker");
  assert.equal(record.microvm.libkrunfw.path, firmware);
  assert.deepEqual(resolveMicrovm(record), {
    krunWorker: layout.krunWorker,
    libkrunfw: firmware,
    casRoot: volumeRoot,
    casStateDir: layout.stateDir,
    runRoot,
  });
});

test("install refuses a CAS root LLO reports as case-insensitive", async (t) => {
  const { layout, deps } = microvmFixture(t);
  await assert.rejects(
    installCompatibilityProvider({
      ...deps,
      provisionCas: () => ({ casRoot: "/x/cas", filesystem: { caseSensitive: false } }),
    }),
    /LLO provisioned a CAS root that is not case-sensitive/,
  );
  assert.equal(existsSync(layout.providerRecord), false);
});

test("an existing pre-volume store is neither migrated nor deleted, and re-import is named", async (t) => {
  const { layout, deps } = microvmFixture(t);
  mkdirSync(join(layout.casRoot, "abc123"), { recursive: true });
  const lines = [];
  await installCompatibilityProvider({ ...deps, log: (m) => lines.push(m) });
  assert.ok(existsSync(join(layout.casRoot, "abc123")), "the old store is left as it is");
  const text = lines.join("\n");
  assert.match(text, /The previous store .* is no longer used and was left as it is\. Re-import each microvm bundle/);
  assert.match(text, /CAS volume: .*case-sensitive; created/);
});

test("a host with no published worker installs without the tier and says why", async (t) => {
  const { layout, fetches, deps } = microvmFixture(t);
  const lines = [];
  await installCompatibilityProvider({ ...deps, platform: "linux", arch: "x64", log: (m) => lines.push(m) });
  assert.deepEqual(fetches, [], "nothing is fetched for a target LLO does not publish");
  assert.equal(readProviderRecord(layout).microvm, undefined);
  assert.match(lines.join("\n"), /microVM tier unavailable: .*darwin-arm64 only/);
});

test("no libkrunfw means no tier, with the install hint — never a guessed path", async (t) => {
  const { layout, deps } = microvmFixture(t);
  const lines = [];
  await installCompatibilityProvider({ ...deps, findLibkrunfw: () => null, log: (m) => lines.push(m) });
  assert.equal(readProviderRecord(layout).microvm, undefined);
  assert.match(lines.join("\n"), /libkrunfw not found.*brew install libkrunfw/);
});

test("a worker download that fails stops the install before any record is published", async (t) => {
  const { layout, deps } = microvmFixture(t);
  await assert.rejects(
    installCompatibilityProvider({
      ...deps,
      fetchKrunWorker: async () => { throw new Error("schema-bridge: DIGEST MISMATCH for leyline-krun-worker-darwin-arm64"); },
    }),
    /leyline-krun-worker: schema-bridge: DIGEST MISMATCH/,
  );
  assert.equal(existsSync(layout.providerRecord), false);
});

test("a swapped guest kernel or worker is refused at run time", async (t) => {
  const { layout, firmware, deps } = microvmFixture(t);
  await installCompatibilityProvider(deps);
  writeFileSync(firmware, "a different kernel\n");
  assert.throws(() => resolveMicrovm(readProviderRecord(layout)), /digest mismatch for libkrunfw/);

  writeFileSync(firmware, "guest kernel\n");
  writeFileSync(layout.krunWorker, "tampered\n");
  assert.throws(() => resolveMicrovm(readProviderRecord(layout)), /digest mismatch for krunWorker/);
});

test("the host runtime is started with the installed tier; explicit operator env wins", async (t) => {
  const { layout, firmware, deps } = microvmFixture(t);
  await installCompatibilityProvider(deps);
  const record = readProviderRecord(layout);

  const env = hostRuntimeEnv(record, { PATH: "/usr/bin" });
  assert.equal(env.CLOISTER_KRUN_WORKER, layout.krunWorker);
  assert.equal(env.CLOISTER_CAS_ROOT, readProviderRecord(layout).microvm.casRoot);
  assert.equal(env.CLOISTER_CAS_STATE_DIR, layout.stateDir, "so the host runtime can re-attach the volume");
  assert.equal(env.CLOISTER_EPHEMERAL_ROOT, readProviderRecord(layout).microvm.runRoot);
  assert.equal(env.CLOISTER_LIBKRUNFW, firmware);
  assert.equal(env.DYLD_LIBRARY_PATH, dirname(firmware));
  assert.equal(env.PATH, "/usr/bin");

  const overridden = hostRuntimeEnv(record, { CLOISTER_CAS_ROOT: "/operator/cas" });
  assert.equal(overridden.CLOISTER_CAS_ROOT, "/operator/cas");
});

test("a record without the tier leaves the environment untouched", async (t) => {
  const { layout, deps } = microvmFixture(t);
  await installCompatibilityProvider({ ...deps, findLibkrunfw: () => null });
  const env = { PATH: "/usr/bin" };
  assert.equal(hostRuntimeEnv(readProviderRecord(layout), env), env);
});

test("a half-written microvm section makes the record unselectable", async (t) => {
  const { layout, deps } = microvmFixture(t);
  await installCompatibilityProvider(deps);
  const raw = JSON.parse(readFileSync(layout.providerRecord, "utf8"));
  delete raw.microvm.libkrunfw.sha256;
  writeFileSync(layout.providerRecord, JSON.stringify(raw));
  assert.throws(() => readProviderRecord(layout), /libkrunfw\.sha256/);
});
