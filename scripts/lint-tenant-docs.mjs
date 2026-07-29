#!/usr/bin/env node
// scripts/lint-tenant-docs.mjs
//
// Drift gate for docs/tenants/ — asserts every tenant declared in
// `cloister.capnp` and every sibling service in `cluster.compose.yaml`
// has a corresponding markdown page under `docs/tenants/`. Companion to
// lint-paths.mjs (drift class) and lint-bundle-isolation.mjs
// (substrate class). Per cloister-c9df61.
//
// ── Rule (deterministic name-matching) ───────────────────────────────────
//
// The rule has two halves:
//
//   1. MCP tenants — every `Backend` in cloister.capnp's
//      `routes[].mcp.backends` MUST resolve to a `docs/tenants/<doc>.md`
//      file. The mapping from backend name to doc filename is:
//
//        backend `bead`              → `bead-mcp.md`
//        backend `mache`             → `mache-mcp.md`
//        backend `lsp`               → `lsp-mcp.md`
//        backend `leyline-lifecycle` → `ley-line-mcp.md`
//        any other name `<x>`        → `<x>-mcp.md`  (fallback)
//
//      The first three are special-cased here so the lint message
//      points at the right file. `leyline-lifecycle` → `ley-line-mcp`
//      is the one rename that doesn't fall out of a naive transform —
//      the backend name reflects the cap'n proto field, while the
//      doc filename reflects the upstream project.
//
//   2. Non-MCP tenants — every `Route` whose `kind` is one of the
//      tenant-bearing variants (`wellKnownIdentityBridge` today) MUST
//      resolve to `docs/tenants/<slug>.md`. The mapping is:
//
//        kind `wellKnownIdentityBridge` → `identity-bridge.md`
//
//      Other route kinds are SUBSTRATE — explicitly excluded by the
//      `SUBSTRATE_ROUTE_KINDS` set below. Adding a new MCP-shaped
//      tenant means either (a) extending the explicit map here or
//      (b) following the fallback transform (kind name → kebab-case
//      slug). Adding a substrate route means extending the exclude
//      list (and likely an ADR).
//
//   3. Compose services — every service in `cluster.compose.yaml`
//      MUST EITHER (a) be on the hypervisor-substrate exclude list
//      (`SUBSTRATE_COMPOSE_SERVICES`, declared below) OR (b) resolve
//      to a tenant doc by the same name-mapping rules. A service that
//      isn't on the exclude list and has no doc fails the lint.
//      `rosary` is currently a SUBSTRATE exclude because it's not
//      exposed through cloister yet (per the comment in
//      `cloister.capnp` referencing cloister-824849 — blocked on
//      ADR-0005 / cloister-companion). When rosary ships as a tenant,
//      remove it from the exclude list and add `rosary-mcp.md`.
//
// ── Exit codes ───────────────────────────────────────────────────────────
//
//   0 — every declared tenant has a doc page
//   1 — drift found; missing-doc list on stderr
//   2 — toolchain error (capnp eval failed, compose.yaml unreadable, …)

import { schemaRoot as deriveSchemaRoot } from "./schema-root.mjs";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = process.cwd();
const TENANT_DIR = resolve(REPO, "docs/tenants");

// ── Mappings (explicit, name-matched) ────────────────────────────────────

// Backend name → doc filename (without `.md`). Anything not listed falls
// back to `<name>-mcp.md`.
const BACKEND_NAME_TO_DOC = {
  "bead": "bead-mcp",
  "mache": "mache-mcp",
  "lsp": "lsp-mcp",
  "leyline-lifecycle": "ley-line-mcp",
};

// Route kind (the discriminated-union tag in `Route.kind`) → doc
// filename. Only tenant-bearing kinds appear here.
const ROUTE_KIND_TO_DOC = {
  "wellKnownIdentityBridge": "identity-bridge",
};

// Route kinds that are SUBSTRATE — not tenants. Adding a kind here is
// an editorial call ratified by the surrounding code/ADRs; the lint
// just enforces the bookkeeping.
const SUBSTRATE_ROUTE_KINDS = new Set([
  "health",
  "wellKnownInterlace",
  "disclosure",
  "ociRegistry",
  "wellKnownMcpRegistry",
  "serviceBindingProxy",   // `/identity/*` proxy — substrate seam, not a tenant
  "httpProxy",              // outer-layer HTTP forward; not currently used as a tenant
  "mcp",                    // the /mcp route itself — its backends are the tenants
  "caBundle",               // Interlace 0.2.0 archival CA bundle endpoint
                            // (cloister-ae713f) — substrate-side identity
                            // surface, not a tenant. RECEIPTS.md §2.3, §2.7.
  "vaultProxy",             // credential-isolation/v1 route (ADR-0024 /
                            // ADR-0040) — substrate credential/audit
                            // plane; service declarations live in
                            // gateway.vaultProxyServices, not tenant docs.
]);

// Compose services that are SUBSTRATE bundles (hypervisor tier in
// cluster.capnp) or otherwise excluded from the tenant grid. Each entry
// is paired with a reason for the next reader.
const SUBSTRATE_COMPOSE_SERVICES = new Map([
  ["cloister-router", "hypervisor: the gateway itself"],
  ["notme-identity",  "hypervisor: Signet master CA (mints what identity-bridge publishes)"],
  ["rosary",          "cluster-tier but not yet exposed through cloister — blocked on ADR-0005 / cloister-824849"],
]);

// ── capnp eval — load cloister.capnp into JSON ───────────────────────────

function evalGateway() {
  // Shared derivation (cloister-70df69): works in worktrees without env setup.
  const root = deriveSchemaRoot({ schemaFile: resolve(REPO, "manifest/cloister.capnp"), cwd: REPO });
  try {
    const out = execFileSync(
      "capnp",
      ["eval", "-I", root, "--no-standard-import",
       resolve(REPO, "cloister.capnp"), "gateway", "-o", "json"],
      { encoding: "utf8" },
    );
    return JSON.parse(out);
  } catch (e) {
    const err = e.stderr?.toString?.() ?? String(e);
    throw new Error(`capnp eval cloister.capnp failed:\n${err}`);
  }
}

// ── Compose YAML — extract the `services:` map keys ──────────────────────
//
// We don't depend on a YAML library; the compose file is auto-generated
// by scripts/emit-compose.mjs with a stable two-space indent. Service
// names are the only thing this lint needs. Volumes / environment /
// labels are not inspected here.
function readComposeServices() {
  const path = resolve(REPO, "cluster.compose.yaml");
  if (!existsSync(path)) {
    throw new Error(
      `cluster.compose.yaml missing at ${path} — run \`task cluster:emit\` first`,
    );
  }
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  const services = [];
  let inServices = false;
  for (const line of lines) {
    if (/^services:\s*$/.test(line)) { inServices = true; continue; }
    if (inServices) {
      // Top-level key terminates the services block.
      if (/^[a-zA-Z]/.test(line)) { inServices = false; continue; }
      // Service entries: two-space indent + `name:`.
      const m = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
      if (m) services.push(m[1]);
    }
  }
  return services;
}

// ── Name → expected doc path ─────────────────────────────────────────────

function docFor(slug) {
  return resolve(TENANT_DIR, `${slug}.md`);
}

function backendDocSlug(backendName) {
  return BACKEND_NAME_TO_DOC[backendName] ?? `${backendName}-mcp`;
}

function routeDocSlug(kindTag) {
  return ROUTE_KIND_TO_DOC[kindTag] ?? null;
}

// ── Walk the manifest + compose ──────────────────────────────────────────

function collectExpectedDocs(gateway, composeServices) {
  // Map of slug → [origin string] — origin lets us tell the user
  // *why* a doc is required when it's missing.
  const expected = new Map();
  const addExpected = (slug, origin) => {
    if (!expected.has(slug)) expected.set(slug, []);
    expected.get(slug).push(origin);
  };

  // (1) MCP tenants — backends inside `mcp` routes.
  for (const route of gateway.routes ?? []) {
    const kindObj = route.kind ?? {};
    const kindTag = Object.keys(kindObj)[0];
    if (kindTag === "mcp") {
      for (const backend of kindObj.mcp.backends ?? []) {
        const slug = backendDocSlug(backend.name);
        addExpected(slug, `cloister.capnp: mcp backend "${backend.name}"`);
      }
      continue;
    }
    // (2) Non-MCP tenant routes.
    if (SUBSTRATE_ROUTE_KINDS.has(kindTag)) continue;
    const slug = routeDocSlug(kindTag);
    if (slug) {
      addExpected(slug, `cloister.capnp: route kind "${kindTag}"`);
      continue;
    }
    // Unknown kind — fail loudly so a new variant requires an explicit
    // decision (substrate vs tenant).
    throw new Error(
      `lint-tenant-docs: route kind "${kindTag}" at path "${route.path}" ` +
      `is neither in SUBSTRATE_ROUTE_KINDS nor in ROUTE_KIND_TO_DOC. ` +
      `Decide whether it's a tenant (add a docs/tenants/<slug>.md and a ` +
      `mapping entry) or substrate (add to SUBSTRATE_ROUTE_KINDS).`,
    );
  }

  // (3) Compose services.
  for (const svc of composeServices) {
    if (SUBSTRATE_COMPOSE_SERVICES.has(svc)) continue;
    // Try the explicit map first (for renames like leyline-lifecycle),
    // then the fallback `<name>-mcp` slug.
    const slug = BACKEND_NAME_TO_DOC[svc] ?? `${svc}-mcp`;
    addExpected(slug, `cluster.compose.yaml: service "${svc}"`);
  }

  return expected;
}

// ── Main ────────────────────────────────────────────────────────────────

function main() {
  if (!existsSync(TENANT_DIR)) {
    console.error(
      `lint-tenant-docs: docs/tenants/ does not exist at ${TENANT_DIR}`,
    );
    process.exit(1);
  }

  let gateway;
  let composeServices;
  try {
    gateway = evalGateway();
    composeServices = readComposeServices();
  } catch (e) {
    console.error(`lint-tenant-docs: toolchain error\n${e.message ?? e}`);
    process.exit(2);
  }

  const expected = collectExpectedDocs(gateway, composeServices);
  const missing = [];
  for (const [slug, origins] of expected) {
    const path = docFor(slug);
    if (!existsSync(path)) {
      missing.push({ slug, origins, path });
    }
  }

  if (missing.length > 0) {
    console.error("lint-tenant-docs: drift detected — tenant docs missing:");
    for (const m of missing) {
      console.error(`  ✗ docs/tenants/${m.slug}.md  (required by ${m.origins.join(", ")})`);
    }
    console.error("");
    console.error("Add the missing page(s) under docs/tenants/, OR update");
    console.error("scripts/lint-tenant-docs.mjs to record the new mapping.");
    console.error("See docs/tenants/README.md for the conventions.");
    process.exit(1);
  }

  console.log(
    `lint-tenant-docs: ok — ${expected.size} tenant doc(s) accounted for ` +
    `(${composeServices.length} compose services, ` +
    `${gateway.routes?.length ?? 0} routes).`,
  );
}

main();
