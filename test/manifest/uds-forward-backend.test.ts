/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect } from "vitest";
import { UdsForwardToolBackend } from "../../src/manifest/backends/uds-forward.js";
import type { Env } from "../../src/types.js";
import { encodeToolResult } from "../../src/wire/tool-result.js";
import { decodeToolCall } from "../../src/wire/tool-call.js";

/**
 * UDS-forward backend wire-up (cloister-46fc1a).
 *
 * Workerd has no `connect("AF_UNIX")`; cloister-companion (Rust) is the
 * IPC seam. The backend POSTs a capnp ToolCall to the companion's HTTP
 * face, tagging the request with `X-Cloister-Transport: uds` +
 * `X-Cloister-Socket-Path: …` so companion routes to a UDS dial instead
 * of its default leyline-net path.
 *
 * These tests inject a fake fetcher and assert:
 *   - the request goes to env.COMPANION_URL,
 *   - the headers signal `uds` transport + the socket path verbatim,
 *   - the body is a parseable capnp ToolCall,
 *   - successful capnp ToolResult round-trips back to the caller,
 *   - error paths propagate cleanly (no companion config, HTTP non-2xx,
 *     companion unreachable, malformed capnp).
 *
 * End-to-end against a real UDS responder is covered separately by
 * `scripts/smoke-leyline-stub.mjs` (which spawns stub-companion + a UDS
 * responder out of process) — that lives in the smoke target rather than
 * vitest because workerd doesn't expose `node:net`.
 */

const bin = (b: Uint8Array): BodyInit => b as unknown as BodyInit;

function envWith(url: string): Env {
  return { COMPANION_URL: url } as unknown as Env;
}

const BASE_SPEC = {
  socketPath: "/run/cloister-uds/mache.sock",
  tools: [
    { name: "mache_overview", description: "code overview", inputSchemaJson: '{"type":"object"}' },
    { name: "mache_search",   description: "code search",   inputSchemaJson: '{"type":"object"}' },
  ],
} as const;

interface Captured {
  url: string;
  init: RequestInit | undefined;
  body: Uint8Array | null;
}

function captureFetch(
  respond: (req: Captured) => Response | Promise<Response>,
): { fetcher: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    let body: Uint8Array | null = null;
    if (init?.body instanceof Uint8Array) body = init.body;
    else if (init?.body instanceof ArrayBuffer) body = new Uint8Array(init.body);
    const c: Captured = { url, init, body };
    calls.push(c);
    return await respond(c);
  };
  return { fetcher, calls };
}

// ── Configuration / wiring ────────────────────────────────────────────────

describe("UdsForwardToolBackend — configuration", () => {
  it("throws -32603 when COMPANION_URL is unset", async () => {
    const b = new UdsForwardToolBackend(BASE_SPEC, "mache_");
    await expect(b.invoke("mache_overview", {}, {} as Env)).rejects.toMatchObject({
      name: "JsonRpcInvocationError",
      code: -32603,
      message: expect.stringContaining("COMPANION_URL"),
    });
  });

  it("advertises tools and matches handlesPrefix", () => {
    const b = new UdsForwardToolBackend(BASE_SPEC, "mache_");
    expect(b.tools().map(t => t.name)).toEqual(["mache_overview", "mache_search"]);
    expect(b.handles("mache_overview")).toBe(true);
    expect(b.handles("mache_search")).toBe(true);
    expect(b.handles("bead_create")).toBe(false);
  });

  it("POSTs a capnp ToolCall to the configured companion URL with uds transport headers", async () => {
    const okResult = encodeToolResult({
      content: [{ kind: "text", text: '{"head_sha":"abc"}' }],
      isError: false,
    });
    const { fetcher, calls } = captureFetch(() => new Response(bin(okResult), {
      status: 200,
      headers: { "Content-Type": "application/x-capnp; type=ToolResult" },
    }));
    const b = new UdsForwardToolBackend(BASE_SPEC, "mache_", fetcher);
    await b.invoke("mache_overview", {}, envWith("http://companion/mcp"));

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://companion/mcp");
    expect(calls[0].init?.method).toBe("POST");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toMatch(/application\/x-capnp/);
    expect(headers["X-Cloister-Transport"]).toBe("uds");
    expect(headers["X-Cloister-Socket-Path"]).toBe("/run/cloister-uds/mache.sock");

    // Body is a capnp ToolCall — decode it to verify wire fidelity.
    expect(calls[0].body).not.toBeNull();
    const tc = decodeToolCall(calls[0].body!);
    // upstreamId is the handlesPrefix with trailing underscore stripped.
    expect(tc.upstreamId).toBe("mache");
    expect(tc.toolName).toBe("mache_overview");
  });

  it("encodes args as canonical JSON in argumentsJson", async () => {
    const okResult = encodeToolResult({ content: [{ kind: "text", text: "{}" }], isError: false });
    const { fetcher, calls } = captureFetch(() => new Response(bin(okResult), { status: 200 }));
    const b = new UdsForwardToolBackend(BASE_SPEC, "mache_", fetcher);
    // Args in unsorted order; canonical() must sort keys.
    await b.invoke("mache_search", { query: "foo", repo: "bar" }, envWith("http://x/"));
    const tc = decodeToolCall(calls[0].body!);
    expect(new TextDecoder().decode(tc.argumentsJson)).toBe('{"query":"foo","repo":"bar"}');
  });

  it("empty handlesPrefix: uses toolName as upstreamId tag", async () => {
    const exactSpec = {
      socketPath: "/run/cloister-uds/rosary.sock",
      tools: [{ name: "status", description: "", inputSchemaJson: '{"type":"object"}' }],
    } as const;
    const okResult = encodeToolResult({ content: [{ kind: "text", text: "{}" }], isError: false });
    const { fetcher, calls } = captureFetch(() => new Response(bin(okResult), { status: 200 }));
    const b = new UdsForwardToolBackend(exactSpec, "", fetcher);
    await b.invoke("status", {}, envWith("http://x/"));
    const tc = decodeToolCall(calls[0].body!);
    expect(tc.upstreamId).toBe("status");
    expect(tc.toolName).toBe("status");
  });
});

// ── Success paths ─────────────────────────────────────────────────────────

describe("UdsForwardToolBackend — success paths", () => {
  it("single-text result: returns parsed JSON when text is valid JSON", async () => {
    const upstream = encodeToolResult({
      content: [{ kind: "text", text: '{"ok":true,"count":3}' }],
      isError: false,
    });
    const { fetcher } = captureFetch(() => new Response(bin(upstream), { status: 200 }));
    const b = new UdsForwardToolBackend(BASE_SPEC, "mache_", fetcher);
    const result = await b.invoke("mache_overview", {}, envWith("http://x/"));
    expect(result).toEqual({ ok: true, count: 3 });
  });

  it("single-text result: returns raw text when text is not JSON", async () => {
    const upstream = encodeToolResult({
      content: [{ kind: "text", text: "free-form prose" }],
      isError: false,
    });
    const { fetcher } = captureFetch(() => new Response(bin(upstream), { status: 200 }));
    const b = new UdsForwardToolBackend(BASE_SPEC, "mache_", fetcher);
    expect(await b.invoke("mache_overview", {}, envWith("http://x/"))).toBe("free-form prose");
  });

  it("multi-content result: returns array verbatim with binary base64-encoded", async () => {
    const upstream = encodeToolResult({
      content: [
        { kind: "text", text: "first" },
        { kind: "binary", binary: { data: new Uint8Array([1, 2, 3]), mimeType: "application/octet-stream" } },
      ],
      isError: false,
    });
    const { fetcher } = captureFetch(() => new Response(bin(upstream), { status: 200 }));
    const b = new UdsForwardToolBackend(BASE_SPEC, "mache_", fetcher);
    const result = await b.invoke("mache_overview", {}, envWith("http://x/")) as Array<Record<string, unknown>>;
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: "text", text: "first" });
    expect(result[1].type).toBe("image");
    expect(result[1].data).toBe("AQID"); // base64 of [1,2,3]
  });
});

// ── Error paths ───────────────────────────────────────────────────────────

describe("UdsForwardToolBackend — error paths", () => {
  it("isError=true: throws -32000 with the upstream's error message", async () => {
    const upstream = encodeToolResult({
      content: [{ kind: "text", text: '{"error":"socket connect refused"}' }],
      isError: true,
    });
    const { fetcher } = captureFetch(() => new Response(bin(upstream), { status: 200 }));
    const b = new UdsForwardToolBackend(BASE_SPEC, "mache_", fetcher);
    await expect(b.invoke("mache_overview", {}, envWith("http://x/"))).rejects.toMatchObject({
      name: "JsonRpcInvocationError",
      code: -32000,
      message: "socket connect refused",
    });
  });

  it("companion HTTP non-2xx (e.g. UDS dial failed in companion): -32603 with status", async () => {
    const { fetcher } = captureFetch(() =>
      new Response("uds proxy to /run/cloister-uds/mache.sock failed: ENOENT", { status: 502 }),
    );
    const b = new UdsForwardToolBackend(BASE_SPEC, "mache_", fetcher);
    await expect(b.invoke("mache_overview", {}, envWith("http://x/"))).rejects.toMatchObject({
      code: -32603,
      message: expect.stringContaining("HTTP 502"),
    });
  });

  it("companion unreachable: throws -32603 'unreachable'", async () => {
    const fetcher: typeof fetch = async () => { throw new Error("ECONNREFUSED"); };
    const b = new UdsForwardToolBackend(BASE_SPEC, "mache_", fetcher);
    await expect(b.invoke("mache_overview", {}, envWith("http://x/"))).rejects.toMatchObject({
      code: -32603,
      message: expect.stringContaining("unreachable"),
    });
  });

  it("companion returns malformed capnp: throws -32603", async () => {
    const garbage = new Uint8Array([0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
    const { fetcher } = captureFetch(() => new Response(bin(garbage), { status: 200 }));
    const b = new UdsForwardToolBackend(BASE_SPEC, "mache_", fetcher);
    await expect(b.invoke("mache_overview", {}, envWith("http://x/"))).rejects.toMatchObject({
      code: -32603,
      message: expect.stringContaining("not valid capnp"),
    });
  });
});
