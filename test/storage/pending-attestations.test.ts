/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  MAX_RETRY_ATTEMPTS,
  RETRY_BACKOFF_MS,
  backoffNextRetry,
  claimRetryBatch,
  commitPending,
  enqueuePending,
  listPendingForPeer,
  recordFailedAttempt,
} from "../../src/storage/pending-attestations.js";

let counter = 0;
function freshStub() {
  // Fresh DO per test → fresh schema → no cross-test bleed.
  return env.TRUST_STORE.get(
    env.TRUST_STORE.idFromName(`pending-attestations-test-${counter++}-${Math.random()}`),
  );
}

const PEER = "sha256:abc123";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const SCOPE = "bead_create:/r/foo";
const CERT = new Uint8Array([0xCA, 0xFE]);
const SIG  = new Uint8Array([0xBA, 0xBE]);

// ── backoffNextRetry ─────────────────────────────────────────────────────

describe("backoffNextRetry", () => {
  it("returns nowMs + RETRY_BACKOFF_MS[attempts] for attempts < MAX", () => {
    expect(backoffNextRetry(0, 1000)).toBe(1000 + RETRY_BACKOFF_MS[0]);
    expect(backoffNextRetry(1, 1000)).toBe(1000 + RETRY_BACKOFF_MS[1]);
    expect(backoffNextRetry(MAX_RETRY_ATTEMPTS - 1, 1000)).toBe(
      1000 + RETRY_BACKOFF_MS[MAX_RETRY_ATTEMPTS - 1],
    );
  });

  it("returns null at MAX_RETRY_ATTEMPTS (no further retries scheduled)", () => {
    expect(backoffNextRetry(MAX_RETRY_ATTEMPTS, 1000)).toBeNull();
    expect(backoffNextRetry(MAX_RETRY_ATTEMPTS + 5, 1000)).toBeNull();
  });

  it("backoff schedule is monotonically non-decreasing", () => {
    for (let i = 1; i < RETRY_BACKOFF_MS.length; i++) {
      expect(RETRY_BACKOFF_MS[i]!).toBeGreaterThanOrEqual(RETRY_BACKOFF_MS[i - 1]!);
    }
  });
});

// ── enqueuePending ───────────────────────────────────────────────────────

describe("enqueuePending", () => {
  it("first enqueue succeeds (returns enqueued: true)", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_, state) => {
      const r = enqueuePending(state.storage.sql, {
        peerFp: PEER, contentHash: HASH_A, scope: SCOPE,
        cert: CERT, sig: SIG, nowMs: 1000,
      });
      expect(r.enqueued).toBe(true);
    });
  });

  it("re-enqueue with same (peer_fp, content_hash) is idempotent (returns enqueued: false)", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_, state) => {
      const a = enqueuePending(state.storage.sql, {
        peerFp: PEER, contentHash: HASH_A, scope: SCOPE,
        cert: CERT, sig: SIG, nowMs: 1000,
      });
      const b = enqueuePending(state.storage.sql, {
        peerFp: PEER, contentHash: HASH_A, scope: "different",
        cert: new Uint8Array([0xFF]), sig: new Uint8Array([0xEE]), nowMs: 9000,
      });
      expect(a.enqueued).toBe(true);
      expect(b.enqueued).toBe(false);

      // The original row's state is preserved (re-enqueue can't overwrite).
      const list = listPendingForPeer(state.storage.sql, PEER);
      expect(list.length).toBe(1);
      expect(list[0]!.scope).toBe(SCOPE);
      expect(list[0]!.attempts).toBe(0);
    });
  });

  it("different content_hash for same peer creates a separate row", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_, state) => {
      enqueuePending(state.storage.sql, {
        peerFp: PEER, contentHash: HASH_A, scope: SCOPE,
        cert: CERT, sig: SIG, nowMs: 1000,
      });
      enqueuePending(state.storage.sql, {
        peerFp: PEER, contentHash: HASH_B, scope: SCOPE,
        cert: CERT, sig: SIG, nowMs: 1000,
      });
      const list = listPendingForPeer(state.storage.sql, PEER);
      expect(list.length).toBe(2);
    });
  });
});

// ── claimRetryBatch ──────────────────────────────────────────────────────

describe("claimRetryBatch", () => {
  it("returns rows whose next_retry_at <= nowMs", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_, state) => {
      enqueuePending(state.storage.sql, {
        peerFp: PEER, contentHash: HASH_A, scope: SCOPE,
        cert: CERT, sig: SIG, nowMs: 1000,
      });
      // First retry is scheduled at 1000 + RETRY_BACKOFF_MS[0] = 1000 + 30000.
      const tooEarly = claimRetryBatch(state.storage.sql, 5_000);
      expect(tooEarly).toEqual([]);

      const eligible = claimRetryBatch(state.storage.sql, 1000 + RETRY_BACKOFF_MS[0]!);
      expect(eligible.length).toBe(1);
      expect(eligible[0]!.peer_fp).toBe(PEER);
      expect(eligible[0]!.content_hash).toBe(HASH_A);
      expect(eligible[0]!.attempts).toBe(0);
    });
  });

  it("excludes rows that hit MAX_RETRY_ATTEMPTS", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_, state) => {
      enqueuePending(state.storage.sql, {
        peerFp: PEER, contentHash: HASH_A, scope: SCOPE,
        cert: CERT, sig: SIG, nowMs: 1000,
      });
      // Hammer the retry until exhausted.
      for (let i = 0; i < MAX_RETRY_ATTEMPTS; i++) {
        recordFailedAttempt(state.storage.sql, PEER, HASH_A, 1000 + (i + 1) * 1_000_000);
      }
      // Even at far-future nowMs, the exhausted row doesn't surface for retry.
      const eligible = claimRetryBatch(state.storage.sql, Number.MAX_SAFE_INTEGER - 1);
      expect(eligible).toEqual([]);
      // But it stays visible to the disclosure endpoint (PENDING-failed).
      const visible = listPendingForPeer(state.storage.sql, PEER);
      expect(visible.length).toBe(1);
      expect(visible[0]!.attempts).toBe(MAX_RETRY_ATTEMPTS);
    });
  });

  it("respects the limit argument", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_, state) => {
      for (let i = 0; i < 10; i++) {
        const hash = i.toString(16).padStart(64, "0");
        enqueuePending(state.storage.sql, {
          peerFp: PEER, contentHash: hash, scope: SCOPE,
          cert: CERT, sig: SIG, nowMs: 1000,
        });
      }
      const batch = claimRetryBatch(state.storage.sql, Number.MAX_SAFE_INTEGER - 1, 3);
      expect(batch.length).toBe(3);
    });
  });

  it("orders by next_retry_at ASC (oldest-due first)", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_, state) => {
      enqueuePending(state.storage.sql, {
        peerFp: PEER, contentHash: HASH_A, scope: SCOPE,
        cert: CERT, sig: SIG, nowMs: 5000,
      });
      enqueuePending(state.storage.sql, {
        peerFp: PEER, contentHash: HASH_B, scope: SCOPE,
        cert: CERT, sig: SIG, nowMs: 1000,  // earlier → due first
      });
      const batch = claimRetryBatch(state.storage.sql, Number.MAX_SAFE_INTEGER - 1);
      expect(batch[0]!.content_hash).toBe(HASH_B);
      expect(batch[1]!.content_hash).toBe(HASH_A);
    });
  });
});

// ── commitPending ────────────────────────────────────────────────────────

describe("commitPending", () => {
  it("deletes the row on successful retry (returns deleted: true)", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_, state) => {
      enqueuePending(state.storage.sql, {
        peerFp: PEER, contentHash: HASH_A, scope: SCOPE,
        cert: CERT, sig: SIG, nowMs: 1000,
      });
      const r = commitPending(state.storage.sql, PEER, HASH_A);
      expect(r.deleted).toBe(true);
      expect(listPendingForPeer(state.storage.sql, PEER)).toEqual([]);
    });
  });

  it("returns deleted: false when no row matches (idempotent)", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_, state) => {
      const r = commitPending(state.storage.sql, PEER, HASH_A);
      expect(r.deleted).toBe(false);
    });
  });
});

// ── recordFailedAttempt ──────────────────────────────────────────────────

describe("recordFailedAttempt", () => {
  it("increments attempts and pushes next_retry_at forward", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_, state) => {
      enqueuePending(state.storage.sql, {
        peerFp: PEER, contentHash: HASH_A, scope: SCOPE,
        cert: CERT, sig: SIG, nowMs: 1000,
      });
      const r = recordFailedAttempt(state.storage.sql, PEER, HASH_A, 60_000);
      expect(r.newAttempts).toBe(1);
      expect(r.nextRetryAt).toBe(60_000 + RETRY_BACKOFF_MS[1]!);

      const list = listPendingForPeer(state.storage.sql, PEER);
      expect(list[0]!.attempts).toBe(1);
      expect(list[0]!.next_retry_at).toBe(60_000 + RETRY_BACKOFF_MS[1]!);
      expect(list[0]!.last_attempt_at).toBe(60_000);
    });
  });

  it("at MAX_RETRY_ATTEMPTS, sets next_retry_at to MAX_SAFE_INTEGER (effectively never)", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_, state) => {
      enqueuePending(state.storage.sql, {
        peerFp: PEER, contentHash: HASH_A, scope: SCOPE,
        cert: CERT, sig: SIG, nowMs: 1000,
      });
      let r;
      for (let i = 0; i < MAX_RETRY_ATTEMPTS; i++) {
        r = recordFailedAttempt(state.storage.sql, PEER, HASH_A, 60_000 + i * 1000);
      }
      expect(r!.nextRetryAt).toBeNull();

      const list = listPendingForPeer(state.storage.sql, PEER);
      expect(list[0]!.attempts).toBe(MAX_RETRY_ATTEMPTS);
      expect(list[0]!.next_retry_at).toBe(Number.MAX_SAFE_INTEGER);
    });
  });

  it("returns newAttempts: 0 when no row matches (silent no-op)", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_, state) => {
      const r = recordFailedAttempt(state.storage.sql, PEER, HASH_A, 1000);
      expect(r.newAttempts).toBe(0);
      expect(r.nextRetryAt).toBeNull();
    });
  });
});

// ── listPendingForPeer ───────────────────────────────────────────────────

describe("listPendingForPeer", () => {
  it("returns rows ordered by created_at ASC", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_, state) => {
      enqueuePending(state.storage.sql, {
        peerFp: PEER, contentHash: HASH_A, scope: SCOPE,
        cert: CERT, sig: SIG, nowMs: 5000,
      });
      enqueuePending(state.storage.sql, {
        peerFp: PEER, contentHash: HASH_B, scope: SCOPE,
        cert: CERT, sig: SIG, nowMs: 1000,
      });
      const list = listPendingForPeer(state.storage.sql, PEER);
      expect(list.map(r => r.content_hash)).toEqual([HASH_B, HASH_A]);
    });
  });

  it("returns empty list for unknown peer", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_, state) => {
      expect(listPendingForPeer(state.storage.sql, "unknown")).toEqual([]);
    });
  });

  it("scopes strictly to the requested peer (no cross-peer leak)", async () => {
    const stub = freshStub();
    const PEER_OTHER = "sha256:other";
    await runInDurableObject(stub, async (_, state) => {
      enqueuePending(state.storage.sql, {
        peerFp: PEER, contentHash: HASH_A, scope: SCOPE,
        cert: CERT, sig: SIG, nowMs: 1000,
      });
      enqueuePending(state.storage.sql, {
        peerFp: PEER_OTHER, contentHash: HASH_A, scope: SCOPE,
        cert: CERT, sig: SIG, nowMs: 1000,
      });
      const a = listPendingForPeer(state.storage.sql, PEER);
      const b = listPendingForPeer(state.storage.sql, PEER_OTHER);
      expect(a.length).toBe(1);
      expect(b.length).toBe(1);
      expect(a[0]!.peer_fp).toBe(PEER);
      expect(b[0]!.peer_fp).toBe(PEER_OTHER);
    });
  });
});
