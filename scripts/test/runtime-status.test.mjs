// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { RuntimeNotInstalledError } from "../../cli/lib/runtime/provider-record.mjs";

import { main as runtimeMain } from "../../cli/commands/runtime.mjs";
import {
  CompatibilityRuntimeError,
  runCompatibilityJson,
} from "../../cli/lib/runtime/compatibility-client.mjs";

const STATUS = {
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

test("compatibility JSON calls capture one machine-readable response", () => {
  const result = runCompatibilityJson(["status"], {
    env: { CLOISTER_HOST_RUNTIME_BIN: process.execPath },
    spawnSync: (command, args, options) => {
      assert.equal(command, process.execPath);
      assert.deepEqual(args, ["status"]);
      assert.equal(options.encoding, "utf8");
      assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
      return { status: 0, signal: null, stdout: JSON.stringify(STATUS), stderr: "" };
    },
  });

  assert.deepEqual(result.data, STATUS);
  assert.equal(result.provider, "explicit override");
});

test("compatibility JSON failures retain subprocess evidence", () => {
  assert.throws(
    () => runCompatibilityJson(["status"], {
      env: { CLOISTER_HOST_RUNTIME_BIN: process.execPath },
      spawnSync: () => ({
        status: 17,
        signal: null,
        stdout: "",
        stderr: "permission denied\n",
        error: undefined,
      }),
    }),
    (error) => {
      assert.ok(error instanceof CompatibilityRuntimeError);
      assert.equal(error.command, process.execPath);
      assert.equal(error.provider, "explicit override");
      assert.equal(error.status, 17);
      assert.equal(error.signal, null);
      assert.equal(error.stderr, "permission denied\n");
      assert.equal(error.spawnError, undefined);
      return true;
    },
  );
});

// cloister-a4e446 / cloister-727354: the compatibility provider's storage is
// the CAS volume `cloister runtime install` provisioned and recorded. Status
// reads the CAS root from the provider record and asks the host runtime's
// read-only `cas-status` about the volume.
const LAYOUT_ENV = { CLOISTER_STATE_DIR: "/state" };
const VOLUME_RECORD = { microvm: { casRoot: "/state/cas-volume/mnt/cas", casStateDir: "/state", runRoot: "/state/run" } };

test("storage status JSON reports the recorded CAS volume and whether it is case-sensitive", async () => {
  const lines = [];
  const calls = [];
  const status = await runtimeMain(["storage", "status", "--json"], {
    log: (line) => lines.push(line),
    errLog: (line) => lines.push(`ERR:${line}`),
    env: LAYOUT_ENV,
    existsSync: () => true,
    readProviderRecord: () => VOLUME_RECORD,
    runCompatibilityJson: (args) => {
      calls.push(args);
      return { data: {
        casRoot: "/state/cas-volume/mnt/cas",
        image: "/state/cas-volume/cas.sparsebundle",
        imageExists: true,
        mountpoint: "/state/cas-volume/mnt",
        attached: true,
        filesystem: { caseSensitive: true, normalizationSensitive: false },
      } };
    },
  });

  assert.equal(status, 0);
  assert.deepEqual(calls, [["cas-status", "--state-dir", "/state"]], "read-only status, never provision");
  assert.deepEqual(JSON.parse(lines[0]), {
    provider: "compatibility",
    maturity: "experimental",
    backend: "microVm",
    trackedRuns: null,
    runningRuns: null,
    state: "prepared",
    storageVolume: "/state/cas-volume/mnt/cas",
    volume: {
      image: "/state/cas-volume/cas.sparsebundle",
      mountpoint: "/state/cas-volume/mnt",
      attached: true,
      caseSensitive: true,
      normalizationSensitive: false,
    },
  });
});

test("a detached volume is not prepared, and the text says so", async () => {
  const lines = [];
  await runtimeMain(["storage", "status"], {
    log: (line) => lines.push(line),
    errLog: (line) => lines.push(`ERR:${line}`),
    env: LAYOUT_ENV,
    existsSync: () => true,
    readProviderRecord: () => VOLUME_RECORD,
    runCompatibilityJson: () => ({ data: {
      casRoot: "/state/cas-volume/mnt/cas", image: "/state/cas-volume/cas.sparsebundle",
      imageExists: true, mountpoint: "/state/cas-volume/mnt", attached: false, filesystem: null,
    } }),
  });
  const text = lines.join("\n");
  assert.match(text, /Runtime storage is not prepared\./);
  assert.match(text, /CAS volume: \/state\/cas-volume\/cas\.sparsebundle \(not attached; case-sensitive: unknown \(not attached\)\)/);
});

test("missing storage is a successful observation that names runtime install, without spawning", async () => {
  const lines = [];
  const status = await runtimeMain(["storage", "status"], {
    log: (line) => lines.push(line),
    errLog: (line) => lines.push(`ERR:${line}`),
    env: LAYOUT_ENV,
    existsSync: () => false,
    readProviderRecord: () => { throw new RuntimeNotInstalledError("not installed"); },
    runCompatibilityJson: () => { throw new Error("no record: nothing to ask the host runtime"); },
  });

  assert.equal(status, 0);
  const text = lines.join("\n");
  assert.match(text, /Runtime storage is not prepared\./);
  assert.match(text, /Provider: compatibility \(experimental\)/);
  assert.match(text, /Run: cloister runtime install/);
  assert.doesNotMatch(text, /krunvm|storage init|task /i);
});

test("LLO storage status is a read-only UDS observation", async () => {
  const lines = [];
  const status = await runtimeMain(["storage", "status", "--json"], {
    env: { CLOISTER_LLO_CONTROL_SOCKET: "/run/llo.sock" },
    log: (line) => lines.push(line),
    errLog: (line) => lines.push(`ERR:${line}`),
    lloStatus: async (socket) => {
      assert.equal(socket, "/run/llo.sock");
      return { provisioned: false, backend: "libkrun/1" };
    },
    runCompatibilityJson: () => { throw new Error("compatibility provider must not be called"); },
  });

  assert.equal(status, 0);
  assert.deepEqual(JSON.parse(lines[0]), {
    state: "notPrepared",
    provider: "llo",
    maturity: "native",
    backend: "libkrun/1",
    storageVolume: "managed by LLO",
    trackedRuns: null,
    runningRuns: null,
  });
});

test("LLO lifecycle commands use the UDS provider and explicit cancellation keys", async () => {
  const calls = [];
  const run = async (argv, method) => {
    const lines = [];
    const status = await runtimeMain(argv, {
      env: { CLOISTER_LLO_CONTROL_SOCKET: "/run/llo.sock" },
      log: (line) => lines.push(line),
      errLog: (line) => lines.push(`ERR:${line}`),
      [method]: async (...args) => {
        calls.push(args);
        return { ok: true, op: method };
      },
    });
    assert.equal(status, 0);
    assert.deepEqual(JSON.parse(lines[0]), { ok: true, op: method });
  };

  await run(["inspect", "run-1", "7"], "lloInspect");
  await run(["collect", "run-1"], "lloCollect");
  await run(["cancel", "run-1", "--idempotency-key", "cancel-1"], "lloCancel");
  await run(["cleanup", "run-1", "--idempotency-key", "cleanup-1"], "lloCleanup");
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map((args) => args.slice(0, -1)), [
    ["/run/llo.sock", "run-1", 7],
    ["/run/llo.sock", "run-1"],
    ["/run/llo.sock", "run-1", "cancel-1"],
    ["/run/llo.sock", "run-1", "cleanup-1"],
  ]);
});

test("LLO cancellation fails closed without an idempotency key", async () => {
  const lines = [];
  const status = await runtimeMain(["cancel", "run-1"], {
    env: { CLOISTER_LLO_CONTROL_SOCKET: "/run/llo.sock" },
    log: (line) => lines.push(line),
    errLog: (line) => lines.push(line),
    lloCancel: () => { throw new Error("must not call LLO"); },
  });
  assert.equal(status, 2);
  assert.match(lines[0], /idempotency-key is required/);
});
