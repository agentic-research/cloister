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
    env: { CLOISTER_MODE: "dev" },
  });
  assert.equal(accepted, receipt);
});

// The downgrade covers "no verifier was available", never "the verifier said
// no". Falling through a rejection into the downgrade would accept a receipt
// that was verified AS BAD — strictly worse than one never checked.
test("a verifier's rejection is terminal and the fixture downgrade cannot override it", async () => {
  await assert.rejects(
    verifyExecutionReceipt(
      { outcome: "tampered", signature: "bad" },
      {
        verify: async () => false,
        allowUnverifiedEvidence: true,
        localFixture: true,
        env: { CLOISTER_MODE: "dev" },
      },
    ),
    /rejected by the execution receipt verifier/i,
  );
});

// ADR-0042 / lint:no-dev-mode: `CLOISTER_MODE=dev` is the one place a relaxation
// can be anchored, because committed config can never set it. Without that
// anchor the two option flags are a per-call auth bypass, which ADR-0007 removed.
test("the fixture downgrade is inert outside CLOISTER_MODE=dev", async () => {
  await assert.rejects(
    verifyExecutionReceipt(
      { outcome: "fixture", signature: null },
      { allowUnverifiedEvidence: true, localFixture: true, env: {} },
    ),
    /execution receipt could not be verified/i,
  );
});
