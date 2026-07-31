// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";

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

test("storage status JSON is exact and contains no human commentary", async () => {
  const lines = [];
  const status = await runtimeMain(["storage", "status", "--json"], {
    log: (line) => lines.push(line),
    errLog: (line) => lines.push(`ERR:${line}`),
    runCompatibilityJson: () => ({ data: STATUS, provider: "compatibility provider" }),
  });

  assert.equal(status, 0);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), STATUS);
});

test("missing storage is a successful observation with a CLI-owned next step", async () => {
  const lines = [];
  const status = await runtimeMain(["storage", "status"], {
    log: (line) => lines.push(line),
    errLog: (line) => lines.push(`ERR:${line}`),
    runCompatibilityJson: () => ({ data: STATUS, provider: "compatibility provider" }),
  });

  assert.equal(status, 0);
  assert.match(lines.join("\n"), /Runtime storage is not prepared\./);
  assert.match(lines.join("\n"), /Provider: compatibility \(experimental\)/);
  assert.match(lines.join("\n"), /Backend: krunvm compatibility/);
  assert.match(lines.join("\n"), /Run: cloister runtime storage init/);
  assert.doesNotMatch(lines.join("\n"), /task /i);
});

test("runtime doctor names the provider boundary and verified artifact", async () => {
  const lines = [];
  const status = await runtimeMain(["doctor"], {
    log: (line) => lines.push(line),
    errLog: (line) => lines.push(`ERR:${line}`),
    runCompatibilityJson: () => ({
      data: {
        schema: "cloister/host-runtime/doctor/v1",
        microvm: { available: true, krunvm: true, buildah: true },
        storage: STATUS,
      },
      provider: "compatibility provider",
      record: {
        provider: "compatibility",
        maturity: "experimental",
        transport: "subprocess",
        apiVersion: "cloister/compatibility-runtime/v1",
        backends: ["nativeNonoCompatibility", "krunvmCompatibility"],
        artifacts: { hostRuntime: { sha256: "a".repeat(64) } },
      },
    }),
  });

  assert.equal(status, 0);
  const text = lines.join("\n");
  assert.match(text, /Runtime provider: compatibility \(experimental\)/);
  assert.match(text, /Transport: subprocess/);
  assert.match(text, /Backends: nativeNonoCompatibility, krunvm compatibility/);
  assert.match(text, new RegExp(`Host runtime digest: ${"a".repeat(64)}`));
  assert.match(text, /Storage: notPrepared/);
});
