/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, it, expect } from "vitest";
import { WorkerdBlobStore, WorkerdRefStore } from "../../src/storage/workerd.js";
import { asDigest, isDigest, type Digest } from "../../src/storage/types.js";
import { digestBytes } from "../../src/storage/canonical.js";

// ── Helpers ────────────────────────────────────────────────────────────────
//
// Each test grabs a fresh BEAD_STORE DO instance and runs storage operations
// inside it via `runInDurableObject`, which gives us access to the DO's
// real `state.storage.sql` handle. The BeadStore class itself isn't being
// exercised — we're borrowing its SqlStorage as the substrate. Different DO
// names give per-test isolation.

let counter = 0;
function freshStub() {
  const id = env.BEAD_STORE.idFromName(`storage-test-${counter++}-${Math.random()}`);
  return env.BEAD_STORE.get(id);
}

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

// ── WorkerdBlobStore ───────────────────────────────────────────────────────

// Deterministic byte pattern so round-trips are verifiable (cloister-f193d3).
function bigBlob(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = i & 0xff;
  return b;
}
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function countRowsIn(sql: SqlStorage, table: string): number {
  let n = 0;
  for (const r of sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)) n = r.n;
  return n;
}

describe("WorkerdBlobStore", () => {
  it("put returns a 64-char lowercase hex Digest", async () => {
    const stub = freshStub();
    const d = await runInDurableObject(stub, async (_inst, state) => {
      const blobs = new WorkerdBlobStore(state.storage.sql, "t1");
      return await blobs.put(enc("hello"));
    });
    expect(isDigest(d)).toBe(true);
  });

  it("put is idempotent — same bytes → same digest, no duplicate rows", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_inst, state) => {
      const blobs = new WorkerdBlobStore(state.storage.sql, "t2");
      const d1 = await blobs.put(enc("hello"));
      const d2 = await blobs.put(enc("hello"));
      expect(d1).toBe(d2);
      // Verify only one row exists.
      const rows = state.storage.sql.exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM t2_blobs`,
      );
      let count = 0;
      for (const row of rows) count = row.n;
      expect(count).toBe(1);
    });
  });

  it("get returns the original bytes round-trip", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_inst, state) => {
      const blobs = new WorkerdBlobStore(state.storage.sql, "t3");
      const d = await blobs.put(enc("round trip me"));
      const got = await blobs.get(d);
      expect(got).not.toBeNull();
      expect(dec(got!)).toBe("round trip me");
    });
  });

  it("large blob (> 2 MB) round-trips byte-for-byte via the chunks table (cloister-f193d3)", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_inst, state) => {
      const blobs = new WorkerdBlobStore(state.storage.sql, "big");
      const bytes = bigBlob(3 * 1024 * 1024); // 3 MiB — over the ~2 MB single-value ceiling
      const d = await blobs.put(bytes);
      const got = await blobs.get(d);
      expect(got).not.toBeNull();
      expect(bytesEqual(got!, bytes)).toBe(true);
      // Landed in the chunks table (3 × 1 MiB), NOT the single-row table.
      expect(countRowsIn(state.storage.sql, "big_blobs")).toBe(0);
      expect(countRowsIn(state.storage.sql, "big_blob_chunks")).toBe(3);
    });
  });

  it("blob at the chunk-size boundary (1 MiB) stays single-row (back-compat)", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_inst, state) => {
      const blobs = new WorkerdBlobStore(state.storage.sql, "bound");
      const bytes = bigBlob(1 << 20); // exactly the chunk size → single row
      const d = await blobs.put(bytes);
      expect(bytesEqual((await blobs.get(d))!, bytes)).toBe(true);
      expect(countRowsIn(state.storage.sql, "bound_blobs")).toBe(1);
      expect(countRowsIn(state.storage.sql, "bound_blob_chunks")).toBe(0);
    });
  });

  it("large-blob put is idempotent — no duplicate chunk rows", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_inst, state) => {
      const blobs = new WorkerdBlobStore(state.storage.sql, "idem");
      const bytes = bigBlob(3 * 1024 * 1024);
      const d1 = await blobs.put(bytes);
      const d2 = await blobs.put(bytes);
      expect(d1).toBe(d2);
      expect(countRowsIn(state.storage.sql, "idem_blob_chunks")).toBe(3);
    });
  });

  it("has() finds a chunked blob", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_inst, state) => {
      const blobs = new WorkerdBlobStore(state.storage.sql, "hasc");
      const d = await blobs.put(bigBlob(3 * 1024 * 1024));
      expect(await blobs.has(d)).toBe(true);
      expect(await blobs.has(asDigest("a".repeat(64)))).toBe(false);
    });
  });

  it("get returns null for unknown digest", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_inst, state) => {
      const blobs = new WorkerdBlobStore(state.storage.sql, "t4");
      const ghost = await digestBytes(enc("never stored"));
      const got = await blobs.get(ghost);
      expect(got).toBeNull();
    });
  });

  it("has reflects presence", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_inst, state) => {
      const blobs = new WorkerdBlobStore(state.storage.sql, "t5");
      const d = await blobs.put(enc("x"));
      const ghost = await digestBytes(enc("y"));
      expect(await blobs.has(d)).toBe(true);
      expect(await blobs.has(ghost)).toBe(false);
    });
  });

  it("Digest from WorkerdBlobStore.put matches digestBytes computed outside the DO", async () => {
    // Substrate-equivalence: the DO must not mutate bytes (e.g. via the
    // ArrayBuffer copy in asBlob). Digest is a content-addressed contract;
    // if these diverge, sync between substrates would break.
    const stub = freshStub();
    await runInDurableObject(stub, async (_inst, state) => {
      const blobs = new WorkerdBlobStore(state.storage.sql, "se");
      const bytes = enc("substrate-equivalence");
      const inside  = await blobs.put(bytes);
      const outside = await digestBytes(bytes);
      expect(inside).toBe(outside);
    });
  });

  it("rejects unsafe prefixes at construction", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_inst, state) => {
      expect(() => new WorkerdBlobStore(state.storage.sql, "Bad-Name")).toThrow();
      expect(() => new WorkerdBlobStore(state.storage.sql, "1leading")).toThrow();
      expect(() => new WorkerdBlobStore(state.storage.sql, "ok; DROP TABLE x;--")).toThrow();
    });
  });
});

// ── WorkerdRefStore ────────────────────────────────────────────────────────

describe("WorkerdRefStore", () => {
  let DIG_A: Digest;
  let DIG_B: Digest;
  // Pre-compute two valid digests for use as ref values.
  beforeAll(async () => {
    DIG_A = await digestBytes(enc("a"));
    DIG_B = await digestBytes(enc("b"));
  });

  it("cas with expected=null creates a new ref", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_inst, state) => {
      const refs = new WorkerdRefStore(state.storage.sql, "r1");
      expect(await refs.cas("refs/main", null, DIG_A)).toBe(true);
      const list = await refs.list("refs/");
      expect(list).toEqual([["refs/main", DIG_A]]);
    });
  });

  it("cas with expected=null fails if ref already exists", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_inst, state) => {
      const refs = new WorkerdRefStore(state.storage.sql, "r2");
      expect(await refs.cas("refs/main", null, DIG_A)).toBe(true);
      expect(await refs.cas("refs/main", null, DIG_B)).toBe(false);
      const list = await refs.list("refs/");
      expect(list).toEqual([["refs/main", DIG_A]]); // unchanged
    });
  });

  it("cas with matching expected updates the ref", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_inst, state) => {
      const refs = new WorkerdRefStore(state.storage.sql, "r3");
      await refs.cas("refs/main", null, DIG_A);
      expect(await refs.cas("refs/main", DIG_A, DIG_B)).toBe(true);
      const list = await refs.list("refs/");
      expect(list).toEqual([["refs/main", DIG_B]]);
    });
  });

  it("cas with non-matching expected returns false and leaves ref unchanged", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_inst, state) => {
      const refs = new WorkerdRefStore(state.storage.sql, "r4");
      await refs.cas("refs/main", null, DIG_A);
      const wrong = asDigest("0".repeat(64));
      expect(await refs.cas("refs/main", wrong, DIG_B)).toBe(false);
      const list = await refs.list("refs/");
      expect(list).toEqual([["refs/main", DIG_A]]);
    });
  });

  it("list returns refs ordered by name and matching prefix", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_inst, state) => {
      const refs = new WorkerdRefStore(state.storage.sql, "r5");
      await refs.cas("refs/agents/alice", null, DIG_A);
      await refs.cas("refs/agents/bob", null, DIG_B);
      await refs.cas("refs/main", null, DIG_A);
      const agents = await refs.list("refs/agents/");
      expect(agents.map(([n]) => n)).toEqual(["refs/agents/alice", "refs/agents/bob"]);
      const all = await refs.list("refs/");
      expect(all).toHaveLength(3);
    });
  });

  it("list treats SQL wildcards in the prefix literally", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_inst, state) => {
      const refs = new WorkerdRefStore(state.storage.sql, "r6");
      await refs.cas("refs/main", null, DIG_A);
      // A naive impl would treat % and _ as wildcards and match everything.
      // We escape, so a prefix containing them should match nothing here.
      expect(await refs.list("refs/%")).toEqual([]);
      expect(await refs.list("refs/_ain")).toEqual([]);
    });
  });

  it("cas rejects non-Digest 'next'", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_inst, state) => {
      const refs = new WorkerdRefStore(state.storage.sql, "r7");
      const bogus = "not-a-digest" as unknown as Digest;
      await expect(refs.cas("refs/main", null, bogus)).rejects.toThrow(/digest/i);
    });
  });
});


// ── WorkerdBlobStore — caller-provided key verification (cloister-7e631b) ──
//
// PR #84 added `put(bytes, key?)` so the OCI route could honor the
// build-cache/v1 BLAKE3-in-`sha256:` wire (key is BLAKE3 of body, not
// SHA-256). All current callers verify body-against-key BEFORE calling put,
// but that moves the content-addressed invariant from substrate-enforced to
// caller-discipline — a future contributor could add a put-with-key site
// without verification. cloister-7e631b restores the substrate-side
// guarantee: put now re-verifies the body matches the key under SHA-256 OR
// BLAKE3 when a key is provided. Adversarial review (bundle-isolation +
// trust-root) flagged this as the right defense-in-depth seam.

describe("WorkerdBlobStore — caller-provided key verification (cloister-7e631b)", () => {
  it("put(bytes, sha256-of-bytes) accepts (default content-addressed path)", async () => {
    const stub = freshStub();
    const d = await runInDurableObject(stub, async (_inst, state) => {
      const blobs = new WorkerdBlobStore(state.storage.sql, "v1");
      const bytes = enc("substrate-verified-sha256");
      const sha = await digestBytes(bytes);
      return await blobs.put(bytes, sha);
    });
    expect(isDigest(d)).toBe(true);
  });

  it("put(bytes, blake3-of-bytes) accepts (build-cache/v1 path)", async () => {
    // Use a known fixture: chunk-001.bin's BLAKE3 from leyline-schema-spec (LLO).
    const stub = freshStub();
    await runInDurableObject(stub, async (_inst, state) => {
      const blobs = new WorkerdBlobStore(state.storage.sql, "v2");
      const { blake3Hex: blake3HexCas } = await import("../../src/wire/cas-hash.js");
      const bytes = enc("substrate-verified-blake3");
      const blake3Hex = blake3HexCas(bytes);
      // Body's SHA-256 will NOT match this key — substrate must fall back
      // to BLAKE3, find a match, and accept.
      const d = await blobs.put(bytes, asDigest(blake3Hex));
      expect(d).toBe(blake3Hex);
    });
  });

  it("put(bytes, wrong-key) throws — substrate refuses to store under unverified key", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_inst, state) => {
      const blobs = new WorkerdBlobStore(state.storage.sql, "v3");
      const bytes = enc("real-bytes");
      const wrongKey = asDigest("0".repeat(64)); // matches neither SHA-256 nor BLAKE3
      await expect(blobs.put(bytes, wrongKey)).rejects.toThrow(/digest.*mismatch|verification/i);
    });
  });

  it("put(bytes) with no key still works — default SHA-256 path unchanged", async () => {
    const stub = freshStub();
    const d = await runInDurableObject(stub, async (_inst, state) => {
      const blobs = new WorkerdBlobStore(state.storage.sql, "v4");
      return await blobs.put(enc("default-path"));
    });
    expect(isDigest(d)).toBe(true);
  });
});
