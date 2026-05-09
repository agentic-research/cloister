/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Digest } from "../src/storage/types.js";
import { asDigest } from "../src/storage/types.js";
import { beadCanonicalBytesV1, beadCanonicalDigestV1 } from "../src/storage/bead-canonical.js";
import type { Bead } from "../src/types.js";

// Singleton-per-cluster keying: cloister-960f68 / ADR-0012.
function blobStoreStub() {
  return env.BLOB_STORE.get(env.BLOB_STORE.idFromName("cluster")) as DurableObjectStub & {
    put(bytes: Uint8Array): Promise<Digest>;
    get(digest: Digest): Promise<Uint8Array | null>;
    has(digest: Digest): Promise<boolean>;
  };
}

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

// ── Smoke ────────────────────────────────────────────────────────────────

describe("BlobStore DO — basic ops", () => {
  it("put returns a 64-char lowercase hex digest", async () => {
    const stub = blobStoreStub();
    const d = await stub.put(enc("hello-blob-store"));
    expect(d).toMatch(/^[0-9a-f]{64}$/);
  });

  it("get round-trips bytes exactly", async () => {
    const stub = blobStoreStub();
    const original = enc("round-trip payload — UTF-8 with extended chars: αβγ 🎲");
    const d = await stub.put(original);
    const round = await stub.get(d);
    expect(round).not.toBeNull();
    expect(dec(round!)).toBe(dec(original));
  });

  it("get returns null for a digest that was never put", async () => {
    const stub = blobStoreStub();
    const fakeDigest = asDigest("0".repeat(64));
    const result = await stub.get(fakeDigest);
    expect(result).toBeNull();
  });

  it("has returns true for stored digest, false otherwise", async () => {
    const stub = blobStoreStub();
    const d = await stub.put(enc("has-test"));
    expect(await stub.has(d)).toBe(true);
    expect(await stub.has(asDigest("f".repeat(64)))).toBe(false);
  });
});

// ── Idempotency: the load-bearing invariant for ADR-0012 ─────────────────

describe("BlobStore DO — idempotency (ADR-0012 cross-DO recovery contract)", () => {
  it("put is idempotent: same bytes -> same digest, repeatedly", async () => {
    const stub = blobStoreStub();
    const bytes = enc(`idempotent-test-${Math.random()}`);  // unique per run
    const d1 = await stub.put(bytes);
    const d2 = await stub.put(bytes);
    const d3 = await stub.put(bytes);
    expect(d1).toBe(d2);
    expect(d2).toBe(d3);
  });

  it("idempotent put doesn't corrupt the stored bytes", async () => {
    const stub = blobStoreStub();
    const original = enc(`no-corrupt-${Math.random()}`);
    const d = await stub.put(original);
    // Repeat puts; readback must still match the original.
    await stub.put(original);
    await stub.put(original);
    const round = await stub.get(d);
    expect(round).not.toBeNull();
    expect(dec(round!)).toBe(dec(original));
  });

  it("digest is byte-stable across put/get/put: callers can compute it client-side", async () => {
    const stub = blobStoreStub();
    const bytes = enc(`stable-${Math.random()}`);
    // Compute the digest WITHOUT calling the DO — same SHA-256 contract.
    const hashBuf = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
    const expected = Array.from(new Uint8Array(hashBuf))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
    const dFromDo = await stub.put(bytes);
    expect(dFromDo).toBe(expected);
  });
});

// ── ADR-0012 cross-DO consistency: bead canonical digest ─────────────────

describe("BlobStore DO + bead canonical bytes (ADR-0012 handoff invariant)", () => {
  function fixtureBead(overrides: Partial<Bead> = {}): Bead {
    return {
      id:          "cloister-blob01",
      title:       "blob-store handoff fixture",
      description: "minted for ADR-0012 cross-DO consistency tests",
      state:       "open",
      priority:    2,
      labels:      ["test"],
      created_at:  "2026-05-09T20:00:00Z",
      updated_at:  "2026-05-09T20:00:00Z",
      repo:        "cloister",
      ...overrides,
    };
  }

  it("BlobStore digest of canonical bytes matches beadCanonicalDigestV1 (the cross-DO contract)", async () => {
    // The whole point of ADR-0012's content-addressed handoff: BeadStore
    // (per-repo) and TrustStore (singleton) must be able to compute the
    // SAME digest for the SAME Bead struct. BlobStore is the substrate;
    // bead-canonical.ts is the encoder. They must agree.
    const stub = blobStoreStub();
    const bead = fixtureBead();

    const expectedDigest = await beadCanonicalDigestV1(bead);
    const canonicalBytes = beadCanonicalBytesV1(bead);
    const blobDigest = await stub.put(canonicalBytes);

    expect(blobDigest).toBe(expectedDigest);
  });

  it("the same Bead struct produces a stable digest across runs (no random salts)", async () => {
    const stub = blobStoreStub();
    const bead = fixtureBead({ id: "cloister-blob02" });
    const d1 = await stub.put(beadCanonicalBytesV1(bead));
    const d2 = await stub.put(beadCanonicalBytesV1(bead));
    expect(d1).toBe(d2);
  });

  it("a different Bead struct produces a different digest (no collision)", async () => {
    const stub = blobStoreStub();
    const beadA = fixtureBead({ id: "cloister-blob03a" });
    const beadB = fixtureBead({ id: "cloister-blob03b" });
    const dA = await stub.put(beadCanonicalBytesV1(beadA));
    const dB = await stub.put(beadCanonicalBytesV1(beadB));
    expect(dA).not.toBe(dB);
  });

  it("simulated cross-DO recovery: caller A puts, caller B can recover via has()/get()", async () => {
    // Per ADR-0012's recovery path: if BeadStore writes a row referencing
    // a digest, TrustStore can later verify the blob exists (recovery
    // probe) and read its contents. This test simulates that handoff
    // through two independent stub references — both resolve to the same
    // singleton.
    const writer = blobStoreStub();
    const reader = blobStoreStub();
    const bead = fixtureBead({ id: "cloister-handoff01" });
    const bytes = beadCanonicalBytesV1(bead);

    const digest = await writer.put(bytes);
    expect(await reader.has(digest)).toBe(true);
    const recovered = await reader.get(digest);
    expect(recovered).not.toBeNull();
    expect(dec(recovered!)).toBe(dec(bytes));
  });
});
