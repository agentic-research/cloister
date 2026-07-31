// SPDX-License-Identifier: AGPL-3.0-or-later

import { test } from "node:test";
import assert from "node:assert/strict";

import { main } from "../../cli/commands/dev.mjs";

test("dev bootstrap accepts an explicit checkout directory", async () => {
  const calls = [];
  const code = await main(["bootstrap", "--dir", "/tmp/cloister"], {
    bootstrapLocalDev: async (options) => calls.push(options),
    log: () => {},
    errLog: () => {},
    env: { FIXTURE: "1" },
  });
  assert.equal(code, 0);
  assert.equal(calls[0].root, "/tmp/cloister");
  assert.deepEqual(calls[0].env, { FIXTURE: "1" });
});

test("dev serve starts the first-party router and waits for its exit", async () => {
  const child = { pid: 42 };
  let started;
  const code = await main(["serve", "--dir", "/tmp/cloister"], {
    startLocalRouter: (options) => { started = options; return child; },
    waitForChild: async (value) => {
      assert.equal(value, child);
      return 7;
    },
    log: () => {},
    errLog: () => {},
    env: {},
  });
  assert.equal(started.root, "/tmp/cloister");
  assert.equal(code, 7);
});

test("dev help has no bootstrap or router side effects", async () => {
  let sideEffects = 0;
  const output = [];
  const code = await main(["--help"], {
    bootstrapLocalDev: async () => { sideEffects++; },
    startLocalRouter: () => { sideEffects++; },
    log: (line) => output.push(line),
    errLog: () => {},
  });
  assert.equal(code, 0);
  assert.equal(sideEffects, 0);
  assert.match(output.join("\n"), /cloister dev bootstrap/);
  assert.match(output.join("\n"), /cloister dev serve/);
});
