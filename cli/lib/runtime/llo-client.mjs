// SPDX-License-Identifier: AGPL-3.0-or-later

import { createConnection } from "node:net";
import { readFileSync } from "node:fs";

import {
  lloExecutionRequest,
  validateLloExecutionResponse,
} from "./llo-execution-contract.mjs";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;

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
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = deps.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const operationName = request?.op;
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = "";
    let socket;
    const timer = setTimeout(() => {
      if (settled) return;
      socket?.destroy();
      finish(reject, new LloClientError(
        `LLO execution socket timed out after ${timeoutMs}ms`,
        { socketPath, request, timeoutMs },
      ));
    }, timeoutMs);
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    socket = connect(socketPath);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > maxResponseBytes) {
        socket.destroy();
        finish(reject, new LloClientError(
          `LLO response exceeded the ${maxResponseBytes}-byte limit`,
          { socketPath, request, maxResponseBytes },
        ));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      try {
        const response = JSON.parse(line);
        finish(resolve, validateLloExecutionResponse(operationName, response));
      } catch (error) {
        finish(reject, new LloClientError(
          `LLO returned an invalid ${operationName ?? "execution"} response: ${error.message}`,
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

export function lloProvision(socketPath, backendClass = "microVm", idempotencyKey, deps) {
  return callLloJson(
    socketPath,
    lloExecutionRequest.provision(backendClass, idempotencyKey),
    deps,
  );
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
