/**
 * Edge router — protocol-agnostic dispatch over an ordered table of EdgeRoutes.
 *
 * Routes are tried in declaration order; the first whose `match(request)` returns
 * true handles the request. No match → 404. Routes never see one another and
 * never call back into the Router; they return a Response.
 *
 * The Router does not know about MCP, SSE, or any application protocol. It only
 * delivers bytes to the matching route.
 */

import type { Env } from "./types.js";

export interface EdgeRoute {
  match(request: Request): boolean;
  handle(request: Request, env: Env): Promise<Response>;
}

export class Router {
  constructor(private readonly routes: readonly EdgeRoute[]) {}

  async handle(request: Request, env: Env): Promise<Response> {
    for (const route of this.routes) {
      if (route.match(request)) return route.handle(request, env);
    }
    return new Response("not found", { status: 404 });
  }
}
