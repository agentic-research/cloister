/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { CaBundleRoute } from "../../src/routes/ca-bundle.js";

const route = new CaBundleRoute();

async function seedBundle(epoch: number, status: "active" | "retired"): Promise<void> {
  const stub = env.TRUST_STORE.get(env.TRUST_STORE.idFromName("cluster")) as any;
  await stub.upsertCaBundle({
    epoch,
    signing_key_pubkey_b64u: `pub-${epoch}`,
    cert_der_b64u: null,
    issued_at_ms: 1000 * epoch,
    retired_at_ms: status === "retired" ? 2000 * epoch : null,
    status,
    compromise_notice_b64u: null,
    external_anchor_uri: null,
  });
}

describe("CaBundleRoute", () => {
  it("match() rejects POST", () => {
    expect(route.match(new Request("https://example.com/interlace/ca-bundle/1", { method: "POST" }))).toBe(false);
  });

  it("match() accepts GET on list and lookup paths", () => {
    expect(route.match(new Request("https://example.com/interlace/ca-bundle"))).toBe(true);
    expect(route.match(new Request("https://example.com/interlace/ca-bundle/42"))).toBe(true);
  });

  it("GET /interlace/ca-bundle returns the list", async () => {
    // Note: This test runs in the singleton TRUST_STORE; it may share
    // state with other tests via the cluster DO. We seed unique epochs
    // to limit cross-test interference.
    await seedBundle(101, "active");
    await seedBundle(102, "retired");
    const resp = await route.handle(new Request("https://example.com/interlace/ca-bundle"), env);
    expect(resp.status).toBe(200);
    const body = await resp.json() as { version: string; epochs: Array<{ epoch: number; status: string }> };
    expect(body.version).toBe("v1");
    const epochs = body.epochs.map((e) => e.epoch);
    expect(epochs).toContain(101);
    expect(epochs).toContain(102);
  });

  it("GET /interlace/ca-bundle/<known-epoch> returns the entry", async () => {
    await seedBundle(201, "active");
    const resp = await route.handle(new Request("https://example.com/interlace/ca-bundle/201"), env);
    expect(resp.status).toBe(200);
    const body = await resp.json() as { epoch: number; signing_key_pubkey: string };
    expect(body.epoch).toBe(201);
    expect(body.signing_key_pubkey).toBe("pub-201");
  });

  it("GET /interlace/ca-bundle/<unknown> returns 404", async () => {
    const resp = await route.handle(new Request("https://example.com/interlace/ca-bundle/999999"), env);
    expect(resp.status).toBe(404);
  });

  it("GET /interlace/ca-bundle/<malformed> returns 404", async () => {
    const resp = await route.handle(new Request("https://example.com/interlace/ca-bundle/abc"), env);
    expect(resp.status).toBe(404);
  });

  it("returns compromise notice in the body when attached", async () => {
    await seedBundle(301, "retired");
    const stub = env.TRUST_STORE.get(env.TRUST_STORE.idFromName("cluster")) as any;
    await stub.attachCompromiseNoticeToEpoch(301, "the-notice-b64u");

    const resp = await route.handle(new Request("https://example.com/interlace/ca-bundle/301"), env);
    expect(resp.status).toBe(200);
    const body = await resp.json() as { compromise_notice?: string };
    expect(body.compromise_notice).toBe("the-notice-b64u");
  });
});
