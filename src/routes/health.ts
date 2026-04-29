/**
 * GET /health — service liveness + backend configuration snapshot.
 *
 * Returns a stable shape so external probes can assert connectivity. The
 * `backends` field reports configured (not necessarily reachable) targets.
 */

import type { EdgeRoute } from "../router.js";
import type { Env } from "../types.js";

export class HealthRoute implements EdgeRoute {
  match(request: Request): boolean {
    return request.method === "GET" && new URL(request.url).pathname === "/health";
  }

  async handle(_request: Request, env: Env): Promise<Response> {
    return Response.json({
      status: "ok",
      service: "cloister",
      backends: {
        notme:  "service-binding",
        rosary: env.ROSARY_MCP_URL || "not configured",
        signet: env.SIGNET_URL     || "not configured",
      },
    });
  }
}
