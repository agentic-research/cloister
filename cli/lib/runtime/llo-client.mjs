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

/**
 * The `ResourceLimits` layout revision Cloister speaks (cloister-dac140).
 *
 * LLO v0.21 replaced execution/v1 `ResourceLimits` in place with the OCI
 * `linux.resources` shape (memory / cpu / pids). The contract name
 * `cloister/execution/v1` did not change, so it cannot say which layout a
 * daemon reads. A daemon that predates the OCI layout reads an OCI-shaped
 * message as its own four words: `memory`, `cpu` and `pids` vanish, and every
 * ceiling Cloister asked for is silently unenforced. That daemon cannot refuse
 * what it cannot see, so the refusal has to be Cloister's.
 *
 * LLO's execution/v1 README: a client MUST find this entry in
 * `llo_execution_capabilities` before it sends `start`, and treat its absence
 * as a daemon that would drop every OCI ceiling. Revision 1 (the pre-OCI
 * layout) was never advertised, so anything other than an exact "2" is refused.
 */
export const LLO_RESOURCE_LIMITS_CAPABILITY = Object.freeze({
  name: "cloister/execution/v1/resource-limits",
  version: "2",
});

/** Throw unless a capabilities response advertises the OCI limits layout. */
export function requireResourceLimitsRevision(capabilities, socketPath) {
  const entries = Array.isArray(capabilities?.capabilities) ? capabilities.capabilities : [];
  const { name, version } = LLO_RESOURCE_LIMITS_CAPABILITY;
  const entry = entries.find((candidate) => candidate?.name === name);
  if (!entry || entry.version !== version) {
    const found = entry ? `version ${JSON.stringify(entry.version)}` : "no such entry";
    throw new LloClientError(
      `refusing to start: LLO daemon does not advertise ${name} version ${version} ` +
        `(${found}); it would read execution/v1 ResourceLimits in the pre-OCI layout and ` +
        "drop every memory, cpu and pids ceiling. Upgrade the daemon to LLO v0.21 or later.",
      { socketPath, capabilities },
    );
  }
  return entry;
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
  // Validate locally first, so a malformed envelope never costs a round trip.
  const start = lloExecutionRequest.start(envelope.spec, envelope.grant);
  requireResourceLimitsRevision(await lloCapabilities(socketPath, deps), socketPath);
  return callLloJson(socketPath, start, deps);
}
