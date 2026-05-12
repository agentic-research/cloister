/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it } from "vitest";
import {
  INTERLACE_RECEIPT_HEADER,
  decodeReceiptHeader,
  eventChainStep,
  makeReceiptSignerFromKeypair,
  sha256,
  encodeStreamOpenCommitment,
} from "../../src/wire/receipts.js";
import { wrapSseWithReceiptStream, type StreamReceiptContext } from "../../src/routes/receipt-stream.js";
import {
  verifyStreamClose,
  verifyStreamOpen,
} from "../../src/wire/receipt-verify.js";

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
const ACTOR_FP = new Uint8Array(32).fill(0x55);

async function makeCtx(): Promise<StreamReceiptContext> {
  return {
    requestCanon: new TextEncoder().encode("GET\n/mcp\n1700000000000\nnonce\n"),
    nonce:        new Uint8Array(16).fill(0xab),
    signer:       await makeReceiptSignerFromKeypair(KEYPAIR),
    actorFp:      ACTOR_FP,
    epoch:        1,
    nowMs:        1700000000000,
  };
}

function makeSseResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) controller.enqueue(encoder.encode(e));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function readBody(resp: Response): Promise<string> {
  return await resp.text();
}

describe("wrapSseWithReceiptStream — §2.4 stream chain", () => {
  it("adds Interlace-Receipt header carrying a valid stream-open commitment", async () => {
    const ctx = await makeCtx();
    const upstream = makeSseResponse(["data: hello\n\n"]);
    const wrapped = await wrapSseWithReceiptStream(upstream, ctx);
    expect(wrapped.headers.get(INTERLACE_RECEIPT_HEADER)).not.toBeNull();

    const header = wrapped.headers.get(INTERLACE_RECEIPT_HEADER)!;
    const v = await verifyStreamOpen({
      headerValue:     header,
      expectedActorFp: ACTOR_FP,
      currentEpoch:    1,
      resolvePubkey:   () => PUB,
      expectedNonce:   ctx.nonce,
      requestCanon:    ctx.requestCanon,
      nowMs:           ctx.nowMs,
    });
    expect(v.ok).toBe(true);
    await readBody(wrapped); // drain
  });

  it("emits final interlace-stream-close event after stream ends", async () => {
    const ctx = await makeCtx();
    const upstream = makeSseResponse(["data: e1\n\n", "data: e2\n\n"]);
    const wrapped = await wrapSseWithReceiptStream(upstream, ctx);
    const body = await readBody(wrapped);
    expect(body).toContain("data: e1");
    expect(body).toContain("data: e2");
    expect(body).toContain("event: interlace-stream-close");
  });

  it("empty-stream case: tip_hash equals open_commitment_hash", async () => {
    const ctx = await makeCtx();
    const upstream = makeSseResponse([]);  // no events
    const wrapped = await wrapSseWithReceiptStream(upstream, ctx);
    const body = await readBody(wrapped);
    // Body contains only the close event.
    expect(body).toContain("event: interlace-stream-close");

    // Parse open from header + close from body.
    const headerValue = wrapped.headers.get(INTERLACE_RECEIPT_HEADER)!;
    const openV = await verifyStreamOpen({
      headerValue,
      expectedActorFp: ACTOR_FP,
      currentEpoch:    1,
      resolvePubkey:   () => PUB,
      expectedNonce:   ctx.nonce,
      requestCanon:    ctx.requestCanon,
      nowMs:           ctx.nowMs,
    });
    expect(openV.ok).toBe(true);
    if (!openV.ok) return;

    const closeMatch = body.match(/event: interlace-stream-close\ndata: ([^\n]+)/);
    expect(closeMatch).not.toBeNull();
    const closePayload = closeMatch![1]!;
    const closeV = await verifyStreamClose({
      payload: closePayload,
      expectedOpenCommitmentHash: openV.openCommitmentHash,
      // Empty stream → tip_hash MUST equal open_commitment_hash.
      expectedTipHash: openV.openCommitmentHash,
      pubkey: PUB,
    });
    expect(closeV.ok).toBe(true);
    if (closeV.ok) expect(closeV.envelope.commitment.eventCount).toBe(0);
  });

  it("chain walk: each non-comment event advances the rolling hash; close binds to tip", async () => {
    const ctx = await makeCtx();
    const events = ["data: a\n\n", "data: b\n\n", "data: c\n\n"];
    const upstream = makeSseResponse(events);
    const wrapped = await wrapSseWithReceiptStream(upstream, ctx);
    const body = await readBody(wrapped);

    const headerValue = wrapped.headers.get(INTERLACE_RECEIPT_HEADER)!;
    const openV = await verifyStreamOpen({
      headerValue,
      expectedActorFp: ACTOR_FP,
      currentEpoch:    1,
      resolvePubkey:   () => PUB,
      expectedNonce:   ctx.nonce,
      requestCanon:    ctx.requestCanon,
      nowMs:           ctx.nowMs,
    });
    if (!openV.ok) throw new Error("open verify failed");

    // P-side simulate the rolling hash. Each event block (without
    // trailing \n\n) is passed to eventChainStep.
    let rolling = openV.openCommitmentHash;
    for (let i = 0; i < events.length; i++) {
      const block = events[i]!.slice(0, -2);  // strip trailing \n\n
      const bytes = new TextEncoder().encode(block);
      rolling = await eventChainStep(rolling, bytes, i);
    }

    const closeMatch = body.match(/event: interlace-stream-close\ndata: ([^\n]+)/);
    if (closeMatch === null) throw new Error("no close event");
    const closeV = await verifyStreamClose({
      payload: closeMatch[1]!,
      expectedOpenCommitmentHash: openV.openCommitmentHash,
      expectedTipHash: rolling,
      pubkey: PUB,
    });
    expect(closeV.ok).toBe(true);
    if (closeV.ok) expect(closeV.envelope.commitment.eventCount).toBe(3);
  });

  it("comments (lines starting with ':') are NOT chained", async () => {
    const ctx = await makeCtx();
    const events = ["data: a\n\n", ": keepalive comment\n\n", "data: b\n\n"];
    const upstream = makeSseResponse(events);
    const wrapped = await wrapSseWithReceiptStream(upstream, ctx);
    const body = await readBody(wrapped);
    expect(body).toContain(": keepalive comment");

    const headerValue = wrapped.headers.get(INTERLACE_RECEIPT_HEADER)!;
    const openV = await verifyStreamOpen({
      headerValue,
      expectedActorFp: ACTOR_FP,
      currentEpoch:    1,
      resolvePubkey:   () => PUB,
      expectedNonce:   ctx.nonce,
      requestCanon:    ctx.requestCanon,
      nowMs:           ctx.nowMs,
    });
    if (!openV.ok) throw new Error("open verify failed");

    // P's rolling — only "a" and "b" should advance the chain.
    let rolling = openV.openCommitmentHash;
    rolling = await eventChainStep(rolling, new TextEncoder().encode("data: a"), 0);
    rolling = await eventChainStep(rolling, new TextEncoder().encode("data: b"), 1);

    const closeMatch = body.match(/event: interlace-stream-close\ndata: ([^\n]+)/);
    if (closeMatch === null) throw new Error("no close event");
    const closeV = await verifyStreamClose({
      payload: closeMatch[1]!,
      expectedOpenCommitmentHash: openV.openCommitmentHash,
      expectedTipHash: rolling,
      pubkey: PUB,
    });
    expect(closeV.ok).toBe(true);
    if (closeV.ok) expect(closeV.envelope.commitment.eventCount).toBe(2);
  });

  it("pass-through for non-200 responses", async () => {
    const ctx = await makeCtx();
    const upstream = new Response("oops", { status: 500 });
    const wrapped = await wrapSseWithReceiptStream(upstream, ctx);
    expect(wrapped.status).toBe(500);
    expect(wrapped.headers.get(INTERLACE_RECEIPT_HEADER)).toBeNull();
  });

  it("open_commitment_hash equals SHA-256(canonical_cbor(open_commitment))", async () => {
    const ctx = await makeCtx();
    const upstream = makeSseResponse([]);
    const wrapped = await wrapSseWithReceiptStream(upstream, ctx);
    await readBody(wrapped);  // drain

    const headerValue = wrapped.headers.get(INTERLACE_RECEIPT_HEADER)!;
    const decoded = decodeReceiptHeader(headerValue);
    // decodeReceiptHeader is for per-request receipts; stream uses
    // its own envelope shape. Just sanity-check it doesn't crash.
    void decoded;

    const openV = await verifyStreamOpen({
      headerValue,
      expectedActorFp: ACTOR_FP,
      currentEpoch:    1,
      resolvePubkey:   () => PUB,
      expectedNonce:   ctx.nonce,
      requestCanon:    ctx.requestCanon,
      nowMs:           ctx.nowMs,
    });
    if (!openV.ok) throw new Error("open verify failed");

    // Independently compute SHA-256 of canonical CBOR — must match
    const manual = await sha256(encodeStreamOpenCommitment(openV.envelope.commitment));
    expect(Array.from(openV.openCommitmentHash)).toEqual(Array.from(manual));
  });
});
