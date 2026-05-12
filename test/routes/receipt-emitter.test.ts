/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it } from "vitest";
import {
  INTERLACE_RECEIPT_HEADER,
  buildHeadersCommittedBytes,
  decodeReceiptHeader,
  encodeCommitment,
  makeReceiptSignerFromKeypair,
  sha256,
  verifyEd25519,
} from "../../src/wire/receipts.js";
import {
  attachReceipt,
  type ReceiptEmissionContext,
} from "../../src/routes/receipt-emitter.js";

const SEED = new Uint8Array([
  0x9d, 0x61, 0xb1, 0x9d, 0xef, 0xfd, 0x5a, 0x60,
  0xba, 0x84, 0x4a, 0xf4, 0x92, 0xec, 0x2c, 0xc4,
  0x44, 0x49, 0xc5, 0x69, 0x7b, 0x32, 0x69, 0x19,
  0x70, 0x3b, 0xac, 0x03, 0x1c, 0xae, 0x7f, 0x60,
]);
const PUB = new Uint8Array([
  0xd7, 0x5a, 0x98, 0x01, 0x82, 0xb1, 0x0a, 0xb7,
  0xd5, 0x4b, 0xfe, 0xd3, 0xc9, 0x64, 0x07, 0x3a,
  0x0e, 0xe1, 0x72, 0xf3, 0xda, 0xa6, 0x23, 0x25,
  0xaf, 0x02, 0x1a, 0x68, 0xf7, 0x07, 0x51, 0x1a,
]);
const KEYPAIR = new Uint8Array(64);
KEYPAIR.set(SEED, 0);
KEYPAIR.set(PUB, 32);

async function makeContext(): Promise<ReceiptEmissionContext> {
  const signer = await makeReceiptSignerFromKeypair(KEYPAIR);
  return {
    nowMs:        1700000000000,
    requestCanon: new TextEncoder().encode("POST\n/mcp\n1700000000000\nnonce\n{}"),
    nonce:        new Uint8Array(16).fill(0xab),
    signer,
    actorFp:      new Uint8Array(32).fill(0x55),
    epoch:        1,
  };
}

describe("attachReceipt — per-request receipt emission", () => {
  it("emits Interlace-Receipt header on a 200 response", async () => {
    const ctx = await makeContext();
    const body = JSON.stringify({ ok: true });
    const resp = new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    const wrapped = await attachReceipt(resp, ctx);

    expect(wrapped.headers.get(INTERLACE_RECEIPT_HEADER)).not.toBeNull();
    const headerValue = wrapped.headers.get(INTERLACE_RECEIPT_HEADER)!;
    const decoded = decodeReceiptHeader(headerValue);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;

    // Signature must verify
    const canon = encodeCommitment(decoded.value.commitment);
    expect(await verifyEd25519(PUB, decoded.value.signature, canon)).toBe(true);

    // body_hash matches the wrapped body
    const expectedBodyHash = await sha256(new TextEncoder().encode(body));
    expect(Array.from(decoded.value.commitment.bodyHash)).toEqual(Array.from(expectedBodyHash));

    // headers_hash matches what the emitter would have computed
    const expectedHeadersHash = await sha256(buildHeadersCommittedBytes(wrapped.headers));
    expect(Array.from(decoded.value.commitment.headersHash)).toEqual(Array.from(expectedHeadersHash));
  });

  it("appends INTERLACE_RECEIPT_HEADER to Access-Control-Expose-Headers", async () => {
    const ctx = await makeContext();
    const resp = new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    const wrapped = await attachReceipt(resp, ctx);
    const expose = wrapped.headers.get("access-control-expose-headers");
    expect(expose).not.toBeNull();
    expect(expose!.toLowerCase()).toContain(INTERLACE_RECEIPT_HEADER.toLowerCase());
  });

  it("preserves an existing Access-Control-Expose-Headers list", async () => {
    const ctx = await makeContext();
    const resp = new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json", "access-control-expose-headers": "X-Trace-Id" },
    });
    const wrapped = await attachReceipt(resp, ctx);
    const expose = wrapped.headers.get("access-control-expose-headers");
    expect(expose).toContain("X-Trace-Id");
    expect(expose!.toLowerCase()).toContain(INTERLACE_RECEIPT_HEADER.toLowerCase());
  });

  it("passes 4xx through unchanged", async () => {
    const ctx = await makeContext();
    const resp = new Response("forbidden", { status: 403 });
    const wrapped = await attachReceipt(resp, ctx);
    expect(wrapped.headers.get(INTERLACE_RECEIPT_HEADER)).toBeNull();
  });

  it("passes 5xx through unchanged", async () => {
    const ctx = await makeContext();
    const resp = new Response("oops", { status: 500 });
    const wrapped = await attachReceipt(resp, ctx);
    expect(wrapped.headers.get(INTERLACE_RECEIPT_HEADER)).toBeNull();
  });

  it("passes SSE responses through unchanged (defer to streaming wrapper)", async () => {
    const ctx = await makeContext();
    const resp = new Response("data: hello\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const wrapped = await attachReceipt(resp, ctx);
    expect(wrapped.headers.get(INTERLACE_RECEIPT_HEADER)).toBeNull();
  });

  it("no-op when signer is null (Phase 1 mode)", async () => {
    const ctx: ReceiptEmissionContext = {
      nowMs: 1700000000000,
      requestCanon: new Uint8Array(0),
      nonce: new Uint8Array(16),
      signer: null,
      actorFp: new Uint8Array(32),
      epoch: 1,
    };
    const resp = new Response("{}", { status: 200 });
    const wrapped = await attachReceipt(resp, ctx);
    expect(wrapped.headers.get(INTERLACE_RECEIPT_HEADER)).toBeNull();
  });

  it("body_hash differs between two different bodies", async () => {
    const ctx = await makeContext();
    const a = await attachReceipt(new Response(`{"a":1}`, { status: 200 }), ctx);
    const b = await attachReceipt(new Response(`{"a":2}`, { status: 200 }), ctx);
    const ah = a.headers.get(INTERLACE_RECEIPT_HEADER)!;
    const bh = b.headers.get(INTERLACE_RECEIPT_HEADER)!;
    expect(ah).not.toBe(bh);
  });
});
