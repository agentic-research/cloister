#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// gen/cli-schema.mjs — generate the CLI's schemas from manifest/cli.capnp,
// and hold each JSON output's format version to its shape (ADR-0077).
//
//   node gen/cli-schema.mjs              write src/generated/cli.zod.ts and
//                                        schema/cli.schema.json
//   node gen/cli-schema.mjs --check      fail if either differs from what
//                                        schema-bridge generates, or if an
//                                        output's shape changed and its
//                                        version did not
//   node gen/cli-schema.mjs --bump <Out> record <Out>'s new shape and version
//
// An output is a struct with a `formatVersion` field. Its version is
// "MAJOR.MINOR" and lives in schema/cli-formats.lock.json beside a signature
// of its shape: every field it can reach, by type, with descriptions left out
// (rewording a field is not a format change). `--bump` decides the bump
// itself: a field or enum value only added is a minor change; one removed or
// retyped is a major change. So a version cannot claim less than the change
// it records, and nobody has to remember the rule.
//
// The code that prints an output reads its version from the lock
// (cli/lib/output-format.mjs), so it is stated in one place.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { writeGeneratedFile } from "../cli/lib/atomic-write.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = "manifest/cli.capnp";
export const ZOD = "src/generated/cli.zod.ts";
export const JSON_SCHEMA = "schema/cli.schema.json";
export const LOCK = "schema/cli-formats.lock.json";

const plugin = (name) => execFileSync(process.execPath, [resolve(ROOT, "gen/fetch-schema-bridge.mjs"), name], { cwd: ROOT, encoding: "utf8" }).trim();

/** What schema-bridge generates from manifest/cli.capnp today. */
export function generate() {
  const out = mkdtempSync(join(tmpdir(), "cli-schema-"));
  try {
    const files = {};
    for (const [target, file, name] of [["zod", ZOD, "cli.zod.ts"], ["jsonschema", JSON_SCHEMA, "cli.schema.json"]]) {
      // `capnp compile` exits 0 when a plugin fails and writes nothing, so
      // the file's absence is the error, read below.
      try {
        execFileSync("capnp", ["compile", `-o${plugin(`capnpc-schema-bridge-${target}`)}:${out}`, SOURCE], { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] });
      } catch {
        throw new Error(`cli-schema: schema-bridge's ${target} output refused ${SOURCE}; its error is on stderr above`);
      }
      try {
        files[file] = readFileSync(join(out, name), "utf8");
      } catch {
        throw new Error(`cli-schema: schema-bridge wrote no ${name}; its error is on stderr above`);
      }
    }
    return files;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** The output names in a generated JSON Schema: every def with a formatVersion. */
export function outputsOf(schema) {
  return Object.entries(schema.$defs).filter(([, def]) => def.properties?.formatVersion).map(([name]) => name).sort();
}

/** The type of one property, as a string, descriptions left out. */
function typeOf(prop) {
  if (prop.$ref) return prop.$ref.replace("#/$defs/", "");
  if (prop.type === "array") return `${typeOf(prop.items)}[]`;
  if (prop.enum) return `enum`;
  return prop.type;
}

/**
 * The shape of an output: for each def it reaches, each field's type, and
 * each enum's values. Descriptions are not part of it.
 */
export function signatureOf(schema, output) {
  const sig = {};
  const visit = (name) => {
    if (sig[name]) return;
    const def = schema.$defs[name];
    if (def.enum) { sig[name] = { enum: [...def.enum].sort() }; return; }
    // A union is a oneOf of one-key objects; each variant is a field of the
    // union, so adding, removing or retyping one is a change like any other.
    const properties = def.oneOf
      ? Object.assign({}, ...def.oneOf.map((variant) => variant.properties))
      : def.properties ?? {};
    if (def.oneOf) sig[name] = { union: Object.fromEntries(Object.entries(properties).map(([k, p]) => [k, typeOf(p)])) };
    else sig[name] = { fields: Object.fromEntries(Object.entries(properties).map(([k, p]) => [k, typeOf(p)])) };
    for (const p of Object.values(properties)) {
      const ref = (p.$ref ?? p.items?.$ref)?.replace("#/$defs/", "");
      if (ref) visit(ref);
    }
  };
  visit(output);
  return Object.fromEntries(Object.entries(sig).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * How `next` differs from `prev`: "same", "minor" (only additions) or
 * "major" (anything removed or retyped), with what changed.
 */
export function changeBetween(prev, next) {
  const changes = [];
  let major = false;
  for (const [name, was] of Object.entries(prev)) {
    const now = next[name];
    if (!now) continue; // no longer reached: whatever reached it changed, and says so
    if (was.enum) {
      for (const v of was.enum) if (!now.enum?.includes(v)) { major = true; changes.push(`${name}: value "${v}" removed`); }
      for (const v of now.enum ?? []) if (!was.enum.includes(v)) changes.push(`${name}: value "${v}" added`);
      continue;
    }
    // A union's variants are its fields: a variant added is additive for a
    // reader that ignores what it does not know; one removed is not.
    const wasFields = was.fields ?? was.union;
    const nowFields = now.fields ?? now.union ?? {};
    if (Boolean(was.union) !== Boolean(now.union)) { major = true; changes.push(`${name}: ${was.union ? "union" : "struct"} became ${now.union ? "union" : "struct"}`); }
    for (const [field, type] of Object.entries(wasFields)) {
      if (!(field in nowFields)) { major = true; changes.push(`${name}.${field} removed`); }
      else if (nowFields[field] !== type) { major = true; changes.push(`${name}.${field}: ${type} became ${nowFields[field]}`); }
    }
    for (const field of Object.keys(nowFields)) if (!(field in wasFields)) changes.push(`${name}.${field} added`);
  }
  for (const name of Object.keys(next)) if (!prev[name]) changes.push(`${name} added`);
  return { kind: changes.length === 0 ? "same" : major ? "major" : "minor", changes };
}

const readLock = () => JSON.parse(readFileSync(resolve(ROOT, LOCK), "utf8"));
const writeLock = (lock) => writeGeneratedFile(resolve(ROOT, LOCK), `${JSON.stringify(lock, null, 2)}\n`);

function bumped(version, kind) {
  const [major, minor] = version.split(".").map(Number);
  return kind === "major" ? `${major + 1}.0` : `${major}.${minor + 1}`;
}

/** Problems with the committed files, as sentences. Empty when all is well. */
export function check() {
  const problems = [];
  const files = generate();
  for (const [file, text] of Object.entries(files)) {
    if (readFileSync(resolve(ROOT, file), "utf8") !== text) problems.push(`${file} differs from what schema-bridge generates from ${SOURCE}. Run \`task cli:schema\``);
  }
  const schema = JSON.parse(files[JSON_SCHEMA]);
  const lock = readLock();
  const outputs = outputsOf(schema);
  if (outputs.length === 0) problems.push(`${SOURCE} declares no output (no struct has a formatVersion field)`);
  for (const name of outputs) {
    const held = lock.outputs[name];
    if (!held) { problems.push(`${name} is a new output with no version. Run \`node gen/cli-schema.mjs --bump ${name}\``); continue; }
    const { kind, changes } = changeBetween(held.shape, signatureOf(schema, name));
    if (kind !== "same") problems.push(`${name}'s shape changed and its version (${held.formatVersion}) did not: ${changes.join("; ")}. That is a ${kind} change. Run \`node gen/cli-schema.mjs --bump ${name}\``);
  }
  for (const name of Object.keys(lock.outputs)) if (!outputs.includes(name)) problems.push(`${LOCK} holds ${name}, which ${SOURCE} no longer declares`);
  return problems;
}

function main(argv) {
  if (argv[0] === "--check") {
    const problems = check();
    for (const p of problems) console.error(`cli-schema: ${p}`);
    if (problems.length) process.exit(1);
    console.log(`cli-schema: OK — ${ZOD}, ${JSON_SCHEMA} and ${LOCK} match ${SOURCE}`);
    return;
  }
  if (argv[0] === "--bump") {
    const name = argv[1];
    const schema = JSON.parse(generate()[JSON_SCHEMA]);
    if (!outputsOf(schema).includes(name)) throw new Error(`cli-schema: ${SOURCE} declares no output named ${JSON.stringify(name)}`);
    const lock = readLock();
    const shape = signatureOf(schema, name);
    const held = lock.outputs[name];
    if (!held) {
      lock.outputs[name] = { formatVersion: "1.0", shape };
      console.log(`cli-schema: ${name} is new, at 1.0`);
    } else {
      const { kind, changes } = changeBetween(held.shape, shape);
      if (kind === "same") { console.log(`cli-schema: ${name}'s shape is unchanged; it stays at ${held.formatVersion}`); return; }
      lock.outputs[name] = { formatVersion: bumped(held.formatVersion, kind), shape };
      console.log(`cli-schema: ${name} ${held.formatVersion} → ${lock.outputs[name].formatVersion} (${kind}): ${changes.join("; ")}`);
    }
    lock.outputs = Object.fromEntries(Object.entries(lock.outputs).sort(([a], [b]) => a.localeCompare(b)));
    writeLock(lock);
    return;
  }
  for (const [file, text] of Object.entries(generate())) writeGeneratedFile(resolve(ROOT, file), text);
  console.log(`cli-schema: wrote ${ZOD} and ${JSON_SCHEMA}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
