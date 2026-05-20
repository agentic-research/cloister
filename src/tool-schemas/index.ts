// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tool schemas registry — single source of truth for every MCP tool's
// input shape. Per cloister-7ca96c.
//
// `scripts/build-tool-schemas.mjs` reads this module's exports at
// build time, emits JSON Schema for each tool via zod-to-json-schema,
// and merges the result into `src/generated/manifest.ts` so the wire
// surface to MCP clients (tools/list) stays compatible.
//
// To add a new tool's schema:
//   1. Add a zod schema export in the appropriate group module
//      (beads.ts), or create a new group.
//   2. Add it to that module's `schemas` map under its tool name.
//   3. Add it to the merged `schemas` map below.
//   4. The cloister.capnp tool entry NO LONGER needs `inputSchemaJson`
//      — it's deprecated; the build step injects from here.
//   5. `task lint:tool-schemas` enforces parity.
//
// Group ownership note (cloister-05334b, P1 of LLO arc): the root
// `cloister.capnp` no longer asserts the `lsp_*` or `leyline-lifecycle`
// (status / enrich / reparse) catalogs — they're generated from
// `cluster.lock.toml` `[[generated_backends]]` rows produced by
// scripts/resolve-inputs.mjs. The manifest emitter overlays them into
// the /mcp McpRouteSpec.backends list at `task manifest` time.
//
// The `lifecycle` schemas (reparse / enrich / status) STAY exported
// here because `recipes/rosary-dev/cloister.capnp` still uses the
// hand-declared shell shape with `inputSchemaJson = ""` — the build-time
// injector reads from this registry and would fail recipe builds if the
// schemas vanished. Recipe migration to lockfile-driven backends is
// Phase 3 (per the bead description); until then, the schemas live on
// here as "recipes-only", documented in TOOL_SCHEMAS_RECIPES_ONLY below
// so the orphan-detection test in test/manifest/tool-schemas.test.ts
// knows to exempt them.
//
// The `bead_*` family also lives here because it's an in-process
// Durable Object backend (not an mcpProxy upstream); the schemas serve
// real runtime input validation, not just MCP `tools/list` advertising.

import { z } from "zod";
import { schemas as bead }      from "./beads.js";
import { schemas as lifecycle } from "./lifecycle.js";

/** Every cloister-resident tool's input schema, keyed by MCP tool name. */
export const schemas = {
  ...bead,
  ...lifecycle,
} as const;

/**
 * Tool schemas that exist in this registry but are NOT present in the
 * root manifest's static catalog (their runtime backend is dynamic via
 * the lockfile-driven emitter, or they're consumed only by per-recipe
 * cloister.capnp files like rosary-dev). The orphan-detection test in
 * `test/manifest/tool-schemas.test.ts` exempts these names.
 *
 * Per cloister-05334b. Phase 3 of the LLO arc will migrate the recipe
 * to lockfile-driven backends too, at which point this exemption set
 * can shrink.
 */
export const TOOL_SCHEMAS_RECIPES_ONLY: ReadonlySet<string> = new Set<string>([
  "reparse",
  "enrich",
  "status",
]);

/** Type of all known tool names — useful for handler dispatch. */
export type ToolName = keyof typeof schemas;

/** Type-safe accessor: returns the zod schema for the named tool. */
export function schemaFor<T extends ToolName>(name: T): (typeof schemas)[T] {
  return schemas[name];
}

/** Inferred TS type for a tool's args. Use in handler signatures. */
export type ArgsOf<T extends ToolName> = z.infer<(typeof schemas)[T]>;
