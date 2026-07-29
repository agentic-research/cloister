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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

import { parse as parseToml } from "@iarna/toml";

import { schemaRoot } from "./schema-root.mjs";

const REPO          = process.cwd();
const MANIFEST_FILE = process.env.CLOISTER_MANIFEST    ?? resolve(REPO, "cloister.capnp");
const SCHEMA_FILE   = process.env.CLOISTER_SCHEMA      ?? resolve(REPO, "manifest/cloister.capnp");
const OUTPUT_FILE   = process.env.CLOISTER_OUTPUT      ?? resolve(REPO, "src/generated/manifest.ts");
// Generated map of toolName → JSON Schema, produced by
// scripts/build-tool-schemas.mjs from src/tool-schemas/*.ts (zod). When
// present, it's the source of truth: the manifest's `inputSchemaJson`
// becomes either a parity check (must match) or empty (we inject).
// Per cloister-7ca96c.
const TOOL_SCHEMAS_FILE = process.env.CLOISTER_TOOL_SCHEMAS ?? resolve(REPO, "src/generated/tool-schemas.ts");
// Lockfile produced by scripts/resolve-inputs.mjs. When present, its
// [[generated_backends]] rows are merged into the manifest's /mcp
// McpRouteSpec.backends list by `overlayLockfileBackends()` below.
// Phase 1 of the LLO arc (cloister-05334b); the lockfile is a no-op
// when the file is absent (back-compat with pre-P3 cluster.toml).
//
// Default: SIBLING of CLOISTER_MANIFEST (so each recipe gets its own
// lockfile lookup; recipes without a `cluster.lock.toml` next to their
// `cloister.capnp` see no overlay — exactly what `task lint:recipes`
// needs to keep per-recipe builds independent of the repo-root lockfile).
const LOCKFILE       = process.env.CLOISTER_LOCKFILE   ?? resolve(dirname(MANIFEST_FILE), "cluster.lock.toml");
// Default import root: parent of the directory containing manifest/cloister.capnp.
// e.g. SCHEMA_FILE = /work/cloister/manifest/cloister.capnp
//      schemaDir   = /work/cloister/manifest
//      schemaRoot  = /work
// so an `import "/cloister/manifest/cloister.capnp"` resolves correctly.
const SCHEMA_ROOT   = schemaRoot({ schemaFile: SCHEMA_FILE, cwd: REPO });

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

// ── Overlay TS-sourced tool schemas (cloister-7ca96c) ─────────────────────
//
// If `src/generated/tool-schemas.ts` exists, it's the source of truth.
// For each tool in the manifest, we either inject (when the manifest
// has `inputSchemaJson = ""`) or parity-check (when both are present).
// Any drift fails the build with a precise error.

await overlayToolSchemas(json);

/**
 * The row contract, DERIVED from `manifest/cluster.capnp` (cloister-71a9f4).
 *
 * `struct GeneratedBackend` is declared in the schema; schema-bridge emits a
 * strict `GeneratedBackendSchema` for it. Reading the shape from that schema
 * means the field list, the types, and the strictness all come from one
 * declaration. The hand-maintained JS table this replaces was the same
 * species of defect it was written to fix: a list nothing checked against
 * the schema it was mirroring.
 *
 * Absence still takes the capnp zero value, so older lockfiles predating a
 * field keep building. Those zeros are derived from the schema's own types,
 * not enumerated here.
 */
async function loadGeneratedBackendContract() {
  const mod = await import(pathToFileURL(resolve(REPO, "src/generated/cluster.zod.ts")).href);
  const schema = mod.GeneratedBackendSchema;
  const inner = schema?._def?.getter?.() ?? schema?.def?.getter?.();
  const shape = inner?.shape;
  if (!shape) {
    fail(
      "could not introspect GeneratedBackendSchema from src/generated/cluster.zod.ts — " +
      "the generator's output shape changed. Fix this rather than reinstating a hand-written " +
      "field table; the whole point is that the contract has one source.",
    );
  }

  // The generator emits `.default(...)` per field (ley-line-open 8c00c6), so
  // absence is handled by the schema itself and there are no zeros to
  // synthesise here.
  const node = shape.dynamicTools;
  const nodeType = node?._def?.type ?? node?.def?.type;
  if (nodeType !== "default") {
    fail(
      "GeneratedBackendSchema no longer supplies field defaults — an older schema-bridge " +
      "is pinned. Absence would be rejected instead of defaulted, breaking older lockfiles.",
    );
  }

  return { schema };
}

// ── Overlay [[generated_backends]] from cluster.lock.toml ────────────────
//
// Phase 1 of the LLO arc (cloister-05334b). Reads cluster.lock.toml when
// present + injects one mcpProxy backend per [[generated_backends]] row
// into the /mcp route's `backends` list. Hand-shells with the same name
// as a generated row are replaced + a warning is logged so the operator
// knows to delete the shell.
await overlayLockfileBackends(json);

// ── Static validation (build-time, before the TS compiler sees this) ──────

validate(json);

// ── Mirror runtime invariants at build time (cloister-8f57f0 Copilot #1) ──
//
// Don't duplicate validation logic — IMPORT the runtime helper. Same
// code path runs at boot (instantiate manifest) and at build (this
// script via tsx). Any new manifest invariant added to runtime.ts is
// automatically enforced here too; no parallel implementation to keep
// in sync.
{
  const { buildServiceRegistry } = await import("../src/manifest/vault-proxy-services.ts");
  try {
    buildServiceRegistry(json.vaultProxyServices ?? []);
  } catch (e) {
    fail(`vaultProxyServices: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── Emit the typed TS module ──────────────────────────────────────────────

// No `Built:` timestamp in the banner — the generated file is checked
// in, and a wall-clock stamp would force every regen to diff (which
// breaks the `generated-drift` CI gate).
const banner = [
  "/**",
  " * AUTO-GENERATED — do not edit. Regenerate with `task manifest`.",
  ` * Source: ${relPath(MANIFEST_FILE)}`,
  ` * Schema: ${relPath(SCHEMA_FILE)}`,
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
  const seenClaimsPrefixes = new Set();

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

        const hasClaims = (b.kind?.mcpProxy?.claims?.length ?? 0) > 0;

        // cloister-3b8cd6: mirror src/manifest/runtime.ts validate() at BUILD
        // time. A dynamicTools backend with empty handlesPrefix AND empty claims
        // has no routing discriminator — runtime.ts throws on it, but only at
        // instantiate (i.e. `wrangler dev` boot), several steps removed from the
        // cause. The resolver's single-backend fallback (a server.json with no
        // _meta.art.cloister/v1.groups[]) emits exactly this shape, so catch it
        // here where `task manifest` runs, naming the backend + the fix.
        if (b.kind?.mcpProxy?.dynamicTools === true && b.handlesPrefix === "" && !hasClaims) {
          fail(
            `backend "${b.name}" has dynamicTools=true but empty handlesPrefix AND ` +
            `empty claims — unroutable; workerd refuses to boot (mirrors ` +
            `runtime.ts validate()). Its source input needs an ` +
            `_meta.art.cloister/v1.groups[] block (upstreamNames → claims) or a ` +
            `handlesPrefix.`,
          );
        }

        // Empty prefix = exact-match-against-tool-list mode. Multiple
        // empty-prefix backends can coexist; the duplicate-prefix check
        // applies only to non-empty prefixes — UNLESS every backend
        // sharing the prefix has a non-empty `claims` set. Mirrors
        // src/manifest/runtime.ts's validate(): McpProxyToolBackend.handles()
        // checks `claims` BEFORE falling back to prefix matching, so two
        // claims-backed backends sharing a prefix dispatch by exact
        // upstream tool name, not by prefix — no first-wins-shadow hazard.
        // This is the shape the P3 resolver produces for a multi-group
        // server.json whose groups share one `advertisedPrefix`
        // (cloister-cb7263; e.g. mache's navigation/callgraph/lsp/
        // lifecycle/linter/mutate groups all advertise under "mache_" but
        // claim disjoint tool sets).
        if (b.handlesPrefix !== "") {
          const prefixSeenBefore = seenPrefixes.has(b.handlesPrefix);
          const bothClaimsBacked = hasClaims && seenClaimsPrefixes.has(b.handlesPrefix);
          if (prefixSeenBefore && !bothClaimsBacked) {
            if (hasClaims || seenClaimsPrefixes.has(b.handlesPrefix)) {
              fail(
                `backend "${b.name}" shares prefix "${b.handlesPrefix}" with a claims-less ` +
                `backend — the claims-less backend falls back to prefix matching in handles() ` +
                `and would collide`,
              );
            }
            fail(`duplicate backend prefix: ${b.handlesPrefix}`);
          }
          if (hasClaims) seenClaimsPrefixes.add(b.handlesPrefix);
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
          // After the overlay step, every tool MUST have a populated schema —
          // either from the TS source (preferred) or the legacy inline JSON.
          // Empty string means: zod schema missing AND no inline fallback.
          if (t.inputSchemaJson === "") {
            fail(`tool ${t.name} has no input schema — register it in src/tool-schemas/ or set inputSchemaJson in cloister.capnp`);
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

// ── TS-sourced tool schema overlay ────────────────────────────────────────
//
// Source: scripts/build-tool-schemas.mjs writes
// `src/generated/tool-schemas.ts`, exporting `toolSchemas: Record<name,
// JSONSchema>`. This function loads it and either INJECTS the schema
// (when the manifest has `inputSchemaJson = ""`) or PARITY-CHECKS it
// (when the manifest has a non-empty inputSchemaJson).
//
// "Drift" here means: a tool's manifest-declared schema disagrees with
// the TS handler's actual schema. That's the cloister-7ca96c bug class.
// Build fails on drift, with a diff in the error message.

async function overlayToolSchemas(g) {
  if (!existsSync(TOOL_SCHEMAS_FILE)) {
    // Bootstrap path — first invocation before tool-schemas.ts exists.
    // Skip silently; legacy inline JSON path still works.
    return;
  }

  let toolSchemas;
  try {
    const mod = await import(pathToFileURL(TOOL_SCHEMAS_FILE).href);
    toolSchemas = mod.toolSchemas;
  } catch (e) {
    console.error(`build-manifest: failed to load ${relPath(TOOL_SCHEMAS_FILE)} — ${e?.message ?? e}`);
    process.exit(2);
  }
  if (!toolSchemas || typeof toolSchemas !== "object") {
    fail(`${relPath(TOOL_SCHEMAS_FILE)} must export \`toolSchemas\` as an object`);
  }

  let injected = 0, parity = 0;

  for (const r of g.routes ?? []) {
    if (!r.kind?.mcp) continue;
    for (const b of r.kind.mcp.backends ?? []) {
      const inner = b.kind?.[Object.keys(b.kind ?? {})[0]];
      const tools = inner?.tools ?? [];
      for (const t of tools) {
        const tsSchema = toolSchemas[t.name];
        if (!tsSchema) continue;  // Tool not in TS registry — keep manifest value.

        const tsJson = JSON.stringify(tsSchema);
        if (t.inputSchemaJson === "") {
          // Inject. This is the post-migration path: cloister.capnp drops
          // the inline JSON; build wires it in here.
          t.inputSchemaJson = tsJson;
          injected += 1;
        } else {
          // Parity check. Both sources present — must match exactly.
          // Comparison is structural via canonical JSON: parse + re-stringify
          // so whitespace/key-order differences don't false-positive.
          let manifestSchema;
          try { manifestSchema = JSON.parse(t.inputSchemaJson); }
          catch { fail(`tool.inputSchemaJson is not valid JSON on tool ${t.name}`); }
          const manifestCanonical = JSON.stringify(manifestSchema);
          const tsCanonical = tsJson;
          if (manifestCanonical !== tsCanonical) {
            console.error(`build-manifest: schema drift on tool "${t.name}" (cloister-7ca96c)`);
            console.error(`  manifest (cloister.capnp): ${manifestCanonical}`);
            console.error(`  TS (src/tool-schemas/):    ${tsCanonical}`);
            console.error(`  Resolution: drop the inline JSON in cloister.capnp (set inputSchemaJson = "")`);
            console.error(`              and let the TS schema be the source of truth, OR update`);
            console.error(`              src/tool-schemas/ to match the manifest if the manifest is right.`);
            process.exit(2);
          }
          parity += 1;
        }
      }
    }
  }

  if (injected || parity) {
    console.error(`build-manifest:   tool schemas: ${injected} injected, ${parity} parity-checked`);
  }
}

function relPath(p) {
  const r = p.startsWith(REPO + "/") ? p.slice(REPO.length + 1) : p;
  return r;
}

// ── Lockfile → /mcp backend overlay (cloister-05334b, P1 of LLO arc) ─────
//
// Reads `cluster.lock.toml` (when present) + injects one mcpProxy backend
// per [[generated_backends]] row into the /mcp route. The lockfile is
// produced by `scripts/resolve-inputs.mjs` from cluster.toml's `[inputs.*]`
// blocks; each input resolves to bytes + (optionally) an
// `_meta.art.cloister/v1.groups[]` block. Each group becomes one
// generated backend row.
//
// Precedence (when a hand-shell in cloister.capnp and a generated row
// share the same backend name):
//
//   GENERATED WINS. The hand-shell's mcpProxy payload is replaced with
//   the generated shape. A warning is logged to stderr so the operator
//   notices + can delete the shell. The Phase 1 goal is gradual
//   migration: operators move upstream by upstream from hand-declared
//   shells to lockfile-driven backends.
//
// No-op behavior:
//
//   - Lockfile file missing → silent skip (back-compat: pre-P3
//     cluster.toml files without [inputs.*] don't get a lockfile).
//   - Lockfile parses but carries no [[generated_backends]] rows →
//     silent skip (the resolver only writes the section when at least
//     one input produced rows).
//   - Manifest has no /mcp route → log a warning; the generated
//     backends have nowhere to land.
//
// Adding a new generated-backend FIELD (e.g. `stripPrefix`, `protocolMode`)
// means extending the row→backend mapping inside this function; the
// schema add at @ordinal lives in `manifest/cloister.capnp:HttpForwardBackend`.

async function overlayLockfileBackends(g) {
  if (!existsSync(LOCKFILE)) {
    return;
  }
  let doc;
  try {
    doc = parseToml(readFileSync(LOCKFILE, "utf8"));
  } catch (e) {
    fail(`failed to parse ${relPath(LOCKFILE)}: ${e?.message ?? e}`);
  }
  const rows = doc.generated_backends;
  if (!Array.isArray(rows) || rows.length === 0) {
    return;
  }

  // Locate the /mcp route's backends array. The manifest schema allows
  // any path for the mcp route kind, but build-manifest's existing
  // validation pins /mcp specifically; we mirror that here so the lookup
  // is unambiguous.
  const mcpRoute = (g.routes ?? []).find((r) => r?.kind?.mcp);
  if (!mcpRoute) {
    console.error(
      `build-manifest: ${relPath(LOCKFILE)} declares ${rows.length} generated backend(s) ` +
      `but the manifest has no /mcp route to inject them into — skipping`,
    );
    return;
  }
  const backends = mcpRoute.kind.mcp.backends ?? (mcpRoute.kind.mcp.backends = []);

  // Loaded once, after the early returns — a manifest with no lockfile rows
  // should not pay to import the generated schema.
  const contract = await loadGeneratedBackendContract();

  // Index hand-shells by name so collision detection is O(N) not O(N*M).
  const shellsByName = new Map(backends.map((b, i) => [b.name, i]));
  const collisions = [];
  let injected = 0;
  let replaced = 0;

  // Names already claimed by a PRIOR generated row this pass, so a later
  // row from a different input can be detected and qualified instead of
  // silently overwriting the earlier one. meta-groups.md only promises
  // group-name uniqueness WITHIN one server.json's groups[] (§`name`:
  // "unique within the groups[] array of THIS server.json") — nothing
  // stops two different inputs (e.g. llo and mache) from both naming a
  // group "lsp"/"lifecycle". Before this fix, `shellsByName`'s "generated
  // wins" precedence (meant for hand-shell-vs-generated) silently applied
  // to generated-vs-generated too: whichever input's row came later in
  // cluster.lock.toml's [[generated_backends]] array clobbered the
  // earlier one under the SAME backend.name key, dropping the earlier
  // input's tools with only a misleading "hand-shell collision" log line
  // (there was no hand-shell at all).
  const generatedNamesByInput = new Map(); // name -> input that generated it

  for (const row of rows) {
    // No null guard: backendFromGeneratedRow either returns a backend or
    // fails the build. A malformed row is no longer skippable.
    const backend = backendFromGeneratedRow(row, contract);

    const priorInput = generatedNamesByInput.get(backend.name);
    if (priorInput !== undefined && priorInput !== row.input) {
      // Cross-input collision: qualify THIS row's name by its input so
      // both backends survive instead of one clobbering the other.
      // `${input}/${name}` mirrors the `input` field already carried on
      // every generated_backends row for traceability.
      const qualifiedName = `${row.input}/${row.name}`;
      console.error(
        `build-manifest: generated_backends name collision — "${backend.name}" is ` +
        `declared by both input "${priorInput}" and input "${row.input}"; qualifying ` +
        `the latter as "${qualifiedName}" so neither input's tools are dropped. ` +
        `(meta-groups.md only guarantees group-name uniqueness within one server.json.)`,
      );
      backend.name = qualifiedName;
    }
    generatedNamesByInput.set(backend.name, row.input);

    const existingIdx = shellsByName.get(backend.name);
    if (existingIdx !== undefined) {
      // Collision: a hand-shell with the same name already exists.
      // Generated wins — replace the entry in place to keep the original
      // declaration order stable.
      backends[existingIdx] = backend;
      shellsByName.set(backend.name, existingIdx);
      collisions.push(backend.name);
      replaced += 1;
    } else {
      backends.push(backend);
      shellsByName.set(backend.name, backends.length - 1);
      injected += 1;
    }
  }

  if (collisions.length > 0) {
    // One warning line per collision so a noisy lockfile surfaces every
    // offender. The hint at the end tells the operator the fix.
    for (const name of collisions) {
      console.error(
        `build-manifest: lockfile collision — backend "${name}" exists in ` +
        `${relPath(MANIFEST_FILE)} as a hand-shell AND in ${relPath(LOCKFILE)} ` +
        `as a [[generated_backends]] row. The generated row WINS (Phase 1 ` +
        `precedence per cloister-05334b). Delete the hand-shell from ` +
        `${relPath(MANIFEST_FILE)} once you've verified the generated backend works.`,
      );
    }
  }
  if (injected || replaced) {
    console.error(
      `build-manifest:   lockfile backends: ${injected} injected, ${replaced} replaced (collision precedence)`,
    );
  }
}

/**
 * Convert one [[generated_backends]] row from cluster.lock.toml into a
 * Backend declaration matching the manifest JSON shape. Returns `null`
 * + logs a warning if the row is malformed (so a single bad row doesn't
 * tank the whole build).
 *
 * Row shape (per scripts/resolve-inputs.mjs `deriveGeneratedBackends`):
 *
 *   { input, name, handlesPrefix, stripPrefix, claims, dynamicTools,
 *     urlBinding, serviceBinding }
 *
 * Backend output:
 *
 *   { name, handlesPrefix, kind: { mcpProxy: { urlBinding, tools: [],
 *                                              dynamicTools, claims,
 *                                              stripPrefix,
 *                                              serviceBinding } } }
 *
 * `tools` is always `[]` — the catalog is derived at request time from
 * the upstream's `tools/list` (the row's `dynamicTools: true` semantics).
 * `claims` populates `HttpForwardBackend.claims` (cloister-8ede3f, P1)
 * which filters the derived catalog to just the names the row owns.
 * `stripPrefix` (cloister-2d987e, Bug 3 of the mache resolver migration):
 * `McpProxyToolBackend.handles()` checks the ADVERTISED tool name against
 * `claims`, which holds the BARE upstreamNames. When a group's
 * `advertisedPrefix` is non-empty but its `upstreamNames` are bare (e.g.
 * mache: prefix "mache_", claim "find_callers"), the advertised name
 * ("mache_find_callers") never matches `claims` without stripping the
 * prefix first — `resolve-inputs.mjs:deriveStripPrefix` computes the
 * right value; this function only threads it through.
 */
function backendFromGeneratedRow(row, contract) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    fail(`generated_backends row is not a table: ${JSON.stringify(row)}`);
  }

  // Absent ⇒ capnp zero (older lockfiles predate newer fields). Present ⇒ the
  // row's own value, which the strict schema then judges. Because the schema
  // is `.strict()`, an unknown key survives the spread and is rejected — that
  // is the typo case (`handlesPrefixx` used to build cleanly into a backend
  // matching nothing).
  const parsed = contract.schema.safeParse(row);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue.path.length ? ` field ${JSON.stringify(issue.path.join("."))}` : "";
    fail(
      `generated_backends row ${JSON.stringify(row.name ?? "(unnamed)")}${where}: ` +
      `${issue.message}`,
    );
  }
  row = parsed.data;

  if (typeof row.name !== "string" || row.name === "") {
    fail(`generated_backends row has no name: ${JSON.stringify(row)}`);
  }

  const handlesPrefix   = row.handlesPrefix   ?? "";
  const stripPrefix     = row.stripPrefix     ?? "";
  const urlBinding      = row.urlBinding      ?? "";
  const serviceBinding  = row.serviceBinding  ?? "";
  const dynamicTools    = row.dynamicTools    ?? true;
  const requiresSession = row.requiresSession ?? false;
  const claims          = (row.claims ?? []).slice();

  const mcpProxy = {
    urlBinding,
    tools: [],
    dynamicTools,
  };
  // Match the existing shape: serviceBinding + claims + stripPrefix are
  // only emitted when populated, to keep diffs tight when a backend
  // doesn't use them. (capnp's JSON encoding for optional fields is
  // "field-present-as-default" OR "field-absent"; the runtime types
  // accept both. We emit them explicitly when populated.)
  if (serviceBinding !== "") mcpProxy.serviceBinding = serviceBinding;
  if (requiresSession)       mcpProxy.requiresSession = true;
  if (claims.length > 0)     mcpProxy.claims         = claims;
  if (stripPrefix !== "")    mcpProxy.stripPrefix     = stripPrefix;

  return {
    name:          row.name,
    handlesPrefix,
    kind:          { mcpProxy },
  };
}
