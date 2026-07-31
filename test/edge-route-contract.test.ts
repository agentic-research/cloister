/// <reference types="@cloudflare/vitest-pool-workers/types" />
//
// EdgeRoute is what makes asserted identity unrepresentable at cloister's
// boundary (cloister-99a85a, filed from notme after notme-6ad276 / notme PR #54).
//
// ── Why this file, and why it is small ─────────────────────────────────────
//
// The filing bead asks for a rail against handlers that RECEIVE identity or
// scopes as inbound parameters, letting the caller assert its own authority.
// Cloister has zero instances — and not by vigilance:
//
//     export interface EdgeRoute {
//       match(request: Request): boolean;
//       handle(request: Request, env: Env): Promise<Response>;
//     }
//
// Every route implements it, there is ONE construction site
// (`new Router(instantiate(manifest))`), and Router only ever calls
// `route.handle(request, env)`. A boundary handler has no slot to receive
// identity: the router would not supply one and the interface would not admit
// it. Identity is obtained INSIDE a handler by calling verifyAndUpsertLease,
// which returns a VerifiedLease (cloister-492c08).
//
// So the thing worth guarding is the CONTRACT, not its instances. A whole-tree
// scanner for `identity: string` was written first and discarded: it produced 75
// findings against correct code, and a redundant guard is worse than none —
// it implies the property needs watching, so the next false positive gets
// "fixed" by loosening whatever the lint points at rather than by understanding
// that the interface is what holds.
//
// Widening EdgeRoute.handle is the only way to reintroduce the class at the
// boundary. This makes that fail loudly.

import { describe, it, expect } from "vitest";
import { Router, type EdgeRoute } from "../src/router.js";
import type { Env } from "../src/types.js";

describe("EdgeRoute — the boundary contract", () => {
  it("Router supplies exactly (request, env) — there is no slot for identity", async () => {
    // The load-bearing assertion. If Router ever passed a third argument, a
    // handler could receive a caller-asserted identity without any interface
    // change, and every check downstream would evaluate a claim rather than a
    // fact.
    let received: unknown[] = [];
    const spy: EdgeRoute = {
      match: () => true,
      handle: (...args: unknown[]) => {
        received = args;
        return Promise.resolve(new Response("ok"));
      },
    } as unknown as EdgeRoute;

    const env = {} as Env;
    await new Router([spy]).handle(new Request("https://x/"), env);

    expect(received).toHaveLength(2);
    expect(received[0]).toBeInstanceOf(Request);
    expect(received[1]).toBe(env);
  });

  it("a conforming handler needs no identity parameter to be reachable", async () => {
    // Non-vacuity for the claim above: the two-argument shape is SUFFICIENT, so
    // "no slot for identity" is not a limitation someone would need to work
    // around. A handler derives identity inside itself instead.
    const route: EdgeRoute = {
      match: (r) => new URL(r.url).pathname === "/ok",
      handle: async () => new Response("derived-inside"),
    };
    const res = await new Router([route]).handle(new Request("https://x/ok"), {} as Env);
    expect(await res.text()).toBe("derived-inside");
  });

  it("an unmatched request 404s rather than falling through to some other route", async () => {
    // Guards the dispatch loop's other half: a route that does not match must
    // not receive the request, or `match` stops being the gate it looks like.
    let called = false;
    const never: EdgeRoute = {
      match: () => false,
      handle: async () => { called = true; return new Response("should not happen"); },
    };
    const res = await new Router([never]).handle(new Request("https://x/nope"), {} as Env);
    expect(res.status).toBe(404);
    expect(called).toBe(false);
  });
});
