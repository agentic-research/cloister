// SPDX-License-Identifier: AGPL-3.0-or-later

import { createConnection } from "node:net";
import { readFileSync } from "node:fs";

import { lloExecutionRequest } from "./llo-execution-contract.mjs";

export class LloClientError extends Error {
  constructor(message, evidence = {}) {
    super(message);
    this.name = "LloClientError";
    Object.assign(this, evidence);
  }
}

/**
 * Call one LLO execution/v1 operation over its newline-delimited UDS JSON
 * protocol. This is deliberately a transport client: policy, signing, and
 * host-path resolution remain outside Cloister and inside the LLO embedding.
 */
export function callLloJson(socketPath, request, deps = {}) {
  const connect = deps.connect ?? createConnection;
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = "";
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const socket = connect(socketPath);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      try {
        finish(resolve, JSON.parse(line));
      } catch (error) {
        finish(reject, new LloClientError(
          `LLO returned invalid JSON: ${error.message}`,
          { socketPath, request, cause: error },
        ));
      }
      socket.destroy();
    });
    socket.once("error", (error) => finish(reject, new LloClientError(
      `unable to connect to LLO execution socket ${socketPath}: ${error.message}`,
      { socketPath, request, cause: error },
    )));
    socket.once("close", () => {
      if (!settled) finish(reject, new LloClientError(
        "LLO execution socket closed without a response",
        { socketPath, request },
      ));
    });
    try {
      socket.write(`${JSON.stringify(request)}\n`);
    } catch (error) {
      finish(reject, new LloClientError(
        `unable to send request to LLO execution socket ${socketPath}: ${error.message}`,
        { socketPath, request, cause: error },
      ));
    }
  });
}

export function lloCapabilities(socketPath, deps) {
  return callLloJson(socketPath, lloExecutionRequest.capabilities(), deps);
}

export function lloStatus(socketPath, deps) {
  return callLloJson(socketPath, lloExecutionRequest.status(), deps);
}

export function lloInspect(socketPath, runId, afterSequence = 0, deps) {
  return callLloJson(socketPath, lloExecutionRequest.inspect(runId, afterSequence), deps);
}

export function lloCollect(socketPath, runId, deps) {
  return callLloJson(socketPath, lloExecutionRequest.collect(runId), deps);
}

export function lloCancel(socketPath, runId, idempotencyKey = "", deps) {
  return callLloJson(socketPath, lloExecutionRequest.cancel(runId, idempotencyKey), deps);
}

export function lloCleanup(socketPath, runId, idempotencyKey = "", deps) {
  return callLloJson(socketPath, lloExecutionRequest.cleanup(runId, idempotencyKey), deps);
}

export async function runLloEnvelope(socketPath, envelopePath, deps) {
  let envelope;
  try {
    envelope = JSON.parse(readFileSync(envelopePath, "utf8"));
  } catch (error) {
    throw new LloClientError(
      `cannot read LLO execution envelope ${envelopePath}: ${error.message}`,
      { socketPath, envelopePath, cause: error },
    );
  }
  if (!envelope || typeof envelope !== "object" || !envelope.spec || !envelope.grant) {
    throw new LloClientError(
      "LLO runtime run requires a JSON envelope containing schema-generated spec and grant",
      { socketPath, envelopePath },
    );
  }
  return callLloJson(socketPath, lloExecutionRequest.start(envelope.spec, envelope.grant), deps);
}
