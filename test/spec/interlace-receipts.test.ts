/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpEdgeRoute } from "../../src/routes/mcp.js";
import type { Env, McpTool } from "../../src/types.js";
import type { ToolBackend } from "../../src/backends.js";
import { MASTER_PUBKEY_B64_STD } from "../wire/fixtures/cert-chain.js";
import { signedMcpRequest } from "../helpers/signed-request.js";
import { _resetCache } from "../../src/storage/ca-bundle-cache.js";
import { bundleCanonical } from "../../src/storage/bundle-canonical.js";
import {
  INTERLACE_RECEIPT_HEADER,
  decodeReceiptHeader,
  encodeCommitment,
  encodeReceiptEnvelope,
  makeReceiptSignerFromKeypair,
  sha256,
  verifyEd25519,
} from "../../src/wire/receipts.js";
import { verifyReceiptPLive, verifyReceiptVArchival } from "../../src/wire/receipt-verify.js";

// Same RFC 8032 vec1 keypair as receipts.test.ts.
const SEED = new Uint8Array([
  0x9d, 0x61, 0xb1, 0x9d, 0xef, 0xfd, 0x5a, 0x60,
  0xba, 0x84, 0x4a, 0xf4, 0x92, 0xec, 0x2c, 0xc4,
  0x44, 0x49, 0xc5, 0x69, 0x7b, 0x32, 0x69, 0x19,
  0x70, 0x3b, 0xac, 0x03, 0x1c, 0xae, 0x7f, 0x60,
]);
const PUB = new Uint8Array([
  0xd7, 0x5a, 0x98, 0x01, 0x82, 0xb1, 0x0a, 0xb7,
  0xd5, 0x4b, 0xfe, 0xd3, 0xc9, 0x64, 0x07, 0x3a,
  0x0e, 0xe1, 0x72, 0xf3, 0xda, 0xa6, 0x23, 0x25,
  0xaf, 0x02, 0x1a, 0x68, 0xf7, 0x07, 0x51, 0x1a,
]);
const KEYPAIR = new Uint8Array(64);
KEYPAIR.set(SEED, 0);
KEYPAIR.set(PUB, 32);
const KEYPAIR_B64STD = btoa(String.fromCharCode(...KEYPAIR));

beforeEach(async () => {
  _resetCache();
  const stub = env.TRUST_STORE.get(env.TRUST_STORE.idFromName("cluster"));
  await runInDurableObject(stub, async (_inst, state) => {
    state.storage.sql.exec("DELETE FROM seen_nonces");
    state.storage.sql.exec("DELETE FROM peer_lease_counters");
  });
});

afterEach(() => {
  // Belt-and-braces: any test that calls vi.useFakeTimers() in this
  // file must not leak frozen time into the next test.
  vi.useRealTimers();
});

async function makeRootKey(): Promise<{ privateKey: CryptoKey; publicKeyB64: string }> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = (await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer;
  const bytes = new Uint8Array(raw);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return { privateKey: kp.privateKey, publicKeyB64: btoa(bin) };
}

async function makeBundleResponder(root: CryptoKey) {
  const base = {
    epoch: 7, seqno: 1,
    keys: { active: MASTER_PUBKEY_B64_STD },
    keyId: "active",
    issuedAt: 1_700_000_050,
  };
  const sig = new Uint8Array(
    (await crypto.subtle.sign("Ed25519", root, bundleCanonical({ ...base, signature: "" }) as BufferSource)) as ArrayBuffer,
  );
  let bin = "";
  for (let i = 0; i < sig.length; i++) bin += String.fromCharCode(sig[i]!);
  return { ...base, signature: btoa(bin) };
}

function envWith(over: Partial<Env>, notmeResponder?: (req: Request) => Promise<Response>): Env {
  return Object.assign({}, env, {
    NOTME: notmeResponder ? { fetch: notmeResponder } as unknown as Env["NOTME"] : env.NOTME,
    ...over,
  }) as Env;
}

const NOOP_BACKEND: ToolBackend = {
  handles: () => false,
  handlesPrefix: "",
  tools(): readonly McpTool[] { return []; },
  async invoke() { return {}; },
};

describe("integration: receipt emission on POST /mcp", () => {
  it("emits valid Interlace-Receipt on a 200 authenticated response", async () => {
    const { privateKey: rootKey, publicKeyB64 } = await makeRootKey();
    const bundle = await makeBundleResponder(rootKey);
    const responder = async (req: Request) => {
      if (new URL(req.url).pathname === "/internal/ca-bundle") {
        return new Response(JSON.stringify(bundle), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    };
    const testEnv = envWith({
      INTERLACE_ROOT_PUBKEY: publicKeyB64,
      RECEIPT_SIGNING_KEY:   KEYPAIR_B64STD,
      RECEIPT_EPOCH:         "1",
    }, responder);

    const route = new McpEdgeRoute([NOOP_BACKEND]);
    const { request, body, nowMs } = await signedMcpRequest({
      method: "tools/call",
      params: { name: "bead_create", arguments: { repo: "/repos/foo" } },
      url: "https://example.com/mcp",
      tsMs: Date.now(),
    });
    void nowMs;
    void body;
    const resp = await route.handle(request, testEnv);
    expect(resp.status).toBe(200);

    const headerValue = resp.headers.get(INTERLACE_RECEIPT_HEADER);
    expect(headerValue).not.toBeNull();
    const decoded = decodeReceiptHeader(headerValue!);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;

    // Signature must verify under the configured receipt-signing pubkey.
    const canon = encodeCommitment(decoded.value.commitment);
    expect(await verifyEd25519(PUB, decoded.value.signature, canon)).toBe(true);

    // Status committed must be 200.
    expect(decoded.value.commitment.status).toBe(200);
    // Epoch committed must match env binding.
    expect(decoded.value.commitment.epoch).toBe(1);
  });

  it("does NOT emit a receipt when RECEIPT_SIGNING_KEY is unset (Phase 1 mode)", async () => {
    const { privateKey: rootKey, publicKeyB64 } = await makeRootKey();
    const bundle = await makeBundleResponder(rootKey);
    const responder = async (req: Request) => {
      if (new URL(req.url).pathname === "/internal/ca-bundle") {
        return new Response(JSON.stringify(bundle), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    };
    const testEnv = envWith({
      INTERLACE_ROOT_PUBKEY: publicKeyB64,
      // RECEIPT_SIGNING_KEY intentionally unset.
    }, responder);

    const route = new McpEdgeRoute([NOOP_BACKEND]);
    const { request } = await signedMcpRequest({
      method: "tools/call",
      params: { name: "bead_create", arguments: { repo: "/repos/foo" } },
      url: "https://example.com/mcp",
      tsMs: Date.now(),
    });
    const resp = await route.handle(request, testEnv);
    expect(resp.status).toBe(200);
    expect(resp.headers.get(INTERLACE_RECEIPT_HEADER)).toBeNull();
  });

  it("does NOT emit a receipt on a 401 lease-rejection response", async () => {
    const { publicKeyB64 } = await makeRootKey();
    // NOTME returns nothing useful — but the route should still 401
    // because the cert won't be in the root key's chain.
    const responder = async () => new Response("err", { status: 500 });
    const testEnv = envWith({
      INTERLACE_ROOT_PUBKEY: publicKeyB64,
      RECEIPT_SIGNING_KEY:   KEYPAIR_B64STD,
    }, responder);

    const route = new McpEdgeRoute([NOOP_BACKEND]);
    const { request } = await signedMcpRequest({ method: "ping", url: "https://example.com/mcp", tsMs: Date.now() });
    const resp = await route.handle(request, testEnv);
    // Either a 401 or 503; both are <200 so no receipt.
    expect(resp.status).toBeGreaterThanOrEqual(400);
    expect(resp.headers.get(INTERLACE_RECEIPT_HEADER)).toBeNull();
  });

  it("full P-live verify against the emitted receipt", async () => {
    const { privateKey: rootKey, publicKeyB64 } = await makeRootKey();
    const bundle = await makeBundleResponder(rootKey);
    const responder = async (req: Request) => {
      if (new URL(req.url).pathname === "/internal/ca-bundle") {
        return new Response(JSON.stringify(bundle), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    };
    const testEnv = envWith({
      INTERLACE_ROOT_PUBKEY: publicKeyB64,
      RECEIPT_SIGNING_KEY:   KEYPAIR_B64STD,
      RECEIPT_EPOCH:         "1",
    }, responder);

    // Freeze the clock for the whole request/verify cycle. The route's
    // `lease.serverTs` (= Date.now() inside handlePost) is hashed into
    // request_canon; the test reconstructs request_canon from the
    // request's `x-signet-ts` header. Without a freeze, the two
    // Date.now() reads can fall in different milliseconds (~20% on dev
    // hardware), producing a request_hash mismatch and a flaky P-live
    // assertion. shouldAdvanceTime=false keeps both reads identical.
    vi.useFakeTimers({ shouldAdvanceTime: false, now: 1_700_000_000_000 });
    const route = new McpEdgeRoute([NOOP_BACKEND]);
    const nowMs = Date.now();
    const { request } = await signedMcpRequest({
      method: "tools/call",
      params: { name: "bead_create", arguments: { repo: "/repos/foo" } },
      url: "https://example.com/mcp",
      tsMs: nowMs,
    });

    // Need a copy of request bytes for verify — recreate the body + headers manually.
    const reqClone = request.clone();
    const reqBody = await reqClone.text();
    const ts = Number.parseInt(request.headers.get("x-signet-ts") ?? "0", 10);

    // Decode the nonce
    const nonceB64u = request.headers.get("x-signet-nonce")!;
    const padded = nonceB64u.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((nonceB64u.length + 3) % 4);
    const nonceBin = atob(padded);
    const nonce = new Uint8Array(nonceBin.length);
    for (let i = 0; i < nonceBin.length; i++) nonce[i] = nonceBin.charCodeAt(i);

    // Run the actual route to get the receipt.
    const resp = await route.handle(request, testEnv);
    expect(resp.status).toBe(200);
    const respClone = resp.clone();
    const respBody = new Uint8Array(await respClone.arrayBuffer());
    const headerValue = resp.headers.get(INTERLACE_RECEIPT_HEADER)!;

    // Derive expected actor_fp = SHA-256(pubkey).
    const actorFp = new Uint8Array(await crypto.subtle.digest("SHA-256", PUB as BufferSource));

    // Reconstruct request_canon the way the route did (POST + url + ts + nonce_b64 + body).
    const requestCanon = new TextEncoder().encode(
      `POST\n${request.url}\n${ts}\n${nonceB64u}\n${reqBody}`,
    );

    const v = await verifyReceiptPLive({
      headerValue,
      expectedActorFp: actorFp,
      currentEpoch:    1,
      resolvePubkey:   () => PUB,
      expectedNonce:   nonce,
      requestCanon,
      responseBody:    respBody,
      responseHeaders: resp.headers,
      nowMs,
    });
    vi.useRealTimers();
    // Include reason in the assertion so a future regression is debuggable
    // from the first failure rather than requiring a re-run with logging.
    expect(v.ok, v.ok ? undefined : `verify failed: ${v.reason}`).toBe(true);
  });

  it("V-archival audit: stored receipt re-verifies later against archived pubkey", async () => {
    const signer = await makeReceiptSignerFromKeypair(KEYPAIR);
    const requestCanon = new TextEncoder().encode("POST\n/mcp\n0\nn\n{}");
    const responseBody = new TextEncoder().encode(`{"ok":true}`);
    const responseHeaders = new Headers({ "content-type": "application/json" });
    const actorFp = new Uint8Array(await crypto.subtle.digest("SHA-256", PUB as BufferSource));

    const c = {
      nonce:        new Uint8Array(16).fill(0xab),
      requestHash:  await sha256(requestCanon),
      status:       200,
      bodyHash:     await sha256(responseBody),
      headersHash:  await sha256(new Uint8Array((await crypto.subtle.digest("SHA-256", new TextEncoder().encode("dummy") as BufferSource)))), // wrong; will fix
      timestampMs:  1700000000000,
      actorFp,
      epoch:        1,
    };
    // Use real headers_hash
    const { buildHeadersCommittedBytes } = await import("../../src/wire/receipts.js");
    c.headersHash = await sha256(buildHeadersCommittedBytes(responseHeaders));

    const { encodeCommitment, encodeReceiptEnvelope } = await import("../../src/wire/receipts.js");
    const canon = encodeCommitment(c);
    const sig = await signer.sign(canon);
    const envBytes = encodeReceiptEnvelope({ commitment: c, signature: sig });

    // V-archival verify against the SAME pubkey resolved from archive
    const v = await verifyReceiptVArchival({
      envelopeBytes: envBytes,
      requestCanon,
      responseBody,
      responseHeaders,
      archivalPubkey: PUB,
      expectedActorFp: actorFp,
    });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.trustedUnderCompromise).toBe(true);

    // V-archival against wrong pubkey → reject.
    const v2 = await verifyReceiptVArchival({
      envelopeBytes: envBytes,
      requestCanon,
      responseBody,
      responseHeaders,
      archivalPubkey: new Uint8Array(32).fill(0x12),
      expectedActorFp: actorFp,
    });
    expect(v2.ok).toBe(false);
  });
});

// Silence unused imports
void encodeReceiptEnvelope;
