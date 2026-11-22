/// <reference types="@cloudflare/vitest-pool-workers/types" />
//
// Tests for the identity discovery bridge (cloister-c9922f): WebFinger and
// NIP-05, the two formats the `WellKnownIdentityBridgeRoute` publishes the
// cluster's Interlace identity under. Cloister issues no tokens (ADR-0086), so
// the retired token endpoint and the issuer documents that described it are
// asserted absent.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  PATH_WEBFINGER,
  PATH_NOSTR_NIP05,
  WellKnownIdentityBridgeRoute,
} from "../../src/routes/well-known-identity.js";
import { instantiate } from "../../src/manifest/runtime.js";
import { Router } from "../../src/router.js";
import type { Env } from "../../src/types.js";
import type { Gateway } from "../../src/manifest/types.js";

// ── Fixtures ──────────────────────────────────────────────────────────────

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

// 32-byte raw Ed25519 public key, base64-standard. The shape that
// notme's CABundle.keys uses (per cloister-c614ae).
const RAW_PUBKEY_B64_32 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

function envWith(extras: Record<string, string> = {}): Env {
  return Object.assign({}, env, {
    INTERLACE_MASTER_PUBKEY: RAW_PUBKEY_B64_32,
    ...extras,
  }) as Env;
}

function makeReq(path: string, init: RequestInit = {}): Request {
  return new Request(`${BASE_URL}${path}`, init);
}

// The paths cloister served while it issued tokens (ADR-0086).
const RETIRED = [
  ["POST", "/oauth/token"],
  ["GET",  "/.well-known/openid-configuration"],
  ["GET",  "/.well-known/jwks.json"],
] as const;

// ── match() — method + path discrimination ────────────────────────────────

describe("WellKnownIdentityBridgeRoute.match", () => {
  it("matches GET on each identity path", () => {
    const route = new WellKnownIdentityBridgeRoute(makeManifest());
    expect(route.match(makeReq(PATH_WEBFINGER))).toBe(true);
    expect(route.match(makeReq(PATH_NOSTR_NIP05))).toBe(true);
  });

  it("rejects other methods (GET-only per RFC 7033 / NIP-05)", () => {
    const route = new WellKnownIdentityBridgeRoute(makeManifest());
    expect(route.match(makeReq(PATH_WEBFINGER, { method: "POST" }))).toBe(false);
    expect(route.match(makeReq(PATH_NOSTR_NIP05, { method: "POST" }))).toBe(false);
  });

  it("does not match unrelated paths", () => {
    const route = new WellKnownIdentityBridgeRoute(makeManifest());
    expect(route.match(makeReq("/health"))).toBe(false);
    expect(route.match(makeReq("/.well-known/interlace/index.json"))).toBe(false);
    expect(route.match(makeReq("/mcp"))).toBe(false);
    expect(route.match(makeReq("/oauth/authorize"))).toBe(false);
  });
});

// ── Cloister issues no tokens (ADR-0086) ─────────────────────────────────

describe("the token endpoint and issuer documents are retired", () => {
  it("the bridge matches none of them, on any method", () => {
    const route = new WellKnownIdentityBridgeRoute(makeManifest());
    for (const [, path] of RETIRED) {
      for (const method of ["GET", "POST"]) {
        expect(route.match(makeReq(path, { method })), `${method} ${path}`).toBe(false);
      }
    }
  });

  it("the gateway answers each with 404, whatever the request carries", async () => {
    const router = new Router(instantiate(makeManifest({
      routes: [{ path: "/.well-known/identity-bridge", kind: { wellKnownIdentityBridge: null } }],
    } as Partial<Gateway>)));
    for (const [method, path] of RETIRED) {
      const init: RequestInit = method === "POST"
        ? { method, body: "grant_type=client_credentials&scope=x&audience=y",
            headers: { "content-type": "application/x-www-form-urlencoded" } }
        : { method };
      const res = await router.handle(makeReq(path, init), envWith());
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  });
});

// ── Identity disable lever ────────────────────────────────────────────────

describe("WellKnownIdentityBridgeRoute — disable", () => {
  it("returns 404 on both paths when actor.fingerprint is empty", async () => {
    const disabled = makeManifest({
      actor: {
        ...makeManifest().actor,
        fingerprint: "",
      },
    });
    const route = new WellKnownIdentityBridgeRoute(disabled);
    for (const p of [PATH_WEBFINGER, PATH_NOSTR_NIP05]) {
      const res = await route.handle(makeReq(p), envWith());
      expect(res.status).toBe(404);
    }
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
    // No OIDC issuer relation: cloister issues no tokens (ADR-0086), so a
    // link telling a client to discover an issuer here would send it nowhere.
    expect(body.links.find((l) => l.rel === "http://openid.net/specs/connect/1.0/issuer")).toBeUndefined();
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
