// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";

export const PROVIDER_SCHEMA = "cloister/runtime-provider/v1";
const RECORD_DIR = Symbol("cloister.runtimeProviderDir");

export class RuntimeProviderError extends Error {}
export class RuntimeNotInstalledError extends RuntimeProviderError {}

export function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function validateArtifact(record, kind) {
  const artifact = record?.artifacts?.[kind];
  if (!artifact || typeof artifact !== "object") {
    throw new RuntimeProviderError(`runtime provider does not declare ${kind}`);
  }
  if (
    typeof artifact.file !== "string" || artifact.file.length === 0 ||
    isAbsolute(artifact.file) || basename(artifact.file) !== artifact.file
  ) {
    throw new RuntimeProviderError(
      `runtime provider ${kind}.file must be one relative file name`,
    );
  }
  if (typeof artifact.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(artifact.sha256)) {
    throw new RuntimeProviderError(
      `runtime provider ${kind}.sha256 must be a complete SHA-256 digest`,
    );
  }
  return artifact;
}

function validateRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new RuntimeProviderError("runtime provider record must be a JSON object");
  }
  if (record.schema !== PROVIDER_SCHEMA) {
    throw new RuntimeProviderError(
      `unsupported runtime provider schema: ${JSON.stringify(record.schema)}`,
    );
  }
  if (record.provider !== "compatibility") {
    throw new RuntimeProviderError(
      `unsupported runtime provider: ${JSON.stringify(record.provider)}`,
    );
  }
  if (record.maturity !== "experimental") {
    throw new RuntimeProviderError(
      `compatibility provider maturity must be "experimental", got ${JSON.stringify(record.maturity)}`,
    );
  }
  if (record.transport !== "subprocess") {
    throw new RuntimeProviderError(
      `compatibility provider transport must be "subprocess", got ${JSON.stringify(record.transport)}`,
    );
  }
  if (record.apiVersion !== "cloister/compatibility-runtime/v1") {
    throw new RuntimeProviderError(
      `unsupported compatibility provider API: ${JSON.stringify(record.apiVersion)}`,
    );
  }
  const expectedBackends = ["nativeNonoCompatibility", "krunvmCompatibility"];
  if (
    !Array.isArray(record.backends) ||
    record.backends.length !== expectedBackends.length ||
    record.backends.some((backend, index) => backend !== expectedBackends[index])
  ) {
    throw new RuntimeProviderError(
      `compatibility provider backends must be ${JSON.stringify(expectedBackends)}`,
    );
  }
  validateArtifact(record, "nativeHelper");
  validateArtifact(record, "hostRuntime");
  return record;
}

function attachRecordDir(record, dir) {
  Object.defineProperty(record, RECORD_DIR, {
    value: dir,
    enumerable: false,
    writable: false,
  });
  return record;
}

export function readProviderRecord(layout) {
  if (!existsSync(layout.providerRecord)) {
    throw new RuntimeNotInstalledError(
      "The execution runtime is not installed.\nRun: cloister runtime install",
    );
  }
  let record;
  try {
    record = JSON.parse(readFileSync(layout.providerRecord, "utf8"));
  } catch (error) {
    throw new RuntimeProviderError(
      `cannot read runtime provider record ${layout.providerRecord}: ${error.message}`,
    );
  }
  return attachRecordDir(validateRecord(record), dirname(layout.providerRecord));
}

export function resolveProviderArtifact(record, kind) {
  const artifact = validateArtifact(record, kind);
  const recordDir = record[RECORD_DIR];
  if (!recordDir) {
    throw new RuntimeProviderError("runtime provider record has no installation directory");
  }
  const file = resolve(recordDir, artifact.file);
  if (!existsSync(file)) {
    throw new RuntimeProviderError(
      `runtime provider artifact ${kind} is missing: ${file}`,
    );
  }
  const actual = sha256File(file);
  if (actual !== artifact.sha256) {
    throw new RuntimeProviderError(
      `runtime provider digest mismatch for ${kind}: expected ${artifact.sha256}, got ${actual}`,
    );
  }
  return file;
}
