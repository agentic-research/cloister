// SPDX-License-Identifier: AGPL-3.0-or-later

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verifyExecutionReceipt } from "../../cli/lib/runtime/llo-execution-adapter.mjs";
import { lloProvision, runLloEnvelope } from "../../cli/lib/runtime/llo-client.mjs";
import {
  LLO_EXECUTION_OPERATIONS,
  lloExecutionRequest,
  lloExecutionTools,
} from "../../cli/lib/runtime/llo-execution-contract.mjs";

test("the checked-in LLO execution artifact matches its content pin", () => {
  const lock = JSON.parse(readFileSync(
    new URL("../../llo-execution-contract.lock.json", import.meta.url),
    "utf8",
  ));
  const artifact = readFileSync(
    new URL("../../src/generated/llo-execution-tools.json", import.meta.url),
  );
  const digest = createHash("sha256").update(artifact).digest("hex");
  assert.equal(digest, lock.sha256);
  assert.equal(lock.artifact, "src/generated/llo-execution-tools.json");
  assert.match(lock.sourceCommit, /^[0-9a-f]{40}$/);
});

test("Cloister derives LLO operation names from the generated artifact", () => {
  const tools = lloExecutionTools();
  assert.deepEqual(
    LLO_EXECUTION_OPERATIONS,
    tools.map((tool) => tool.name),
  );
  assert.deepEqual(lloExecutionRequest.capabilities(), {
    op: "llo_execution_capabilities",
  });
  assert.deepEqual(lloExecutionRequest.status(), {
    op: "llo_execution_status",
    runId: "",
  });
  assert.deepEqual(lloExecutionRequest.provision("microVm", "p-1"), {
    op: "llo_execution_provision",
    backendClass: "microVm",
    idempotencyKey: "p-1",
  });
  assert.deepEqual(lloExecutionRequest.inspect("run-1", 4), {
    op: "llo_execution_inspect",
    runId: "run-1",
    afterSequence: 4,
  });
  assert.throws(
    () => lloExecutionRequest.start({}, null),
    /grant must be an object/i,
  );
  assert.throws(
    () => lloExecutionRequest.inspect("run-1", -1),
    /afterSequence must be >= 0/i,
  );
});

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

test("LLO envelope client sends only schema-bound spec and grant over UDS", async () => {
  const root = mkdtempSync(join(tmpdir(), "cloister-llo-"));
  const envelopePath = join(root, "execution.json");
  const digest = { algorithm: "blake3-256", value: "a".repeat(64) };
  const evidence = { mediaType: "application/test-evidence", digest };
  const limits = { wallTimeMs: 1_000, memoryBytes: 64 * 1024 * 1024, cpuMillis: 1_000, outputBytes: 0 };
  const request = {
    spec: {
      schemaVersion: "cloister/execution/v1",
      executable: { digest, mediaType: "application/test-executable" },
      arguments: [],
      workspaceInputs: [],
      publicEnvironment: [],
      secretHandles: [],
      requestedInterfaces: ["cloister/execution/v1"],
      requestedLimits: limits,
      outputs: [],
      cancellationMode: "explicitOnly",
    },
    grant: {
      grantId: "g-1",
      issuerEvidence: evidence,
      expiresAtUnixMs: 4_000,
      replayKey: "replay-1",
      runSpecDigest: digest,
      workloadIdentityEvidence: evidence,
      actorProvenanceEvidence: evidence,
      capabilities: [{ grant: "urn:signet:cap:execute:run", interface: "cloister/execution/v1" }],
      confinementDigest: digest,
      backendClass: "native",
      limits,
      workspaces: [],
      allowedEgress: [],
      credentialBrokerRefs: [],
    },
  };
  writeFileSync(envelopePath, JSON.stringify(request));
  let sent;
  const response = { runId: "run-1", state: "running" };
  const result = await runLloEnvelope("/run/llo.sock", envelopePath, {
    connect: () => {
      const socket = new EventEmitter();
      socket.setEncoding = () => {};
      socket.write = (line) => {
        sent = JSON.parse(line);
        queueMicrotask(() => socket.emit("data", `${JSON.stringify(response)}\n`));
      };
      socket.destroy = () => {};
      return socket;
    },
  });
  assert.deepEqual(sent, {
    op: "llo_execution_start",
    spec: request.spec,
    grant: request.grant,
  });
  assert.deepEqual(result, response);
});

test("LLO envelope client rejects an envelope without both generated objects", async () => {
  const root = mkdtempSync(join(tmpdir(), "cloister-llo-"));
  const envelopePath = join(root, "invalid.json");
  writeFileSync(envelopePath, JSON.stringify({ spec: {} }));
  await assert.rejects(
    runLloEnvelope("/run/llo.sock", envelopePath),
    /schema-generated spec and grant/i,
  );
});

test("LLO provision uses the generated backend and idempotency contract", async () => {
  let sent;
  const result = await lloProvision("/run/llo.sock", "microVm", "provision-1", {
    connect: () => {
      const socket = new EventEmitter();
      socket.setEncoding = () => {};
      socket.write = (line) => {
        sent = JSON.parse(line);
        queueMicrotask(() => socket.emit("data", '{"provisioned":true,"backendId":"backend-1"}\n'));
      };
      socket.destroy = () => {};
      return socket;
    },
  });
  assert.deepEqual(sent, {
    op: "llo_execution_provision",
    backendClass: "microVm",
    idempotencyKey: "provision-1",
  });
  assert.deepEqual(result, { provisioned: true, backendId: "backend-1" });
});

test("LLO UDS client rejects an unbounded response", async () => {
  await assert.rejects(
    lloProvision("/run/llo.sock", "microVm", "bounded-1", {
      maxResponseBytes: 32,
      connect: () => {
        const socket = new EventEmitter();
        socket.setEncoding = () => {};
        socket.write = () => queueMicrotask(() => socket.emit("data", "x".repeat(33)));
        socket.destroy = () => {};
        return socket;
      },
    }),
    /exceeded the 32-byte limit/i,
  );
});

test("LLO UDS client times out a socket that never responds", async () => {
  await assert.rejects(
    lloProvision("/run/llo.sock", "microVm", "timeout-1", {
      timeoutMs: 5,
      connect: () => {
        const socket = new EventEmitter();
        socket.setEncoding = () => {};
        socket.write = () => {};
        socket.destroy = () => {};
        return socket;
      },
    }),
    /timed out after 5ms/i,
  );
});
