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
import { main as runtimeMain } from "../../cli/commands/runtime.mjs";

function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "cloister-provider-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

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
    spawn: fakeCargo(root, calls),
    platform: "darwin",
  });

  assert.deepEqual(calls, [
    ["cargo", "build", "--release", "--manifest-path", "tools/harness-sandbox/Cargo.toml"],
    ["cargo", "build", "--release", "--manifest-path", "rs/Cargo.toml", "-p", "cloister-host-runtime"],
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
  await installCompatibilityProvider({ root, layout, spawn: fakeCargo(root, []) });
  writeFileSync(layout.hostRuntime, "tampered\n");

  const record = readProviderRecord(layout);
  assert.throws(
    () => resolveProviderArtifact(record, "hostRuntime"),
    /digest mismatch.*hostRuntime/i,
  );
});

test("provider selection rejects a record that changes the named compatibility contract", async (t) => {
  const root = tempRoot(t);
  const layout = resolveInstallLayout({
    env: { CLOISTER_LIBEXEC_DIR: join(root, "libexec") },
    home: root,
    checkoutRoot: root,
  });
  await installCompatibilityProvider({ root, layout, spawn: fakeCargo(root, []) });
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
  await installCompatibilityProvider({ root, layout, spawn: fakeCargo(root, []) });
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
