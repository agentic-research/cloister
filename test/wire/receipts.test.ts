/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it } from "vitest";
import {
  HEADER_ALLOWLIST,
  buildHeadersCommittedBytes,
  decodeReceiptHeader,
  encodeCommitment,
  commitmentCborMap,
  decodeReceiptBytes,
  encodeReceiptEnvelope,
  encodeStreamCloseCommitment,
  encodeStreamOpenCommitment,
  eventChainStep,
  makeReceiptSignerFromKeypair,
  sha256,
  signCommitmentToHeader,
  signStreamCloseToEventPayload,
  signStreamOpenToHeader,
  verifyEd25519,
  type ReceiptCommitment,
  type StreamCloseCommitment,
  type StreamOpenCommitment,
} from "../../src/wire/receipts.js";
import { canonicalCbor } from "../../src/wire/receipts-cbor.js";

// ── Test fixtures ─────────────────────────────────────────────────────────
//
// Deterministic Ed25519 keypair generated from a fixed seed. The seed
// MUST match the pubkey via Ed25519 derivation; Web Crypto Ed25519
// derives pub from seed at importKey time, so we round-trip once
// against the importer to obtain the canonical pubkey.

const SEED = new Uint8Array([
  0x9d, 0x61, 0xb1, 0x9d, 0xef, 0xfd, 0x5a, 0x60,
  0xba, 0x84, 0x4a, 0xf4, 0x92, 0xec, 0x2c, 0xc4,
  0x44, 0x49, 0xc5, 0x69, 0x7b, 0x32, 0x69, 0x19,
  0x70, 0x3b, 0xac, 0x03, 0x1c, 0xae, 0x7f, 0x60,
]);
// Public key derived from the seed via Ed25519 (RFC 8032 vec 1).
const EXPECTED_PUB = new Uint8Array([
  0xd7, 0x5a, 0x98, 0x01, 0x82, 0xb1, 0x0a, 0xb7,
  0xd5, 0x4b, 0xfe, 0xd3, 0xc9, 0x64, 0x07, 0x3a,
  0x0e, 0xe1, 0x72, 0xf3, 0xda, 0xa6, 0x23, 0x25,
  0xaf, 0x02, 0x1a, 0x68, 0xf7, 0x07, 0x51, 0x1a,
]);
const KEYPAIR = new Uint8Array(64);
KEYPAIR.set(SEED, 0);
KEYPAIR.set(EXPECTED_PUB, 32);

function makeCommitment(overrides: Partial<ReceiptCommitment> = {}): ReceiptCommitment {
  return {
    nonce:        new Uint8Array(16).fill(0xab),
    requestHash:  new Uint8Array(32).fill(0xcd),
    status:       200,
    bodyHash:     new Uint8Array(32).fill(0xef),
    headersHash:  new Uint8Array(32).fill(0xaa),
    timestampMs:  1700000000000,
    actorFp:      new Uint8Array(32).fill(0x55),
    epoch:        1,
    ...overrides,
  };
}

describe("ReceiptSigner (Ed25519)", () => {
  it("signs and verifies a round-trip with known keypair", async () => {
    const signer = await makeReceiptSignerFromKeypair(KEYPAIR);
    expect(signer.pubkey).toEqual(EXPECTED_PUB);

    const msg = new TextEncoder().encode("hello receipt");
    const sig = await signer.sign(msg);
    expect(sig.length).toBe(64);
    expect(await verifyEd25519(signer.pubkey, sig, msg)).toBe(true);
    // Tamper one byte
    msg[0] ^= 1;
    expect(await verifyEd25519(signer.pubkey, sig, msg)).toBe(false);
  });

  it("rejects wrong-length keypairs", async () => {
    await expect(makeReceiptSignerFromKeypair(new Uint8Array(63))).rejects.toThrow();
    await expect(makeReceiptSignerFromKeypair(new Uint8Array(65))).rejects.toThrow();
  });

  it("verifyEd25519 returns false on length mismatches without throwing", async () => {
    expect(await verifyEd25519(new Uint8Array(31), new Uint8Array(64), new Uint8Array(1))).toBe(false);
    expect(await verifyEd25519(new Uint8Array(32), new Uint8Array(63), new Uint8Array(1))).toBe(false);
  });
});

describe("commitment canonical bytes are byte-stable + sign-verify clean", () => {
  it("round-trips through header encode + decode", async () => {
    const signer = await makeReceiptSignerFromKeypair(KEYPAIR);
    const c = makeCommitment();
    const { headerValue } = await signCommitmentToHeader(c, signer);
    const decoded = decodeReceiptHeader(headerValue);
    if (!decoded.ok) throw new Error(`decode failed: ${decoded.reason}`);
    expect(decoded.value.commitment).toEqual(c);
    expect(decoded.value.signature.length).toBe(64);

    // Verify the signature over the canonical commitment bytes.
    const canon = encodeCommitment(decoded.value.commitment);
    expect(await verifyEd25519(signer.pubkey, decoded.value.signature, canon)).toBe(true);
  });

  it("two encodes of the same commitment produce byte-equal output", () => {
    const c = makeCommitment();
    const a = encodeCommitment(c);
    const b = encodeCommitment(c);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("changing any field changes the canonical bytes", () => {
    const base = encodeCommitment(makeCommitment());
    const tweaks: Array<[string, Partial<ReceiptCommitment>]> = [
      ["epoch",       { epoch: 2 }],
      ["status",      { status: 201 }],
      ["timestampMs", { timestampMs: 1700000000001 }],
      ["nonce",       { nonce: new Uint8Array(16).fill(0xac) }],
      ["bodyHash",    { bodyHash: new Uint8Array(32).fill(0xee) }],
      ["headersHash", { headersHash: new Uint8Array(32).fill(0xa9) }],
      ["actorFp",     { actorFp: new Uint8Array(32).fill(0x56) }],
      ["requestHash", { requestHash: new Uint8Array(32).fill(0xce) }],
    ];
    for (const [label, override] of tweaks) {
      const enc = encodeCommitment(makeCommitment(override));
      expect(Array.from(enc), `tweak '${label}' should change bytes`).not.toEqual(Array.from(base));
    }
  });

  it("decodeReceiptHeader rejects garbage", () => {
    const r = decodeReceiptHeader("not-base64url!!!");
    expect(r.ok).toBe(false);
  });

  it("decodeReceiptHeader rejects envelope with extra keys", async () => {
    const signer = await makeReceiptSignerFromKeypair(KEYPAIR);
    const c = makeCommitment();
    const { headerValue } = await signCommitmentToHeader(c, signer);
    // A correct receipt → decode succeeds.
    const ok = decodeReceiptHeader(headerValue);
    expect(ok.ok).toBe(true);
  });
});

describe("HEADER_ALLOWLIST + buildHeadersCommittedBytes", () => {
  it("includes only allowlisted headers (case-insensitive)", () => {
    const h = new Headers({
      "Content-Type": "application/json",
      "X-Custom":     "should-be-ignored",
      "etag":         "W/\"abc\"",
    });
    const bytes = buildHeadersCommittedBytes(h);
    // Decode + check shape
    const text = new TextDecoder().decode(bytes);
    // Custom header MUST NOT appear; allowlisted ones do
    expect(text).toContain("content-type");
    expect(text).toContain("etag");
    expect(text).not.toContain("x-custom");
  });

  it("produces deterministic bytes regardless of insertion order", () => {
    const a = new Headers();
    a.set("etag", "x");
    a.set("content-type", "y");
    const b = new Headers();
    b.set("content-type", "y");
    b.set("etag", "x");
    expect(Array.from(buildHeadersCommittedBytes(a))).toEqual(Array.from(buildHeadersCommittedBytes(b)));
  });

  it("MCP protocol headers (R3-1 round-3 finding) are committed", () => {
    const h = new Headers({ "mcp-session-id": "s1", "mcp-protocol-version": "2026-01-01" });
    const bytes = buildHeadersCommittedBytes(h);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("mcp-session-id");
    expect(text).toContain("mcp-protocol-version");
  });

  it("HEADER_ALLOWLIST is bytewise-lex sorted", () => {
    for (let i = 1; i < HEADER_ALLOWLIST.length; i++) {
      expect(HEADER_ALLOWLIST[i - 1] < HEADER_ALLOWLIST[i]).toBe(true);
    }
  });
});

describe("stream commitments (§2.4)", () => {
  it("open + close round-trip via header / payload encoding", async () => {
    const signer = await makeReceiptSignerFromKeypair(KEYPAIR);
    const open: StreamOpenCommitment = {
      nonce:       new Uint8Array(16).fill(1),
      requestHash: new Uint8Array(32).fill(2),
      status:      200,
      streamMode:  "sse",
      streamId:    new Uint8Array(16).fill(3),
      timestampMs: 1700000000000,
      actorFp:     new Uint8Array(32).fill(4),
      epoch:       7,
    };
    const { commitmentHash: openHash } = await signStreamOpenToHeader(open, signer);
    expect(openHash.length).toBe(32);

    // Verify the open-hash matches manually-computed SHA-256 of canonical bytes
    const canon = encodeStreamOpenCommitment(open);
    const manual = await sha256(canon);
    expect(Array.from(openHash)).toEqual(Array.from(manual));

    const close: StreamCloseCommitment = {
      streamId: open.streamId,
      openCommitmentHash: openHash,
      tipHash: openHash, // empty-stream case
      eventCount: 0,
      closeStatus: "ok",
      timestampMs: 1700000000100,
    };
    const { payload } = await signStreamCloseToEventPayload(close, signer);
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("encodeStreamCloseCommitment is byte-stable for identical inputs", () => {
    const close: StreamCloseCommitment = {
      streamId: new Uint8Array(16).fill(9),
      openCommitmentHash: new Uint8Array(32).fill(8),
      tipHash: new Uint8Array(32).fill(7),
      eventCount: 5,
      closeStatus: "ok",
      timestampMs: 1700000000000,
    };
    expect(Array.from(encodeStreamCloseCommitment(close))).toEqual(Array.from(encodeStreamCloseCommitment(close)));
  });
});

describe("event chain hashing (§2.4)", () => {
  it("eventChainStep returns 32-byte SHA-256", async () => {
    const h = await eventChainStep(new Uint8Array(32), new Uint8Array([1, 2, 3]), 0);
    expect(h.length).toBe(32);
  });

  it("eventChainStep changes when prev / data / seq changes", async () => {
    const base = await eventChainStep(new Uint8Array(32).fill(1), new Uint8Array([1, 2]), 0);
    const diffPrev = await eventChainStep(new Uint8Array(32).fill(2), new Uint8Array([1, 2]), 0);
    const diffData = await eventChainStep(new Uint8Array(32).fill(1), new Uint8Array([1, 3]), 0);
    const diffSeq  = await eventChainStep(new Uint8Array(32).fill(1), new Uint8Array([1, 2]), 1);
    expect(Array.from(diffPrev)).not.toEqual(Array.from(base));
    expect(Array.from(diffData)).not.toEqual(Array.from(base));
    expect(Array.from(diffSeq)).not.toEqual(Array.from(base));
  });
});

describe("encodeReceiptEnvelope produces signed-envelope bytes", () => {
  it("base envelope shape: map(2) {commitment, signature}", async () => {
    const signer = await makeReceiptSignerFromKeypair(KEYPAIR);
    const c = makeCommitment();
    const canon = encodeCommitment(c);
    const sig = await signer.sign(canon);
    const env = encodeReceiptEnvelope({ commitment: c, signature: sig });
    // First byte: map(2) = 0xa2
    expect(env[0]).toBe(0xa2);
    // Decode round-trip
    const dec = decodeReceiptHeader(btoa(String.fromCharCode(...env)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
    expect(dec.ok).toBe(true);
  });
});

// ── ADR-0065 phase 2b: origins_hash on the commitment ────────────────────

describe("origins_hash is optional and backward-compatible", () => {
  const base = () => ({
    nonce:       new Uint8Array(16).fill(1),
    requestHash: new Uint8Array(32).fill(2),
    status:      200,
    bodyHash:    new Uint8Array(32).fill(3),
    headersHash: new Uint8Array(32).fill(4),
    timestampMs: 1_700_000_000_000,
    actorFp:     new Uint8Array(32).fill(5),
    epoch:       7,
  });

  it("a commitment WITHOUT origins encodes byte-identically to the pre-0065 shape", () => {
    // The compatibility claim, made falsifiable. If adding the field ever
    // changes the no-origins encoding, every previously-issued receipt stops
    // verifying and nothing else in the suite would say so.
    const withoutField = encodeCommitment(base());
    const withUndefined = encodeCommitment({ ...base(), originsHash: undefined });
    expect(Array.from(withUndefined)).toEqual(Array.from(withoutField));
  });

  it("round-trips a commitment carrying origins_hash", () => {
    const c = { ...base(), originsHash: new Uint8Array(32).fill(9) };
    const decoded = decodeReceiptBytes(
      encodeReceiptEnvelope({ commitment: c, signature: new Uint8Array(64) }),
    );
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(Array.from(decoded.value.commitment.originsHash!)).toEqual(Array.from(c.originsHash));
  });

  it("an absent origins_hash decodes to an ABSENT field, not an explicit undefined", () => {
    // So a decoded commitment deep-equals one built without the key, and
    // re-encoding it reproduces the same bytes.
    const decoded = decodeReceiptBytes(
      encodeReceiptEnvelope({ commitment: base(), signature: new Uint8Array(64) }),
    );
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect("originsHash" in decoded.value.commitment).toBe(false);
  });

  it("rejects an origins_hash of the wrong length rather than accepting a short digest", () => {
    const bad = { ...base(), originsHash: new Uint8Array(16).fill(9) };
    const decoded = decodeReceiptBytes(
      encodeReceiptEnvelope({ commitment: bad, signature: new Uint8Array(64) }),
    );
    expect(decoded.ok).toBe(false);
  });

  it("still rejects a genuinely unknown key — the strictness is not loosened", () => {
    // The optional-key allowance must admit exactly one name, not open the
    // commitment to arbitrary clauses. An unrecognised clause in a SIGNED
    // structure being silently ignored is the failure this check exists for.
    const raw = canonicalCbor({
      commitment: { ...commitmentCborMap(base()), surprise: new Uint8Array(4) },
      signature: new Uint8Array(64),
    });
    expect(decodeReceiptBytes(raw).ok).toBe(false);
  });
});
