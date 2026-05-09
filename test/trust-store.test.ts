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
  }): Promise<{ seq: number; row: PeerAttestation }>;
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
    expect(r.seq).toBe(1);
    expect(r.row.content_hash).toBe(HASH_A);
  });

  it("subsequent rows chain correctly across RPC calls", async () => {
    const stub = freshStub();
    await stub.applyAttestation(baseApply({ contentHash: HASH_A, prevSelfRef: null }));
    const r2 = await stub.applyAttestation(baseApply({ contentHash: HASH_B, prevSelfRef: HASH_A }));
    expect(r2.seq).toBe(2);
    expect(r2.row.prev_self_ref).toBe(HASH_A);
  });

  it("RPC propagates AttestationIntegrityError on prev_self_ref mismatch", async () => {
    const stub = freshStub();
    await stub.applyAttestation(baseApply({ contentHash: HASH_A, prevSelfRef: null }));
    await expect(
      stub.applyAttestation(baseApply({ contentHash: HASH_B, prevSelfRef: "f".repeat(64) })),
    ).rejects.toThrow(/prev_self_ref mismatch/i);
  });

  it("integrity check rejects stale-prev-ref fork without breaking the DO (gate stays alive)", async () => {
    const stub = freshStub();
    await stub.applyAttestation(baseApply({ contentHash: HASH_A, prevSelfRef: null }));
    await stub.applyAttestation(baseApply({ contentHash: HASH_B, prevSelfRef: HASH_A }));

    // Stale-prev fork attempt — should reject AND leave the DO healthy.
    await expect(
      stub.applyAttestation(baseApply({ contentHash: "f".repeat(64), prevSelfRef: HASH_A })),
    ).rejects.toThrow(/prev_self_ref mismatch/i);

    // The DO is still usable: subsequent reads succeed and the chain
    // is exactly 2 entries (no fork landed). This regression-tests the
    // catch-inside-gate / rethrow-outside-gate restructure.
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
