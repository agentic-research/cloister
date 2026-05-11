/// <reference types="@cloudflare/vitest-pool-workers/types" />
//
// End-to-end smoke test for the production cross-DO bead_create
// orchestrator (cloister-492c08) + the disclosure endpoint.
//
// Wire-shape:
//   1. POST /mcp with a signed envelope, tools/call bead_create
//      → orchestrator runs (BlobStore.put → BeadStore.bead_create →
//        TrustStore.applyAttestation)
//   2. GET /interlace/peers/<actor_fp>
//      → JSONL stream of the peer's attestation chain
//   3. Assertions:
//      - chain contains a row whose content_hash matches the digest
//        the orchestrator returned (linking bead row ↔ attestation)
//      - hex-decoding the content_hash + fetching from BlobStore yields
//        the exact canonical bytes the orchestrator hashed (linking
//        digest ↔ canonical bytes)
//      - the bead row in BeadStore carries the same content_hash
//
// This is the "load-bearing in production at runtime" smoke test the
// threat model §13.4 calls for after cloister-492c08.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { McpEdgeRoute } from "../../src/routes/mcp.js";
import { DisclosureRoute } from "../../src/routes/disclosure.js";
import { signedMcpRequest } from "../helpers/signed-request.js";
import { _resetCache } from "../../src/storage/ca-bundle-cache.js";
import { bundleCanonical } from "../../src/storage/bundle-canonical.js";
import { MASTER_PUBKEY_B64_STD } from "../wire/fixtures/cert-chain.js";
import type { Env } from "../../src/types.js";

// The peer fingerprint embedded in the CERT_FULL_B64 fixture (per the
// fixture header comment: extension OID 1.3.6.1.4.1.99999.42.1.5 carries
// "sha256:abc123def456"). That's what the orchestrator pulls from the
// VerifiedLease and writes to the peer_attestations row.
const ACTOR_FP_FROM_CERT = "sha256:abc123def456";

const HMAC_KEY_B64 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

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

async function makeBundle(root: CryptoKey) {
  const base = {
    epoch:    7,
    seqno:    1,
    keys:     { active: MASTER_PUBKEY_B64_STD },
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

function envWith(over: Partial<Env>, notmeResponder?: (req: Request) => Promise<Response>): Env {
  return Object.assign({}, env, {
    NOTME: notmeResponder
      ? ({ fetch: notmeResponder } as unknown as Env["NOTME"])
      : env.NOTME,
    ...over,
  }) as Env;
}

// Decode a hex string into a Uint8Array.
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// Re-hash bytes the same way BlobStore does (sha256-hex).
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, "0")).join("");
}

describe("disclosure → attestation smoke (cloister-492c08)", () => {
  it("bead_create writes a chain row visible from GET /interlace/peers/<fp>; content_hash links BlobStore ↔ BeadStore ↔ disclosure", async () => {
    _resetCache();
    const root = await makeRootKey();
    const bundle = await makeBundle(root.privateKey);

    // ── Step 1: POST /mcp tools/call bead_create through the gate. ──
    const mcpRoute = new McpEdgeRoute([]);
    const { request: mcpReq } = await signedMcpRequest({
      method: "tools/call",
      params: { name: "bead_create", arguments: {
        repo:  "/repos/foo",
        title: "smoke-test-bead",
      } },
      tsMs: Date.now(),
    });
    const e = envWith(
      {
        INTERLACE_ROOT_PUBKEY:         root.publicKeyB64,
        INTERLACE_DISCLOSURE_HMAC_KEY: HMAC_KEY_B64,
      },
      async () => Response.json(bundle),
    );
    const mcpRes = await mcpRoute.handle(mcpReq, e);
    expect(mcpRes.status).toBe(200);
    const mcpBody = await mcpRes.json() as {
      result?: { content?: { type: string; text: string }[] };
      error?: { code: number; message: string };
    };
    expect(mcpBody.error).toBeUndefined();
    const orchestratorResult = JSON.parse(mcpBody.result!.content![0]!.text) as {
      id:           string;
      title:        string;
      state:        string;
      content_hash: string;
    };
    expect(orchestratorResult.title).toBe("smoke-test-bead");
    expect(orchestratorResult.state).toBe("open");
    expect(orchestratorResult.content_hash).toMatch(/^[0-9a-f]{64}$/);

    const expectedDigest = orchestratorResult.content_hash;
    const expectedBeadId = orchestratorResult.id;

    // ── Step 2: GET /interlace/peers/<actor_fp>. ──
    //
    // Disclosure auth-gate is OFF here (INTERLACE_ROOT_PUBKEY drives gate
    // on disclosure but the route also reads INTERLACE_ROOT_PUBKEY from
    // env — to keep the smoke test focused on the JSONL shape we leave
    // it OFF on the disclosure side. The auth-gate path is already
    // covered by `test/routes/disclosure.test.ts`.
    const disclosureRoute = new DisclosureRoute();
    const disclosureEnv = envWith({
      INTERLACE_DISCLOSURE_HMAC_KEY: HMAC_KEY_B64,
      // INTERLACE_ROOT_PUBKEY intentionally absent → gate off
    });
    const disclosureReq = new Request(
      `http://x/interlace/peers/${ACTOR_FP_FROM_CERT}`,
      { method: "GET" },
    );
    const disclosureRes = await disclosureRoute.handle(disclosureReq, disclosureEnv);
    expect(disclosureRes.status).toBe(200);

    const text = await disclosureRes.text();
    const lines = text.trim().split("\n").map(l => JSON.parse(l) as Record<string, unknown>);
    // First line is the HEADER record.
    expect(lines[0]!["type"]).toBe("header");
    expect(lines[0]!["peer_fingerprint"]).toBe(ACTOR_FP_FROM_CERT);

    // ── Step 3a: chain contains an attestation row referencing the digest. ──
    const attestations = lines
      .slice(1)
      .filter(l => l["type"] === "attestation") as Record<string, unknown>[];
    expect(attestations.length).toBeGreaterThanOrEqual(1);
    const ours = attestations.find(a => a["content_hash"] === expectedDigest);
    expect(ours, `disclosure chain should contain attestation for digest ${expectedDigest}`).toBeDefined();
    expect(ours!["content_type"]).toBe("bead/v1");
    expect(ours!["scope"]).toBe("bead_create:/repos/foo");

    // ── Step 3b: hex-decode the content_hash, fetch bytes from BlobStore,
    //            verify they re-hash to the same digest. ──
    const digestBytes = hexToBytes(expectedDigest);
    expect(digestBytes.length).toBe(32);  // sha256 = 32 bytes
    const blobStoreStub = env.BLOB_STORE.get(env.BLOB_STORE.idFromName("cluster")) as DurableObjectStub & {
      get(digest: string): Promise<Uint8Array | null>;
    };
    const canonicalBytes = await blobStoreStub.get(expectedDigest);
    expect(canonicalBytes, "BlobStore.get(digest) should return the canonical bytes").not.toBeNull();
    expect(canonicalBytes!.length).toBeGreaterThan(0);
    const rehashed = await sha256Hex(canonicalBytes!);
    expect(rehashed).toBe(expectedDigest);

    // The canonical bytes should be valid JSON (per bead-canonical's
    // JSON-without-whitespace encoding) — sanity-check the shape.
    const decoded = JSON.parse(new TextDecoder().decode(canonicalBytes!)) as Record<string, unknown>;
    expect(decoded["v"]).toBe(1);
    expect(decoded["type"]).toBe("bead");
    expect(decoded["title"]).toBe("smoke-test-bead");
    expect(decoded["repo"]).toBe("/repos/foo");
    expect(decoded["id"]).toBe(expectedBeadId);

    // ── Step 3c: the bead row in BeadStore carries the same content_hash. ──
    const beadStoreStub = env.BEAD_STORE.get(env.BEAD_STORE.idFromName("/repos/foo")) as DurableObjectStub & {
      fetch(req: Request): Promise<Response>;
    };
    const getReq = new Request("https://internal/", {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({
        jsonrpc: "2.0",
        method:  "bead_get",
        params:  { id: expectedBeadId },
        id:      1,
      }),
    });
    const getRes = await beadStoreStub.fetch(getReq);
    const getBody = await getRes.json() as {
      result?: { bead: { id: string; content_hash?: string; title: string } };
    };
    expect(getBody.result?.bead.id).toBe(expectedBeadId);
    expect(getBody.result?.bead.title).toBe("smoke-test-bead");
    expect(getBody.result?.bead.content_hash).toBe(expectedDigest);
  });
});
