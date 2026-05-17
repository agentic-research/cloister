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

    expect(body.version).toBe("0.2.0");
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

  // ── cloister-c13fa5: epoch index synthesis (RECEIPTS.md §2.3) ───────────

  it("bumps version to 0.2.0 (Interlace 0.2.0 receipts capability)", () => {
    const body = synthesize(makeManifest(), fakeEnv());
    expect(body.version).toBe("0.2.0");
  });

  it("emits empty epochs[] + null current_epoch when TrustStore is empty", () => {
    const body = synthesize(makeManifest(), fakeEnv(), []);
    expect(body.epochs).toEqual([]);
    expect(body.current_epoch).toBeNull();
  });

  it("projects a single active-only epoch from ActorCaBundleEntry", () => {
    const epochs = [{
      epoch:                   3,
      signing_key_pubkey_b64u: "pk-three-b64u",
      cert_der_b64u:           null,
      issued_at_ms:            1_700_000_000_000,
      retired_at_ms:           null,
      status:                  "active" as const,
      compromise_notice_b64u:  null,
      external_anchor_uri:     null,
    }];
    const body = synthesize(makeManifest(), fakeEnv(), epochs);
    expect(body.current_epoch).toBe(3);
    expect(body.epochs).toEqual([{
      epoch:               3,
      pubkey:              "pk-three-b64u",
      status:              "active",
      issued_at_ms:        1_700_000_000_000,
      retired_at_ms:       null,
      compromise_notice:   null,
    }]);
  });

  it("projects mixed retired + active epochs and identifies current_epoch by status='active'", () => {
    const epochs = [
      {
        epoch: 3, signing_key_pubkey_b64u: "pk-three", cert_der_b64u: null,
        issued_at_ms: 1_750_000_000_000, retired_at_ms: null,
        status: "active" as const, compromise_notice_b64u: null, external_anchor_uri: null,
      },
      {
        epoch: 2, signing_key_pubkey_b64u: "pk-two", cert_der_b64u: null,
        issued_at_ms: 1_700_000_000_000, retired_at_ms: 1_750_000_000_000,
        status: "retired" as const, compromise_notice_b64u: null, external_anchor_uri: null,
      },
      {
        epoch: 1, signing_key_pubkey_b64u: "pk-one", cert_der_b64u: null,
        issued_at_ms: 1_650_000_000_000, retired_at_ms: 1_700_000_000_000,
        status: "retired" as const, compromise_notice_b64u: null, external_anchor_uri: null,
      },
    ];
    const body = synthesize(makeManifest(), fakeEnv(), epochs);
    expect(body.current_epoch).toBe(3);
    expect(body.epochs.length).toBe(3);
    expect(body.epochs.map((e) => e.epoch)).toEqual([3, 2, 1]); // most-recent first
    expect(body.epochs[1].status).toBe("retired");
    expect(body.epochs[1].retired_at_ms).toBe(1_750_000_000_000);
  });

  it("emits compromise_notice (b64u opaque blob) when an epoch carries one (§2.7)", () => {
    const epochs = [{
      epoch: 2, signing_key_pubkey_b64u: "pk-two", cert_der_b64u: null,
      issued_at_ms: 1_700_000_000_000, retired_at_ms: 1_750_000_000_000,
      status: "retired" as const,
      compromise_notice_b64u: "signed-notice-b64u-blob",
      external_anchor_uri: null,
    }];
    const body = synthesize(makeManifest(), fakeEnv(), epochs);
    expect(body.epochs[0].compromise_notice).toBe("signed-notice-b64u-blob");
  });

  it("includes external_anchor_uri on epochs that have one (§2.3 lost-bundle defense)", () => {
    const epochs = [{
      epoch: 1, signing_key_pubkey_b64u: "pk-one", cert_der_b64u: null,
      issued_at_ms: 1_700_000_000_000, retired_at_ms: null,
      status: "active" as const, compromise_notice_b64u: null,
      external_anchor_uri: "https://anchors.example/cloister/epoch-1.json",
    }];
    const body = synthesize(makeManifest(), fakeEnv(), epochs);
    expect(body.epochs[0].external_anchor_uri).toBe("https://anchors.example/cloister/epoch-1.json");
  });

  it("omits external_anchor_uri on epochs that don't have one (no null key noise)", () => {
    const epochs = [{
      epoch: 1, signing_key_pubkey_b64u: "pk-one", cert_der_b64u: null,
      issued_at_ms: 1_700_000_000_000, retired_at_ms: null,
      status: "active" as const, compromise_notice_b64u: null, external_anchor_uri: null,
    }];
    const body = synthesize(makeManifest(), fakeEnv(), epochs);
    expect(body.epochs[0]).not.toHaveProperty("external_anchor_uri");
  });

  it("backwards-compat: 0.1.0 readers still see actor.fingerprint + actor.master_public_key + capabilities + policy", () => {
    const epochs = [{
      epoch: 1, signing_key_pubkey_b64u: "pk-one", cert_der_b64u: null,
      issued_at_ms: 1_700_000_000_000, retired_at_ms: null,
      status: "active" as const, compromise_notice_b64u: null, external_anchor_uri: null,
    }];
    const body = synthesize(makeManifest(), fakeEnv(), epochs);
    expect(body.actor.fingerprint).toBe("sha256:abc123");
    expect(body.actor.master_public_key).toBe(TEST_PUBKEY_B64);
    expect(body.capabilities.length).toBe(2);
    expect(body.policy.max_cert_lifetime_seconds).toBe(300);
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
    expect(body.version).toBe("0.2.0");
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

  it("emits a weak ETag whose three segments are fingerprint, capability count, and current_epoch", async () => {
    const route = new WellKnownInterlaceRoute(PATH, makeManifest());
    const res = await route.handle(new Request(`http://x${PATH}`), fakeEnv());
    const etag = res.headers.get("etag");
    // Structural assertion (not a literal string match) so future
    // additions to makeManifest() — e.g. a third backend tool — don't
    // silently break an unrelated test by shifting the cap count.
    // The three segments are: actor fingerprint, capability count,
    // current_epoch (numeric epoch, or "none" when null).
    expect(etag).toMatch(
      /^W\/"sha256:abc123-\d+-(none|\d+)"$/,
    );
  });

  it("ETag epoch segment is 'none' when no active epoch is registered", async () => {
    const route = new WellKnownInterlaceRoute(PATH, makeManifest());
    // No TrustStore binding in this test env → epochs: [] → current_epoch: null.
    const res = await route.handle(new Request(`http://x${PATH}`), fakeEnv());
    expect(res.headers.get("etag")).toMatch(/-none"$/);
  });
});
