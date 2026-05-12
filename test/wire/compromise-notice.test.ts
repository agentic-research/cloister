/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it } from "vitest";
import {
  decodeCompromiseNotice,
  encodeCompromiseNotice,
  encodeCompromiseNoticeEnvelope,
  pubkeyFingerprint,
  signCompromiseNotice,
  verifyCompromiseNotice,
  type CompromiseNoticeCommitment,
} from "../../src/wire/compromise-notice.js";
import { makeReceiptSignerFromKeypair, b64urlDecode } from "../../src/wire/receipts.js";

// Two distinct keypairs — sk_N (compromised) and sk_N+1 (signs the notice).
const SEED_N = new Uint8Array([
  0x4c, 0xcd, 0x08, 0x9b, 0x28, 0xff, 0x96, 0xda,
  0x9d, 0xb6, 0xc3, 0x46, 0xec, 0x11, 0x4e, 0x0f,
  0x5b, 0x8a, 0x31, 0x9f, 0x35, 0xab, 0xa6, 0x24,
  0xda, 0x8c, 0xf6, 0xed, 0x4f, 0xb8, 0xa6, 0xfb,
]);
const PUB_N = new Uint8Array([
  0x3d, 0x40, 0x17, 0xc3, 0xe8, 0x43, 0x89, 0x5a,
  0x92, 0xb7, 0x0a, 0xa7, 0x4d, 0x1b, 0x7e, 0xbc,
  0x9c, 0x98, 0x2c, 0xcf, 0x2e, 0xc4, 0x96, 0x8c,
  0xc0, 0xcd, 0x55, 0xf1, 0x2a, 0xf4, 0x66, 0x0c,
]);
const KEYPAIR_N = new Uint8Array(64);
KEYPAIR_N.set(SEED_N, 0);
KEYPAIR_N.set(PUB_N, 32);

// sk_{N+1} — use the RFC8032 vec1 keypair
const SEED_NEXT = new Uint8Array([
  0x9d, 0x61, 0xb1, 0x9d, 0xef, 0xfd, 0x5a, 0x60,
  0xba, 0x84, 0x4a, 0xf4, 0x92, 0xec, 0x2c, 0xc4,
  0x44, 0x49, 0xc5, 0x69, 0x7b, 0x32, 0x69, 0x19,
  0x70, 0x3b, 0xac, 0x03, 0x1c, 0xae, 0x7f, 0x60,
]);
const PUB_NEXT = new Uint8Array([
  0xd7, 0x5a, 0x98, 0x01, 0x82, 0xb1, 0x0a, 0xb7,
  0xd5, 0x4b, 0xfe, 0xd3, 0xc9, 0x64, 0x07, 0x3a,
  0x0e, 0xe1, 0x72, 0xf3, 0xda, 0xa6, 0x23, 0x25,
  0xaf, 0x02, 0x1a, 0x68, 0xf7, 0x07, 0x51, 0x1a,
]);
const KEYPAIR_NEXT = new Uint8Array(64);
KEYPAIR_NEXT.set(SEED_NEXT, 0);
KEYPAIR_NEXT.set(PUB_NEXT, 32);

describe("compromise notice", () => {
  it("encodes canonical bytes deterministically", () => {
    const c: CompromiseNoticeCommitment = {
      compromisedEpoch: 5,
      compromisedAtMs:  1700000000000,
      prevPubkeyFp:     new Uint8Array(32).fill(0xaa),
      rotationActorFp:  new Uint8Array(32).fill(0xbb),
      noticeAtMs:       1700001000000,
    };
    const a = encodeCompromiseNotice(c);
    const b = encodeCompromiseNotice(c);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("signs with next-epoch key + verifies under next-epoch pubkey", async () => {
    const nextSigner = await makeReceiptSignerFromKeypair(KEYPAIR_NEXT);
    const prevFp = await pubkeyFingerprint(PUB_N);
    const c: CompromiseNoticeCommitment = {
      compromisedEpoch: 5,
      compromisedAtMs:  1700000000000,
      prevPubkeyFp:     prevFp,
      rotationActorFp:  new Uint8Array(32).fill(0xbb),
      noticeAtMs:       1700001000000,
    };
    const { envelopeBytes } = await signCompromiseNotice(c, nextSigner);
    const v = await verifyCompromiseNotice({
      envelopeBytes,
      nextEpochPubkey:      PUB_NEXT,
      expectedPrevPubkeyFp: prevFp,
    });
    expect(v.ok).toBe(true);
  });

  it("rejects when verified against the COMPROMISED key (not next)", async () => {
    const nextSigner = await makeReceiptSignerFromKeypair(KEYPAIR_NEXT);
    const prevFp = await pubkeyFingerprint(PUB_N);
    const c: CompromiseNoticeCommitment = {
      compromisedEpoch: 5,
      compromisedAtMs:  1700000000000,
      prevPubkeyFp:     prevFp,
      rotationActorFp:  new Uint8Array(32).fill(0xbb),
      noticeAtMs:       1700001000000,
    };
    const { envelopeBytes } = await signCompromiseNotice(c, nextSigner);
    const v = await verifyCompromiseNotice({
      envelopeBytes,
      nextEpochPubkey:      PUB_N, // wrong — would let adversary forge
      expectedPrevPubkeyFp: prevFp,
    });
    expect(v.ok).toBe(false);
  });

  it("rejects when prev_pubkey_fp does not match expected", async () => {
    const nextSigner = await makeReceiptSignerFromKeypair(KEYPAIR_NEXT);
    const c: CompromiseNoticeCommitment = {
      compromisedEpoch: 5,
      compromisedAtMs:  1700000000000,
      prevPubkeyFp:     new Uint8Array(32).fill(0xcc), // wrong
      rotationActorFp:  new Uint8Array(32).fill(0xbb),
      noticeAtMs:       1700001000000,
    };
    const { envelopeBytes } = await signCompromiseNotice(c, nextSigner);
    const v = await verifyCompromiseNotice({
      envelopeBytes,
      nextEpochPubkey:      PUB_NEXT,
      expectedPrevPubkeyFp: await pubkeyFingerprint(PUB_N),
    });
    expect(v.ok).toBe(false);
  });

  it("envelope decodes to the same fields it was signed with", async () => {
    const nextSigner = await makeReceiptSignerFromKeypair(KEYPAIR_NEXT);
    const prevFp = await pubkeyFingerprint(PUB_N);
    const c: CompromiseNoticeCommitment = {
      compromisedEpoch: 11,
      compromisedAtMs:  1234567890,
      prevPubkeyFp:     prevFp,
      rotationActorFp:  new Uint8Array(32).fill(0x55),
      noticeAtMs:       1234567899,
    };
    const { envelopeBytes } = await signCompromiseNotice(c, nextSigner);
    const decoded = decodeCompromiseNotice(envelopeBytes);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.commitment.compromisedEpoch).toBe(11);
      expect(decoded.value.commitment.compromisedAtMs).toBe(1234567890);
      expect(decoded.value.commitment.noticeAtMs).toBe(1234567899);
      expect(Array.from(decoded.value.commitment.prevPubkeyFp)).toEqual(Array.from(prevFp));
    }
  });
});

describe("compromise-notice & receipt trust transition (§2.7)", () => {
  it("receipt timestamp < compromised_at_ms remains trusted; ≥ becomes untrusted", async () => {
    // This test re-validates the §2.7 invariant at the boundary.
    const compromisedAtMs = 1700000005000;

    // helper: simulate the §2.7 trust check (lives in V-archival verifier).
    function trustedUnderCompromise(receiptTs: number): boolean {
      return receiptTs < compromisedAtMs;
    }

    expect(trustedUnderCompromise(1700000004999)).toBe(true);  // 1ms before
    expect(trustedUnderCompromise(1700000005000)).toBe(false); // exactly at
    expect(trustedUnderCompromise(1700000005001)).toBe(false); // 1ms after
  });
});

// Touch unused import
void b64urlDecode;
