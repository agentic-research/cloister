// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MCP tool input schemas for the lsp_* family. Forwarded to
// ley-line-open's HTTP MCP endpoint; cloister doesn't dispatch them
// itself, but it advertises their schemas in tools/list so MCP clients
// can validate args before the round-trip. Per cloister-7ca96c.

import { z } from "zod";

/**
 * Position-based LSP requests share a (file, line, col) shape. Lines
 * and columns are zero-based to match LSP's text-document-position
 * convention. cloister doesn't enforce non-negative — that's LLO's job.
 */
const positionArgs = z.object({
  file: z.string(),
  line: z.number().int(),
  col:  z.number().int(),
});

export const lspHover       = positionArgs;
export const lspDefs        = positionArgs;
export const lspRefs        = positionArgs;
export const lspSymbols     = z.object({ file: z.string() });
export const lspDiagnostics = z.object({ file: z.string() });

export const schemas = {
  lsp_hover:       lspHover,
  lsp_defs:        lspDefs,
  lsp_refs:        lspRefs,
  lsp_symbols:     lspSymbols,
  lsp_diagnostics: lspDiagnostics,
} as const;
