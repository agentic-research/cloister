/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import {
  DEFAULT_RECEIPT_RETENTION_MS,
  type PeerReceiptRow,
  findPeerReceipt,
  listReceiptsForActorEpoch,
  pruneExpiredReceipts,
  upsertPeerReceipt,
} from "../../src/storage/peer-receipts.js";
import { upsertActorCaBundle } from "../../src/storage/actor-ca-bundle.js";

function row(overrides: Partial<PeerReceiptRow> = {}): PeerReceiptRow {
  return {
    actor_fp:       "actor-1",
    request_hash:   "rh-1",
    direction:      "in",
    epoch:          1,
    peer_fp:        "peer-x",
    status:         200,
    timestamp_ms:   1700000000000,
    envelope_b64u:  "envelope-bytes-base64url",
    observed_at_ms: 1700000000001,
    ...overrides,
  };
}

describe("peer_receipts helpers", () => {
  it("upsert + find round-trip", async () => {
    const stub = env.TRUST_STORE.get(env.TRUST_STORE.idFromName("peer-receipts-test-1"));
    await runInDurableObject(stub, async (instance: any) => {
      const sql = instance.ctx.storage.sql;
      const r = row();
      upsertPeerReceipt(sql, r);
      const found = findPeerReceipt(sql, "actor-1", "rh-1", "in");
      expect(found).not.toBeNull();
      expect(found?.epoch).toBe(1);
      expect(found?.status).toBe(200);
    });
  });

  it("upsert is idempotent on (actor_fp, request_hash, direction)", async () => {
    const stub = env.TRUST_STORE.get(env.TRUST_STORE.idFromName("peer-receipts-test-2"));
    await runInDurableObject(stub, async (instance: any) => {
      const sql = instance.ctx.storage.sql;
      upsertPeerReceipt(sql, row({ status: 200 }));
      upsertPeerReceipt(sql, row({ status: 201 })); // replace
      const found = findPeerReceipt(sql, "actor-1", "rh-1", "in");
      expect(found?.status).toBe(201);
    });
  });

  it("direction='in' and 'out' coexist for same (actor, request_hash)", async () => {
    const stub = env.TRUST_STORE.get(env.TRUST_STORE.idFromName("peer-receipts-test-3"));
    await runInDurableObject(stub, async (instance: any) => {
      const sql = instance.ctx.storage.sql;
      upsertPeerReceipt(sql, row({ direction: "in" }));
      upsertPeerReceipt(sql, row({ direction: "out", peer_fp: "peer-y" }));
      const a = findPeerReceipt(sql, "actor-1", "rh-1", "in");
      const b = findPeerReceipt(sql, "actor-1", "rh-1", "out");
      expect(a?.peer_fp).toBe("peer-x");
      expect(b?.peer_fp).toBe("peer-y");
    });
  });

  it("listReceiptsForActorEpoch returns ordered list", async () => {
    const stub = env.TRUST_STORE.get(env.TRUST_STORE.idFromName("peer-receipts-test-4"));
    await runInDurableObject(stub, async (instance: any) => {
      const sql = instance.ctx.storage.sql;
      upsertPeerReceipt(sql, row({ request_hash: "rh-a", timestamp_ms: 100 }));
      upsertPeerReceipt(sql, row({ request_hash: "rh-b", timestamp_ms: 200 }));
      upsertPeerReceipt(sql, row({ request_hash: "rh-c", timestamp_ms: 50  }));
      const out = listReceiptsForActorEpoch(sql, "actor-1", 1);
      expect(out.map((r) => r.timestamp_ms)).toEqual([50, 100, 200]);
    });
  });

  it("listReceiptsForActorEpoch filters by epoch", async () => {
    const stub = env.TRUST_STORE.get(env.TRUST_STORE.idFromName("peer-receipts-test-5"));
    await runInDurableObject(stub, async (instance: any) => {
      const sql = instance.ctx.storage.sql;
      upsertPeerReceipt(sql, row({ request_hash: "ep1", epoch: 1 }));
      upsertPeerReceipt(sql, row({ request_hash: "ep2", epoch: 2 }));
      expect(listReceiptsForActorEpoch(sql, "actor-1", 1).length).toBe(1);
      expect(listReceiptsForActorEpoch(sql, "actor-1", 2).length).toBe(1);
      expect(listReceiptsForActorEpoch(sql, "actor-1", 3).length).toBe(0);
    });
  });

  it("findPeerReceipt returns null when not present", async () => {
    const stub = env.TRUST_STORE.get(env.TRUST_STORE.idFromName("peer-receipts-test-6"));
    await runInDurableObject(stub, async (instance: any) => {
      const sql = instance.ctx.storage.sql;
      expect(findPeerReceipt(sql, "nobody", "nothing", "in")).toBeNull();
    });
  });
});

// ── cloister-c1691c: pruneExpiredReceipts retention sweep ───────────────

describe("pruneExpiredReceipts (cloister-c1691c)", () => {
  it("prunes a direction='out' receipt past retention; keeps fresh row", async () => {
    const stub = env.TRUST_STORE.get(env.TRUST_STORE.idFromName("receipts-prune-1"));
    await runInDurableObject(stub, async (instance: any) => {
      const sql = instance.ctx.storage.sql;
      // Two epochs: 1 retired long ago, 2 retired recently.
      upsertActorCaBundle(sql, {
        epoch: 1, signing_key_pubkey_b64u: "pk-1", cert_der_b64u: null,
        issued_at_ms: 1_000_000_000_000, retired_at_ms: 1_100_000_000_000,
        status: "retired", compromise_notice_b64u: null, external_anchor_uri: null,
      });
      upsertActorCaBundle(sql, {
        epoch: 2, signing_key_pubkey_b64u: "pk-2", cert_der_b64u: null,
        issued_at_ms: 2_000_000_000_000, retired_at_ms: 2_100_000_000_000,
        status: "retired", compromise_notice_b64u: null, external_anchor_uri: null,
      });
      // direction='out' in each epoch.
      upsertPeerReceipt(sql, row({ direction: "out", epoch: 1, request_hash: "stale", timestamp_ms: 1_050_000_000_000 }));
      upsertPeerReceipt(sql, row({ direction: "out", epoch: 2, request_hash: "fresh", timestamp_ms: 2_050_000_000_000 }));

      // now_ms = 2_200_000_000_000; retention = 200_000_000_000 (≈ 6.3 years)
      // Epoch 1 retired at 1.1T + 0.2T = 1.3T < now → prune.
      // Epoch 2 retired at 2.1T + 0.2T = 2.3T > now → keep.
      const r = pruneExpiredReceipts(sql, 2_200_000_000_000, 200_000_000_000);
      expect(r.deleted).toBe(1);
      expect(r.oldestRemainingMs).toBe(2_050_000_000_000);
      expect(findPeerReceipt(sql, "actor-1", "stale", "out")).toBeNull();
      expect(findPeerReceipt(sql, "actor-1", "fresh", "out")).not.toBeNull();
    });
  });

  it("never prunes a receipt whose epoch is still active", async () => {
    const stub = env.TRUST_STORE.get(env.TRUST_STORE.idFromName("receipts-prune-2"));
    await runInDurableObject(stub, async (instance: any) => {
      const sql = instance.ctx.storage.sql;
      upsertActorCaBundle(sql, {
        epoch: 1, signing_key_pubkey_b64u: "pk-1", cert_der_b64u: null,
        issued_at_ms: 1_000_000_000_000, retired_at_ms: null,
        status: "active", compromise_notice_b64u: null, external_anchor_uri: null,
      });
      upsertPeerReceipt(sql, row({ direction: "out", epoch: 1, request_hash: "ancient", timestamp_ms: 1 }));

      // now arbitrarily far in the future; retention 1 ms.
      const r = pruneExpiredReceipts(sql, 9_999_999_999_999, 1);
      expect(r.deleted).toBe(0);
      expect(findPeerReceipt(sql, "actor-1", "ancient", "out")).not.toBeNull();
    });
  });

  it("never prunes direction='in' receipts (peer-bundle metadata absent locally — Phase 1 scope)", async () => {
    const stub = env.TRUST_STORE.get(env.TRUST_STORE.idFromName("receipts-prune-3"));
    await runInDurableObject(stub, async (instance: any) => {
      const sql = instance.ctx.storage.sql;
      upsertActorCaBundle(sql, {
        epoch: 1, signing_key_pubkey_b64u: "pk-1", cert_der_b64u: null,
        issued_at_ms: 1_000_000_000_000, retired_at_ms: 1_100_000_000_000,
        status: "retired", compromise_notice_b64u: null, external_anchor_uri: null,
      });
      // direction='in' — observed FROM a peer. We don't own the peer's
      // bundle, so we don't prune it even though OUR epoch 1 is retired.
      upsertPeerReceipt(sql, row({ direction: "in", epoch: 1, request_hash: "from-peer", timestamp_ms: 1_050_000_000_000 }));

      const r = pruneExpiredReceipts(sql, 9_999_999_999_999, 1);
      expect(r.deleted).toBe(0);
      expect(findPeerReceipt(sql, "actor-1", "from-peer", "in")).not.toBeNull();
    });
  });

  it("oldestRemainingMs is null when the table is empty after prune", async () => {
    const stub = env.TRUST_STORE.get(env.TRUST_STORE.idFromName("receipts-prune-4"));
    await runInDurableObject(stub, async (instance: any) => {
      const sql = instance.ctx.storage.sql;
      upsertActorCaBundle(sql, {
        epoch: 1, signing_key_pubkey_b64u: "pk-1", cert_der_b64u: null,
        issued_at_ms: 1_000_000_000_000, retired_at_ms: 1_100_000_000_000,
        status: "retired", compromise_notice_b64u: null, external_anchor_uri: null,
      });
      upsertPeerReceipt(sql, row({ direction: "out", epoch: 1, request_hash: "only-row", timestamp_ms: 1_050_000_000_000 }));

      const r = pruneExpiredReceipts(sql, 9_999_999_999_999, 1);
      expect(r.deleted).toBe(1);
      expect(r.oldestRemainingMs).toBeNull();
    });
  });

  it("defaults to 7-year retention when retentionMs is not supplied", async () => {
    const stub = env.TRUST_STORE.get(env.TRUST_STORE.idFromName("receipts-prune-5"));
    await runInDurableObject(stub, async (instance: any) => {
      const sql = instance.ctx.storage.sql;
      // Retired 1ms ago — fresh under default 7-year retention.
      const nowMs = 5_000_000_000_000;
      upsertActorCaBundle(sql, {
        epoch: 1, signing_key_pubkey_b64u: "pk-1", cert_der_b64u: null,
        issued_at_ms: 4_000_000_000_000, retired_at_ms: nowMs - 1,
        status: "retired", compromise_notice_b64u: null, external_anchor_uri: null,
      });
      upsertPeerReceipt(sql, row({ direction: "out", epoch: 1, request_hash: "recent-retire", timestamp_ms: nowMs - 100 }));

      const r = pruneExpiredReceipts(sql, nowMs);
      expect(r.deleted).toBe(0);

      // Re-call with now > retired_at + DEFAULT_RECEIPT_RETENTION_MS → pruned.
      const r2 = pruneExpiredReceipts(sql, nowMs + DEFAULT_RECEIPT_RETENTION_MS + 1);
      expect(r2.deleted).toBe(1);
    });
  });
});
