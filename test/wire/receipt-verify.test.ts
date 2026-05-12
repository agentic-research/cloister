/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it } from "vitest";
import {
  buildHeadersCommittedBytes,
  makeReceiptSignerFromKeypair,
  sha256,
  signCommitmentToHeader,
  signStreamCloseToEventPayload,
  signStreamOpenToHeader,
  type ReceiptCommitment,
  type StreamCloseCommitment,
  type StreamOpenCommitment,
} from "../../src/wire/receipts.js";
import {
  verifyReceiptPLive,
  verifyReceiptVArchival,
  verifyStreamClose,
  verifyStreamOpen,
} from "../../src/wire/receipt-verify.js";

// Same fixture as receipts.test.ts.
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
const EPOCH = 1;

async function buildScenario() {
  const signer = await makeReceiptSignerFromKeypair(KEYPAIR);
  const requestCanon = new TextEncoder().encode("POST\n/mcp\n1700000000000\nnonce\n{}");
  const responseBody = new TextEncoder().encode(`{"ok":true}`);
  const responseHeaders = new Headers({ "content-type": "application/json" });
  const nonce = new Uint8Array(16).fill(0xab);
  const nowMs = 1700000000000;

  const c: ReceiptCommitment = {
    nonce,
    requestHash:  await sha256(requestCanon),
    status:       200,
    bodyHash:     await sha256(responseBody),
    headersHash:  await sha256(buildHeadersCommittedBytes(responseHeaders)),
    timestampMs:  nowMs,
    actorFp:      ACTOR_FP,
    epoch:        EPOCH,
  };
  const { headerValue } = await signCommitmentToHeader(c, signer);
  return { signer, requestCanon, responseBody, responseHeaders, nonce, nowMs, c, headerValue };
}

describe("verifyReceiptPLive (§2.2.1 P-live)", () => {
  it("happy-path verifies a fresh receipt", async () => {
    const s = await buildScenario();
    const v = await verifyReceiptPLive({
      headerValue:     s.headerValue,
      expectedActorFp: ACTOR_FP,
      currentEpoch:    EPOCH,
      resolvePubkey:   (e) => e === EPOCH ? PUB : null,
      expectedNonce:   s.nonce,
      requestCanon:    s.requestCanon,
      responseBody:    s.responseBody,
      responseHeaders: s.responseHeaders,
      nowMs:           s.nowMs,
    });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.commitment.status).toBe(200);
      expect(v.commitment.epoch).toBe(EPOCH);
    }
  });

  it("rejects when actor_fp does not match", async () => {
    const s = await buildScenario();
    const v = await verifyReceiptPLive({
      headerValue:     s.headerValue,
      expectedActorFp: new Uint8Array(32).fill(0x99), // wrong
      currentEpoch:    EPOCH,
      resolvePubkey:   () => PUB,
      expectedNonce:   s.nonce,
      requestCanon:    s.requestCanon,
      responseBody:    s.responseBody,
      responseHeaders: s.responseHeaders,
      nowMs:           s.nowMs,
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("actor_fp");
  });

  it("rejects when epoch is not current or previous", async () => {
    const s = await buildScenario();
    const v = await verifyReceiptPLive({
      headerValue:     s.headerValue,
      expectedActorFp: ACTOR_FP,
      currentEpoch:    99, // wrong
      resolvePubkey:   () => PUB,
      expectedNonce:   s.nonce,
      requestCanon:    s.requestCanon,
      responseBody:    s.responseBody,
      responseHeaders: s.responseHeaders,
      nowMs:           s.nowMs,
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("epoch");
  });

  it("rejects on body tamper", async () => {
    const s = await buildScenario();
    const tampered = new TextEncoder().encode(`{"ok":false}`);
    const v = await verifyReceiptPLive({
      headerValue:     s.headerValue,
      expectedActorFp: ACTOR_FP,
      currentEpoch:    EPOCH,
      resolvePubkey:   () => PUB,
      expectedNonce:   s.nonce,
      requestCanon:    s.requestCanon,
      responseBody:    tampered, // tampered
      responseHeaders: s.responseHeaders,
      nowMs:           s.nowMs,
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("body_hash");
  });

  it("rejects on headers tamper (allowlisted header changed)", async () => {
    const s = await buildScenario();
    const tampered = new Headers(s.responseHeaders);
    tampered.set("content-type", "text/plain"); // change
    const v = await verifyReceiptPLive({
      headerValue:     s.headerValue,
      expectedActorFp: ACTOR_FP,
      currentEpoch:    EPOCH,
      resolvePubkey:   () => PUB,
      expectedNonce:   s.nonce,
      requestCanon:    s.requestCanon,
      responseBody:    s.responseBody,
      responseHeaders: tampered,
      nowMs:           s.nowMs,
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("headers_hash");
  });

  it("IGNORES non-allowlisted header changes", async () => {
    // Adding `x-custom` to the response headers should NOT cause verify
    // failure — non-allowlisted headers are not committed.
    const s = await buildScenario();
    const extra = new Headers(s.responseHeaders);
    extra.set("x-custom", "added-by-proxy");
    const v = await verifyReceiptPLive({
      headerValue:     s.headerValue,
      expectedActorFp: ACTOR_FP,
      currentEpoch:    EPOCH,
      resolvePubkey:   () => PUB,
      expectedNonce:   s.nonce,
      requestCanon:    s.requestCanon,
      responseBody:    s.responseBody,
      responseHeaders: extra,
      nowMs:           s.nowMs,
    });
    expect(v.ok).toBe(true);
  });

  it("rejects on nonce mismatch", async () => {
    const s = await buildScenario();
    const v = await verifyReceiptPLive({
      headerValue:     s.headerValue,
      expectedActorFp: ACTOR_FP,
      currentEpoch:    EPOCH,
      resolvePubkey:   () => PUB,
      expectedNonce:   new Uint8Array(16).fill(0x00), // wrong
      requestCanon:    s.requestCanon,
      responseBody:    s.responseBody,
      responseHeaders: s.responseHeaders,
      nowMs:           s.nowMs,
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("nonce");
  });

  it("rejects on clock-skew outside ±300s", async () => {
    const s = await buildScenario();
    const v = await verifyReceiptPLive({
      headerValue:     s.headerValue,
      expectedActorFp: ACTOR_FP,
      currentEpoch:    EPOCH,
      resolvePubkey:   () => PUB,
      expectedNonce:   s.nonce,
      requestCanon:    s.requestCanon,
      responseBody:    s.responseBody,
      responseHeaders: s.responseHeaders,
      nowMs:           s.nowMs + 1_000_000, // way out of window
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("timestamp_ms");
  });

  it("rejects on bad signature (pubkey-mismatch / forged)", async () => {
    const s = await buildScenario();
    // Resolve a DIFFERENT pubkey for the same epoch — signature MUST fail.
    const wrongPub = new Uint8Array(32).fill(0x11);
    const v = await verifyReceiptPLive({
      headerValue:     s.headerValue,
      expectedActorFp: ACTOR_FP,
      currentEpoch:    EPOCH,
      resolvePubkey:   () => wrongPub,
      expectedNonce:   s.nonce,
      requestCanon:    s.requestCanon,
      responseBody:    s.responseBody,
      responseHeaders: s.responseHeaders,
      nowMs:           s.nowMs,
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("Ed25519");
  });

  it("rejects on request_canon mismatch", async () => {
    const s = await buildScenario();
    const wrongCanon = new TextEncoder().encode("DIFFERENT REQUEST");
    const v = await verifyReceiptPLive({
      headerValue:     s.headerValue,
      expectedActorFp: ACTOR_FP,
      currentEpoch:    EPOCH,
      resolvePubkey:   () => PUB,
      expectedNonce:   s.nonce,
      requestCanon:    wrongCanon, // wrong
      responseBody:    s.responseBody,
      responseHeaders: s.responseHeaders,
      nowMs:           s.nowMs,
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("request_hash");
  });
});

describe("verifyReceiptVArchival (§2.2.2 audit)", () => {
  it("verifies against archival pubkey for retired epoch", async () => {
    const s = await buildScenario();
    // V at audit time uses the bundle's archival pubkey directly.
    const { decodeReceiptHeader } = await import("../../src/wire/receipts.js");
    const decoded = decodeReceiptHeader(s.headerValue);
    if (!decoded.ok) throw new Error(decoded.reason);
    // Re-encode to envelope bytes for v-archival API
    const { encodeReceiptEnvelope } = await import("../../src/wire/receipts.js");
    const envelopeBytes = encodeReceiptEnvelope(decoded.value);

    const v = await verifyReceiptVArchival({
      envelopeBytes,
      requestCanon:    s.requestCanon,
      responseBody:    s.responseBody,
      responseHeaders: s.responseHeaders,
      archivalPubkey:  PUB,
      expectedActorFp: ACTOR_FP,
    });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.trustedUnderCompromise).toBe(true);
  });

  it("downgrades trust when a compromise notice timestamp ≤ receipt's timestamp_ms", async () => {
    const s = await buildScenario();
    const { decodeReceiptHeader, encodeReceiptEnvelope } = await import("../../src/wire/receipts.js");
    const decoded = decodeReceiptHeader(s.headerValue);
    if (!decoded.ok) throw new Error(decoded.reason);
    const envelopeBytes = encodeReceiptEnvelope(decoded.value);

    const v = await verifyReceiptVArchival({
      envelopeBytes,
      requestCanon:    s.requestCanon,
      responseBody:    s.responseBody,
      responseHeaders: s.responseHeaders,
      archivalPubkey:  PUB,
      expectedActorFp: ACTOR_FP,
      compromiseNotice: { compromisedAtMs: s.nowMs - 1, verified: true },
    });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.trustedUnderCompromise).toBe(false);
  });

  it("retains trust when receipt timestamp_ms is BEFORE compromise", async () => {
    const s = await buildScenario();
    const { decodeReceiptHeader, encodeReceiptEnvelope } = await import("../../src/wire/receipts.js");
    const decoded = decodeReceiptHeader(s.headerValue);
    if (!decoded.ok) throw new Error(decoded.reason);
    const envelopeBytes = encodeReceiptEnvelope(decoded.value);

    const v = await verifyReceiptVArchival({
      envelopeBytes,
      requestCanon:    s.requestCanon,
      responseBody:    s.responseBody,
      responseHeaders: s.responseHeaders,
      archivalPubkey:  PUB,
      expectedActorFp: ACTOR_FP,
      compromiseNotice: { compromisedAtMs: s.nowMs + 60_000, verified: true },
    });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.trustedUnderCompromise).toBe(true);
  });

  it("rejects against the WRONG epoch's archival pubkey", async () => {
    const s = await buildScenario();
    const { decodeReceiptHeader, encodeReceiptEnvelope } = await import("../../src/wire/receipts.js");
    const decoded = decodeReceiptHeader(s.headerValue);
    if (!decoded.ok) throw new Error(decoded.reason);
    const envelopeBytes = encodeReceiptEnvelope(decoded.value);

    const v = await verifyReceiptVArchival({
      envelopeBytes,
      requestCanon:    s.requestCanon,
      responseBody:    s.responseBody,
      responseHeaders: s.responseHeaders,
      archivalPubkey:  new Uint8Array(32).fill(0xfe), // wrong
      expectedActorFp: ACTOR_FP,
    });
    expect(v.ok).toBe(false);
  });
});

describe("verifyStreamOpen + verifyStreamClose (§2.4)", () => {
  it("round-trips open + close binding via openCommitmentHash", async () => {
    const signer = await makeReceiptSignerFromKeypair(KEYPAIR);
    const requestCanon = new TextEncoder().encode("GET\n/mcp\n1\nn\n");
    const nonce = new Uint8Array(16).fill(0x77);
    const streamId = new Uint8Array(16).fill(0x88);
    const open: StreamOpenCommitment = {
      nonce, requestHash: await sha256(requestCanon),
      status: 200, streamMode: "sse", streamId,
      timestampMs: 1700000000000, actorFp: ACTOR_FP, epoch: EPOCH,
    };
    const openResult = await signStreamOpenToHeader(open, signer);
    const openVerify = await verifyStreamOpen({
      headerValue:     openResult.headerValue,
      expectedActorFp: ACTOR_FP,
      currentEpoch:    EPOCH,
      resolvePubkey:   () => PUB,
      expectedNonce:   nonce,
      requestCanon,
      nowMs:           1700000000000,
    });
    expect(openVerify.ok).toBe(true);
    if (!openVerify.ok) return;

    // Close commitment bound to open
    const close: StreamCloseCommitment = {
      streamId,
      openCommitmentHash: openVerify.openCommitmentHash,
      tipHash:            openVerify.openCommitmentHash, // empty stream
      eventCount:         0,
      closeStatus:        "ok",
      timestampMs:        1700000000100,
    };
    const closeResult = await signStreamCloseToEventPayload(close, signer);
    const closeVerify = await verifyStreamClose({
      payload:                   closeResult.payload,
      expectedOpenCommitmentHash: openVerify.openCommitmentHash,
      expectedTipHash:           openVerify.openCommitmentHash,
      pubkey:                    PUB,
    });
    expect(closeVerify.ok).toBe(true);
  });

  it("rejects swap attack (N1) — close bound to different open's hash", async () => {
    const signer = await makeReceiptSignerFromKeypair(KEYPAIR);
    const wrongOpenHash = new Uint8Array(32).fill(0xff);
    const close: StreamCloseCommitment = {
      streamId:           new Uint8Array(16).fill(0x88),
      openCommitmentHash: wrongOpenHash, // bound to a DIFFERENT open
      tipHash:            wrongOpenHash,
      eventCount:         0,
      closeStatus:        "ok",
      timestampMs:        1700000000100,
    };
    const { payload } = await signStreamCloseToEventPayload(close, signer);
    const v = await verifyStreamClose({
      payload,
      // Verifier expects this open's hash
      expectedOpenCommitmentHash: new Uint8Array(32).fill(0xaa),
      expectedTipHash:           new Uint8Array(32).fill(0xff),
      pubkey:                    PUB,
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("open_commitment_hash");
  });

  it("rejects on tip_hash divergence (chain break)", async () => {
    const signer = await makeReceiptSignerFromKeypair(KEYPAIR);
    const open = new Uint8Array(32).fill(0xaa);
    const wrongTip = new Uint8Array(32).fill(0xbb);
    const close: StreamCloseCommitment = {
      streamId:           new Uint8Array(16).fill(0x88),
      openCommitmentHash: open,
      tipHash:            wrongTip,
      eventCount:         3,
      closeStatus:        "ok",
      timestampMs:        1700000000100,
    };
    const { payload } = await signStreamCloseToEventPayload(close, signer);
    const expectedTip = new Uint8Array(32).fill(0xcc); // P's rolling hash
    const v = await verifyStreamClose({
      payload,
      expectedOpenCommitmentHash: open,
      expectedTipHash:           expectedTip,
      pubkey:                    PUB,
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("tip_hash");
  });
});
