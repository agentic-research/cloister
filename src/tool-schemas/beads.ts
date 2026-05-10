// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MCP tool input schemas for the bead_* family. Source of truth is here
// (zod) — the JSON Schema shipped to MCP clients via `tools/list` is
// codegenned from these by `scripts/build-tool-schemas.mjs`. Closes
// cloister-7ca96c (manifest↔handler schema drift class).
//
// Why zod and not raw JSON Schema:
// - Type-couples to the handler signature (`z.infer<typeof X>` is the
//   handler's args type). Drift becomes a TS error, not a silent wire
//   mismatch.
// - One source. The previous `inputSchemaJson` strings in cloister.capnp
//   could disagree with what the handler actually accepts — nothing
//   checked.
// - zod v4's built-in `z.toJSONSchema()` emits MCP-compatible JSON
//   Schema (Draft 7) directly — no third-party converter needed.
//
// Schemas are STRICT (`additionalProperties: false`) — unknown args are
// rejected at the wire, which keeps clients from passing typo'd flags
// that the handler silently ignores.

import { z } from "zod";

export const beadCreate = z.object({
  repo:        z.string(),
  title:       z.string(),
  description: z.string().optional(),
  // Priority: 0 (highest) through 4 (lowest). `int().min().max()` emits
  // `{type:"integer",minimum:0,maximum:4}` on the wire — validation is
  // identical to the legacy `enum:[0,1,2,3,4]` form and clients render
  // it as a numeric range cleanly.
  priority:    z.number().int().min(0).max(4).optional(),
  labels:      z.array(z.string()).optional(),
  created_by:  z.string().optional(),
});

export const beadUpdate = z.object({
  repo:        z.string(),
  id:          z.string(),
  title:       z.string().optional(),
  description: z.string().optional(),
  state:       z.enum(["open", "in_progress", "done", "blocked"]).optional(),
  // Priority: 0 (highest) through 4 (lowest). `int().min().max()` emits
  // `{type:"integer",minimum:0,maximum:4}` on the wire — validation is
  // identical to the legacy `enum:[0,1,2,3,4]` form and clients render
  // it as a numeric range cleanly.
  priority:    z.number().int().min(0).max(4).optional(),
  labels:      z.array(z.string()).optional(),
  notes:       z.string().optional(),
});

export const beadSearch = z.object({
  repo:  z.string(),
  query: z.string(),
});

export const beadList = z.object({
  repo:  z.string(),
  state: z.enum(["open", "in_progress", "done", "blocked"]).optional(),
});

export const beadClose = z.object({
  repo: z.string(),
  id:   z.string(),
});

export const beadComment = z.object({
  repo:   z.string(),
  id:     z.string(),
  body:   z.string(),
  author: z.string().optional(),
});

export const schemas = {
  bead_create:  beadCreate,
  bead_update:  beadUpdate,
  bead_search:  beadSearch,
  bead_list:    beadList,
  bead_close:   beadClose,
  bead_comment: beadComment,
} as const;
