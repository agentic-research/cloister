/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect } from "vitest";
import { Router, type EdgeRoute } from "../src/router.js";
import type { Env } from "../src/types.js";

// ── Helpers ────────────────────────────────────────────────────────────────
//
// Pure unit tests for Router. EdgeRoute matching/handling logic lives on the
// concrete route classes; Router only orchestrates first-match-wins + 404.

function req(url: string, init?: RequestInit): Request {
  return new Request(url, init);
}

function fakeEnv(): Env {
  return {} as Env;
}

const route = (overrides: Partial<EdgeRoute>): EdgeRoute => ({
  match: () => true,
  handle: async () => new Response("default"),
  ...overrides,
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Router", () => {
  it("returns 404 when no route matches", async () => {
    const router = new Router([route({ match: () => false })]);
    const res = await router.handle(req("http://x/missing"), fakeEnv());
    expect(res.status).toBe(404);
  });

  it("returns 404 for an empty route table", async () => {
    const router = new Router([]);
    const res = await router.handle(req("http://x/anything"), fakeEnv());
    expect(res.status).toBe(404);
  });

  it("dispatches to the only matching route", async () => {
    const router = new Router([
      route({ match: () => true, handle: async () => new Response("hit", { status: 200 }) }),
    ]);
    const res = await router.handle(req("http://x/"), fakeEnv());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hit");
  });

  it("first match wins — earlier route shadows later identical match", async () => {
    const router = new Router([
      route({ match: () => true, handle: async () => new Response("first") }),
      route({ match: () => true, handle: async () => new Response("second") }),
    ]);
    const res = await router.handle(req("http://x/"), fakeEnv());
    expect(await res.text()).toBe("first");
  });

  it("skips non-matching routes and uses next match", async () => {
    const router = new Router([
      route({ match: () => false, handle: async () => new Response("skipped") }),
      route({ match: () => true,  handle: async () => new Response("used") }),
    ]);
    const res = await router.handle(req("http://x/"), fakeEnv());
    expect(await res.text()).toBe("used");
  });

  it("passes env through to the matching route", async () => {
    let seen: Env | null = null;
    const router = new Router([
      route({ handle: async (_r, env) => { seen = env; return new Response("ok"); } }),
    ]);
    const stub = { ROSARY_MCP_URL: "x", SIGNET_URL: "y" } as Env;
    await router.handle(req("http://x/"), stub);
    expect(seen).toBe(stub);
  });

  it("propagates the request unchanged to the route", async () => {
    let seen: Request | null = null;
    const router = new Router([
      route({ handle: async (r) => { seen = r; return new Response("ok"); } }),
    ]);
    const incoming = req("http://x/path?q=1", { method: "POST" });
    await router.handle(incoming, fakeEnv());
    expect(seen).toBe(incoming);
  });
});
