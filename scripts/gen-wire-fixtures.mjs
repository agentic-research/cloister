#!/usr/bin/env node
/**
 * Generate reference wire-format fixtures via the capnp CLI.
 *
 * For each named const in `wire/cross-check-fixtures.capnp`, runs
 *   `capnp eval -I .. --no-standard-import wire/cross-check-fixtures.capnp <name> -b`
 * and embeds the resulting bytes as a Uint8Array literal in
 *   `test/wire/fixtures/canonical.ts`
 *
 * Tests in `test/wire/cross-check.test.ts` import that module and decode the
 * bytes with our hand-rolled decoder. If the decoded values match the
 * expected fixtures (the same logical values declared in the capnp file),
 * we have evidence that our reader interoperates with the reference encoder
 * — i.e., that cloister-companion (Rust, when shipped) will produce bytes
 * cloister-side can read.
 *
 * Phase 2D-codec.D substrate-equivalence proof, cloister-5183bc.
 *
 * Run: `task wire:fixtures` (or `node scripts/gen-wire-fixtures.mjs`).
 *
 * Note: this script DOES NOT round-trip our encoder back through capnp.
 * That is Direction 2 of the cross-check (our encode → capnp decode) and
 * is a separate Taskfile entry — see `task wire:verify-roundtrip`.
 */

import { schemaRoot } from "./schema-root.mjs";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Schema-root for capnp's `import "/cloister/manifest/cloister.capnp"` —
// the parent of the cloister repo directory. Derived from this script's
// own location so OSS clones work regardless of where the repo lives.
// Override with CLOISTER_SCHEMA_ROOT for worktrees not named `cloister/`.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// Shared derivation (cloister-70df69) — resolves in worktrees without env setup.
const REPO_PARENT = schemaRoot({
  schemaFile: resolve(SCRIPT_DIR, "..", "wire/cross-check-fixtures.capnp"),
  cwd: resolve(SCRIPT_DIR, ".."),
});
const FIXTURES_FILE = "wire/cross-check-fixtures.capnp";

// Logical fixtures — paired with the capnp const names declared in
// cross-check-fixtures.capnp. The TS variable names are the same as the
// capnp const names; tests reference them by name.
const FIXTURES = [
  "manifestCanonical",
  "manifestZeroSequence",
  "toolCallBasic",
  "toolCallEmpty",
  "toolCallWithArgs",
  "toolResultEmpty",
  "toolResultErrorEmpty",
  "toolResultText",
  "toolResultResource",
  "toolResultBinary",
  "toolResultMixed",
  "toolResultErrorWithText",
];

const out = [];
out.push("/**");
out.push(" * AUTO-GENERATED reference fixtures — do NOT edit by hand.");
out.push(` * Source: ${FIXTURES_FILE}`);
out.push(" * Regenerate with: `task wire:fixtures`");
out.push(" *");
out.push(" * Each export is the byte sequence produced by `capnp eval -b` for the");
out.push(" * named const in cross-check-fixtures.capnp. Used by Phase 2D-codec.D");
out.push(" * substrate-equivalence tests (cloister-5183bc).");
out.push(" */");
out.push("");

for (const name of FIXTURES) {
  const bytes = execFileSync(
    "capnp",
    ["eval", "-I", REPO_PARENT, "--no-standard-import", FIXTURES_FILE, name, "-b"],
    { encoding: null }, // raw Buffer
  );
  // Format as Uint8Array literal — 16 bytes per line for readability.
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const slice = bytes.subarray(i, Math.min(i + 16, bytes.length));
    chunks.push("  " + [...slice].map(b => "0x" + b.toString(16).padStart(2, "0")).join(", "));
  }
  out.push(`export const ${name} = new Uint8Array([`);
  out.push(chunks.join(",\n") + ",");
  out.push("]);");
  out.push("");
}

mkdirSync("test/wire/fixtures", { recursive: true });
writeFileSync("test/wire/fixtures/canonical.ts", out.join("\n"));

console.error(`gen-wire-fixtures: wrote test/wire/fixtures/canonical.ts (${FIXTURES.length} fixtures)`);
