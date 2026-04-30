#!/usr/bin/env node
/**
 * Compile a consumer's `cloister.capnp` into a typed TS module.
 *
 * Pipeline:
 *
 *   <repo>/cloister.capnp
 *           │
 *           │  capnp eval -o json
 *           ▼
 *   { metadata: ..., routes: [...] }     (JSON intermediate)
 *           │
 *           │  this script (≤200 LOC)
 *           ▼
 *   src/generated/manifest.ts            (typed TS module)
 *
 * The TS module re-exports a `manifest` const typed as the schema's `Gateway`,
 * with the JSON literal inlined. Zero runtime parsing — the TS compiler reads
 * the literal at build time.
 *
 * Usage:
 *   node scripts/build-manifest.mjs
 *
 * Env vars (all optional, sensible defaults):
 *   CLOISTER_MANIFEST   path to consumer cloister.capnp     (default: ./cloister.capnp)
 *   CLOISTER_SCHEMA     path to manifest/cloister.capnp     (default: ./manifest/cloister.capnp)
 *   CLOISTER_OUTPUT     where to write the generated TS    (default: ./src/generated/manifest.ts)
 *   CLOISTER_SCHEMA_ROOT root for capnp -I imports          (default: parent of CLOISTER_SCHEMA's dir)
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const REPO          = process.cwd();
const MANIFEST_FILE = process.env.CLOISTER_MANIFEST    ?? resolve(REPO, "cloister.capnp");
const SCHEMA_FILE   = process.env.CLOISTER_SCHEMA      ?? resolve(REPO, "manifest/cloister.capnp");
const OUTPUT_FILE   = process.env.CLOISTER_OUTPUT      ?? resolve(REPO, "src/generated/manifest.ts");
// Default import root: parent of the directory containing manifest/cloister.capnp.
// e.g. SCHEMA_FILE = /work/cloister/manifest/cloister.capnp
//      schemaDir   = /work/cloister/manifest
//      schemaRoot  = /work
// so an `import "/cloister/manifest/cloister.capnp"` resolves correctly.
const SCHEMA_ROOT   = process.env.CLOISTER_SCHEMA_ROOT ?? resolve(dirname(SCHEMA_FILE), "../..");

// ── Run capnp eval → JSON ─────────────────────────────────────────────────

let json;
try {
  const stdout = execFileSync(
    "capnp",
    ["eval", "-I", SCHEMA_ROOT, "--no-standard-import", MANIFEST_FILE, "gateway", "-o", "json"],
    { encoding: "utf8" },
  );
  json = JSON.parse(stdout);
} catch (e) {
  const stderr = e.stderr?.toString?.() ?? String(e);
  console.error(`build-manifest: capnp eval failed`);
  console.error(stderr);
  process.exit(1);
}

// ── Static validation (build-time, before the TS compiler sees this) ──────

validate(json);

// ── Emit the typed TS module ──────────────────────────────────────────────

const banner = [
  "/**",
  " * AUTO-GENERATED — do not edit. Regenerate with `task manifest`.",
  ` * Source: ${relPath(MANIFEST_FILE)}`,
  ` * Schema: ${relPath(SCHEMA_FILE)}`,
  ` * Built:  ${new Date().toISOString()}`,
  " */",
  "",
].join("\n");

const body = [
  `import type { Gateway } from "../manifest/types.js";`,
  "",
  `export const manifest: Gateway = ${JSON.stringify(json, null, 2)} as const;`,
  "",
].join("\n");

mkdirSync(dirname(OUTPUT_FILE), { recursive: true });
writeFileSync(OUTPUT_FILE, banner + body);

console.error(`build-manifest: wrote ${relPath(OUTPUT_FILE)}`);
console.error(`build-manifest:   ${json.metadata.name} v${json.metadata.version}`);
console.error(`build-manifest:   ${json.routes.length} route(s)`);

// ── Validation ────────────────────────────────────────────────────────────

function validate(g) {
  if (!g || typeof g !== "object") fail("manifest is not an object");
  if (!g.metadata || typeof g.metadata.name !== "string") fail("metadata.name missing");
  if (typeof g.metadata.version !== "string")             fail("metadata.version missing");
  if (!Array.isArray(g.routes))                           fail("routes is not a list");

  const seenPaths = new Set();
  const seenToolNames = new Set();
  const seenPrefixes = new Set();

  for (const r of g.routes) {
    if (typeof r.path !== "string")  fail(`route.path missing on ${JSON.stringify(r)}`);
    if (seenPaths.has(r.path))       fail(`duplicate route path: ${r.path}`);
    seenPaths.add(r.path);
    if (!r.kind || typeof r.kind !== "object") fail(`route.kind missing on ${r.path}`);
    const variants = Object.keys(r.kind);
    if (variants.length !== 1) fail(`route.kind must be exactly one variant on ${r.path}; got ${variants.length}`);

    // Path constraints — kept in sync with src/manifest/runtime.ts.
    // Catching these at build time prevents a "compiled manifest crashes
    // worker on boot" failure mode.
    if (r.kind.health && r.path !== "/health") {
      fail(`health route must have path "/health"; got "${r.path}"`);
    }
    if (r.kind.mcp && r.path !== "/mcp") {
      fail(`mcp route must have path "/mcp"; got "${r.path}"`);
    }
    if (r.kind.serviceBindingProxy) {
      const sbp = r.kind.serviceBindingProxy;
      if (r.path !== "/identity") {
        fail(`serviceBindingProxy currently only supports path "/identity"; got "${r.path}"`);
      }
      if (sbp.binding !== "NOTME") {
        fail(`serviceBindingProxy currently only supports binding "NOTME"; got "${sbp.binding}"`);
      }
      if (sbp.upstreamHost !== "notme-bot") {
        fail(`serviceBindingProxy upstreamHost must be "notme-bot"; got "${sbp.upstreamHost}"`);
      }
    }

    if (r.kind.mcp) {
      const backends = r.kind.mcp.backends ?? [];
      for (const b of backends) {
        if (typeof b.name !== "string")          fail(`backend.name missing on route ${r.path}`);
        if (typeof b.handlesPrefix !== "string") fail(`backend.handlesPrefix missing on ${b.name}`);

        // Empty prefix = exact-match-against-tool-list mode. Multiple
        // empty-prefix backends can coexist; the duplicate-prefix check
        // applies only to non-empty prefixes.
        if (b.handlesPrefix !== "") {
          if (seenPrefixes.has(b.handlesPrefix)) {
            fail(`duplicate backend prefix: ${b.handlesPrefix}`);
          }
          seenPrefixes.add(b.handlesPrefix);
        }

        const kindVariants = Object.keys(b.kind ?? {});
        if (kindVariants.length !== 1) fail(`backend.kind must be one variant on ${b.name}; got ${kindVariants.length}`);
        const inner = b.kind[kindVariants[0]];
        const tools = inner?.tools ?? [];
        for (const t of tools) {
          if (typeof t.name !== "string") fail(`tool.name missing on backend ${b.name}`);
          // Tool name must start with backend prefix when prefix is non-empty.
          // Mirrors runtime.ts; build-time catches keep boot-time failures away.
          if (b.handlesPrefix !== "" && !t.name.startsWith(b.handlesPrefix)) {
            fail(`tool "${t.name}" does not start with backend prefix "${b.handlesPrefix}"`);
          }
          if (seenToolNames.has(t.name))  fail(`duplicate tool name across backends: ${t.name}`);
          seenToolNames.add(t.name);
          if (typeof t.inputSchemaJson !== "string") {
            fail(`tool.inputSchemaJson must be a string on tool ${t.name}`);
          }
          try { JSON.parse(t.inputSchemaJson); }
          catch { fail(`tool.inputSchemaJson is not valid JSON on tool ${t.name}`); }
        }
      }
    }
  }
}

function fail(msg) {
  console.error(`build-manifest: validation failed — ${msg}`);
  process.exit(2);
}

function relPath(p) {
  const r = p.startsWith(REPO + "/") ? p.slice(REPO.length + 1) : p;
  return r;
}
