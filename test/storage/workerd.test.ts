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

