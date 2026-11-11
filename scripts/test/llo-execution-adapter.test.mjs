// SPDX-License-Identifier: AGPL-3.0-or-later

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verifyExecutionReceipt } from "../../cli/lib/runtime/llo-execution-adapter.mjs";
import {
  LLO_RESOURCE_LIMITS_CAPABILITY,
  lloProvision,
  requireResourceLimitsRevision,
  runLloEnvelope,
} from "../../cli/lib/runtime/llo-client.mjs";
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

/**
 * A scripted LLO daemon: one socket per connection, answering by request op.
 * Records every request in order so a test can assert what was sent AND what
 * was never sent.
 */
function fakeDaemon(answers) {
  const sent = [];
  const connect = () => {
    const socket = new EventEmitter();
    socket.setEncoding = () => {};
    socket.write = (line) => {
      const request = JSON.parse(line);
      sent.push(request);
      const answer = answers[request.op];
      if (!answer) throw new Error(`fake daemon has no answer for ${request.op}`);
      queueMicrotask(() => socket.emit("data", `${JSON.stringify(answer)}\n`));
    };
    socket.destroy = () => {};
    return socket;
  };
  return { sent, connect };
}

// What an LLO v0.21 daemon advertises (rs/ll-open/runtime/src/transport.rs
// `capabilities_json`): the contract, its backend, and the limits revision.
const V021_CAPABILITIES = {
  capabilities: [
    { name: "cloister/execution/v1", version: "v1" },
    { name: "backend/microvm", version: "krun-worker" },
    { name: "cloister/execution/v1/resource-limits", version: "2" },
  ],
};

// execution/v1 OCI ResourceLimits (LLO v0.21): zero means no ceiling. The
// microVM tier sizes whole MiB and whole vCPUs and refuses outputBytes and
// pids, so this is a set the tier the grant names would actually accept.
const OCI_LIMITS = {
  wallTimeMs: 1_000,
  outputBytes: 0,
  memory: { limit: 64 * 1024 * 1024 },
  cpu: { quota: 100_000, period: 100_000 },
  pids: { limit: 0 },
};

function envelope(limits = OCI_LIMITS) {
  const digest = { algorithm: "blake3-256", value: "a".repeat(64) };
  const evidence = { mediaType: "application/test-evidence", digest };
  return {
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
      backendClass: "microVm",
      limits,
      workspaces: [],
      allowedEgress: [],
      credentialBrokerRefs: [],
    },
  };
}

function writeEnvelope(value) {
  const root = mkdtempSync(join(tmpdir(), "cloister-llo-"));
  const envelopePath = join(root, "execution.json");
  writeFileSync(envelopePath, JSON.stringify(value));
  return envelopePath;
}

test("LLO envelope client checks the limits revision, then sends only schema-bound spec and grant", async () => {
  const request = envelope();
  const response = { runId: "run-1", state: "running" };
  const daemon = fakeDaemon({
    llo_execution_capabilities: V021_CAPABILITIES,
    llo_execution_start: response,
  });
  const result = await runLloEnvelope("/run/llo.sock", writeEnvelope(request), {
    connect: daemon.connect,
  });
  assert.deepEqual(daemon.sent, [
    { op: "llo_execution_capabilities" },
    { op: "llo_execution_start", spec: request.spec, grant: request.grant },
  ]);
  assert.deepEqual(result, response);
});

test("the generated contract carries the OCI limits shape, not the pre-OCI one", () => {
  // The adapter's limits are accepted by Cloister's validator against the
  // pinned artifact...
  lloExecutionRequest.start(envelope().spec, envelope().grant);
  // ...and the pre-OCI keys are refused by name, as LLO's JSON carrier does.
  for (const stale of ["memoryBytes", "cpuMillis"]) {
    const old = envelope({ ...OCI_LIMITS, [stale]: 1 });
    assert.throws(
      () => lloExecutionRequest.start(old.spec, old.grant),
      new RegExp(`${stale} is not declared`),
    );
  }
});

// cloister-dac140: a daemon that predates the OCI layout reads an OCI-shaped
// ResourceLimits as its own four words and silently drops memory, cpu and pids.
// It advertises no limits revision, so Cloister must refuse it before `start`.
for (const [label, capabilities] of [
  ["lacks the resource-limits entry", {
    capabilities: V021_CAPABILITIES.capabilities.filter(
      (entry) => entry.name !== "cloister/execution/v1/resource-limits",
    ),
  }],
  ["advertises a different resource-limits revision", {
    capabilities: V021_CAPABILITIES.capabilities.map((entry) => (
      entry.name === "cloister/execution/v1/resource-limits" ? { ...entry, version: "1" } : entry
    )),
  }],
]) {
  test(`Cloister refuses to start against a daemon that ${label}`, async () => {
    const daemon = fakeDaemon({
      llo_execution_capabilities: capabilities,
      llo_execution_start: { runId: "run-1", state: "running" },
    });
    await assert.rejects(
      runLloEnvelope("/run/llo.sock", writeEnvelope(envelope()), { connect: daemon.connect }),
      /refusing to start: LLO daemon does not advertise cloister\/execution\/v1\/resource-limits version 2/,
    );
    assert.deepEqual(
      daemon.sent.map((request) => request.op),
      ["llo_execution_capabilities"],
      "start must never reach a daemon that would drop the OCI ceilings",
    );
  });
}

test("the limits-revision gate reads the entry by name, not by position", () => {
  const reordered = { capabilities: [...V021_CAPABILITIES.capabilities].reverse() };
  assert.deepEqual(requireResourceLimitsRevision(reordered), LLO_RESOURCE_LIMITS_CAPABILITY);
  assert.throws(() => requireResourceLimitsRevision({ capabilities: [] }), /no such entry/);
  assert.throws(() => requireResourceLimitsRevision(undefined), /no such entry/);
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
        // LLO v0.29.0 (ley-line-open-ba86d3): ProvisionOutput.casRoot @2 —
        // the generated schema requires it, so a v0.29.0 reply carries it
        // (cloister-164236).
        queueMicrotask(() => socket.emit("data", '{"provisioned":true,"backendId":"backend-1","casRoot":"/state/leyline/cas-volume/mnt/cas"}\n'));
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
  assert.deepEqual(result, { provisioned: true, backendId: "backend-1", casRoot: "/state/leyline/cas-volume/mnt/cas" });
});

test("a provision reply without casRoot (a pre-v0.29.0 LLO) is refused by the generated schema", async () => {
  await assert.rejects(
    lloProvision("/run/llo.sock", "microVm", "provision-2", {
      connect: () => {
        const socket = new EventEmitter();
        socket.setEncoding = () => {};
        socket.write = () => queueMicrotask(() => socket.emit("data", '{"provisioned":true,"backendId":"backend-1"}\n'));
        socket.destroy = () => {};
        return socket;
      },
    }),
    /the LLO daemon is older than v0\.29\.0: its provision reply has no casRoot \(added in v0\.29\.0\)\. Run an LLO execution daemon at v0\.29\.0 or later/,
  );
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
