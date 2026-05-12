/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import {
  type PeerReceiptRow,
  findPeerReceipt,
  listReceiptsForActorEpoch,
  upsertPeerReceipt,
} from "../../src/storage/peer-receipts.js";

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
