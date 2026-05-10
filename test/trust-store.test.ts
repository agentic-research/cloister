/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { PeerAttestation } from "../src/storage/peer-attestations.js";
import type { PendingAttestation } from "../src/storage/pending-attestations.js";

// TrustStore RPC integration — exercises the methods exposed on the DO
// (vs. the pure helpers tested per-module). Uses unique idFromName per
// test for isolation since these tests mutate state.

interface TrustStoreRpc {
  applyAttestation(args: {
    peerFingerprint: string;
    contentHash:     string;
    contentType:     string;
    scope:           string;
    cert:            Uint8Array;
    sig:             Uint8Array;
    prevSelfRef:     string | null;
    prevPeerRef:     string | null;
    nowMs:           number;
  }): Promise<import("../src/storage/peer-attestations.js").ApplyAttestationResult>;
  lastAttestationForPeer(peerFp: string): Promise<PeerAttestation | null>;
  listAttestationsForPeer(
    peerFp: string,
    options?: { fromSeq?: number; limit?: number },
  ): Promise<PeerAttestation[]>;
  findAttestationByContent(peerFp: string, contentHash: string): Promise<PeerAttestation | null>;
  enqueuePendingAttestation(args: {
    peerFp: string;
    contentHash: string;
    scope: string;
    cert: Uint8Array;
    sig: Uint8Array;
    nowMs: number;
  }): Promise<{ enqueued: boolean }>;
  commitPendingAttestation(peerFp: string, contentHash: string): Promise<{ deleted: boolean }>;
  recordPendingFailedAttempt(
    peerFp: string,
    contentHash: string,
    nowMs: number,
  ): Promise<{ newAttempts: number; nextRetryAt: number | null }>;
  listPendingForPeer(peerFp: string): Promise<PendingAttestation[]>;
  // cloister-ee51b8 — atomic replay-check + chain advance, replaces the
  // recordSeenNonce + upsertLeaseCounter pair on the lease-middleware
  // hot path.
  verifyLeaseAndAdvanceChain(args: {
    peerFp: string;
    certFp: string;
    nonce:  string;
    ts:     number;
  }): Promise<
    | { replayed: true }
    | { replayed: false; seq: number; last_chain_hash: string }
  >;
  // Legacy methods kept for benches + non-batched callers.
  recordSeenNonce(certFp: string, nonce: string, tsMs: number): Promise<{ fresh: boolean }>;
  upsertLeaseCounter(
    peerFp:  string,
    certFp:  string,
    nonce:   string,
    ts:      number,
  ): Promise<{ seq: number; last_chain_hash: string }>;
  getLeaseCounter(peerFp: string): Promise<{
    peer_fingerprint: string;
    seq:              number;
    last_chain_hash:  string;
    last_cert_fp:     string;
    updated_at:       number;
  } | null>;
}

let counter = 0;
function freshStub() {
  return env.TRUST_STORE.get(
    env.TRUST_STORE.idFromName(`trust-store-rpc-test-${counter++}-${Math.random()}`),
  ) as DurableObjectStub & TrustStoreRpc;
}

const PEER  = "sha256:abc123";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const SCOPE  = "bead_create:/r/foo";
const CERT   = new Uint8Array([0xCA, 0xFE]);
const SIG    = new Uint8Array([0xBA, 0xBE]);

const baseApply = (over: Record<string, unknown> = {}) => ({
  peerFingerprint: PEER,
  contentHash:     HASH_A,
  contentType:     "bead/v1",
  scope:           SCOPE,
  cert:            CERT,
  sig:             SIG,
  prevSelfRef:     null as string | null,
  prevPeerRef:     null as string | null,
  nowMs:           1_000,
  ...over,
}) as Parameters<TrustStoreRpc["applyAttestation"]>[0];

// ── applyAttestation RPC ─────────────────────────────────────────────────

describe("TrustStore.applyAttestation (RPC)", () => {
  it("appends a genesis row over RPC", async () => {
    const stub = freshStub();
    const r = await stub.applyAttestation(baseApply());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.seq).toBe(1);
      expect(r.row.content_hash).toBe(HASH_A);
    }
  });

  it("subsequent rows chain correctly across RPC calls", async () => {
    const stub = freshStub();
    await stub.applyAttestation(baseApply({ contentHash: HASH_A, prevSelfRef: null }));
    const r2 = await stub.applyAttestation(baseApply({ contentHash: HASH_B, prevSelfRef: HASH_A }));
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.seq).toBe(2);
      expect(r2.row.prev_self_ref).toBe(HASH_A);
    }
  });

  it("RPC surfaces integrity failure as a Result (not an exception)", async () => {
    const stub = freshStub();
    const ok = await stub.applyAttestation(baseApply({ contentHash: HASH_A, prevSelfRef: null }));
    expect(ok.ok).toBe(true);

    const bad = await stub.applyAttestation(baseApply({
      contentHash: HASH_B, prevSelfRef: "f".repeat(64),
    }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error).toBe("prev_self_ref_mismatch");
      expect(bad.expected).toBe(HASH_A);
      expect(bad.got).toBe("f".repeat(64));
      expect(bad.message).toMatch(/prev_self_ref mismatch/i);
    }
  });

  it("stale-prev-ref fork returns ok:false; DO stays alive (no fork landed)", async () => {
    const stub = freshStub();
    await stub.applyAttestation(baseApply({ contentHash: HASH_A, prevSelfRef: null }));
    await stub.applyAttestation(baseApply({ contentHash: HASH_B, prevSelfRef: HASH_A }));

    // Stale-prev fork attempt — Result-shape failure, no exception.
    const bad = await stub.applyAttestation(baseApply({
      contentHash: "f".repeat(64), prevSelfRef: HASH_A,
    }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toBe("prev_self_ref_mismatch");

    // The DO is still healthy: subsequent reads succeed, chain has
    // exactly 2 entries — no fork landed. This regression-tests the
    // Result-shape contract (cloister-175a3a): a failed write must NOT
    // poison the chain OR break the input gate.
    const list = await stub.listAttestationsForPeer(PEER);
    expect(list.length).toBe(2);
    expect(list.map(r => r.content_hash)).toEqual([HASH_A, HASH_B]);
  });
});

// ── disclosure-feed RPC ──────────────────────────────────────────────────

describe("TrustStore.listAttestationsForPeer (RPC)", () => {
  it("returns the chain in seq-ASC order", async () => {
    const stub = freshStub();
    await stub.applyAttestation(baseApply({ contentHash: HASH_A, prevSelfRef: null }));
    await stub.applyAttestation(baseApply({ contentHash: HASH_B, prevSelfRef: HASH_A }));
    const list = await stub.listAttestationsForPeer(PEER);
    expect(list.map(r => r.seq)).toEqual([1, 2]);
  });

  it("supports the fromSeq cursor", async () => {
    const stub = freshStub();
    await stub.applyAttestation(baseApply({ contentHash: HASH_A, prevSelfRef: null }));
    await stub.applyAttestation(baseApply({ contentHash: HASH_B, prevSelfRef: HASH_A }));
    const tail = await stub.listAttestationsForPeer(PEER, { fromSeq: 2 });
    expect(tail.length).toBe(1);
    expect(tail[0]!.seq).toBe(2);
  });
});

// ── pending_attestations RPC + retry round-trip ──────────────────────────

describe("TrustStore.enqueuePending + commit (RPC)", () => {
  it("enqueue → list returns the pending row", async () => {
    const stub = freshStub();
    const r = await stub.enqueuePendingAttestation({
      peerFp: PEER, contentHash: HASH_A, scope: SCOPE,
      cert: CERT, sig: SIG, nowMs: 1_000,
    });
    expect(r.enqueued).toBe(true);
    const list = await stub.listPendingForPeer(PEER);
    expect(list.length).toBe(1);
    expect(list[0]!.content_hash).toBe(HASH_A);
  });

  it("commit removes the pending row", async () => {
    const stub = freshStub();
    await stub.enqueuePendingAttestation({
      peerFp: PEER, contentHash: HASH_A, scope: SCOPE,
      cert: CERT, sig: SIG, nowMs: 1_000,
    });
    const c = await stub.commitPendingAttestation(PEER, HASH_A);
    expect(c.deleted).toBe(true);
    const list = await stub.listPendingForPeer(PEER);
    expect(list).toEqual([]);
  });

  it("recordFailedAttempt increments attempts + pushes next_retry_at", async () => {
    const stub = freshStub();
    await stub.enqueuePendingAttestation({
      peerFp: PEER, contentHash: HASH_A, scope: SCOPE,
      cert: CERT, sig: SIG, nowMs: 1_000,
    });
    const r = await stub.recordPendingFailedAttempt(PEER, HASH_A, 60_000);
    expect(r.newAttempts).toBe(1);
    expect(r.nextRetryAt).not.toBeNull();
  });

  it("complete bdcbe7 lifecycle: failed write → enqueue → retry success → commit", async () => {
    const stub = freshStub();

    // 1. State write happens; attestation write fails (simulated by skipping
    //    the applyAttestation call). Caller enqueues to pending.
    await stub.enqueuePendingAttestation({
      peerFp: PEER, contentHash: HASH_A, scope: SCOPE,
      cert: CERT, sig: SIG, nowMs: 1_000,
    });

    // 2. Disclosure endpoint shows PENDING state for this hash.
    const pending = await stub.listPendingForPeer(PEER);
    expect(pending.length).toBe(1);
    const found = await stub.findAttestationByContent(PEER, HASH_A);
    expect(found).toBeNull();

    // 3. Retry pump succeeds: append the attestation row, then commit
    //    pending.
    await stub.applyAttestation(baseApply({ contentHash: HASH_A, prevSelfRef: null }));
    await stub.commitPendingAttestation(PEER, HASH_A);

    // 4. State transitioned PENDING → COMPLETE: pending list empty,
    //    attestation row present.
    expect(await stub.listPendingForPeer(PEER)).toEqual([]);
    expect((await stub.findAttestationByContent(PEER, HASH_A))?.seq).toBe(1);
  });
});

// ── verifyLeaseAndAdvanceChain RPC (cloister-ee51b8) ─────────────────────
//
// Batched replacement for the recordSeenNonce + upsertLeaseCounter pair
// on the lease-middleware hot path. Three load-bearing properties:
//
//   1. PARITY — chain hash is byte-identical to the legacy two-RPC path
//      AND to the Interlace spec test vectors at
//      `interlace-spec/0.1.0/test-vectors/lease-counter.json`. The chain
//      is a cryptographic contract; ANY drift breaks the spec.
//   2. ATOMICITY — replay rejection rolls back the counter UPSERT inside
//      one transactionSync; nonce never gets consumed without the chain
//      advancing in lockstep.
//   3. CONCURRENCY — same-peer concurrent calls don't fork the chain
//      (blockConcurrencyWhile holds the input gate across the digest
//      await; same defense as legacy upsertLeaseCounter).

describe("TrustStore.verifyLeaseAndAdvanceChain (RPC, cloister-ee51b8)", () => {
  const PEER_FP = "sha256:test-peer-ee51b8";
  const CERT_FP = "sha256:test-cert-ee51b8";

  it("genesis call: returns seq=1 + computed chain hash, NOT replayed", async () => {
    const stub = freshStub();
    const r = await stub.verifyLeaseAndAdvanceChain({
      peerFp: PEER_FP, certFp: CERT_FP, nonce: "nonce-1", ts: 1_000,
    });
    expect(r.replayed).toBe(false);
    if (!r.replayed) {
      expect(r.seq).toBe(1);
      expect(r.last_chain_hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("second call: monotonic seq advance + chain extension", async () => {
    const stub = freshStub();
    await stub.verifyLeaseAndAdvanceChain({
      peerFp: PEER_FP, certFp: CERT_FP, nonce: "nonce-1", ts: 1_000,
    });
    const r2 = await stub.verifyLeaseAndAdvanceChain({
      peerFp: PEER_FP, certFp: CERT_FP, nonce: "nonce-2", ts: 2_000,
    });
    expect(r2.replayed).toBe(false);
    if (!r2.replayed) {
      expect(r2.seq).toBe(2);
    }
  });

  it("duplicate (cert_fp, nonce) returns replayed:true; chain does NOT advance", async () => {
    const stub = freshStub();
    const r1 = await stub.verifyLeaseAndAdvanceChain({
      peerFp: PEER_FP, certFp: CERT_FP, nonce: "nonce-dup", ts: 1_000,
    });
    expect(r1.replayed).toBe(false);
    if (r1.replayed) throw new Error("first call should not be replayed");

    // Snapshot chain head BEFORE the duplicate attempt.
    const beforeReplay = await stub.getLeaseCounter(PEER_FP);
    expect(beforeReplay?.seq).toBe(1);
    const headHashBefore = beforeReplay?.last_chain_hash;

    // Replay the same (cert_fp, nonce). MUST be rejected and MUST NOT
    // advance the counter.
    const r2 = await stub.verifyLeaseAndAdvanceChain({
      peerFp: PEER_FP, certFp: CERT_FP, nonce: "nonce-dup", ts: 2_000,
    });
    expect(r2.replayed).toBe(true);

    // Chain head unchanged — the atomicity contract: replay rejection
    // rolls back the counter UPSERT inside one transactionSync.
    const afterReplay = await stub.getLeaseCounter(PEER_FP);
    expect(afterReplay?.seq).toBe(1);
    expect(afterReplay?.last_chain_hash).toBe(headHashBefore);
  });

  it("PARITY: batched chain hashes match the legacy two-RPC path byte-for-byte (N=5)", async () => {
    // The bead's load-bearing assertion. Both paths route through the
    // same `computeNextLeaseStep` helper, so this is effectively a
    // regression test: drift here means the helper composition got
    // accidentally tweaked.
    const N = 5;
    const inputs = Array.from({ length: N }, (_, i) => ({
      nonce: `parity-nonce-${i}`,
      ts:    1_000 + i * 100,
    }));

    // Path 1: legacy two-RPC sequence (recordSeenNonce + upsertLeaseCounter).
    const legacyStub = freshStub();
    const legacyChain: string[] = [];
    for (const { nonce, ts } of inputs) {
      const fresh = await legacyStub.recordSeenNonce(CERT_FP, nonce, ts);
      expect(fresh.fresh).toBe(true);
      const u = await legacyStub.upsertLeaseCounter(PEER_FP, CERT_FP, nonce, ts);
      legacyChain.push(u.last_chain_hash);
    }

    // Path 2: batched one-RPC version.
    const batchedStub = freshStub();
    const batchedChain: string[] = [];
    for (const { nonce, ts } of inputs) {
      const r = await batchedStub.verifyLeaseAndAdvanceChain({
        peerFp: PEER_FP, certFp: CERT_FP, nonce, ts,
      });
      expect(r.replayed).toBe(false);
      if (!r.replayed) batchedChain.push(r.last_chain_hash);
    }

    // Byte-identical at every step.
    expect(batchedChain).toEqual(legacyChain);
    expect(batchedChain.length).toBe(N);
  });

  it("PARITY: spec vector chain hashes — Interlace 0.1.0 lease-counter.json", async () => {
    // This is the load-bearing spec contract. The Interlace 0.1.0
    // spec at `interlace-spec/0.1.0/test-vectors/lease-counter.json`
    // pins the chain-hash transcript. Both the legacy and batched paths
    // MUST produce these digests. If they drift, we've broken the spec
    // — stop, investigate, do NOT rationalize.
    //
    // Spec formula: sha256_hex(UTF8(prev_hash || cert_fp || nonce_b64 || ts_ms_decimal)).
    const SPEC_CERT_FP = "faec491cb52fe7908ae6f5817a342dc261b70fafbea906f211651b0320787c73";
    const SPEC_VECTORS = [
      {
        seq: 1,
        nonce: "oaKjpKWmp6ipqqusra6vsA",
        ts: 1700000100000,
        expected: "549167a8c86aa0ea24bb14a968784a5b15bdb7d9f63dca16a55746fee205df64",
      },
      {
        seq: 2,
        nonce: "sbKztLW2t7i5uru8vb6_wA",
        ts: 1700000200000,
        expected: "0b9d1e76bf3f422b5098557d40b342a0c17f1ad91dfa0d4fe3dfa9b53b6c5963",
      },
      {
        seq: 3,
        nonce: "wcLDxMXGx8jJysvMzc7P0A",
        ts: 1700000300000,
        expected: "13b1bec2df65fad43f3adfc1e98a2f41dc7560391a0f7277b0cf35e38a96c665",
      },
    ];

    // Drive the batched path through the spec inputs. The chain head
    // after each step must match the spec's `expected_last_chain_hash`.
    const stub = freshStub();
    const SPEC_PEER_FP = "sha256:spec-vector-peer";
    for (const v of SPEC_VECTORS) {
      const r = await stub.verifyLeaseAndAdvanceChain({
        peerFp: SPEC_PEER_FP, certFp: SPEC_CERT_FP, nonce: v.nonce, ts: v.ts,
      });
      expect(r.replayed).toBe(false);
      if (!r.replayed) {
        expect(r.seq).toBe(v.seq);
        // The byte-level spec contract. If this fails, the chain
        // formula or its inputs have drifted from interlace-spec/0.1.0
        // — do NOT change the expected; figure out what drifted.
        expect(r.last_chain_hash).toBe(v.expected);
      }
    }

    // Cross-check: legacy path must produce the same digests. (We
    // already test legacy parity in the previous case, but spec-vector
    // coverage of the legacy path is the regression hedge if someone
    // later "optimizes" the legacy path out of band.)
    const legacyStub = freshStub();
    for (const v of SPEC_VECTORS) {
      await legacyStub.recordSeenNonce(SPEC_CERT_FP, v.nonce, v.ts);
      const u = await legacyStub.upsertLeaseCounter(SPEC_PEER_FP, SPEC_CERT_FP, v.nonce, v.ts);
      expect(u.last_chain_hash).toBe(v.expected);
    }
  });
});
