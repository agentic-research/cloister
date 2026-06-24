/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  AttestationIntegrityError,
  applyAttestation,
  attestationsForBead,
  findAttestationByContent,
  lastAttestationForPeer,
  listAttestationsForPeer,
} from "../../src/storage/peer-attestations.js";

let counter = 0;
function freshStub() {
  return env.TRUST_STORE.get(
    env.TRUST_STORE.idFromName(`peer-attestations-test-${counter++}-${Math.random()}`),
  );
}

const PEER  = "sha256:abc123";
const PEER2 = "sha256:def456";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const SCOPE  = "bead_create:/r/foo";
const CERT   = new Uint8Array([0xCA, 0xFE]);
const SIG    = new Uint8Array([0xBA, 0xBE]);

function applyArgs(over: Record<string, unknown> = {}) {
  return {
    peerFingerprint: PEER,
    contentHash:     HASH_A,
    contentType:     "bead/v1",
    scope:           SCOPE,
    cert:            CERT,
    sig:             SIG,
    prevSelfRef:     null,
    prevPeerRef:     null,
    nowMs:           1_000,
    ...over,
  } as Parameters<typeof applyAttestation>[1];
}

// ── lastAttestationForPeer ───────────────────────────────────────────────

describe("lastAttestationForPeer", () => {
  it("returns null when no rows exist for the peer", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_, state) => {
      expect(lastAttestationForPeer(state.storage.sql, PEER)).toBeNull();
    });
  });

  it("returns the highest-seq row for the peer", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_, state) => {
      applyAttestation(state.storage.sql, applyArgs({ contentHash: HASH_A, prevSelfRef: null }));
      applyAttestation(state.storage.sql, applyArgs({ contentHash: HASH_B, prevSelfRef: HASH_A }));
      applyAttestation(state.storage.sql, applyArgs({ contentHash: HASH_C, prevSelfRef: HASH_B }));
      const last = lastAttestationForPeer(state.storage.sql, PEER);
      expect(last).not.toBeNull();
      expect(last!.seq).toBe(3);
      expect(last!.content_hash).toBe(HASH_C);
    });
  });
});

// ── applyAttestation: chain progression ──────────────────────────────────

describe("applyAttestation", () => {
  it("genesis row: seq=1 with prev_self_ref=null", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_, state) => {
      const r = applyAttestation(state.storage.sql, applyArgs({
        contentHash: HASH_A,
        prevSelfRef: null,
      }));
      expect(r.seq).toBe(1);
      expect(r.row.prev_self_ref).toBeNull();
      expect(r.row.content_hash).toBe(HASH_A);
    });
  });

  it("subsequent row: seq increments + prev_self_ref points at previous content_hash", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_, state) => {
      const r1 = applyAttestation(state.storage.sql, applyArgs({
        contentHash: HASH_A, prevSelfRef: null,
      }));
      const r2 = applyAttestation(state.storage.sql, applyArgs({
        contentHash: HASH_B, prevSelfRef: HASH_A,
      }));
      expect(r1.seq).toBe(1);
      expect(r2.seq).toBe(2);
      expect(r2.row.prev_self_ref).toBe(HASH_A);
    });
  });

  it("rejects mismatched prev_self_ref (chain integrity defense)", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_, state) => {
      applyAttestation(state.storage.sql, applyArgs({
        contentHash: HASH_A, prevSelfRef: null,
      }));
      // Caller LIES about the prev — should return ok:false, not throw.
      const r = applyAttestation(state.storage.sql, applyArgs({
        contentHash: HASH_B, prevSelfRef: "f".repeat(64),
      }));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBe("prev_self_ref_mismatch");
        expect(r.expected).toBe(HASH_A);
        expect(r.got).toBe("f".repeat(64));
      }
    });
  });

  it("rejects non-null prev_self_ref on genesis (must be null when no prior row)", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_, state) => {
      const r = applyAttestation(state.storage.sql, applyArgs({
        contentHash: HASH_A, prevSelfRef: HASH_B,
      }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe("prev_self_ref_mismatch");
    });
  });

  it("rejects null prev_self_ref when a prior row exists (chain skip)", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_, state) => {
      applyAttestation(state.storage.sql, applyArgs({
        contentHash: HASH_A, prevSelfRef: null,
      }));
      const r = applyAttestation(state.storage.sql, applyArgs({
        contentHash: HASH_B, prevSelfRef: null,
      }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe("prev_self_ref_mismatch");
    });
  });

  it("integrity-failure leaves NO row written (only one valid INSERT)", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_, state) => {
      applyAttestation(state.storage.sql, applyArgs({
        contentHash: HASH_A, prevSelfRef: null,
      }));
      const bad = applyAttestation(state.storage.sql, applyArgs({
        contentHash: HASH_B, prevSelfRef: "wrong",
      }));
      expect(bad.ok).toBe(false);

      // Chain still exactly 1 row — no fork landed.
      const list = listAttestationsForPeer(state.storage.sql, PEER);
      expect(list.length).toBe(1);
      expect(list[0]!.content_hash).toBe(HASH_A);
    });
  });

  it("scopes per-peer: PEER and PEER2 chains advance independently", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_, state) => {
      applyAttestation(state.storage.sql, applyArgs({
        peerFingerprint: PEER, contentHash: HASH_A, prevSelfRef: null,
      }));
      applyAttestation(state.storage.sql, applyArgs({
        peerFingerprint: PEER2, contentHash: HASH_A, prevSelfRef: null,
      }));
      applyAttestation(state.storage.sql, applyArgs({
        peerFingerprint: PEER, contentHash: HASH_B, prevSelfRef: HASH_A,
      }));

      expect(lastAttestationForPeer(state.storage.sql, PEER)!.seq).toBe(2);
      expect(lastAttestationForPeer(state.storage.sql, PEER2)!.seq).toBe(1);
    });
  });

  it("preserves prev_peer_ref through the round-trip", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_, state) => {
      const r = applyAttestation(state.storage.sql, applyArgs({
        contentHash: HASH_A, prevSelfRef: null,
        prevPeerRef: "sha256:peer_chain_head",
      }));
      expect(r.row.prev_peer_ref).toBe("sha256:peer_chain_head");
    });
  });
});

// ── listAttestationsForPeer ──────────────────────────────────────────────

describe("listAttestationsForPeer", () => {
  it("returns rows ordered by seq ASC", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_, state) => {
      applyAttestation(state.storage.sql, applyArgs({ contentHash: HASH_A, prevSelfRef: null }));
      applyAttestation(state.storage.sql, applyArgs({ contentHash: HASH_B, prevSelfRef: HASH_A }));
      applyAttestation(state.storage.sql, applyArgs({ contentHash: HASH_C, prevSelfRef: HASH_B }));
      const list = listAttestationsForPeer(state.storage.sql, PEER);
      expect(list.map(r => r.seq)).toEqual([1, 2, 3]);
      expect(list.map(r => r.content_hash)).toEqual([HASH_A, HASH_B, HASH_C]);
    });
  });

  it("respects fromSeq for incremental tail reads", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_, state) => {
      applyAttestation(state.storage.sql, applyArgs({ contentHash: HASH_A, prevSelfRef: null }));
      applyAttestation(state.storage.sql, applyArgs({ contentHash: HASH_B, prevSelfRef: HASH_A }));
      applyAttestation(state.storage.sql, applyArgs({ contentHash: HASH_C, prevSelfRef: HASH_B }));
      const tail = listAttestationsForPeer(state.storage.sql, PEER, { fromSeq: 2 });
      expect(tail.map(r => r.seq)).toEqual([2, 3]);
    });
  });

  it("respects the limit argument", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_, state) => {
      applyAttestation(state.storage.sql, applyArgs({ contentHash: HASH_A, prevSelfRef: null }));
      applyAttestation(state.storage.sql, applyArgs({ contentHash: HASH_B, prevSelfRef: HASH_A }));
      applyAttestation(state.storage.sql, applyArgs({ contentHash: HASH_C, prevSelfRef: HASH_B }));
      const limited = listAttestationsForPeer(state.storage.sql, PEER, { limit: 2 });
      expect(limited.length).toBe(2);
    });
  });

  it("scopes strictly to the requested peer (no cross-peer leak)", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_, state) => {
      applyAttestation(state.storage.sql, applyArgs({
        peerFingerprint: PEER, contentHash: HASH_A, prevSelfRef: null,
      }));
      applyAttestation(state.storage.sql, applyArgs({
        peerFingerprint: PEER2, contentHash: HASH_A, prevSelfRef: null,
      }));
      const list = listAttestationsForPeer(state.storage.sql, PEER2);
      expect(list.length).toBe(1);
      expect(list[0]!.peer_fingerprint).toBe(PEER2);
    });
  });
});

// ── findAttestationByContent ─────────────────────────────────────────────

describe("findAttestationByContent", () => {
  it("returns the row matching (peer, content_hash)", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_, state) => {
      applyAttestation(state.storage.sql, applyArgs({ contentHash: HASH_A, prevSelfRef: null }));
      applyAttestation(state.storage.sql, applyArgs({ contentHash: HASH_B, prevSelfRef: HASH_A }));
      const found = findAttestationByContent(state.storage.sql, PEER, HASH_B);
      expect(found?.seq).toBe(2);
      expect(found?.content_hash).toBe(HASH_B);
    });
  });

  it("returns null when no match exists", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_, state) => {
      applyAttestation(state.storage.sql, applyArgs({ contentHash: HASH_A, prevSelfRef: null }));
      expect(findAttestationByContent(state.storage.sql, PEER, HASH_C)).toBeNull();
    });
  });

  it("supports retry-idempotency probe (caller checks before re-attempting)", async () => {
    // This is the ADR-0012 recovery story: pending-attestations retry pump
    // uses findAttestationByContent before re-attempting a write to avoid
    // double-applying. If the row already exists, the retry already
    // succeeded earlier and the pending row should be cleaned up.
    const stub = freshStub();
    await runInDurableObject(stub, async (_, state) => {
      applyAttestation(state.storage.sql, applyArgs({ contentHash: HASH_A, prevSelfRef: null }));
      const probe = findAttestationByContent(state.storage.sql, PEER, HASH_A);
      expect(probe).not.toBeNull();
      // Caller would now call commitPending and skip the re-attempt.
    });
  });
});

// ── End-to-end: chain re-derivation from disclosed rows ──────────────────

describe("disclosure-endpoint round-trip", () => {
  it("a third-party verifier can reconstruct the chain from the disclosed rows", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_, state) => {
      applyAttestation(state.storage.sql, applyArgs({ contentHash: HASH_A, prevSelfRef: null }));
      applyAttestation(state.storage.sql, applyArgs({ contentHash: HASH_B, prevSelfRef: HASH_A }));
      applyAttestation(state.storage.sql, applyArgs({ contentHash: HASH_C, prevSelfRef: HASH_B }));

      // Simulate a third-party disclosure consumer: they get the rows
      // via the (future) /interlace/peers/{fp} endpoint and verify the
      // chain is internally consistent.
      const chain = listAttestationsForPeer(state.storage.sql, PEER);
      expect(chain.length).toBe(3);

      // seq starts at 1 and increments by 1
      expect(chain[0]!.seq).toBe(1);
      expect(chain[1]!.seq).toBe(2);
      expect(chain[2]!.seq).toBe(3);

      // genesis prev_self_ref is null
      expect(chain[0]!.prev_self_ref).toBeNull();

      // each subsequent prev_self_ref points at previous content_hash
      expect(chain[1]!.prev_self_ref).toBe(chain[0]!.content_hash);
      expect(chain[2]!.prev_self_ref).toBe(chain[1]!.content_hash);
    });
  });
});

// ── cloister-c8b907 sub-bead 1: bead_id column + attestationsForBead ─────

describe("bead_id column (cloister-c8b907)", () => {
  it("applyAttestation persists beadId on the row and returns it in the result", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_, state) => {
      const result = applyAttestation(
        state.storage.sql,
        applyArgs({ contentHash: HASH_A, beadId: "cloister-1abcde" }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.row.bead_id).toBe("cloister-1abcde");
      }
    });
  });

  it("applyAttestation without beadId defaults to null bead_id (back-compat for non-bead-create attestations)", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_, state) => {
      const result = applyAttestation(
        state.storage.sql,
        applyArgs({ contentHash: HASH_A }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.row.bead_id).toBeNull();
      }
    });
  });

  it("attestationsForBead returns rows matching the bead_id, ordered by created_at", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_, state) => {
      // Two attestations for bead "cloister-aaa" (one per peer), one for bead "cloister-bbb".
      applyAttestation(state.storage.sql, applyArgs({
        peerFingerprint: PEER, contentHash: HASH_A, prevSelfRef: null,
        beadId: "cloister-aaa", nowMs: 1_000,
      }));
      applyAttestation(state.storage.sql, applyArgs({
        peerFingerprint: PEER2, contentHash: HASH_B, prevSelfRef: null,
        beadId: "cloister-aaa", nowMs: 2_000,
      }));
      applyAttestation(state.storage.sql, applyArgs({
        peerFingerprint: PEER, contentHash: HASH_C, prevSelfRef: HASH_A,
        beadId: "cloister-bbb", nowMs: 3_000,
      }));

      const aaa = attestationsForBead(state.storage.sql, "cloister-aaa");
      expect(aaa.length).toBe(2);
      expect(aaa[0]!.created_at).toBe(1_000);
      expect(aaa[1]!.created_at).toBe(2_000);
      expect(aaa.map((r) => r.peer_fingerprint).sort()).toEqual([PEER, PEER2].sort());

      const bbb = attestationsForBead(state.storage.sql, "cloister-bbb");
      expect(bbb.length).toBe(1);
      expect(bbb[0]!.content_hash).toBe(HASH_C);

      const missing = attestationsForBead(state.storage.sql, "cloister-doesnotexist");
      expect(missing).toEqual([]);
    });
  });

  it("§13.4 audit-chain reconstitution: bead_id lets the audit query recover (bead, content_hash) pairs after BeadStore-DO deprecation", async () => {
    // This is the LOAD-BEARING property for cloister-c8b907's migration:
    // after the BeadStore DO retires, the bead row in rsry/bd has no
    // content_hash column. The orchestrator's TrustStore attestation
    // row carries both bead_id AND content_hash; this test pins the
    // recovery query.
    const stub = freshStub();
    await runInDurableObject(stub, async (_, state) => {
      // Simulate the orchestrator's bead_create call: BlobStore.put →
      // bead_id from rsry → applyAttestation(content_hash, bead_id).
      applyAttestation(state.storage.sql, applyArgs({
        contentHash: HASH_A,
        beadId:      "cloister-deadbeef",
        prevSelfRef: null,
        nowMs:       42_000,
      }));

      // Audit query: "what's the content_hash for cloister-deadbeef?"
      const found = attestationsForBead(state.storage.sql, "cloister-deadbeef");
      expect(found.length).toBe(1);
      expect(found[0]!.content_hash).toBe(HASH_A);
      // The §13.4 invariant: bead → attestation → content_hash. Recovered.
    });
  });
});
