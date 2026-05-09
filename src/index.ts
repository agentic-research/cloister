/**
 * cloister — SSE/HTTP edge router for the ART constellation.
 *
 * cloister is *not* an MCP gateway. It is an edge router that delivers bytes
 * over SSE/HTTP to a table of EdgeRoutes; MCP is one tenant of that pipe.
 *
 * Architecture: ADR-0001 (workerd choice), ADR-0002 (router + backends seam),
 *               ADR-0004 (Cap'n Proto manifest as the registration format).
 *
 * The route table is no longer hand-coded here — it is compiled from
 * `cloister.capnp` at build time (via `task manifest` → `src/generated/manifest.ts`)
 * and instantiated by `manifest/runtime.ts`. To add a tenant, edit
 * `cloister.capnp` and re-run `task manifest`.
 */

import type { Env } from "./types.js";
import { Router } from "./router.js";
import { instantiate } from "./manifest/runtime.js";
import { manifest } from "./generated/manifest.js";

export { BeadStore } from "./beads.js";
export { TrustStore } from "./trust-store.js";

const router = new Router(instantiate(manifest));

export default {
  fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    return router.handle(request, env);
  },
} satisfies ExportedHandler<Env>;
