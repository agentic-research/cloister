/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import {
  type ActorCaBundleEntry,
  attachCompromiseNotice,
  getActorCaBundle,
  listActorCaBundleEpochs,
  upsertActorCaBundle,
} from "../../src/storage/actor-ca-bundle.js";

function makeEntry(overrides: Partial<ActorCaBundleEntry> = {}): ActorCaBundleEntry {
  return {
    epoch: 1,
    signing_key_pubkey_b64u: "pubkey-bytes-b64u",
    cert_der_b64u: null,
    issued_at_ms: 1700000000000,
    retired_at_ms: null,
    status: "active",
    compromise_notice_b64u: null,
    external_anchor_uri: null,
    ...overrides,
  };
}

describe("actor_ca_bundle helpers", () => {
  it("upsert + get round-trip on a single epoch", async () => {
    const stub = env.TRUST_STORE.get(env.TRUST_STORE.idFromName("ca-bundle-test-1"));
    await runInDurableObject(stub, async (instance: any) => {
      const sql = instance.ctx.storage.sql;
      upsertActorCaBundle(sql, makeEntry());
      const got = getActorCaBundle(sql, 1);
      expect(got).not.toBeNull();
      expect(got?.epoch).toBe(1);
      expect(got?.status).toBe("active");
    });
  });

  it("upsert overwrites on conflict by epoch", async () => {
    const stub = env.TRUST_STORE.get(env.TRUST_STORE.idFromName("ca-bundle-test-2"));
    await runInDurableObject(stub, async (instance: any) => {
      const sql = instance.ctx.storage.sql;
      upsertActorCaBundle(sql, makeEntry({ status: "active" }));
      upsertActorCaBundle(sql, makeEntry({ status: "retired", retired_at_ms: 9999 }));
      const got = getActorCaBundle(sql, 1);
      expect(got?.status).toBe("retired");
      expect(got?.retired_at_ms).toBe(9999);
    });
  });

  it("listActorCaBundleEpochs returns DESC by epoch", async () => {
    const stub = env.TRUST_STORE.get(env.TRUST_STORE.idFromName("ca-bundle-test-3"));
    await runInDurableObject(stub, async (instance: any) => {
      const sql = instance.ctx.storage.sql;
      upsertActorCaBundle(sql, makeEntry({ epoch: 5 }));
      upsertActorCaBundle(sql, makeEntry({ epoch: 3 }));
      upsertActorCaBundle(sql, makeEntry({ epoch: 7, status: "active" }));
      const out = listActorCaBundleEpochs(sql);
      expect(out.map((e) => e.epoch)).toEqual([7, 5, 3]);
    });
  });

  it("attachCompromiseNotice returns false on unknown epoch", async () => {
    const stub = env.TRUST_STORE.get(env.TRUST_STORE.idFromName("ca-bundle-test-4"));
    await runInDurableObject(stub, async (instance: any) => {
      const sql = instance.ctx.storage.sql;
      expect(attachCompromiseNotice(sql, 99, "notice-bytes")).toBe(false);
    });
  });

  it("attachCompromiseNotice attaches to an existing epoch row", async () => {
    const stub = env.TRUST_STORE.get(env.TRUST_STORE.idFromName("ca-bundle-test-5"));
    await runInDurableObject(stub, async (instance: any) => {
      const sql = instance.ctx.storage.sql;
      upsertActorCaBundle(sql, makeEntry({ epoch: 4, status: "retired", retired_at_ms: 200 }));
      const ok = attachCompromiseNotice(sql, 4, "the-notice-b64u");
      expect(ok).toBe(true);
      const got = getActorCaBundle(sql, 4);
      expect(got?.compromise_notice_b64u).toBe("the-notice-b64u");
    });
  });

  it("getActorCaBundle returns null on miss", async () => {
    const stub = env.TRUST_STORE.get(env.TRUST_STORE.idFromName("ca-bundle-test-6"));
    await runInDurableObject(stub, async (instance: any) => {
      const sql = instance.ctx.storage.sql;
      expect(getActorCaBundle(sql, 42)).toBeNull();
    });
  });
});
