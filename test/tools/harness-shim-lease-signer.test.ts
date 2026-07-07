/// <reference types="@cloudflare/vitest-pool-workers/types" />
//
// Unit test for the harness shim's lease signer (cloister-caab2d). Proves the
// signer in isolation — no DO, no verifier pipeline — by verifying its output
// with Web Crypto directly against the fixture's ephemeral pubkey. The full
// signer↔gate proof lives in test/routes/vault-proxy-lease-gate.test.ts.

import { describe, expect, it } from "vitest";
import { b64uEncode, signLeaseHeaders, type EphemeralIdentity } from "../../tools/harness-shim/lease-signer.js";
import { EPHEMERAL_PRIV_SEED_B64, EPHEMERAL_PUBKEY_B64, CERT_ADMIN_B64 } from "../wire/fixtures/cert-chain.js";

const IDENTITY: EphemeralIdentity = {
  certB64:     CERT_ADMIN_B64,
  privSeedB64: EPHEMERAL_PRIV_SEED_B64,
  pubKeyB64:   EPHEMERAL_PUBKEY_B64,
};

function b64uDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importVerifyKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    { kty: "OKP", crv: "Ed25519", x: EPHEMERAL_PUBKEY_B64 },
    { name: "Ed25519" },
    false,
    ["verify"],
  );
}

const URL_ = "https://cloister.test/vault/proxy/openai/v1/chat/completions";
const BODY = JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
const NONCE = new Uint8Array(16).fill(0x42);
const TS = 1_700_000_100_000;

describe("harness-shim lease-signer", () => {
  it("attaches all four Signet headers in the expected shape", async () => {
    const h = await signLeaseHeaders({ method: "POST", url: URL_, body: BODY, identity: IDENTITY, tsMs: TS, nonce: NONCE });
    expect(h.authorization).toBe(`Signet ${CERT_ADMIN_B64}`);
    expect(h["x-signet-ts"]).toBe(String(TS));
    expect(h["x-signet-nonce"]).toBe(b64uEncode(NONCE));
    expect(h["x-signet-sig"]).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("produces a signature that verifies over the canonical bytes", async () => {
    const h = await signLeaseHeaders({ method: "POST", url: URL_, body: BODY, identity: IDENTITY, tsMs: TS, nonce: NONCE });
    const canonical = new TextEncoder().encode(
      `POST\n${URL_}\n${TS}\n${b64uEncode(NONCE)}\n${BODY}`,
    );
    const ok = await crypto.subtle.verify(
      "Ed25519", await importVerifyKey(), b64uDecode(h["x-signet-sig"]) as BufferSource, canonical as BufferSource,
    );
    expect(ok).toBe(true);
  });

  it("signature does NOT verify if the body changes (binds the body)", async () => {
    const h = await signLeaseHeaders({ method: "POST", url: URL_, body: BODY, identity: IDENTITY, tsMs: TS, nonce: NONCE });
    const tamperedCanonical = new TextEncoder().encode(
      `POST\n${URL_}\n${TS}\n${b64uEncode(NONCE)}\n${BODY}TAMPERED`,
    );
    const ok = await crypto.subtle.verify(
      "Ed25519", await importVerifyKey(), b64uDecode(h["x-signet-sig"]) as BufferSource, tamperedCanonical as BufferSource,
    );
    expect(ok).toBe(false);
  });

  it("is deterministic for pinned ts + nonce", async () => {
    const a = await signLeaseHeaders({ method: "POST", url: URL_, body: BODY, identity: IDENTITY, tsMs: TS, nonce: NONCE });
    const b = await signLeaseHeaders({ method: "POST", url: URL_, body: BODY, identity: IDENTITY, tsMs: TS, nonce: NONCE });
    expect(a["x-signet-sig"]).toBe(b["x-signet-sig"]);
  });
});
