// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Proof-only notme worker for local lease-gated /mcp smoke tests.
// It implements just the service-binding endpoint cloister needs:
// GET /internal/ca-bundle -> signed JSON CABundle.

import type { CABundle } from "../../../src/storage/ca-bundle-cache.js";
import { bundleCanonical } from "../../../src/storage/bundle-canonical.js";

const MASTER_PUBKEY_B64_STD = "ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ=";
const MASTER_PUBKEY_B64_URL = "ebVWLo_mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ";
const MASTER_PRIV_SEED_B64_URL = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA";

const BASE_BUNDLE: Omit<CABundle, "signature"> = {
  epoch: 7,
  seqno: 1,
  keys: { active: MASTER_PUBKEY_B64_STD },
  keyId: "active",
  issuedAt: 1_700_000_050,
};

let cachedBundle: Promise<CABundle> | null = null;

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "notme-ca-bundle-proof" });
    }
    if (request.method === "GET" && url.pathname === "/internal/ca-bundle") {
      cachedBundle ??= signedBundle();
      return Response.json(await cachedBundle);
    }
    return new Response("not found", { status: 404 });
  },
};

async function signedBundle(): Promise<CABundle> {
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "OKP",
      crv: "Ed25519",
      d: MASTER_PRIV_SEED_B64_URL,
      x: MASTER_PUBKEY_B64_URL,
    },
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const tmp: CABundle = { ...BASE_BUNDLE, signature: "" };
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      "Ed25519",
      privateKey,
      bundleCanonical(tmp) as BufferSource,
    ),
  );
  return { ...BASE_BUNDLE, signature: b64Std(sig) };
}

function b64Std(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

