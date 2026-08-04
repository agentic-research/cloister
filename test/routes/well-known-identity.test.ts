/// <reference types="@cloudflare/vitest-pool-workers/types" />
//
// Tests for the multi-format identity discovery bridge (cloister-c9922f).
//
// Exercises all five concrete paths the `WellKnownIdentityBridgeRoute`
// handles plus an end-to-end JWT round-trip: cloister's `/oauth/token`
// produces a JWS compact form whose signature, when fed back through
// the JWK published at `/.well-known/jwks.json`, verifies under
// Web Crypto's Ed25519 primitive. That assertion proves the bridge is
// a working OIDC IdP from the consumer's point of view.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  PATH_OIDC_DISCOVERY,
  PATH_JWKS,
  PATH_WEBFINGER,
  PATH_NOSTR_NIP05,
  PATH_OAUTH_TOKEN,
  WellKnownIdentityBridgeRoute,
} from "../../src/routes/well-known-identity.js";
import type { Env } from "../../src/types.js";
import type { Gateway } from "../../src/manifest/types.js";

// ── Fixtures ──────────────────────────────────────────────────────────────

// Real Ed25519 keypair generated inside `beforeAll` per test that needs
// it — we use Web Crypto end-to-end so the JWKS publishes the exact
// bytes a verifier would consume.
const FINGERPRINT  = "sha256:c9922f-test-fingerprint";
const HOST         = "cloister.test";
const BASE_URL     = `https://${HOST}`;

function makeManifest(overrides: Partial<Gateway> = {}): Gateway {
  return {
    metadata: { name: "cloister-test", version: "0.0.0" },
    actor: {
      fingerprint:     FINGERPRINT,
      algorithm:       "ed25519",
      pubkeyBinding:   "INTERLACE_MASTER_PUBKEY",
      attestationRepo: "",
      tunnelEndpoint:  "",
    },
    policy: {
      maxCertLifetimeSeconds: 300,
      requireInterlock:       true,
      minAlgorithm:           "ed25519",
    },
    routes: [],
    ...overrides,
  };
}

type FetchResponder = (req: Request) => Promise<Response> | Response;

// 32-byte raw Ed25519 public key, base64-standard. The shape that
// notme's CABundle.keys uses (per cloister-c614ae).
const RAW_PUBKEY_B64_32 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

function envWith(
  extras: Record<string, string> = {},
  notme?: FetchResponder,
  jwtSigner?: Env["NOTME_JWT"],
): Env {
  return Object.assign({}, env, {
    INTERLACE_MASTER_PUBKEY: RAW_PUBKEY_B64_32,
    ...extras,
    ...(notme ? { NOTME: { fetch: notme } as unknown as Env["NOTME"] } : {}),
    ...(jwtSigner ? { NOTME_JWT: jwtSigner } : {}),
  }) as Env;
}

function makeReq(path: string, init: RequestInit = {}): Request {
  return new Request(`${BASE_URL}${path}`, init);
}

// ── match() — method + path discrimination ────────────────────────────────

describe("WellKnownIdentityBridgeRoute.match", () => {
  it("matches GET on each /.well-known/* identity path", () => {
    const route = new WellKnownIdentityBridgeRoute(makeManifest());
    expect(route.match(makeReq(PATH_OIDC_DISCOVERY))).toBe(true);
    expect(route.match(makeReq(PATH_JWKS))).toBe(true);
    expect(route.match(makeReq(PATH_WEBFINGER))).toBe(true);
    expect(route.match(makeReq(PATH_NOSTR_NIP05))).toBe(true);
  });

  it("matches POST on /oauth/token only (not GET)", () => {
    const route = new WellKnownIdentityBridgeRoute(makeManifest());
    expect(route.match(makeReq(PATH_OAUTH_TOKEN, { method: "POST" }))).toBe(true);
    expect(route.match(makeReq(PATH_OAUTH_TOKEN, { method: "GET" }))).toBe(false);
  });

  it("rejects POST on discovery paths (GET-only per RFC 8414 / 7033 / NIP-05)", () => {
    const route = new WellKnownIdentityBridgeRoute(makeManifest());
    expect(route.match(makeReq(PATH_OIDC_DISCOVERY, { method: "POST" }))).toBe(false);
    expect(route.match(makeReq(PATH_JWKS, { method: "POST" }))).toBe(false);
    expect(route.match(makeReq(PATH_WEBFINGER, { method: "POST" }))).toBe(false);
    expect(route.match(makeReq(PATH_NOSTR_NIP05, { method: "POST" }))).toBe(false);
  });

  it("does not match unrelated paths", () => {
    const route = new WellKnownIdentityBridgeRoute(makeManifest());
    expect(route.match(makeReq("/health"))).toBe(false);
    expect(route.match(makeReq("/.well-known/interlace/index.json"))).toBe(false);
    expect(route.match(makeReq("/mcp"))).toBe(false);
    expect(route.match(makeReq("/.well-known/openid-config"))).toBe(false);  // typo
    expect(route.match(makeReq("/oauth/authorize"))).toBe(false);
  });
});

// ── Identity disable lever ────────────────────────────────────────────────

describe("WellKnownIdentityBridgeRoute — disable", () => {
  it("returns 404 across all paths when actor.fingerprint is empty", async () => {
    const disabled = makeManifest({
      actor: {
        ...makeManifest().actor,
        fingerprint: "",
      },
    });
    const route = new WellKnownIdentityBridgeRoute(disabled);
    for (const p of [PATH_OIDC_DISCOVERY, PATH_JWKS, PATH_WEBFINGER, PATH_NOSTR_NIP05]) {
      const res = await route.handle(makeReq(p), envWith());
      expect(res.status).toBe(404);
    }
    const post = await route.handle(
      makeReq(PATH_OAUTH_TOKEN, { method: "POST", body: "grant_type=client_credentials",
        headers: { "content-type": "application/x-www-form-urlencoded" } }),
      envWith(),
    );
    expect(post.status).toBe(404);
  });
});

// ── /.well-known/openid-configuration ─────────────────────────────────────

describe("WellKnownIdentityBridgeRoute — OIDC discovery", () => {
  it("returns valid OIDC discovery JSON with spec-required fields", async () => {
    const route = new WellKnownIdentityBridgeRoute(makeManifest());
    const res = await route.handle(makeReq(PATH_OIDC_DISCOVERY), envWith());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    const body = await res.json() as Record<string, unknown>;
    // RFC 8414 / OIDC Discovery 1.0 — issuer + jwks_uri + token_endpoint
    // plus the alg/subject/response/grant arrays we declare support for.
    expect(body.issuer).toBe(BASE_URL);
    expect(body.jwks_uri).toBe(`${BASE_URL}${PATH_JWKS}`);
    expect(body.token_endpoint).toBe(`${BASE_URL}${PATH_OAUTH_TOKEN}`);
    expect(body.id_token_signing_alg_values_supported).toEqual(["EdDSA"]);
    expect(body.subject_types_supported).toEqual(["public"]);
    expect(body.response_types_supported).toEqual(["id_token"]);
    expect(body.grant_types_supported).toEqual(["client_credentials"]);
  });

  it("jwks_uri resolves to a real route (round-trip)", async () => {
    const route = new WellKnownIdentityBridgeRoute(makeManifest());
    const disc = await route.handle(makeReq(PATH_OIDC_DISCOVERY), envWith());
    const body = await disc.json() as { jwks_uri: string };
    // Use the published URI to re-enter the route.
    const url = new URL(body.jwks_uri);
    const jwks = await route.handle(new Request(body.jwks_uri, { method: "GET" }), envWith());
    expect(url.pathname).toBe(PATH_JWKS);
    expect(jwks.status).toBe(200);
  });
});

// ── /.well-known/jwks.json ────────────────────────────────────────────────

describe("WellKnownIdentityBridgeRoute — JWKS", () => {
  it("publishes the master pubkey in standard JWK format (OKP/Ed25519)", async () => {
    const route = new WellKnownIdentityBridgeRoute(makeManifest());
    const res = await route.handle(makeReq(PATH_JWKS), envWith());
    expect(res.status).toBe(200);
    const body = await res.json() as { keys: Array<Record<string, string>> };
    expect(Array.isArray(body.keys)).toBe(true);
    expect(body.keys.length).toBe(1);
    const jwk = body.keys[0]!;
    // RFC 8037 §2 — Ed25519 JWK MUST carry kty=OKP, crv=Ed25519, and
    // base64url-no-pad encoded `x`.
    expect(jwk.kty).toBe("OKP");
    expect(jwk.crv).toBe("Ed25519");
    expect(jwk.alg).toBe("EdDSA");
    expect(jwk.use).toBe("sig");
    expect(jwk.kid).toBe(FINGERPRINT);
    // No base64-standard chars allowed in base64url.
    expect(jwk.x).not.toMatch(/[+/=]/);
    expect(jwk.x.length).toBeGreaterThan(0);
  });

  it("an off-the-shelf JOSE consumer can use the JWK to verify a signature", async () => {
    // Generate a real Ed25519 keypair, export the public half as
    // base64-standard (the binding format), serve via the route's JWKS,
    // then verify a known signature using Web Crypto + the published JWK.
    const kp = await crypto.subtle.generateKey(
      { name: "Ed25519" } as unknown as AlgorithmIdentifier,
      true,
      ["sign", "verify"],
    ) as CryptoKeyPair;
    const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
    const pubB64Std = b64Encode(rawPub);

    const route = new WellKnownIdentityBridgeRoute(makeManifest());
    const res = await route.handle(
      makeReq(PATH_JWKS),
      envWith({ INTERLACE_MASTER_PUBKEY: pubB64Std }),
    );
    const body = await res.json() as { keys: Array<{ x: string; kty: string; crv: string }> };
    const jwk = body.keys[0]!;

    // Reconstruct the verifier key from the JWK's `x` (base64url) and
    // assert it round-trips through Web Crypto's `importKey("jwk", ...)`.
    const verifier = await crypto.subtle.importKey(
      "jwk",
      jwk as unknown as JsonWebKey,
      { name: "Ed25519" } as unknown as AlgorithmIdentifier,
      false,
      ["verify"],
    );
    const message = new TextEncoder().encode("hello-cloister");
    const sig = await crypto.subtle.sign("Ed25519", kp.privateKey, message);
    const ok = await crypto.subtle.verify("Ed25519", verifier, sig, message);
    expect(ok).toBe(true);
  });

  it("503s when the pubkey binding is unset", async () => {
    const route = new WellKnownIdentityBridgeRoute(makeManifest());
    // Empty string for the binding — readEnvString returns undefined.
    const res = await route.handle(
      makeReq(PATH_JWKS),
      envWith({ INTERLACE_MASTER_PUBKEY: "" }),
    );
    expect(res.status).toBe(503);
  });
});

// ── /.well-known/webfinger ────────────────────────────────────────────────

describe("WellKnownIdentityBridgeRoute — WebFinger", () => {
  it("returns spec-valid JRD with the required content-type", async () => {
    const route = new WellKnownIdentityBridgeRoute(makeManifest());
    const resource = `acct:cluster@${HOST}`;
    const res = await route.handle(
      makeReq(`${PATH_WEBFINGER}?resource=${encodeURIComponent(resource)}`),
      envWith(),
    );
    expect(res.status).toBe(200);
    // RFC 7033 §4.2 — Content-Type MUST be application/jrd+json.
    expect(res.headers.get("content-type")).toMatch(/^application\/jrd\+json/);
    const body = await res.json() as { subject: string; links: Array<Record<string, string>> };
    expect(body.subject).toBe(resource);
    // OIDC issuer relation present.
    const issuerLink = body.links.find((l) => l.rel === "http://openid.net/specs/connect/1.0/issuer");
    expect(issuerLink).toBeDefined();
    expect(issuerLink!.href).toBe(BASE_URL);
    // Self-link present, correct type.
    const self = body.links.find((l) => l.rel === "self");
    expect(self).toBeDefined();
    expect(self!.type).toBe("application/jrd+json");
  });

  it("emits wildcard CORS so browser federation clients can read it", async () => {
    const route = new WellKnownIdentityBridgeRoute(makeManifest());
    const resource = `acct:cluster@${HOST}`;
    const res = await route.handle(
      makeReq(`${PATH_WEBFINGER}?resource=${encodeURIComponent(resource)}`),
      envWith(),
    );
    // RFC 7033 §5 — server SHOULD make cross-origin access available.
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("returns 400 when resource is missing (RFC 7033 §4.2)", async () => {
    const route = new WellKnownIdentityBridgeRoute(makeManifest());
    const res = await route.handle(makeReq(PATH_WEBFINGER), envWith());
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown account", async () => {
    const route = new WellKnownIdentityBridgeRoute(makeManifest());
    const res = await route.handle(
      makeReq(`${PATH_WEBFINGER}?resource=acct:someone-else@${HOST}`),
      envWith(),
    );
    expect(res.status).toBe(404);
  });
});

// ── /.well-known/nostr.json (NIP-05) ──────────────────────────────────────

describe("WellKnownIdentityBridgeRoute — Nostr NIP-05", () => {
  it("publishes the cluster's pubkey as 64-char lowercase hex", async () => {
    const route = new WellKnownIdentityBridgeRoute(makeManifest());
    const res = await route.handle(
      makeReq(`${PATH_NOSTR_NIP05}?name=cluster`),
      envWith(),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { names: Record<string, string>; relays: Record<string, unknown> };
    const hex = body.names.cluster;
    expect(typeof hex).toBe("string");
    expect(hex).toMatch(/^[0-9a-f]+$/);  // lowercase hex
    expect(hex.length).toBe(64);          // 32 bytes
    expect(body.relays).toEqual({});
  });

  it("emits wildcard CORS so JS clients can fetch it (NIP-05 requirement)", async () => {
    const route = new WellKnownIdentityBridgeRoute(makeManifest());
    const res = await route.handle(
      makeReq(`${PATH_NOSTR_NIP05}?name=cluster`),
      envWith(),
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("returns empty names mapping for unknown name query (NIP-05 default)", async () => {
    const route = new WellKnownIdentityBridgeRoute(makeManifest());
    const res = await route.handle(
      makeReq(`${PATH_NOSTR_NIP05}?name=other`),
      envWith(),
    );
    const body = await res.json() as { names: Record<string, string> };
    expect(body.names).toEqual({});
  });

  it("returns the cluster mapping when no name is supplied", async () => {
    // NIP-05 servers MAY return the full mapping when no name is given;
    // we choose to surface only the canonical `cluster` entry.
    const route = new WellKnownIdentityBridgeRoute(makeManifest());
    const res = await route.handle(makeReq(PATH_NOSTR_NIP05), envWith());
    const body = await res.json() as { names: Record<string, string> };
    expect(Object.keys(body.names)).toEqual(["cluster"]);
  });
});

// ── /oauth/token ──────────────────────────────────────────────────────────

describe("WellKnownIdentityBridgeRoute — /oauth/token", () => {
  it("end-to-end: POST client_credentials → JWT → JWKS-verifiable signature", async () => {
    // Build a real keypair so the JWKS publishes a key whose private
    // half exists for the test. The stub for env.NOTME below signs
    // with that private key — mimicking notme's /internal/sign-jwt
    // contract end-to-end without needing the real notme worker.
    const kp = await crypto.subtle.generateKey(
      { name: "Ed25519" } as unknown as AlgorithmIdentifier,
      true,
      ["sign", "verify"],
    ) as CryptoKeyPair;
    const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
    const pubB64Std = b64Encode(rawPub);

    // Contract: the NOTME_JWT RPC entrypoint (notme ADR-015 / PR #62), NOT
    // `POST /internal/sign-jwt` — notme replaced that path with a 404 because
    // an `/internal/` prefix is publicly routable and so is not an access
    // control. The stub asserts the RPC shape, including that cloister passes
    // the two segments SEPARATELY rather than the joined signing input, and
    // returns raw signature BYTES rather than a base64url string.
    const jwtSigner: Env["NOTME_JWT"] = {
      async signJwt({ issuer, headerB64, payloadB64 }) {
        expect(issuer).toBe(BASE_URL);
        expect(headerB64).not.toContain(".");
        expect(payloadB64).not.toContain(".");
        const sig = await crypto.subtle.sign(
          "Ed25519",
          kp.privateKey,
          new TextEncoder().encode(`${headerB64}.${payloadB64}`),
        );
        return { ok: true, signature: new Uint8Array(sig), kid: "delegated-test" };
      },
      async issuerPublicKey() {
        return { ok: true, publicRawB64: pubB64Std, kid: "delegated-test" };
      },
    };

    const route = new WellKnownIdentityBridgeRoute(makeManifest());
    const tokenRes = await route.handle(
      makeReq(PATH_OAUTH_TOKEN, {
        method:  "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body:    "grant_type=client_credentials&scope=read%3A%2A&audience=https%3A%2F%2Frp.example",
      }),
      envWith({ INTERLACE_MASTER_PUBKEY: pubB64Std }, undefined, jwtSigner),
    );
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.headers.get("cache-control")).toBe("no-store");
    const token = await tokenRes.json() as {
      access_token: string;
      token_type:   string;
      expires_in:   number;
      scope?:       string;
    };
    expect(token.token_type).toBe("Bearer");
    expect(token.expires_in).toBe(300);
    expect(token.scope).toBe("read:*");

    // Decompose JWS compact form and verify the signature with the
    // JWK published at /.well-known/jwks.json (which is the same
    // pubkey we generated above — the round-trip is the assertion).
    const parts = token.access_token.split(".");
    expect(parts.length).toBe(3);
    const [hB64, pB64, sB64] = parts as [string, string, string];

    const jwksRes = await route.handle(
      makeReq(PATH_JWKS),
      envWith({ INTERLACE_MASTER_PUBKEY: pubB64Std }),
    );
    const { keys } = await jwksRes.json() as { keys: Array<JsonWebKey> };
    const verifier = await crypto.subtle.importKey(
      "jwk",
      keys[0]!,
      { name: "Ed25519" } as unknown as AlgorithmIdentifier,
      false,
      ["verify"],
    );
    const signingInput = new TextEncoder().encode(`${hB64}.${pB64}`);
    const sigBytes = b64UrlDecode(sB64);
    const ok = await crypto.subtle.verify("Ed25519", verifier, sigBytes, signingInput);
    expect(ok).toBe(true);

    // JWT claims sanity check.
    const payload = JSON.parse(new TextDecoder().decode(b64UrlDecode(pB64))) as Record<string, unknown>;
    expect(payload.iss).toBe(BASE_URL);
    expect(payload.aud).toBe("https://rp.example");
    expect(payload.sub).toBe(FINGERPRINT);
    expect(payload.scope).toBe("read:*");
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.exp).toBe("number");
    expect((payload.exp as number) - (payload.iat as number)).toBe(300);

    // JWT header sanity check.
    const header = JSON.parse(new TextDecoder().decode(b64UrlDecode(hB64))) as Record<string, unknown>;
    expect(header.alg).toBe("EdDSA");
    expect(header.typ).toBe("JWT");
    expect(header.kid).toBe(FINGERPRINT);
  });

  it("rejects non-form content-types with invalid_request", async () => {
    const route = new WellKnownIdentityBridgeRoute(makeManifest());
    const res = await route.handle(
      makeReq(PATH_OAUTH_TOKEN, {
        method:  "POST",
        headers: { "content-type": "application/json" },
        body:    '{"grant_type":"client_credentials"}',
      }),
      envWith(),
    );
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("invalid_request");
  });

  it("rejects unsupported grant types per RFC 6749 §5.2", async () => {
    const route = new WellKnownIdentityBridgeRoute(makeManifest());
    const res = await route.handle(
      makeReq(PATH_OAUTH_TOKEN, {
        method:  "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body:    "grant_type=password&username=x&password=y",
      }),
      envWith(),
    );
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("unsupported_grant_type");
  });

  it("returns 503 temporarily_unavailable when notme can't sign", async () => {
    const notme: FetchResponder = async () => new Response("nope", { status: 404 });
    const route = new WellKnownIdentityBridgeRoute(makeManifest());
    const res = await route.handle(
      makeReq(PATH_OAUTH_TOKEN, {
        method:  "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body:    "grant_type=client_credentials",
      }),
      envWith({}, notme),
    );
    expect(res.status).toBe(503);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("temporarily_unavailable");
  });
});

// ── base64 helpers (test-local) ───────────────────────────────────────────

function b64Encode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

function b64UrlEncode(bytes: Uint8Array): string {
  return b64Encode(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64UrlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/")
    + "===".slice((s.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
