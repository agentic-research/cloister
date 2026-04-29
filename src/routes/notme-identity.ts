/**
 * /identity/* → notme-bot service binding.
 *
 * Strips the /identity prefix so notme sees its own root paths. The notme
 * vault has no network access; it is reachable only via this service binding,
 * which is an unforgeable intra-process reference. cloister is the only thing
 * on the network in front of it.
 */

import type { EdgeRoute } from "../router.js";
import type { Env } from "../types.js";

export class NotmeIdentityRoute implements EdgeRoute {
  match(request: Request): boolean {
    return new URL(request.url).pathname.startsWith("/identity/");
  }

  async handle(request: Request, env: Env): Promise<Response> {
    const url      = new URL(request.url);
    const stripped = url.pathname.replace(/^\/identity/, "") || "/";
    const upstream = new URL(stripped + url.search, "https://notme-bot/");
    return env.NOTME.fetch(new Request(upstream.toString(), request));
  }
}
