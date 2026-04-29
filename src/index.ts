/**
 * cloister — SSE/HTTP edge router for the ART constellation.
 *
 * cloister is *not* an MCP gateway. It is an edge router that delivers bytes
 * over SSE/HTTP to a table of EdgeRoutes; MCP is one tenant of that pipe.
 *
 * Architecture: ADR-0001 (workerd choice), ADR-0002 (router + backends seam).
 *
 * Today's tenants:
 *   /health      → HealthRoute                  (liveness + backend snapshot)
 *   /identity/*  → NotmeIdentityRoute           (vault, no-net; via service binding)
 *   /mcp         → McpEdgeRoute                 (JSON-RPC over POST + SSE over GET)
 *                    ├─ BeadToolBackend         (bead_*                → BEAD_STORE DO)
 *                    ├─ LspToolBackend          (lsp_*                 → LLO_MCP_URL)
 *                    └─ LeylineLifecycleBackend (reparse|enrich|status → LLO_MCP_URL)
 *
 * Adding a tenant: implement EdgeRoute, append to ROUTES.
 * Adding an MCP tool family: implement ToolBackend, append to McpEdgeRoute backends.
 */

import type { Env } from "./types.js";
import { Router, type EdgeRoute } from "./router.js";
import { HealthRoute } from "./routes/health.js";
import { NotmeIdentityRoute } from "./routes/notme-identity.js";
import { McpEdgeRoute } from "./routes/mcp.js";
import { BeadToolBackend } from "./backends/bead.js";
import { LspToolBackend } from "./backends/lsp.js";
import { LeylineLifecycleBackend } from "./backends/leyline.js";

export { BeadStore } from "./beads.js";

const ROUTES: readonly EdgeRoute[] = [
  new HealthRoute(),
  new NotmeIdentityRoute(),
  new McpEdgeRoute([
    new BeadToolBackend(),
    new LspToolBackend(),
    new LeylineLifecycleBackend(),
  ]),
];

const router = new Router(ROUTES);

export default {
  fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    return router.handle(request, env);
  },
} satisfies ExportedHandler<Env>;
