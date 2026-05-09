/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  pruneSeenNoncesBefore,
  recordSeenNonce,
} from "../../src/storage/seen-nonces.js";

// We need a workerd SqlStorage to test against. Borrow the TrustStore
// DO's storage handle — it already has the seen_nonces table schema
// applied at construction time, and runInDurableObject gives us direct
// SQL access without going through any RPC method.

let counter = 0;
function freshStub() {
  // Distinct DO name per test → fresh storage per test, no cross-test
  // bleed. seen_nonces ledger semantics depend on prior state, so
  // isolation is essential.
  const id = env.TRUST_STORE.idFromName(`seen-nonces-test-${counter++}-${Math.random()}`);
  return env.TRUST_STORE.get(id);
}

describe("recordSeenNonce", () => {
  it("first observation returns fresh: true", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_, state) => {
      const r = recordSeenNonce(state.storage.sql, "fp1", "n1", 1700000000000);
      expect(r.fresh).toBe(true);
    });
  });

  it("duplicate (cert_fp, nonce) returns fresh: false", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_, state) => {
      const a = recordSeenNonce(state.storage.sql, "fp1", "n1", 1700000000000);
      const b = recordSeenNonce(state.storage.sql, "fp1", "n1", 1700000000999);
      expect(a.fresh).toBe(true);
      expect(b.fresh).toBe(false);
    });
  });

  it("same nonce, different cert_fp -> both fresh (cert_fp is part of the key)", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_, state) => {
      const a = recordSeenNonce(state.storage.sql, "fp1", "shared-nonce", 1);
      const b = recordSeenNonce(state.storage.sql, "fp2", "shared-nonce", 2);
      expect(a.fresh).toBe(true);
      expect(b.fresh).toBe(true);
    });
  });

  it("same cert_fp, different nonce -> both fresh", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_, state) => {
      const a = recordSeenNonce(state.storage.sql, "fp1", "n1", 1);
      const b = recordSeenNonce(state.storage.sql, "fp1", "n2", 2);
      expect(a.fresh).toBe(true);
      expect(b.fresh).toBe(true);
    });
  });

  it("triple-replay: only the first is fresh", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_, state) => {
      const a = recordSeenNonce(state.storage.sql, "fp1", "n1", 1);
      const b = recordSeenNonce(state.storage.sql, "fp1", "n1", 2);
      const c = recordSeenNonce(state.storage.sql, "fp1", "n1", 3);
      expect([a.fresh, b.fresh, c.fresh]).toEqual([true, false, false]);
    });
  });
});

describe("pruneSeenNoncesBefore", () => {
  it("deletes entries with ts_ms < cutoff and leaves newer ones intact", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_, state) => {
      recordSeenNonce(state.storage.sql, "fp1", "old1",  100);
      recordSeenNonce(state.storage.sql, "fp1", "old2",  200);
      recordSeenNonce(state.storage.sql, "fp1", "fresh", 5000);

      const deleted = pruneSeenNoncesBefore(state.storage.sql, 1000);
      expect(deleted).toBe(2);

      // Old entries gone → re-inserting them is fresh again.
      const reInsertOld   = recordSeenNonce(state.storage.sql, "fp1", "old1",  100);
      const replayFresh   = recordSeenNonce(state.storage.sql, "fp1", "fresh", 5000);
      expect(reInsertOld.fresh).toBe(true);
      expect(replayFresh.fresh).toBe(false);  // still in the ledger
    });
  });

  it("returns 0 when no rows match the cutoff", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_, state) => {
      recordSeenNonce(state.storage.sql, "fp1", "n1", 5000);
      const deleted = pruneSeenNoncesBefore(state.storage.sql, 1000);
      expect(deleted).toBe(0);
    });
  });
});
