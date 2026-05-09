/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect } from "vitest";
import { WellKnownInterlaceRoute, synthesize } from "../../src/routes/well-known.js";
import type { Env } from "../../src/types.js";
import type { Gateway } from "../../src/manifest/types.js";

// ── Fixtures ──────────────────────────────────────────────────────────────

const TEST_PUBKEY_B64 = "qrvM3e7/AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

function makeManifest(overrides: Partial<Gateway> = {}): Gateway {
  return {
    metadata: { name: "cloister-test", version: "0.0.0" },
    actor: {
      fingerprint:     "sha256:abc123",
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
    routes: [
      { path: "/health", kind: { health: null } },
      { path: "/.well-known/interlace/index.json", kind: { wellKnownInterlace: null } },
      {
        path: "/mcp",
        kind: {
          mcp: {
            backends: [
              {
                name:          "bead",
                handlesPrefix: "bead_",
                kind: {
                  durableObject: {
                    binding: "BEAD_STORE",
                    keyArg:  "repo",
                    tools: [
                      {
                        name:            "bead_create",
                        description:     "Create a bead",
                        inputSchemaJson: "{}",
                      },
                      {
                        name:            "bead_close",
                        description:     "Close a bead",
                        inputSchemaJson: "{}",
                      },
                    ],
                  },
                },
              },
            ],
          },
        },
      },
    ],
    ...overrides,
  };
}

function fakeEnv(extras: Record<string, string> = {}): Env {
  return { INTERLACE_MASTER_PUBKEY: TEST_PUBKEY_B64, ...extras } as unknown as Env;
}

// ── Body synthesis ────────────────────────────────────────────────────────

describe("WellKnownInterlaceRoute / synthesize", () => {
  it("emits Interlace §4.1 schema with version + actor + capabilities + policy", () => {
    const body = synthesize(makeManifest(), fakeEnv());

    expect(body.version).toBe("0.1.0");
    expect(body.actor.fingerprint).toBe("sha256:abc123");
    expect(body.actor.algorithm).toBe("ed25519");
    expect(body.actor.master_public_key).toBe(TEST_PUBKEY_B64);

    expect(body.policy.max_cert_lifetime_seconds).toBe(300);
    expect(body.policy.require_interlock).toBe(true);
    expect(body.policy.min_algorithm).toBe("ed25519");

    expect(Array.isArray(body.capabilities)).toBe(true);
  });

  it("aggregates capabilities from every mcp backend's tools", () => {
    const body = synthesize(makeManifest(), fakeEnv());
    const names = body.capabilities.map((c) => c.name);
    expect(names).toContain("bead_create");
    expect(names).toContain("bead_close");
    expect(body.capabilities.length).toBe(2);
  });

  it("each capability carries a scope string", () => {
    const body = synthesize(makeManifest(), fakeEnv());
    const create = body.capabilities.find((c) => c.name === "bead_create");
    expect(create?.scopes).toEqual(["bead_create:*"]);
  });

  it("excludes non-mcp routes from capabilities", () => {
    const body = synthesize(makeManifest(), fakeEnv());
    // /health and /.well-known/* are not mcp routes — must not produce capabilities.
    for (const cap of body.capabilities) {
      expect(cap.name.startsWith("bead_")).toBe(true);
    }
  });

  it("omits attestation_repo when empty", () => {
    const body = synthesize(makeManifest(), fakeEnv());
    expect(body.actor).not.toHaveProperty("attestation_repo");
  });

  it("includes attestation_repo when set", () => {
    const m = makeManifest();
    const body = synthesize(
      { ...m, actor: { ...m.actor, attestationRepo: "https://example.com/attest.git" } },
      fakeEnv(),
    );
    expect(body.actor.attestation_repo).toBe("https://example.com/attest.git");
  });

  it("omits tunnel block when endpoint empty", () => {
    const body = synthesize(makeManifest(), fakeEnv());
    expect(body.actor).not.toHaveProperty("tunnel");
  });

  it("includes tunnel block when endpoint set", () => {
    const m = makeManifest();
    const body = synthesize(
      { ...m, actor: { ...m.actor, tunnelEndpoint: "tunnel.example.com" } },
      fakeEnv(),
    );
    expect(body.actor.tunnel).toEqual({ endpoint: "tunnel.example.com" });
  });

  it("emits empty master_public_key when env binding is unset", () => {
    const body = synthesize(makeManifest(), {} as Env);
    expect(body.actor.master_public_key).toBe("");
  });
});

// ── Route handler ─────────────────────────────────────────────────────────

describe("WellKnownInterlaceRoute.handle", () => {
  const PATH = "/.well-known/interlace/index.json";

  it("matches GET on the configured path", () => {
    const route = new WellKnownInterlaceRoute(PATH, makeManifest());
    expect(route.match(new Request(`http://x${PATH}`))).toBe(true);
    expect(route.match(new Request(`http://x${PATH}`, { method: "POST" }))).toBe(false);
    expect(route.match(new Request(`http://x/other`))).toBe(false);
  });

  it("returns 200 + Interlace doc when actor.fingerprint is set", async () => {
    const route = new WellKnownInterlaceRoute(PATH, makeManifest());
    const res = await route.handle(new Request(`http://x${PATH}`), fakeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    const body = await res.json() as { version: string; actor: { fingerprint: string } };
    expect(body.version).toBe("0.1.0");
    expect(body.actor.fingerprint).toBe("sha256:abc123");
  });

  it("returns 404 when actor.fingerprint is empty (Interlace disabled)", async () => {
    const m = makeManifest();
    const disabled: Gateway = { ...m, actor: { ...m.actor, fingerprint: "" } };
    const route = new WellKnownInterlaceRoute(PATH, disabled);
    const res = await route.handle(new Request(`http://x${PATH}`), fakeEnv());
    expect(res.status).toBe(404);
  });

  it("emits a Cache-Control header for edge caching", async () => {
    const route = new WellKnownInterlaceRoute(PATH, makeManifest());
    const res = await route.handle(new Request(`http://x${PATH}`), fakeEnv());
    expect(res.headers.get("cache-control")).toMatch(/max-age=/);
  });

  it("emits a weak ETag derived from fingerprint + capability count", async () => {
    const route = new WellKnownInterlaceRoute(PATH, makeManifest());
    const res = await route.handle(new Request(`http://x${PATH}`), fakeEnv());
    expect(res.headers.get("etag")).toBe('W/"sha256:abc123-2"');
  });
});
