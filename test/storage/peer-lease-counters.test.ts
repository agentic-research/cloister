/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it } from "vitest";
import {
  type PeerLeaseCounter,
  type SqlExecutor,
  ZERO_HASH,
  applyLeaseCounter,
  nextChainHash,
  readLeaseCounter,
} from "../../src/storage/peer-lease-counters.js";

// ── In-memory SqlExecutor ────────────────────────────────────────────────
//
// The peer-lease-counters helpers are pure functions over an injected SQL
// executor. Tests inject a tiny in-memory implementation here so the unit
// tests don't need a real DO. The actual integration with BeadStore is
// exercised by the BeadStore DO's own tests (when bd7770 wires the call
// site).

class FakeSql implements SqlExecutor {
  private rows = new Map<string, PeerLeaseCounter>();

  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): { toArray(): T[] } {
    const q = query.replace(/\s+/g, " ").trim();

    // SELECT for the read path
    if (q.startsWith("SELECT")) {
      const fp = bindings[0] as string;
      const row = this.rows.get(fp);
      return { toArray: () => (row ? [row as unknown as T] : []) };
    }

    // INSERT … ON CONFLICT DO UPDATE — the upsert path. Match by signature
    // rather than parsing SQL. excluded.* bindings come from the same
    // bindings array; we just take them positionally.
    if (q.startsWith("INSERT INTO peer_lease_counters")) {
      const [peer_fingerprint, seq, last_chain_hash, last_cert_fp, updated_at] = bindings as [
        string, number, string, string, number,
      ];
      this.rows.set(peer_fingerprint, {
        peer_fingerprint, seq, last_chain_hash, last_cert_fp, updated_at,
      });
      return { toArray: () => [] };
    }

    throw new Error(`FakeSql: unrecognized query: ${q.slice(0, 60)}`);
  }
}

const PEER = "sha256:abc123";
const CERT_A = "cert_fp_alpha";
const CERT_B = "cert_fp_beta";

// ── Hash chain ───────────────────────────────────────────────────────────

describe("nextChainHash", () => {
  it("produces a 64-char hex digest", async () => {
    const h = await nextChainHash(ZERO_HASH, CERT_A, "nonce1", 1000);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same inputs", async () => {
    const a = await nextChainHash(ZERO_HASH, CERT_A, "nonce1", 1000);
    const b = await nextChainHash(ZERO_HASH, CERT_A, "nonce1", 1000);
    expect(a).toBe(b);
  });

  it("changes when any input changes", async () => {
    const base = await nextChainHash(ZERO_HASH, CERT_A, "nonce1", 1000);
    const diffPrev  = await nextChainHash("a".repeat(64), CERT_A, "nonce1", 1000);
    const diffCert  = await nextChainHash(ZERO_HASH,      CERT_B, "nonce1", 1000);
    const diffNonce = await nextChainHash(ZERO_HASH,      CERT_A, "nonce2", 1000);
    const diffTs    = await nextChainHash(ZERO_HASH,      CERT_A, "nonce1", 1001);

    expect(diffPrev).not.toBe(base);
    expect(diffCert).not.toBe(base);
    expect(diffNonce).not.toBe(base);
    expect(diffTs).not.toBe(base);
  });
});

// ── Read path ────────────────────────────────────────────────────────────

describe("readLeaseCounter", () => {
  it("returns null for a peer with no counter row", () => {
    const sql = new FakeSql();
    expect(readLeaseCounter(sql, PEER)).toBeNull();
  });

  it("returns the row when it exists", async () => {
    const sql = new FakeSql();
    await applyLeaseCounter(sql, PEER, CERT_A, "n1", 1000);
    const row = readLeaseCounter(sql, PEER);
    expect(row).not.toBeNull();
    expect(row?.peer_fingerprint).toBe(PEER);
    expect(row?.seq).toBe(1);
  });
});

// ── Upsert + chain progression ───────────────────────────────────────────

describe("applyLeaseCounter", () => {
  it("creates a counter on first call (genesis from ZERO_HASH)", async () => {
    const sql = new FakeSql();
    const result = await applyLeaseCounter(sql, PEER, CERT_A, "n1", 1000);
    expect(result.seq).toBe(1);
    expect(result.last_chain_hash).toMatch(/^[0-9a-f]{64}$/);

    const row = readLeaseCounter(sql, PEER);
    expect(row).toEqual({
      peer_fingerprint: PEER,
      seq: 1,
      last_chain_hash: result.last_chain_hash,
      last_cert_fp: CERT_A,
      updated_at: 1000,
    });
  });

  it("increments seq on each call", async () => {
    const sql = new FakeSql();
    const r1 = await applyLeaseCounter(sql, PEER, CERT_A, "n1", 1000);
    const r2 = await applyLeaseCounter(sql, PEER, CERT_A, "n2", 1100);
    const r3 = await applyLeaseCounter(sql, PEER, CERT_A, "n3", 1200);
    expect(r1.seq).toBe(1);
    expect(r2.seq).toBe(2);
    expect(r3.seq).toBe(3);
  });

  it("chains: each hash folds in the previous one", async () => {
    const sql = new FakeSql();
    const r1 = await applyLeaseCounter(sql, PEER, CERT_A, "n1", 1000);
    const r2 = await applyLeaseCounter(sql, PEER, CERT_A, "n2", 1100);
    expect(r1.last_chain_hash).not.toBe(r2.last_chain_hash);

    // Re-derive r2's hash from r1 + the same inputs r2 used.
    const expectedR2 = await nextChainHash(r1.last_chain_hash, CERT_A, "n2", 1100);
    expect(r2.last_chain_hash).toBe(expectedR2);
  });

  it("two calls with identical inputs after the first produce different chain hashes (anti-replay)", async () => {
    const sql = new FakeSql();
    const r1 = await applyLeaseCounter(sql, PEER, CERT_A, "n1", 1000);
    const r2 = await applyLeaseCounter(sql, PEER, CERT_A, "n1", 1000);
    expect(r1.last_chain_hash).not.toBe(r2.last_chain_hash);
    // Different because r2 folds in r1's chain hash, not ZERO_HASH.
  });

  it("stores last_cert_fp from the most-recent observation", async () => {
    const sql = new FakeSql();
    await applyLeaseCounter(sql, PEER, CERT_A, "n1", 1000);
    await applyLeaseCounter(sql, PEER, CERT_B, "n2", 1100);
    expect(readLeaseCounter(sql, PEER)?.last_cert_fp).toBe(CERT_B);
  });

  it("stores updated_at from the most-recent observation", async () => {
    const sql = new FakeSql();
    await applyLeaseCounter(sql, PEER, CERT_A, "n1", 1000);
    await applyLeaseCounter(sql, PEER, CERT_A, "n2", 9999);
    expect(readLeaseCounter(sql, PEER)?.updated_at).toBe(9999);
  });

  it("isolates counter per peer", async () => {
    const sql = new FakeSql();
    const PEER2 = "sha256:def456";
    await applyLeaseCounter(sql, PEER,  CERT_A, "n1", 1000);
    await applyLeaseCounter(sql, PEER,  CERT_A, "n2", 1100);
    await applyLeaseCounter(sql, PEER2, CERT_A, "n1", 1000);

    expect(readLeaseCounter(sql, PEER)?.seq).toBe(2);
    expect(readLeaseCounter(sql, PEER2)?.seq).toBe(1);
  });
});
