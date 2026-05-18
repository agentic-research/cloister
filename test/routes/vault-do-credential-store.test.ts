/// <reference types="@cloudflare/vitest-pool-workers/types" />
// Unit tests for `VaultDoCredentialStore` — the production
// CredentialStore impl that delegates to `env.VAULT_STORE.proxyRequest`.
//
// Per cloister-e26ea8 (D1 of the DO saga). The CredentialStore seam
// in `vault-proxy-credential-store.ts:48` ships two impls:
//
//   - `InMemoryCredentialStore` — dev/test backing, plaintext credentials in a Map.
//   - `VaultDoCredentialStore` — production backing, delegates the entire
//     Request to vault DO so plaintext bytes never cross the trust boundary.
//
// These tests pin the wiring of the production impl: that it calls
// `idFromName(bundleIdName)` faithfully, threads args + body, propagates
// non-2xx upstream responses, and degrades gracefully when the DO RPC
// throws. Integration against a REAL vault DO is D3 (cloister-e2d38a).

import { describe, expect, it } from "vitest";
import { VaultDoCredentialStore } from "../../src/routes/vault-do-credential-store.js";
import type { Env } from "../../src/types.js";

const TEST_PEER_FP = "sha256:test-peer-d1";
const TEST_SERVICE = "openai";
const TEST_CALLER  = "skill/openai/chat";

// ── Test doubles for the vault DO namespace + stub ──────────────────────

interface ProxyRequestCall {
  subjectFp:        string;
  service:          string;
  callerSub:        string;
  incomingRequest:  Request;
}

interface FakeStubBehavior {
  respondWith?: Response;
  throwWith?:   Error;
}

function fakeNamespace(behavior: FakeStubBehavior): {
  ns:    DurableObjectNamespace;
  calls: ProxyRequestCall[];
  idNamesSeen: string[];
} {
  const calls: ProxyRequestCall[] = [];
  const idNamesSeen: string[] = [];
  const ns = {
    idFromName(name: string): DurableObjectId {
      idNamesSeen.push(name);
      return { name } as unknown as DurableObjectId;
    },
    get(_id: DurableObjectId): DurableObjectStub {
      return {
        async proxyRequest(
          subjectFp: string,
          service: string,
          callerSub: string,
          incomingRequest: Request,
        ): Promise<Response> {
          calls.push({ subjectFp, service, callerSub, incomingRequest });
          if (behavior.throwWith) throw behavior.throwWith;
          return behavior.respondWith ?? new Response("ok", { status: 200 });
        },
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
  return { ns, calls, idNamesSeen };
}

function envWith(ns: DurableObjectNamespace | undefined): Env {
  return { VAULT_STORE: ns } as unknown as Env;
}

describe("VaultDoCredentialStore.resolve", () => {
  it("always returns null — vault DO never returns plaintext bytes (use forward instead)", async () => {
    const { ns } = fakeNamespace({});
    const store = new VaultDoCredentialStore({ env: envWith(ns), bundleIdName: "router" });
    const result = await store.resolve(TEST_PEER_FP, TEST_SERVICE);
    expect(result).toBeNull();
  });
});

describe("VaultDoCredentialStore.forward — delegation", () => {
  it("calls idFromName(bundleIdName) and delegates proxyRequest with all args", async () => {
    const { ns, calls, idNamesSeen } = fakeNamespace({});
    const store = new VaultDoCredentialStore({ env: envWith(ns), bundleIdName: "router" });

    const incoming = new Request("https://x.example/foo", { method: "POST", body: "hello" });
    await store.forward(TEST_PEER_FP, TEST_SERVICE, TEST_CALLER, incoming);

    expect(idNamesSeen).toEqual(["router"]);
    expect(calls.length).toBe(1);
    expect(calls[0].subjectFp).toBe(TEST_PEER_FP);
    expect(calls[0].service).toBe(TEST_SERVICE);
    expect(calls[0].callerSub).toBe(TEST_CALLER);
    expect(calls[0].incomingRequest).toBe(incoming);
  });

  it("returns the vault-DO Response faithfully (200 + body)", async () => {
    const upstreamBody = JSON.stringify({ choices: [{ text: "ok" }] });
    const { ns } = fakeNamespace({
      respondWith: new Response(upstreamBody, { status: 200, headers: { "x-foo": "bar" } }),
    });
    const store = new VaultDoCredentialStore({ env: envWith(ns), bundleIdName: "router" });

    const res = await store.forward(TEST_PEER_FP, TEST_SERVICE, TEST_CALLER, new Request("https://x/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-foo")).toBe("bar");
    expect(await res.text()).toBe(upstreamBody);
  });
});

describe("VaultDoCredentialStore.forward — failure propagation", () => {
  it("propagates 404 (constant-shape collapsed) from vault DO unchanged", async () => {
    const body = JSON.stringify({ error: "not_found" });
    const { ns } = fakeNamespace({ respondWith: new Response(body, { status: 404 }) });
    const store = new VaultDoCredentialStore({ env: envWith(ns), bundleIdName: "router" });

    const res = await store.forward(TEST_PEER_FP, TEST_SERVICE, TEST_CALLER, new Request("https://x/"));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(body);
  });

  it("propagates 429 rate-limit responses from vault DO unchanged (preserves retry-after)", async () => {
    const { ns } = fakeNamespace({
      respondWith: new Response(JSON.stringify({ error: "rate_limited" }), {
        status: 429,
        headers: { "retry-after": "7" },
      }),
    });
    const store = new VaultDoCredentialStore({ env: envWith(ns), bundleIdName: "router" });

    const res = await store.forward(TEST_PEER_FP, TEST_SERVICE, TEST_CALLER, new Request("https://x/"));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("7");
  });

  it("returns a 502 with no internals when vault DO RPC throws", async () => {
    const { ns } = fakeNamespace({ throwWith: new Error("DO RPC: connection reset by peer") });
    const store = new VaultDoCredentialStore({ env: envWith(ns), bundleIdName: "router" });

    const res = await store.forward(TEST_PEER_FP, TEST_SERVICE, TEST_CALLER, new Request("https://x/"));
    expect(res.status).toBe(502);
    const body = await res.json() as { error: string; message?: string };
    expect(body.error).toBe("upstream_unavailable");
    expect(JSON.stringify(body)).not.toContain("connection reset");
    expect(JSON.stringify(body)).not.toContain("DO RPC");
  });
});

describe("VaultDoCredentialStore — per-bundle isolation seam", () => {
  it("two stores with distinct bundleIdName values call idFromName with distinct names", async () => {
    const { ns: nsA, idNamesSeen: namesA } = fakeNamespace({});
    const { ns: nsB, idNamesSeen: namesB } = fakeNamespace({});

    const storeA = new VaultDoCredentialStore({ env: envWith(nsA), bundleIdName: "router" });
    const storeB = new VaultDoCredentialStore({ env: envWith(nsB), bundleIdName: "notme" });

    await storeA.forward(TEST_PEER_FP, TEST_SERVICE, TEST_CALLER, new Request("https://x/"));
    await storeB.forward(TEST_PEER_FP, TEST_SERVICE, TEST_CALLER, new Request("https://x/"));

    expect(namesA).toEqual(["router"]);
    expect(namesB).toEqual(["notme"]);
  });
});

describe("VaultDoCredentialStore — missing binding", () => {
  it("returns 503 from forward when env.VAULT_STORE is unset (defensive: composition should not build this in that case)", async () => {
    const store = new VaultDoCredentialStore({ env: envWith(undefined), bundleIdName: "router" });
    const res = await store.forward(TEST_PEER_FP, TEST_SERVICE, TEST_CALLER, new Request("https://x/"));
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("vault_unavailable");
  });
});
