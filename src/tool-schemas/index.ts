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
//      (beads.ts / lifecycle.ts), or create a new group.
//   2. Add it to that module's `schemas` map under its tool name.
//   3. Add it to the merged `schemas` map below.
//   4. The cloister.capnp tool entry NO LONGER needs `inputSchemaJson`
//      — it's deprecated; the build step injects from here.
//   5. `task lint:tool-schemas` enforces parity.
//
// Group ownership note (cloister-d9347e): the `lsp_*` family used to live
// here as a mirror of LLO's canonical schemas. The mirror is gone — LLO's
// `server.json` (`_meta.art.cloister/v1.groups[].name = "lsp"`) is the
// source of truth, and cloister derives `lsp_*` tool definitions at
// request time via the upstream `tools/list`. The `leyline-lifecycle`
// group (`status` / `enrich` / `reparse`) still mirrors locally because
// its backend has `handlesPrefix = ""`; until the manifest emitter
// consumes `cluster.lock.toml` `[[generated_backends]]`, prefix-less
// backends can't fall back to derived-cache claims and need the
// asserted catalog.

import { z } from "zod";
import { schemas as bead }      from "./beads.js";
import { schemas as lifecycle } from "./lifecycle.js";

/** Every cloister-resident tool's input schema, keyed by MCP tool name. */
export const schemas = {
  ...bead,
  ...lifecycle,
} as const;

/** Type of all known tool names — useful for handler dispatch. */
export type ToolName = keyof typeof schemas;

/** Type-safe accessor: returns the zod schema for the named tool. */
export function schemaFor<T extends ToolName>(name: T): (typeof schemas)[T] {
  return schemas[name];
}

/** Inferred TS type for a tool's args. Use in handler signatures. */
export type ArgsOf<T extends ToolName> = z.infer<(typeof schemas)[T]>;
