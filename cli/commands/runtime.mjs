// SPDX-License-Identifier: AGPL-3.0-or-later

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveInstallLayout } from "../lib/install-layout.mjs";
import {
  runCompatibilityJson as invokeCompatibilityJson,
} from "../lib/runtime/compatibility-client.mjs";
import {
  lloCapabilities,
  lloStatus,
  lloInspect,
  lloCollect,
  lloCancel,
  lloCleanup,
} from "../lib/runtime/llo-client.mjs";
import { RuntimeProviderError } from "../lib/runtime/provider-record.mjs";
import { renderCommandHelp } from "../surface.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function parseJsonOnly(argv, usage) {
  if (argv.length === 0) return false;
  if (argv.length === 1 && argv[0] === "--json") return true;
  throw new Error(`${usage} accepts only --json`);
}

function backendLabel(backend) {
  return backend === "krunvmCompatibility" ? "krunvm compatibility" : backend;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "unknown";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function renderStorageStatus(status, log) {
  if (status.state === "notPrepared") {
    log("Runtime storage is not prepared.");
    log(`Provider: ${status.provider} (${status.maturity})`);
    log(`Backend: ${backendLabel(status.backend)}`);
    log(`Storage: ${status.storageVolume}`);
    log(status.provider === "llo"
      ? "Provision through the LLO execution/v1 provider"
      : "Run: cloister runtime storage init");
    return;
  }

  log("Runtime storage is prepared.");
  log(`Provider: ${status.provider} (${status.maturity})`);
  log(`Backend: ${backendLabel(status.backend)}`);
  log(`Storage: ${status.storageVolume}`);
  if (status.capacity) {
    log(
      `Capacity: ${formatBytes(status.capacity.usedBytes)} used; ` +
      `${formatBytes(status.capacity.availableBytes)} available`,
    );
  }
  log(`Tracked runs: ${status.trackedRuns}; running: ${status.runningRuns}`);
}

function doctorReport(invocation) {
  const record = invocation.record;
  return {
    schema: "cloister/runtime-doctor/v1",
    provider: {
      name: record?.provider ?? "compatibility",
      maturity: record?.maturity ?? "experimental",
      transport: record?.transport ?? "subprocess (explicit development override)",
      apiVersion: record?.apiVersion ?? "cloister/compatibility-runtime/v1",
      backends: record?.backends ?? ["krunvmCompatibility"],
      hostRuntimeDigest: record?.artifacts?.hostRuntime?.sha256 ?? null,
    },
    checks: invocation.data,
  };
}

function lloDoctorReport(capabilities) {
  const names = Array.isArray(capabilities?.capabilities)
    ? capabilities.capabilities.map((entry) => entry.name)
    : [];
  return {
    schema: "cloister/runtime-doctor/v1",
    provider: {
      name: "llo",
      maturity: "native",
      transport: "uds",
      apiVersion: "cloister/execution/v1",
      backends: names.filter((name) => name?.startsWith("backend/")),
      hostRuntimeDigest: null,
    },
    checks: { llo: capabilities },
  };
}

function renderDoctor(report, log) {
  const provider = report.provider;
  log(`Runtime provider: ${provider.name} (${provider.maturity})`);
  log(`Transport: ${provider.transport}`);
  log(`Backends: ${provider.backends.map(backendLabel).join(", ")}`);
  log(`Host runtime digest: ${provider.hostRuntimeDigest ?? "not available for explicit override"}`);
  const storage = report.checks.storage;
  if (storage) {
    log(`Storage: ${storage.state} (${storage.storageVolume})`);
  }
  const microvm = report.checks.microvm;
  if (microvm) {
    log(`krunvm: ${microvm.krunvm ? "available" : "missing"}`);
    log(`Buildah: ${microvm.buildah ? "available" : "missing"}`);
  }
}

function reportRuntimeError(error, errLog) {
  errLog(`cloister runtime: ${error.message}`);
  if (error instanceof RuntimeProviderError && !/cloister runtime install/.test(error.message)) {
    errLog("Run: cloister runtime install");
  }
  return error instanceof RuntimeProviderError ? 2 : 1;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const log = deps.log ?? console.log;
  const errLog = deps.errLog ?? console.error;
  const env = deps.env ?? process.env;
  const runCompatibilityJson = deps.runCompatibilityJson ?? invokeCompatibilityJson;
  const lloSocket = env.CLOISTER_LLO_CONTROL_SOCKET;
  const runLloCapabilities = deps.lloCapabilities ?? lloCapabilities;
  const runLloStatus = deps.lloStatus ?? lloStatus;
  const runLloInspect = deps.lloInspect ?? lloInspect;
  const runLloCollect = deps.lloCollect ?? lloCollect;
  const runLloCancel = deps.lloCancel ?? lloCancel;
  const runLloCleanup = deps.lloCleanup ?? lloCleanup;
  const [sub, ...rest] = argv;

  if (sub === "--help" || sub === "-h") {
    log(renderCommandHelp("runtime install"));
    return 0;
  }
  if (sub === "doctor") {
    if (rest.includes("--help") || rest.includes("-h")) {
      log(renderCommandHelp("runtime doctor"));
      return 0;
    }
    let json;
    try {
      json = parseJsonOnly(rest, "cloister runtime doctor");
      const report = lloSocket
        ? lloDoctorReport(await runLloCapabilities(lloSocket, deps))
        : doctorReport(runCompatibilityJson(["doctor"], {
          env,
          spawnSync: deps.spawnSync,
        }));
      if (json) log(JSON.stringify(report, null, 2));
      else renderDoctor(report, log);
      return 0;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return reportRuntimeError(error, errLog);
    }
  }
  if (sub === "storage" && rest[0] === "status") {
    if (rest.includes("--help") || rest.includes("-h")) {
      log(renderCommandHelp("runtime storage status"));
      return 0;
    }
    try {
      const json = parseJsonOnly(rest.slice(1), "cloister runtime storage status");
      let data;
      if (lloSocket) {
        const value = await runLloStatus(lloSocket, deps);
        data = {
          state: value.provisioned ? "prepared" : "notPrepared",
          provider: "llo",
          maturity: "native",
          backend: value.backend || "unavailable",
          storageVolume: "managed by LLO",
          trackedRuns: null,
          runningRuns: null,
        };
      } else {
        data = runCompatibilityJson(["status"], {
          env,
          spawnSync: deps.spawnSync,
        }).data;
      }
      if (json) log(JSON.stringify(data, null, 2));
      else renderStorageStatus(data, log);
      return 0;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return reportRuntimeError(error, errLog);
    }
  }
  if (["inspect", "collect", "cancel", "cleanup"].includes(sub)) {
    if (!lloSocket) {
      errLog(`cloister runtime ${sub}: set CLOISTER_LLO_CONTROL_SOCKET to use the LLO provider`);
      return 2;
    }
    const runId = rest[0];
    if (!runId || rest.includes("--help") || rest.includes("-h")) {
      errLog(`cloister runtime ${sub}: expected <run-id>`);
      return 2;
    }
    const cursor = sub === "inspect" ? Number(rest[1] ?? 0) : 0;
    if (sub === "inspect" && (!Number.isInteger(cursor) || cursor < 0)) {
      errLog("cloister runtime inspect: expected a non-negative integer after-sequence");
      return 2;
    }
    const keyFlag = rest.indexOf("--idempotency-key");
    const idempotencyKey = keyFlag >= 0 ? rest[keyFlag + 1] : undefined;
    if (keyFlag >= 0 && (!idempotencyKey || keyFlag + 1 >= rest.length)) {
      errLog(`cloister runtime ${sub}: --idempotency-key requires a value`);
      return 2;
    }
    if ((sub === "cancel" || sub === "cleanup") && !idempotencyKey) {
      errLog(`cloister runtime ${sub}: --idempotency-key is required`);
      return 2;
    }
    try {
      const value = sub === "inspect"
        ? await runLloInspect(lloSocket, runId, cursor, deps)
        : sub === "collect"
          ? await runLloCollect(lloSocket, runId, deps)
            : sub === "cancel"
            ? await runLloCancel(lloSocket, runId, idempotencyKey ?? "", deps)
            : await runLloCleanup(lloSocket, runId, idempotencyKey ?? "", deps);
      log(JSON.stringify(value));
      return 0;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return reportRuntimeError(error, errLog);
    }
  }
  if (sub === "install" && (rest.includes("--help") || rest.includes("-h"))) {
    log(renderCommandHelp("runtime install"));
    return 0;
  }
  if (sub !== "install" || rest.length > 0) {
    errLog(`cloister runtime: expected \`install\`, \`doctor\`, or \`storage status\`, got ${JSON.stringify(argv.join(" "))}`);
    return 2;
  }

  const root = resolve(deps.root ?? ROOT);
  const layout = resolveInstallLayout({ env, checkoutRoot: root });
  try {
    const install = deps.installCompatibilityProvider
      ?? (await import("../lib/runtime/install-compatibility.mjs")).installCompatibilityProvider;
    const record = await install({ root, layout, spawn: deps.spawn, platform: deps.platform });
    log(
      `cloister runtime install: installed ${record.provider} provider ` +
      `(${record.maturity}) in ${layout.libexecDir}`,
    );
    return 0;
  } catch (error) {
    errLog(`cloister runtime install: ${error.message}`);
    return 1;
  }
}
