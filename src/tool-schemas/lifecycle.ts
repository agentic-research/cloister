// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MCP tool input schemas for the leyline-lifecycle family (reparse,
// enrich, status). Forwarded to LLO; cloister advertises the schemas.
// Per cloister-7ca96c.

import { z } from "zod";

export const reparse = z.object({
  source: z.string().optional(),
  lang:   z.string().optional(),
});

export const enrich = z.object({
  pass:  z.string(),
  files: z.array(z.string()).optional(),
});

export const status = z.object({});

export const schemas = {
  reparse,
  enrich,
  status,
} as const;
