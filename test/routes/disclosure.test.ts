/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CONSTANT_TIME_ERROR_BODY_LEN,
  DisclosureRoute,
} from "../../src/routes/disclosure.js";

// ── Helpers ──────────────────────────────────────────────────────────────

const PEER  = "sha256:peer-disclosure-test";
const PEER2 = "sha256:other-peer";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

const HMAC_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";  // 32 bytes
const MASTER_PUBKEY = "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=";

function makeEnv(over: Partial<typeof env> = {}): typeof env {
  // Default: gate OFF (INTERLACE_ROOT_PUBKEY unset) so the disclosure-
  // logic tests (JSONL shape, cursor signing, constant-time errors)
  // exercise the post-auth code path. Tests that exercise the auth gate
  // explicitly opt in by setting INTERLACE_ROOT_PUBKEY in the override.
  return Object.assign({}, env, {
    INTERLACE_DISCLOSURE_HMAC_KEY: HMAC_KEY,
    // INTERLACE_ROOT_PUBKEY intentionally absent here; set by gate-on tests
    ...over,
  }) as typeof env;
}

const baseAttestation = (over: Record<string, unknown> = {}) => ({
  peerFingerprint: PEER,
  contentHash:     HASH_A,
  contentType:     "bead/v1",
  scope:           "bead_create:/r/foo",
  cert:            new Uint8Array([0xCA, 0xFE]),
  sig:             new Uint8Array([0xBA, 0xBE]),
  prevSelfRef:     null as string | null,
  prevPeerRef:     null as string | null,
  nowMs:           1_000,
  ...over,
});

interface TrustStoreRpc {
  applyAttestation(args: ReturnType<typeof baseAttestation>): Promise<unknown>;
  enqueuePendingAttestation(args: {
    peerFp: string; contentHash: string; scope: string;
    cert: Uint8Array; sig: Uint8Array; nowMs: number;
  }): Promise<unknown>;
  recordPendingFailedAttempt(
    peerFp: string, contentHash: string, nowMs: number,
  ): Promise<unknown>;
}

function trustStub() {
  return env.TRUST_STORE.get(env.TRUST_STORE.idFromName("cluster")) as DurableObjectStub & TrustStoreRpc;
}

// Each test resets the singleton's tables so the disclosure read
// returns only what THIS test populated.
beforeEach(async () => {
  const stub = env.TRUST_STORE.get(env.TRUST_STORE.idFromName("cluster"));
  await runInDurableObject(stub, async (_, state) => {
    state.storage.sql.exec("DELETE FROM peer_attestations");
    state.storage.sql.exec("DELETE FROM pending_attestations");
  });
});

function makeReq(path: string): Request {
  return new Request(`http://x${path}`, { method: "GET" });
}

async function readJsonl(res: Response): Promise<unknown[]> {
  const text = await res.text();
  return text.trim().split("\n").map(l => JSON.parse(l));
}

// ── match() ──────────────────────────────────────────────────────────────

describe("DisclosureRoute.match", () => {
  it("matches GET /interlace/peers/<fp>", () => {
    const route = new DisclosureRoute();
    expect(route.match(makeReq(`/interlace/peers/${PEER}`))).toBe(true);
  });

  it("does not match other methods", () => {
    const route = new DisclosureRoute();
    expect(
      route.match(new Request(`http://x/interlace/peers/${PEER}`, { method: "POST" })),
    ).toBe(false);
  });

  it("does not match other paths", () => {
    const route = new DisclosureRoute();
    expect(route.match(makeReq("/health"))).toBe(false);
    expect(route.match(makeReq("/.well-known/interlace/index.json"))).toBe(false);
    expect(route.match(makeReq("/mcp"))).toBe(false);
  });

  it("URLPattern shape: rejects subpaths under /interlace/peers/", () => {
    const route = new DisclosureRoute();
    // /interlace/peers/<fp>/divergence is a sibling endpoint (per
    // ADR-0007 §6.4) — must NOT match this route. URLPattern's
    // segment-match prevents the "swallow everything" bug startsWith
    // would have.
    expect(route.match(makeReq(`/interlace/peers/${PEER}/divergence`))).toBe(false);
    expect(route.match(makeReq(`/interlace/peers/${PEER}/anything`))).toBe(false);
  });

  it("URLPattern shape: rejects empty fp segment", () => {
    const route = new DisclosureRoute();
    expect(route.match(makeReq("/interlace/peers/"))).toBe(false);
  });

  it("URLPattern shape: rejects bare /interlace or /interlace/peers", () => {
    const route = new DisclosureRoute();
    expect(route.match(makeReq("/interlace"))).toBe(false);
    expect(route.match(makeReq("/interlace/peers"))).toBe(false);
  });
});

// ── Happy path: chain reconstruction ─────────────────────────────────────

describe("DisclosureRoute.handle — happy path", () => {
  it("returns header + attestation rows for a known peer (JSONL)", async () => {
    await trustStub().applyAttestation(baseAttestation({ contentHash: HASH_A, prevSelfRef: null }));
    await trustStub().applyAttestation(baseAttestation({ contentHash: HASH_B, prevSelfRef: HASH_A }));

    // Use a DIFFERENT env binding for the surfaced master pubkey so we
    // can set it WITHOUT triggering the lease gate (which keys on
    // INTERLACE_ROOT_PUBKEY). This test is about response shape, not auth.
    const route = new DisclosureRoute(undefined, "INTERLACE_PUBLISHED_MASTER");
    const res = await route.handle(
      makeReq(`/interlace/peers/${PEER}`),
      makeEnv({ INTERLACE_PUBLISHED_MASTER: MASTER_PUBKEY } as unknown as Partial<typeof env>),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/jsonl/);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const rows = await readJsonl(res);
    expect(rows[0]).toMatchObject({
      type: "header",
      version: "v1",
      peer_fingerprint: PEER,
      master_public_key: MASTER_PUBKEY,
    });
    expect(rows[1]).toMatchObject({ type: "attestation", seq: 1, content_hash: HASH_A });
    expect(rows[2]).toMatchObject({ type: "attestation", seq: 2, content_hash: HASH_B, prev_self_ref: HASH_A });
  });

  it("encodes cert + sig as base64-standard for offline verification", async () => {
    const cert = new Uint8Array([1, 2, 3, 4, 0xFF]);
    const sig  = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
    await trustStub().applyAttestation(baseAttestation({
      contentHash: HASH_A, prevSelfRef: null,
      cert, sig,
    }));

    const route = new DisclosureRoute();
    const res = await route.handle(makeReq(`/interlace/peers/${PEER}`), makeEnv());
    const rows = await readJsonl(res);
    const att = rows[1] as { cert_b64: string; sig_b64: string };

    // Round-trip via atob → bytes → match.
    const certBytes = Uint8Array.from(atob(att.cert_b64), c => c.charCodeAt(0));
    const sigBytes  = Uint8Array.from(atob(att.sig_b64),  c => c.charCodeAt(0));
    expect(Array.from(certBytes)).toEqual(Array.from(cert));
    expect(Array.from(sigBytes)).toEqual(Array.from(sig));
  });

  it("includes pending rows after the attestation chain", async () => {
    await trustStub().applyAttestation(baseAttestation({ contentHash: HASH_A, prevSelfRef: null }));
    await trustStub().enqueuePendingAttestation({
      peerFp: PEER, contentHash: HASH_B, scope: "bead_create:/r/bar",
      cert: new Uint8Array([0xAA]), sig: new Uint8Array([0xBB]),
      nowMs: 5_000,
    });

    const route = new DisclosureRoute();
    const res = await route.handle(makeReq(`/interlace/peers/${PEER}`), makeEnv());
    const rows = await readJsonl(res);

    // [header, attestation, pending]
    expect(rows.length).toBe(3);
    expect((rows[2] as { type: string }).type).toBe("pending");
    expect(rows[2]).toMatchObject({
      type:         "pending",
      content_hash: HASH_B,
      scope:        "bead_create:/r/bar",
      attempts:     0,
      exhausted:    false,
    });
  });

  it("flags exhausted pending rows (attempts == MAX_RETRY_ATTEMPTS)", async () => {
    await trustStub().enqueuePendingAttestation({
      peerFp: PEER, contentHash: HASH_A, scope: "bead_create:/r/foo",
      cert: new Uint8Array([0xAA]), sig: new Uint8Array([0xBB]),
      nowMs: 1_000,
    });
    // Hammer through the backoff schedule.
    for (let i = 0; i < 10; i++) {
      await trustStub().recordPendingFailedAttempt(PEER, HASH_A, 1_000 + (i + 1) * 1_000_000);
    }

    const route = new DisclosureRoute();
    const res = await route.handle(makeReq(`/interlace/peers/${PEER}`), makeEnv());
    const rows = await readJsonl(res);
    expect((rows[1] as { type: string; exhausted: boolean }).exhausted).toBe(true);
  });
});

// ── Pagination via signed cursor ─────────────────────────────────────────

describe("DisclosureRoute.handle — pagination", () => {
  it("emits next_cursor when chain exceeds the page size, omits it otherwise", async () => {
    // Default page size is 100; mint 105 rows.
    let prev: string | null = null;
    for (let i = 0; i < 105; i++) {
      const hash = i.toString(16).padStart(64, "0");
      await trustStub().applyAttestation(baseAttestation({ contentHash: hash, prevSelfRef: prev }));
      prev = hash;
    }

    const route = new DisclosureRoute();
    const res = await route.handle(makeReq(`/interlace/peers/${PEER}`), makeEnv());
    const rows = await readJsonl(res);
    const header = rows[0] as { next_cursor?: string };
    expect(header.next_cursor).toBeDefined();
    // Header + 100 attestation rows = 101 (no pending).
    expect(rows.length).toBe(101);
  });

  it("the second page picks up where the first left off (no overlap, no gap)", async () => {
    // 150 rows so we get exactly 2 pages of 100 + 50.
    let prev: string | null = null;
    for (let i = 0; i < 150; i++) {
      const hash = i.toString(16).padStart(64, "0");
      await trustStub().applyAttestation(baseAttestation({ contentHash: hash, prevSelfRef: prev }));
      prev = hash;
    }

    const route = new DisclosureRoute();
    const page1 = await readJsonl(await route.handle(
      makeReq(`/interlace/peers/${PEER}`),
      makeEnv(),
    ));
    const cursor = (page1[0] as { next_cursor: string }).next_cursor;

    const page2 = await readJsonl(await route.handle(
      makeReq(`/interlace/peers/${PEER}?since=${encodeURIComponent(cursor)}`),
      makeEnv(),
    ));

    // Page 1 has 100 attestation rows (seq 1..100); page 2 has 50 (seq 101..150).
    const p1Seqs = page1.slice(1).map(r => (r as { seq: number }).seq);
    const p2Seqs = page2.slice(1).map(r => (r as { seq: number }).seq);
    expect(p1Seqs[0]).toBe(1);
    expect(p1Seqs[p1Seqs.length - 1]).toBe(100);
    expect(p2Seqs[0]).toBe(101);
    expect(p2Seqs[p2Seqs.length - 1]).toBe(150);

    // Page 2 should NOT have a next_cursor — chain exhausted.
    expect((page2[0] as { next_cursor?: string }).next_cursor).toBeUndefined();
  });

  it("rejects an unsigned cursor (`since=raw_seq`) — paginated-tail oracle defense", async () => {
    await trustStub().applyAttestation(baseAttestation({ contentHash: HASH_A, prevSelfRef: null }));
    const route = new DisclosureRoute();
    const res = await route.handle(
      makeReq(`/interlace/peers/${PEER}?since=42`),
      makeEnv(),
    );
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body.length).toBe(CONSTANT_TIME_ERROR_BODY_LEN);
  });

  it("rejects a cursor signed for a different peer (cross-peer cursor reuse)", async () => {
    // Sign a cursor for PEER2 manually, then submit it on PEER's URL.
    await trustStub().applyAttestation(baseAttestation({ peerFingerprint: PEER, contentHash: HASH_A, prevSelfRef: null }));
    const { signCursor, importHmacKey } = await import("../../src/storage/disclosure-cursor.js");
    const key = await importHmacKey(HMAC_KEY);
    const wrongCursor = await signCursor({ peerFp: PEER2, fromSeq: 1, ts: Date.now() }, key);

    const route = new DisclosureRoute();
    const res = await route.handle(
      makeReq(`/interlace/peers/${PEER}?since=${encodeURIComponent(wrongCursor)}`),
      makeEnv(),
    );
    expect(res.status).toBe(404);
  });

  it("rejects a cursor signed by a DIFFERENT HMAC key", async () => {
    await trustStub().applyAttestation(baseAttestation({ contentHash: HASH_A, prevSelfRef: null }));
    const { signCursor, importHmacKey } = await import("../../src/storage/disclosure-cursor.js");
    const otherKey = await importHmacKey("ZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmY=");
    const cursor = await signCursor({ peerFp: PEER, fromSeq: 1, ts: Date.now() }, otherKey);

    const route = new DisclosureRoute();
    const res = await route.handle(
      makeReq(`/interlace/peers/${PEER}?since=${encodeURIComponent(cursor)}`),
      makeEnv(),
    );
    expect(res.status).toBe(404);
  });
});

// ── Error paths: constant-time + indistinguishability ───────────────────

describe("DisclosureRoute.handle — error paths (threat model §9.2)", () => {
  it("returns 404 with constant-time body for an unknown peer (no rows)", async () => {
    const route = new DisclosureRoute();
    const res = await route.handle(makeReq(`/interlace/peers/${PEER}`), makeEnv());
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body.length).toBe(CONSTANT_TIME_ERROR_BODY_LEN);
  });

  it("returns the SAME constant-time body for not_found vs bad_cursor (no oracle)", async () => {
    await trustStub().applyAttestation(baseAttestation({ contentHash: HASH_A, prevSelfRef: null }));
    const route = new DisclosureRoute();

    const notFound = await route.handle(makeReq(`/interlace/peers/unknown_peer`), makeEnv());
    const badCursor = await route.handle(
      makeReq(`/interlace/peers/${PEER}?since=garbage_cursor`),
      makeEnv(),
    );

    const a = await notFound.text();
    const b = await badCursor.text();
    // Bodies must be byte-identical so an attacker probing for peer
    // existence can't distinguish "no peer" from "bad cursor".
    expect(a).toBe(b);
    expect(a.length).toBe(CONSTANT_TIME_ERROR_BODY_LEN);
  });

  it("returns 404 when HMAC key is unset (denied via constant-time)", async () => {
    await trustStub().applyAttestation(baseAttestation({ contentHash: HASH_A, prevSelfRef: null }));
    const route = new DisclosureRoute();
    const envNoKey = makeEnv({ INTERLACE_DISCLOSURE_HMAC_KEY: "" });
    const res = await route.handle(makeReq(`/interlace/peers/${PEER}`), envNoKey);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body.length).toBe(CONSTANT_TIME_ERROR_BODY_LEN);
  });

  it("returns 404 for an empty fingerprint segment", async () => {
    const route = new DisclosureRoute();
    const res = await route.handle(makeReq(`/interlace/peers/`), makeEnv());
    expect(res.status).toBe(404);
  });

  it("scopes strictly: PEER's data is not leaked through PEER2's URL", async () => {
    await trustStub().applyAttestation(baseAttestation({ peerFingerprint: PEER,  contentHash: HASH_A, prevSelfRef: null }));
    await trustStub().applyAttestation(baseAttestation({ peerFingerprint: PEER2, contentHash: HASH_C, prevSelfRef: null }));

    const route = new DisclosureRoute();
    const res = await route.handle(makeReq(`/interlace/peers/${PEER2}`), makeEnv());
    const rows = await readJsonl(res);
    const attRows = rows.slice(1) as { content_hash: string }[];
    expect(attRows.every(r => r.content_hash === HASH_C)).toBe(true);
    expect(attRows.find(r => r.content_hash === HASH_A)).toBeUndefined();
  });
});

// ── Auth gate integration (cloister-bdef0c) ──────────────────────────────
//
// When INTERLACE_ROOT_PUBKEY is set, every request MUST carry a valid
// Signet envelope with scope `disclosure:<peerFp>`. These tests exercise
// the gate via the same direct McpEdgeRoute pattern used in
// test/mcp-auth.test.ts.

import { _resetCache } from "../../src/storage/ca-bundle-cache.js";
import { bundleCanonical } from "../../src/storage/bundle-canonical.js";

async function makeRootKey(): Promise<{ privateKey: CryptoKey; publicKeyB64: string }> {
  const kp = (await crypto.subtle.generateKey(
    { name: "Ed25519" }, true, ["sign", "verify"],
  )) as CryptoKeyPair;
  const raw = (await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer;
  const bytes = new Uint8Array(raw);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return { privateKey: kp.privateKey, publicKeyB64: btoa(bin) };
}

async function signedBundle(root: CryptoKey, masterB64Std: string) {
  const base = {
    epoch:    7,
    seqno:    1,
    keys:     { active: masterB64Std },
    keyId:    "active",
    issuedAt: 1_700_000_050,
  };
  const sig = new Uint8Array(
    (await crypto.subtle.sign(
      "Ed25519", root,
      bundleCanonical({ ...base, signature: "" }) as BufferSource,
    )) as ArrayBuffer,
  );
  let bin = "";
  for (let i = 0; i < sig.length; i++) bin += String.fromCharCode(sig[i]!);
  return { ...base, signature: btoa(bin) };
}

function envWithGate(
  root: CryptoKey,
  rootPubkeyB64: string,
  notmeResponder: (req: Request) => Promise<Response>,
): typeof env {
  return Object.assign({}, env, {
    INTERLACE_DISCLOSURE_HMAC_KEY: HMAC_KEY,
    INTERLACE_ROOT_PUBKEY: rootPubkeyB64,
    NOTME: { fetch: notmeResponder } as unknown as typeof env.NOTME,
  }) as typeof env;
}

describe("DisclosureRoute — auth gate (INTERLACE_ROOT_PUBKEY set)", () => {
  it("rejects (constant-time 404) when no auth headers are present", async () => {
    _resetCache();
    const root = await makeRootKey();
    const bundle = await signedBundle(root.privateKey, MASTER_PUBKEY);
    const route = new DisclosureRoute();

    const res = await route.handle(
      makeReq(`/interlace/peers/${PEER}`),
      envWithGate(root.privateKey, root.publicKeyB64, async () => Response.json(bundle)),
    );

    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body.length).toBe(CONSTANT_TIME_ERROR_BODY_LEN);
  });

  it("rejects (constant-time 404) when notme CA bundle is unreachable", async () => {
    _resetCache();
    const root = await makeRootKey();
    const route = new DisclosureRoute();

    const res = await route.handle(
      makeReq(`/interlace/peers/${PEER}`),
      envWithGate(root.privateKey, root.publicKeyB64, async () =>
        new Response("nope", { status: 503 }),
      ),
    );

    // Auth-fail collapses into the same 404 as "not_found" — the threat-
    // model §9.2 indistinguishability contract holds even when the cause
    // is bundle-unavailable rather than missing-headers.
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body.length).toBe(CONSTANT_TIME_ERROR_BODY_LEN);
  });

  it("rejects with malformed Signet cert (constant-time 404)", async () => {
    _resetCache();
    const root = await makeRootKey();
    const bundle = await signedBundle(root.privateKey, MASTER_PUBKEY);
    const route = new DisclosureRoute();

    const req = new Request(`http://x/interlace/peers/${PEER}`, {
      method: "GET",
      headers: {
        "authorization":  "Signet not_a_real_cert_just_bytes",
        "x-signet-sig":   "AAAA",
        "x-signet-ts":    String(Date.now()),
        "x-signet-nonce": "AAAA",
      },
    });

    const res = await route.handle(
      req,
      envWithGate(root.privateKey, root.publicKeyB64, async () => Response.json(bundle)),
    );

    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body.length).toBe(CONSTANT_TIME_ERROR_BODY_LEN);
  });

  it("indistinguishability: gate-on auth-fail body == gate-off not-found body", async () => {
    _resetCache();
    const root = await makeRootKey();
    const bundle = await signedBundle(root.privateKey, MASTER_PUBKEY);
    const route = new DisclosureRoute();

    // gate-on: no auth headers → constant-time 404
    const denied = await route.handle(
      makeReq(`/interlace/peers/${PEER}`),
      envWithGate(root.privateKey, root.publicKeyB64, async () => Response.json(bundle)),
    );

    // gate-off: unknown peer → constant-time 404
    const notFound = await route.handle(makeReq(`/interlace/peers/unknown`), makeEnv());

    const deniedBody = await denied.text();
    const notFoundBody = await notFound.text();
    expect(deniedBody).toBe(notFoundBody);
    expect(deniedBody.length).toBe(CONSTANT_TIME_ERROR_BODY_LEN);
  });
});
