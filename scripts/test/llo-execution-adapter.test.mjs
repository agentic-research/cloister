// SPDX-License-Identifier: AGPL-3.0-or-later

import { test } from "node:test";
import assert from "node:assert/strict";

import { verifyExecutionReceipt } from "../../cli/lib/runtime/llo-execution-adapter.mjs";

// The RunSpec-builder tests that used to live here were removed with the builder
// (ADR-0063). They pinned a hand-written ten-field contract that shares no field
// name with the canonical eleven-field RunSpec, so they asserted the wrong thing
// green — including one that pinned `executable` as a host-shaped escape to be
// excluded, when `executable` is RunSpec @1, a required content-addressed
// ArtifactRef. Their instincts (fail closed, forward no undeclared field, admit
// no host path) belong on the GENERATED mapping when it lands: cloister-3e86e8.

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
