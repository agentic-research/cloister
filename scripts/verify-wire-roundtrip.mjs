#!/usr/bin/env node
/**
 * Substrate-equivalence proof, Direction 2: our encoder → capnp ↔ ours.
 *
 * Phase 2D-codec.E (cloister-5183bc). Direction 1 is a vitest-side test
 * (`test/wire/cross-check.test.ts`); Direction 2 needs to shell out to the
 * capnp CLI which vitest-pool-workers can't do, so it lives here.
 *
 * Per-fixture flow:
 *
 *     V  --our.encode-->  B  --capnp decode--> T  --capnp encode--> B'
 *     V' <--our.decode--  B'
 *     assert V == V'
 *
 * If our bytes (B) round-trip through capnp's text formatter and back
 * (B') and our decoder produces the same logical value (V'), then:
 *   1. Our encoder produces VALID capnp (capnp accepted B without error)
 *   2. The encoded structure is preserved through capnp's parser
 *   3. The bytes are interoperable in both directions
 *
 * Combined with Direction 1 (capnp emits, we decode), this proves the
 * bidirectional substrate-equivalence contract for ADR-0005.
 *
 * The Taskfile entry pre-compiles src/wire/*.ts → dist-verify/wire/*.js
 * before running this script.
 *
 * Exit codes: 0 = all fixtures verified; 1 = any mismatch.
 */

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeManifest, decodeManifest } from "../dist-verify/src/wire/manifest.js";
import { encodeToolCall, decodeToolCall } from "../dist-verify/src/wire/tool-call.js";
import { encodeToolResult, decodeToolResult } from "../dist-verify/src/wire/tool-result.js";

// Schema-root for capnp's `-I` flag — the parent of the cloister repo
// directory, where `import "/cloister/.../cloister.capnp"` resolves
// against. Derived from this script's location so OSS clones work
// regardless of repo path. Override via CLOISTER_SCHEMA_ROOT for
// non-`cloister/`-named worktrees.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_PARENT = process.env.CLOISTER_SCHEMA_ROOT
  ?? resolve(SCRIPT_DIR, "..", "..");
const SCHEMA = "wire/cloister.capnp";

const filled = (n, byte) => { const a = new Uint8Array(n); a.fill(byte); return a; };
const enc = (s) => new TextEncoder().encode(s);
const eq  = (a, b) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

const FIXTURES = [
  {
    name: "Manifest canonical",
    type: "Manifest",
    value: {
      sequence:    42n,
      publicKey:   filled(32, 0x11),
      signature:   filled(64, 0x22),
      contentHash: filled(32, 0x33),
    },
    encode: encodeManifest,
    decode: decodeManifest,
    equals: (a, b) =>
      a.sequence === b.sequence &&
      eq(a.publicKey, b.publicKey) &&
      eq(a.signature, b.signature) &&
      eq(a.contentHash, b.contentHash),
  },
  {
    name: "Manifest sequence=0",
    type: "Manifest",
    value: {
      sequence:    0n,
      publicKey:   filled(32, 0xAA),
      signature:   filled(64, 0xBB),
      contentHash: filled(32, 0xCC),
    },
    encode: encodeManifest,
    decode: decodeManifest,
    equals: (a, b) =>
      a.sequence === b.sequence &&
      eq(a.publicKey, b.publicKey) &&
      eq(a.signature, b.signature) &&
      eq(a.contentHash, b.contentHash),
  },
  {
    name: "ToolCall basic",
    type: "ToolCall",
    value: { upstreamId: "rosary", toolName: "rsry_status", argumentsJson: enc("{}") },
    encode: encodeToolCall,
    decode: decodeToolCall,
    equals: (a, b) =>
      a.upstreamId === b.upstreamId &&
      a.toolName === b.toolName &&
      eq(a.argumentsJson, b.argumentsJson),
  },
  {
    name: "ToolCall realistic args",
    type: "ToolCall",
    value: {
      upstreamId: "leyline",
      toolName: "lsp_hover",
      argumentsJson: enc('{"col":5,"file":"/x/foo.rs","line":10}'),
    },
    encode: encodeToolCall,
    decode: decodeToolCall,
    equals: (a, b) =>
      a.upstreamId === b.upstreamId &&
      a.toolName === b.toolName &&
      eq(a.argumentsJson, b.argumentsJson),
  },
  {
    name: "ToolResult empty",
    type: "ToolResult",
    value: { content: [], isError: false },
    encode: encodeToolResult,
    decode: decodeToolResult,
    equals: trEqual,
  },
  {
    name: "ToolResult error+text",
    type: "ToolResult",
    value: {
      content: [{ kind: "text", text: "tool failed: missing 'file' argument" }],
      isError: true,
    },
    encode: encodeToolResult,
    decode: decodeToolResult,
    equals: trEqual,
  },
  {
    name: "ToolResult binary (PNG sig)",
    type: "ToolResult",
    value: {
      content: [{
        kind: "binary",
        binary: { data: new Uint8Array([0x89, 0x50, 0x4E, 0x47]), mimeType: "image/png" },
      }],
      isError: false,
    },
    encode: encodeToolResult,
    decode: decodeToolResult,
    equals: trEqual,
  },
  {
    name: "ToolResult resource",
    type: "ToolResult",
    value: { content: [{ kind: "resource", resource: enc("opaque") }], isError: false },
    encode: encodeToolResult,
    decode: decodeToolResult,
    equals: trEqual,
  },
  {
    name: "ToolResult mixed (4 elements)",
    type: "ToolResult",
    value: {
      content: [
        { kind: "text", text: "first" },
        { kind: "binary", binary: { data: new Uint8Array([1, 2, 3]), mimeType: "application/octet-stream" } },
        { kind: "resource", resource: enc("opaque2") },
        { kind: "text", text: "last" },
      ],
      isError: false,
    },
    encode: encodeToolResult,
    decode: decodeToolResult,
    equals: trEqual,
  },
];

function trEqual(a, b) {
  if (a.isError !== b.isError) return false;
  if (a.content.length !== b.content.length) return false;
  for (let i = 0; i < a.content.length; i++) {
    const ae = a.content[i], be = b.content[i];
    if (ae.kind !== be.kind) return false;
    if (ae.kind === "text"     && ae.text !== be.text) return false;
    if (ae.kind === "resource" && !eq(ae.resource, be.resource)) return false;
    if (ae.kind === "binary") {
      if (!eq(ae.binary.data, be.binary.data)) return false;
      if (ae.binary.mimeType !== be.binary.mimeType) return false;
    }
  }
  return true;
}

// ── Runner ────────────────────────────────────────────────────────────────

let failed = 0, passed = 0;

for (const f of FIXTURES) {
  const ourBytes = f.encode(f.value);

  // Step 1: capnp parses our bytes (if it errors, our encoder is broken).
  let text;
  try {
    text = execFileSync(
      "capnp",
      ["decode", "-I", REPO_PARENT, "--no-standard-import", SCHEMA, f.type],
      { input: Buffer.from(ourBytes), encoding: "utf-8" },
    );
  } catch (e) {
    console.error(`✗ ${f.name}: capnp REJECTED our bytes`);
    console.error(`  stderr: ${e.stderr?.toString?.() ?? String(e)}`);
    failed++; continue;
  }

  // Step 2: capnp re-encodes the text back to binary.
  let capnpBytes;
  try {
    capnpBytes = execFileSync(
      "capnp",
      ["encode", "-I", REPO_PARENT, "--no-standard-import", SCHEMA, f.type],
      { input: text, encoding: null },
    );
  } catch (e) {
    console.error(`✗ ${f.name}: capnp encode (round-trip) failed`);
    console.error(`  stderr: ${e.stderr?.toString?.() ?? String(e)}`);
    console.error(`  text input was:\n${text}`);
    failed++; continue;
  }

  // Step 3: our decoder reads capnp's bytes and produces a value matching
  // the original logical value.
  let roundTripped;
  try {
    roundTripped = f.decode(new Uint8Array(capnpBytes));
  } catch (e) {
    console.error(`✗ ${f.name}: our decoder rejected capnp's re-encoded bytes`);
    console.error(`  error: ${e.message}`);
    failed++; continue;
  }

  if (f.equals(f.value, roundTripped)) {
    console.log(`✓ ${f.name}`);
    passed++;
  } else {
    console.error(`✗ ${f.name}: round-trip altered the value`);
    console.error(`  original:    ${JSON.stringify(f.value, jsonReplacer, 2)}`);
    console.error(`  roundTripped:${JSON.stringify(roundTripped, jsonReplacer, 2)}`);
    failed++;
  }
}

function jsonReplacer(_k, v) {
  if (v instanceof Uint8Array) return `Uint8Array(${v.length})[${[...v.subarray(0, 16)].map(b=>b.toString(16).padStart(2,"0")).join(" ")}${v.length>16?" …":""}]`;
  if (typeof v === "bigint") return v.toString();
  return v;
}

console.error(`\n${passed}/${FIXTURES.length} fixtures verified`);
process.exit(failed === 0 ? 0 : 1);
