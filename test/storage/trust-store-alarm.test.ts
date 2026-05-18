/// <reference types="@cloudflare/vitest-pool-workers/types" />
//
// Tests for the TrustStore DO alarm scaffolding (cloister-0719da).
//
// The alarm is the first DO alarm in the cloister codebase. It runs
// hourly, sweeping seen_nonces + peer_receipts in one pass. These
// tests pin three invariants:
//
//   1. **Bootstrap** — the alarm is scheduled on first DO method call
//      (via blockConcurrencyWhile in the constructor).
//   2. **Sweep** — triggering the alarm via `runDurableObjectAlarm`
//      deletes expired seen_nonces + expired retired-epoch receipts.
//      Active-epoch receipts + recent nonces survive.
//   3. **Reschedule** — after the alarm body runs, `getAlarm()` is
//      non-null again so the hourly cadence continues.
//
// Sweep detection uses the public API rather than peeking at SQL
// directly: `recordSeenNonce` returns `{ fresh: true }` if the nonce
// was pruned (no longer in the ledger), and `findPeerReceipt`
// returns null for pruned rows.

import { describe, expect, it } from "vitest";
import { env, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { upsertActorCaBundle } from "../../src/storage/actor-ca-bundle.js";
import {
  findPeerReceipt,
  upsertPeerReceipt,
  type PeerReceiptRow,
} from "../../src/storage/peer-receipts.js";

function receipt(overrides: Partial<PeerReceiptRow> = {}): PeerReceiptRow {
  return {
    actor_fp:       "actor-alarm",
    request_hash:   "rh-1",
    direction:      "out",
    epoch:          1,
    peer_fp:        "peer-a",
    status:         200,
    timestamp_ms:   1_000_000_000_000,
    envelope_b64u:  "envelope-bytes",
    observed_at_ms: 1_000_000_000_001,
    ...overrides,
  };
}

describe("TrustStore DO alarm (cloister-0719da)", () => {
  it("bootstraps an alarm on first method call (constructor's ensureAlarmScheduled)", async () => {
    const stub = env.TRUST_STORE.get(env.TRUST_STORE.idFromName("alarm-bootstrap"));
    // Touch any method so the DO is instantiated. The constructor's
    // blockConcurrencyWhile defers this call until the bootstrap
    // resolves, so an alarm is guaranteed scheduled by the time we
    // observe `getAlarm()`.
    await stub.getLeaseCounter("dummy-peer");
    await runInDurableObject(stub, async (instance: any) => {
      const alarmAt = await instance.ctx.storage.getAlarm();
      expect(alarmAt).not.toBeNull();
      expect(typeof alarmAt).toBe("number");
      expect(alarmAt).toBeGreaterThan(Date.now());
    });
  });

  it("alarm() prunes expired retired-epoch receipts; active-epoch receipts survive", async () => {
    const stub = env.TRUST_STORE.get(env.TRUST_STORE.idFromName("alarm-sweep-receipts"));
    await runInDurableObject(stub, async (instance: any) => {
      const sql = instance.ctx.storage.sql;
      // Epoch 1: retired long ago → expired under default 7-year retention.
      upsertActorCaBundle(sql, {
        epoch: 1, signing_key_pubkey_b64u: "pk-1", cert_der_b64u: null,
        issued_at_ms: 1, retired_at_ms: 2,
        status: "retired", compromise_notice_b64u: null, external_anchor_uri: null,
      });
      // Epoch 2: still active → must survive regardless of receipt age.
      upsertActorCaBundle(sql, {
        epoch: 2, signing_key_pubkey_b64u: "pk-2", cert_der_b64u: null,
        issued_at_ms: 3, retired_at_ms: null,
        status: "active", compromise_notice_b64u: null, external_anchor_uri: null,
      });
      upsertPeerReceipt(sql, receipt({ epoch: 1, request_hash: "expired-out", timestamp_ms: 4 }));
      upsertPeerReceipt(sql, receipt({ epoch: 2, request_hash: "active-out",  timestamp_ms: 5 }));
    });
    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);
    await runInDurableObject(stub, async (instance: any) => {
      const sql = instance.ctx.storage.sql;
      // Use the public helper rather than poking SQL — the prune
      // contract is observable via findPeerReceipt returning null.
      expect(findPeerReceipt(sql, "actor-alarm", "expired-out", "out")).toBeNull();
      expect(findPeerReceipt(sql, "actor-alarm", "active-out",  "out")).not.toBeNull();
    });
  });

  it("alarm() prunes ancient seen_nonces; recent nonces survive", async () => {
    const stub = env.TRUST_STORE.get(env.TRUST_STORE.idFromName("alarm-sweep-nonces"));
    const now = Date.now();
    await runInDurableObject(stub, async (instance: any) => {
      // Recent nonce (within retention window).
      instance.recordSeenNonce("cert-a", "nonce-recent", now - 1_000);
      // Ancient nonce (well past the 1-hour SEEN_NONCES_RETENTION_MS).
      instance.recordSeenNonce("cert-b", "nonce-ancient", now - (24 * 60 * 60 * 1000));
    });
    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);
    // Public-API probe: recordSeenNonce returns fresh:true if the
    // nonce is no longer in the ledger (i.e. it was pruned and the
    // re-record is the first observation). The recent nonce was kept,
    // so re-recording it returns fresh:false.
    await runInDurableObject(stub, async (instance: any) => {
      const recentResult = instance.recordSeenNonce("cert-a", "nonce-recent", now);
      expect(recentResult.fresh).toBe(false);  // still there → not fresh
      const ancientResult = instance.recordSeenNonce("cert-b", "nonce-ancient", now);
      expect(ancientResult.fresh).toBe(true);  // pruned → fresh again
    });
  });

  it("alarm() reschedules itself so the hourly cadence continues", async () => {
    const stub = env.TRUST_STORE.get(env.TRUST_STORE.idFromName("alarm-reschedule"));
    // Trigger one run.
    await stub.getLeaseCounter("dummy");
    await runDurableObjectAlarm(stub);
    // After the alarm body returns, `setAlarm` should have re-armed.
    await runInDurableObject(stub, async (instance: any) => {
      const alarmAt = await instance.ctx.storage.getAlarm();
      expect(alarmAt).not.toBeNull();
      expect(typeof alarmAt).toBe("number");
      expect(alarmAt).toBeGreaterThan(Date.now());
    });
  });

  it("ensureAlarmScheduled is idempotent — pre-existing alarm is preserved", async () => {
    const stub = env.TRUST_STORE.get(env.TRUST_STORE.idFromName("alarm-idempotent"));
    let firstAlarmAt: number | null = null;
    await runInDurableObject(stub, async (instance: any) => {
      firstAlarmAt = await instance.ctx.storage.getAlarm();
    });
    // A subsequent ensure call must NOT shift the deadline.
    await runInDurableObject(stub, async (instance: any) => {
      await instance.ensureAlarmScheduled?.();
      const secondAlarmAt = await instance.ctx.storage.getAlarm();
      expect(secondAlarmAt).toBe(firstAlarmAt);
    });
  });
});
