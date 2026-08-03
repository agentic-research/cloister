// SPDX-License-Identifier: AGPL-3.0-or-later

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildRunSpec,
  verifyExecutionReceipt,
} from "../../cli/lib/runtime/llo-execution-adapter.mjs";

const REQUEST = {
  artifactRef: "sha256:artifact",
  entrypoint: "/bin/worker",
  argv: ["--once"],
  workspaceGrant: { head: "blake3:workspace", operations: ["read", "write"] },
  isolation: "nativeNono",
  filesystem: { read: ["/etc/ssl"], write: ["/workspace"] },
  network: { allow: ["api.example.test"] },
  resources: { cpuMillis: 1000, memoryBytes: 64 * 1024 * 1024 },
  secrets: [{ reference: "secret://provider/api-key" }],
  receiptDestination: "cas://receipts/run-1",
};

test("Cloister maps policy into a capability-bound neutral RunSpec", () => {
  const spec = buildRunSpec(REQUEST);
  assert.deepEqual(spec, { schema: "execution/v1", ...REQUEST });
  assert.equal(Object.hasOwn(spec, "executable"), false);
  assert.equal(Object.hasOwn(spec, "hostDirectory"), false);
});

test("Cloister rejects undeclared execution fields instead of forwarding them", () => {
  assert.throws(
    () => buildRunSpec({ ...REQUEST, cwd: "/host/project" }),
    /unknown execution policy field.*cwd/i,
  );
});

test("Cloister refuses an unverifiable execution receipt by default", async () => {
  await assert.rejects(
    verifyExecutionReceipt({ receipt: { outcome: "completed" } }),
    /execution receipt could not be verified/i,
  );
});

test("Cloister accepts a receipt only when its injected verifier confirms it", async () => {
  const receipt = { outcome: "completed", signature: "sig" };
  const verified = await verifyExecutionReceipt(receipt, {
    verify: async (value) => value === receipt,
  });
  assert.equal(verified, receipt);
});

test("unverified evidence is available only through an explicit fixture downgrade", async () => {
  const receipt = { outcome: "fixture", signature: null };
  const accepted = await verifyExecutionReceipt(receipt, {
    allowUnverifiedEvidence: true,
    localFixture: true,
  });
  assert.equal(accepted, receipt);
});
