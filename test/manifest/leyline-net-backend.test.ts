/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect } from "vitest";
import { LeylineNetToolBackend } from "../../src/manifest/backends/leyline-net.js";
import type { Env } from "../../src/types.js";
import { encodeToolResult } from "../../src/wire/tool-result.js";
import { decodeToolCall } from "../../src/wire/tool-call.js";

// workerd-types' Response/BodyInit doesn't include Uint8Array directly;
// at runtime it's accepted (we get a valid binary body). Cast at the
// boundary so the test signal isn't drowned in spurious BodyInit errors.
const bin = (b: Uint8Array): BodyInit => b as unknown as BodyInit;

// ── Helpers ────────────────────────────────────────────────────────────────

function envWith(url: string): Env {
  return { COMPANION_URL: url } as unknown as Env;
}

const BASE_SPEC = {
  companionUrlBinding: "COMPANION_URL",
  upstreamId:          "rosary",
  tools: [
    { name: "rsry_status",  description: "rosary status",  inputSchemaJson: '{"type":"object"}' },
    { name: "rsry_search",  description: "search beads",   inputSchemaJson: '{"type":"object"}' },
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

describe("LeylineNetToolBackend — configuration", () => {
  it("throws -32603 when companionUrlBinding is unset", async () => {
    const b = new LeylineNetToolBackend(BASE_SPEC, "rsry_");
    await expect(b.invoke("rsry_status", {}, {} as Env)).rejects.toMatchObject({
      name: "JsonRpcInvocationError",
      code: -32603,
      message: expect.stringContaining("COMPANION_URL"),
    });
  });

  it("POSTs a capnp ToolCall to the configured companion URL", async () => {
    const okResult = encodeToolResult({
      content: [{ kind: "text", text: '{"phase":"ready"}' }],
      isError: false,
    });
    const { fetcher, calls } = captureFetch(() => new Response(bin(okResult), {
      status: 200, headers: { "Content-Type": "application/x-capnp; type=ToolResult" },
    }));
    const b = new LeylineNetToolBackend(BASE_SPEC, "rsry_", fetcher);
    await b.invoke("rsry_status", {}, envWith("http://companion/mcp"));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://companion/mcp");
    expect(calls[0].init?.method).toBe("POST");
    expect((calls[0].init?.headers as Record<string, string>)["Content-Type"])
      .toMatch(/application\/x-capnp/);
    // Body is a capnp ToolCall — decode it to verify wire fidelity.
    expect(calls[0].body).not.toBeNull();
    const tc = decodeToolCall(calls[0].body!);
    expect(tc.upstreamId).toBe("rosary");
    expect(tc.toolName).toBe("rsry_status");
  });

  it("encodes args as canonical JSON in argumentsJson", async () => {
    const okResult = encodeToolResult({ content: [{ kind: "text", text: "{}" }], isError: false });
    const { fetcher, calls } = captureFetch(() => new Response(bin(okResult), { status: 200 }));
    const b = new LeylineNetToolBackend(BASE_SPEC, "rsry_", fetcher);
    // Args in unsorted order; canonical() must sort keys.
    await b.invoke("rsry_search", { query: "foo", repo: "bar" }, envWith("http://x/"));
    const tc = decodeToolCall(calls[0].body!);
    // Canonical JSON sorts keys: query before repo (q < r).
    expect(new TextDecoder().decode(tc.argumentsJson)).toBe('{"query":"foo","repo":"bar"}');
  });
});

// ── Success paths ─────────────────────────────────────────────────────────

describe("LeylineNetToolBackend — success paths", () => {
  it("single-text result: returns parsed JSON when text is valid JSON", async () => {
    const upstream = encodeToolResult({
      content: [{ kind: "text", text: '{"ok":true,"count":3}' }],
      isError: false,
    });
    const { fetcher } = captureFetch(() => new Response(bin(upstream), { status: 200 }));
    const b = new LeylineNetToolBackend(BASE_SPEC, "rsry_", fetcher);
    const result = await b.invoke("rsry_status", {}, envWith("http://x/"));
    expect(result).toEqual({ ok: true, count: 3 });
  });

  it("single-text result: returns raw text when text is not JSON", async () => {
    const upstream = encodeToolResult({
      content: [{ kind: "text", text: "free-form prose" }],
      isError: false,
    });
    const { fetcher } = captureFetch(() => new Response(bin(upstream), { status: 200 }));
    const b = new LeylineNetToolBackend(BASE_SPEC, "rsry_", fetcher);
    expect(await b.invoke("rsry_status", {}, envWith("http://x/"))).toBe("free-form prose");
  });

  it("multi-content result: returns content array verbatim with binary base64-encoded", async () => {
    const upstream = encodeToolResult({
      content: [
        { kind: "text", text: "first" },
        { kind: "binary", binary: { data: new Uint8Array([1, 2, 3]), mimeType: "application/octet-stream" } },
        { kind: "text", text: "third" },
      ],
      isError: false,
    });
    const { fetcher } = captureFetch(() => new Response(bin(upstream), { status: 200 }));
    const b = new LeylineNetToolBackend(BASE_SPEC, "rsry_", fetcher);
    const result = await b.invoke("rsry_status", {}, envWith("http://x/")) as Array<Record<string, unknown>>;
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ type: "text", text: "first" });
    expect(result[1].type).toBe("image");
    expect(result[1].mimeType).toBe("application/octet-stream");
    expect(result[1].data).toBe("AQID"); // base64 of [1,2,3]
    expect(result[2]).toEqual({ type: "text", text: "third" });
  });
});

// ── Error paths ───────────────────────────────────────────────────────────

describe("LeylineNetToolBackend — error paths", () => {
  it("isError=true: throws -32000 with the upstream's error message", async () => {
    const upstream = encodeToolResult({
      content: [{ kind: "text", text: '{"error":"bead not found: foo"}' }],
      isError: true,
    });
    const { fetcher } = captureFetch(() => new Response(bin(upstream), { status: 200 }));
    const b = new LeylineNetToolBackend(BASE_SPEC, "rsry_", fetcher);
    await expect(b.invoke("rsry_status", {}, envWith("http://x/"))).rejects.toMatchObject({
      name: "JsonRpcInvocationError",
      code: -32000,
      message: "bead not found: foo",
    });
  });

  it("isError=true with raw text: throws -32000 with the raw text as message", async () => {
    const upstream = encodeToolResult({
      content: [{ kind: "text", text: "tool died" }],
      isError: true,
    });
    const { fetcher } = captureFetch(() => new Response(bin(upstream), { status: 200 }));
    const b = new LeylineNetToolBackend(BASE_SPEC, "rsry_", fetcher);
    await expect(b.invoke("rsry_status", {}, envWith("http://x/"))).rejects.toMatchObject({
      code: -32000, message: "tool died",
    });
  });

  it("companion HTTP non-2xx: throws -32603 with status + body snippet", async () => {
    const { fetcher } = captureFetch(() => new Response("companion is down", { status: 502 }));
    const b = new LeylineNetToolBackend(BASE_SPEC, "rsry_", fetcher);
    await expect(b.invoke("rsry_status", {}, envWith("http://x/"))).rejects.toMatchObject({
      code: -32603,
      message: expect.stringContaining("HTTP 502"),
    });
  });

  it("companion unreachable: throws -32603 'unreachable'", async () => {
    const fetcher: typeof fetch = async () => { throw new Error("ECONNREFUSED"); };
    const b = new LeylineNetToolBackend(BASE_SPEC, "rsry_", fetcher);
    await expect(b.invoke("rsry_status", {}, envWith("http://x/"))).rejects.toMatchObject({
      code: -32603,
      message: expect.stringContaining("unreachable"),
    });
  });

  it("companion returns malformed capnp: throws -32603 'not valid capnp ToolResult'", async () => {
    const garbage = new Uint8Array([0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
    const { fetcher } = captureFetch(() => new Response(bin(garbage), { status: 200 }));
    const b = new LeylineNetToolBackend(BASE_SPEC, "rsry_", fetcher);
    await expect(b.invoke("rsry_status", {}, envWith("http://x/"))).rejects.toMatchObject({
      code: -32603,
      message: expect.stringContaining("not valid capnp"),
    });
  });

  it("isError but empty content: throws -32000 with generic message", async () => {
    const upstream = encodeToolResult({ content: [], isError: true });
    const { fetcher } = captureFetch(() => new Response(bin(upstream), { status: 200 }));
    const b = new LeylineNetToolBackend(BASE_SPEC, "rsry_", fetcher);
    await expect(b.invoke("rsry_status", {}, envWith("http://x/"))).rejects.toMatchObject({
      code: -32000,
      message: expect.stringContaining("rsry_status failed"),
    });
  });
});
