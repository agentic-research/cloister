/// <reference types="@cloudflare/vitest-pool-workers/types" />
// MCP Registry OpenAPI surface tests (cloister-a30e40, ADR-0016, Phase 3
// of the MCP spec-alignment arc per ADR-0015).
//
// Exercises:
//   - URLPattern matching for /.well-known/mcp-registry/v0.1/{servers,
//     servers/<name>}
//   - List endpoint shape (servers[] + metadata.count + nextCursor=null)
//   - Detail endpoint round-trips the list entry exactly
//   - Unknown server names get a constant-time-shaped 404 (modelled on
//     the disclosure-endpoint pattern from threat-model §9.4)
//   - server.json required fields (name, description, version) on every
//     emitted entry
//   - Naming convention: `art.agentic-research/cloister/<backend-id>`
//   - Excluded backends: durableObject (BeadStore) is intra-cluster
//   - Spec divergence: path prefix is `/.well-known/mcp-registry/v0.1/`
//     not `/v0.1/` directly — recorded in ADR-0016

import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import {
  WellKnownMcpRegistryRoute,
  synthesizeAll,
  deriveCapabilities,
} from "../../src/routes/well-known-mcp-registry.js";
import type { Env } from "../../src/types.js";
import type { Gateway } from "../../src/manifest/types.js";

// ── Fixtures ──────────────────────────────────────────────────────────────

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
      {
        path: "/mcp",
        kind: {
          mcp: {
            backends: [
              // durableObject — intra-cluster; should NOT appear in registry
              {
                name:          "bead",
                handlesPrefix: "bead_",
                kind: {
                  durableObject: {
                    binding: "BEAD_STORE",
                    keyArg:  "repo",
                    tools: [
                      { name: "bead_create", description: "Create a bead", inputSchemaJson: "{}" },
                      { name: "bead_close",  description: "Close a bead",  inputSchemaJson: "{}" },
                    ],
                  },
                },
              },
              // httpForward — externally-shaped; should appear
              {
                name:          "lsp",
                handlesPrefix: "lsp_",
                kind: {
                  mcpProxy: {
                    urlBinding: "LLO_MCP_URL",
                    tools: [
                      { name: "lsp_hover", description: "Hover", inputSchemaJson: "{}" },
                    ],
                  },
                },
              },
              // httpForward + dynamic tools — should appear
              {
                name:          "mache",
                handlesPrefix: "mache_",
                kind: {
                  mcpProxy: {
                    urlBinding:      "MACHE_MCP_URL",
                    tools:           [],
                    dynamicTools:    true,
                    stripPrefix:     "mache_",
                    requiresSession: true,
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

function fakeEnv(): Env {
  return {} as unknown as Env;
}

const BASE_PATH = "/.well-known/mcp-registry/v0.1/servers";

// Server name convention encoded in the route — keep in lockstep with
// the SERVER_NAME_PREFIX constant in the implementation.
const NAME_PREFIX = "art.agentic-research/cloister/";

// ── match() ──────────────────────────────────────────────────────────────

describe("WellKnownMcpRegistryRoute.match", () => {
  const route = new WellKnownMcpRegistryRoute(makeManifest());

  it("matches GET /.well-known/mcp-registry/v0.1/servers", () => {
    expect(route.match(new Request(`http://x${BASE_PATH}`))).toBe(true);
  });

  it("matches GET /.well-known/mcp-registry/v0.1/servers/{name}", () => {
    expect(route.match(new Request(`http://x${BASE_PATH}/${NAME_PREFIX}mache`))).toBe(true);
  });

  it("rejects non-GET methods", () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"] as const) {
      const r = new Request(`http://x${BASE_PATH}`, { method });
      expect(route.match(r)).toBe(false);
    }
  });

  it("does not match unrelated paths", () => {
    expect(route.match(new Request("http://x/.well-known/openid-configuration"))).toBe(false);
    expect(route.match(new Request("http://x/.well-known/mcp-registry"))).toBe(false);
    expect(route.match(new Request("http://x/.well-known/mcp-registry/v0/servers"))).toBe(false);
    expect(route.match(new Request("http://x/mcp"))).toBe(false);
    expect(route.match(new Request("http://x/v2/_catalog"))).toBe(false);
  });
});

// ── synthesizeAll (catalog builder) ──────────────────────────────────────

describe("synthesizeAll", () => {
  it("emits one envelope per externally-shaped backend", () => {
    const out = synthesizeAll(makeManifest(), "http://cloister.example");
    // The fixture has 3 backends: bead (durableObject, excluded), lsp
    // (httpForward), mache (httpForward dynamic). 2 entries expected.
    expect(out.length).toBe(2);
  });

  it("excludes durableObject backends (intra-cluster)", () => {
    const out = synthesizeAll(makeManifest(), "http://cloister.example");
    for (const e of out) {
      expect(e.server.name).not.toContain("bead");
    }
  });

  it("uses the art.agentic-research/cloister/ namespace prefix", () => {
    const out = synthesizeAll(makeManifest(), "http://cloister.example");
    for (const e of out) {
      expect(e.server.name.startsWith(NAME_PREFIX)).toBe(true);
    }
  });

  it("each entry has the required server.json fields (name, description, version)", () => {
    const out = synthesizeAll(makeManifest(), "http://cloister.example");
    for (const e of out) {
      expect(typeof e.server.name).toBe("string");
      expect(e.server.name.length).toBeGreaterThan(0);
      expect(typeof e.server.description).toBe("string");
      expect(e.server.description.length).toBeGreaterThan(0);
      expect(e.server.description.length).toBeLessThanOrEqual(100);
      expect(typeof e.server.version).toBe("string");
      // Spec: semver, no ranges. Placeholder is "0.0.0".
      expect(e.server.version).toMatch(/^\d+\.\d+\.\d+/);
    }
  });

  it("emits a remotes block pointing at the cloister /mcp endpoint", () => {
    const out = synthesizeAll(makeManifest(), "http://cloister.example");
    for (const e of out) {
      expect(e.server.remotes).toBeDefined();
      expect(e.server.remotes!.length).toBeGreaterThan(0);
      const r = e.server.remotes![0]!;
      expect(r.type).toBe("streamable-http");
      expect(r.url).toBe("http://cloister.example/mcp");
    }
  });

  it("emits an _meta envelope under the spec's registry namespace key", () => {
    const out = synthesizeAll(makeManifest(), "http://cloister.example");
    const META_KEY = "io.modelcontextprotocol.registry/official";
    for (const e of out) {
      const meta = e._meta as Record<string, unknown>;
      expect(meta[META_KEY]).toBeDefined();
      const m = meta[META_KEY] as Record<string, unknown>;
      expect(typeof m.id).toBe("string");
      expect(typeof m.publishedAt).toBe("string");
      expect(typeof m.updatedAt).toBe("string");
      expect(m.isLatest).toBe(true);
      expect(m.status).toBe("active");
    }
  });

  it("emits empty catalog when manifest has no mcp routes", () => {
    const m = makeManifest({
      routes: [{ path: "/health", kind: { health: null } }],
    });
    const out = synthesizeAll(m, "http://cloister.example");
    expect(out).toEqual([]);
  });

  it("emits a $schema field pointing at the published server.json schema", () => {
    const out = synthesizeAll(makeManifest(), "http://cloister.example");
    for (const e of out) {
      expect(e.server.$schema).toBeDefined();
      expect(e.server.$schema!.startsWith("https://modelcontextprotocol.io/")).toBe(true);
      expect(e.server.$schema!.endsWith("server.schema.json")).toBe(true);
    }
  });
});

// ── GET /.well-known/mcp-registry/v0.1/servers ───────────────────────────

describe("WellKnownMcpRegistryRoute — list endpoint", () => {
  const route = new WellKnownMcpRegistryRoute(makeManifest());

  it("returns 200 + JSON content-type", async () => {
    const res = await route.handle(new Request(`http://x${BASE_PATH}`), fakeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
  });

  it("body has the OpenAPI-shaped `servers` + `metadata` envelope", async () => {
    const res = await route.handle(new Request(`http://x${BASE_PATH}`), fakeEnv());
    const body = await res.json() as {
      servers:  unknown[];
      metadata: { count: number; nextCursor: string | null };
    };
    expect(Array.isArray(body.servers)).toBe(true);
    expect(typeof body.metadata.count).toBe("number");
    expect(body.metadata.nextCursor).toBeNull();
  });

  it("metadata.count matches servers.length", async () => {
    const res = await route.handle(new Request(`http://x${BASE_PATH}`), fakeEnv());
    const body = await res.json() as {
      servers:  unknown[];
      metadata: { count: number };
    };
    expect(body.metadata.count).toBe(body.servers.length);
    // 2 externally-shaped backends in the fixture (lsp + mache).
    expect(body.metadata.count).toBe(2);
  });

  it("server count matches the number of external backends in the manifest", async () => {
    // Construct a manifest with 1 durableObject + 3 httpForwards. Only
    // the 3 httpForwards should be exposed.
    const m: Gateway = {
      ...makeManifest(),
      routes: [
        {
          path: "/mcp",
          kind: {
            mcp: {
              backends: [
                {
                  name:          "bead",
                  handlesPrefix: "bead_",
                  kind: { durableObject: { binding: "BEAD_STORE", keyArg: "repo", tools: [] } },
                },
                {
                  name:          "a",
                  handlesPrefix: "a_",
                  kind: { mcpProxy: { urlBinding: "A_URL", tools: [] } },
                },
                {
                  name:          "b",
                  handlesPrefix: "b_",
                  kind: { mcpProxy: { urlBinding: "B_URL", tools: [] } },
                },
                {
                  name:          "c",
                  handlesPrefix: "c_",
                  kind: { mcpProxy: { urlBinding: "C_URL", tools: [] } },
                },
              ],
            },
          },
        },
      ],
    };
    const r = new WellKnownMcpRegistryRoute(m);
    const res = await r.handle(new Request(`http://x${BASE_PATH}`), fakeEnv());
    const body = await res.json() as { metadata: { count: number } };
    expect(body.metadata.count).toBe(3);
  });

  it("emits a Cache-Control header for edge caching", async () => {
    const res = await route.handle(new Request(`http://x${BASE_PATH}`), fakeEnv());
    expect(res.headers.get("cache-control")).toMatch(/max-age=/);
  });
});

// ── GET /.well-known/mcp-registry/v0.1/servers/{name} ────────────────────

describe("WellKnownMcpRegistryRoute — detail endpoint", () => {
  const route = new WellKnownMcpRegistryRoute(makeManifest());

  it("returns the same entry as in the list for a known name", async () => {
    const listRes  = await route.handle(new Request(`http://x${BASE_PATH}`), fakeEnv());
    const listBody = await listRes.json() as {
      servers: { server: { name: string }; _meta: unknown }[];
    };
    expect(listBody.servers.length).toBeGreaterThan(0);
    const firstName = listBody.servers[0]!.server.name;
    expect(firstName.startsWith(NAME_PREFIX)).toBe(true);

    const detailRes = await route.handle(
      new Request(`http://x${BASE_PATH}/${firstName}`),
      fakeEnv(),
    );
    expect(detailRes.status).toBe(200);
    const detailBody = await detailRes.json() as { server: { name: string } };
    expect(detailBody.server.name).toBe(firstName);
    expect(detailBody).toEqual(listBody.servers[0]);
  });

  it("returns 404 for an unknown server name", async () => {
    const res = await route.handle(
      new Request(`http://x${BASE_PATH}/${NAME_PREFIX}does-not-exist`),
      fakeEnv(),
    );
    expect(res.status).toBe(404);
  });

  it("returns constant-shape 404 — body length is independent of the requested name", async () => {
    // Mirrors the disclosure-endpoint constant-time pattern from threat-
    // model §9.4. Two distinct unknown names should produce byte-equal
    // response bodies so probing for which names exist via response
    // size is defeated.
    const r1 = await route.handle(
      new Request(`http://x${BASE_PATH}/${NAME_PREFIX}foo`),
      fakeEnv(),
    );
    const r2 = await route.handle(
      new Request(`http://x${BASE_PATH}/${NAME_PREFIX}foobarbazquuxlong`),
      fakeEnv(),
    );
    const b1 = await r1.text();
    const b2 = await r2.text();
    expect(b1.length).toBe(b2.length);
    expect(b1).toBe(b2);
  });

  it("404 body is valid JSON with content-type application/json", async () => {
    const res = await route.handle(
      new Request(`http://x${BASE_PATH}/${NAME_PREFIX}does-not-exist`),
      fakeEnv(),
    );
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    // Should parse without throwing.
    const body = await res.json() as { error: string };
    expect(body.error).toBe("not_found");
  });

  it("returns 404 for a malformed percent-encoded name (constant-time-shaped)", async () => {
    // `%G0` is malformed — decodeURIComponent throws. The route should
    // collapse to the constant-time 404 path rather than 500.
    const res = await route.handle(
      new Request(`http://x${BASE_PATH}/${NAME_PREFIX}foo%G0bar`),
      fakeEnv(),
    );
    expect(res.status).toBe(404);
  });

  // ── Filtered-out backend kinds (cloister-ec7a52) ─────────────────────────
  //
  // The list endpoint excludes `durableObject` / `serviceBinding` /
  // `udsForward` backends — they're intra-cluster compute, not externally-
  // shaped MCP servers. The single-server lookup MUST apply the SAME
  // filter: a request for a filtered-out backend's name must return the
  // constant-time 404, NOT a 200 envelope with null fields (which would
  // both leak the intra-cluster name AND violate the spec's server.json
  // required-fields contract).

  it("returns 404 for a durableObject backend name (intra-cluster, filtered)", async () => {
    // `bead` is the canonical durableObject in the fixture — the regression
    // probe from cloister-ec7a52 used this exact name.
    const res = await route.handle(
      new Request(`http://x${BASE_PATH}/${NAME_PREFIX}bead`),
      fakeEnv(),
    );
    expect(res.status).toBe(404);
    // Critical: NOT 200-with-nulls. Confirm the body is the error
    // envelope, not a server.json with null fields.
    const body = await res.json() as { error?: string; server?: unknown };
    expect(body.error).toBe("not_found");
    expect(body.server).toBeUndefined();
  });

  it("filtered-backend 404 is byte-equal to unknown-name 404 (constant-time)", async () => {
    // Probing for "this name exists but is internal" via response body
    // or size must not work. Compare bead (real durableObject backend)
    // against an unknown name of similar shape.
    const r1 = await route.handle(
      new Request(`http://x${BASE_PATH}/${NAME_PREFIX}bead`),
      fakeEnv(),
    );
    const r2 = await route.handle(
      new Request(`http://x${BASE_PATH}/${NAME_PREFIX}does-not-exist`),
      fakeEnv(),
    );
    const b1 = await r1.text();
    const b2 = await r2.text();
    expect(r1.status).toBe(r2.status);
    expect(b1.length).toBe(b2.length);
    expect(b1).toBe(b2);
  });

  it("returns 404 for serviceBinding + udsForward backend names (intra-cluster, filtered)", async () => {
    // Construct a manifest where the only backends are intra-cluster
    // kinds. Every detail lookup against them must 404, never 200.
    const m: Gateway = {
      ...makeManifest(),
      routes: [
        {
          path: "/mcp",
          kind: {
            mcp: {
              backends: [
                {
                  name:          "notme",
                  handlesPrefix: "",
                  kind: {
                    serviceBinding: {
                      binding: "NOTME",
                      tools:   [],
                    },
                  },
                },
                {
                  name:          "uds-thing",
                  handlesPrefix: "",
                  kind: {
                    udsForward: {
                      socketPath: "/tmp/x.sock",
                      tools:      [],
                    },
                  },
                },
              ],
            },
          },
        },
      ],
    };
    const r = new WellKnownMcpRegistryRoute(m);
    for (const name of ["notme", "uds-thing"]) {
      const res = await r.handle(
        new Request(`http://x${BASE_PATH}/${NAME_PREFIX}${name}`),
        fakeEnv(),
      );
      expect(res.status).toBe(404);
      const body = await res.json() as { error?: string; server?: unknown };
      expect(body.error).toBe("not_found");
      expect(body.server).toBeUndefined();
    }
  });

  it("filter-included backends (lsp, leyline-lifecycle, mache) still return 200 with full server.json", async () => {
    // Lock the positive path: the fix must NOT regress the included
    // backend kinds. Use the realistic-shape fixture from the top of
    // this file (lsp + mache are httpForward) plus a leyline-net entry
    // to cover both included kinds.
    const m: Gateway = {
      ...makeManifest(),
      routes: [
        {
          path: "/mcp",
          kind: {
            mcp: {
              backends: [
                {
                  name:          "bead",  // filtered
                  handlesPrefix: "bead_",
                  kind: { durableObject: { binding: "BEAD_STORE", keyArg: "repo", tools: [] } },
                },
                {
                  name:          "lsp",   // httpForward — included
                  handlesPrefix: "lsp_",
                  kind: { mcpProxy: { urlBinding: "LLO_MCP_URL", tools: [] } },
                },
                {
                  name:          "leyline-lifecycle", // httpForward — included
                  handlesPrefix: "",
                  kind: { mcpProxy: { urlBinding: "LLO_MCP_URL", tools: [] } },
                },
                {
                  name:          "mache", // httpForward dynamic — included
                  handlesPrefix: "mache_",
                  kind: { mcpProxy: { urlBinding: "MACHE_MCP_URL", tools: [], dynamicTools: true } },
                },
              ],
            },
          },
        },
      ],
    };
    const r = new WellKnownMcpRegistryRoute(m);
    for (const included of ["lsp", "leyline-lifecycle", "mache"]) {
      const res = await r.handle(
        new Request(`http://x${BASE_PATH}/${NAME_PREFIX}${included}`),
        fakeEnv(),
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { server: { name: string; description: string; version: string } };
      expect(body.server.name).toBe(`${NAME_PREFIX}${included}`);
      expect(typeof body.server.description).toBe("string");
      expect(body.server.description.length).toBeGreaterThan(0);
      expect(body.server.version).toMatch(/^\d+\.\d+\.\d+/);
    }
  });

  it("detail entries carry $schema, name, description, version, remotes", async () => {
    const listRes  = await route.handle(new Request(`http://x${BASE_PATH}`), fakeEnv());
    const listBody = await listRes.json() as {
      servers: { server: { name: string } }[];
    };
    const someName = listBody.servers[0]!.server.name;
    const detailRes = await route.handle(
      new Request(`http://x${BASE_PATH}/${someName}`),
      fakeEnv(),
    );
    const detail = await detailRes.json() as {
      server: {
        $schema:     string;
        name:        string;
        description: string;
        version:     string;
        remotes:     { type: string; url: string }[];
      };
    };
    expect(detail.server.$schema).toBeDefined();
    expect(detail.server.name).toBe(someName);
    expect(detail.server.description.length).toBeGreaterThan(0);
    expect(detail.server.version).toBeDefined();
    expect(detail.server.remotes.length).toBeGreaterThan(0);
  });
});

// Suppress unused `env` import warning — kept for parity with other route tests.
void env;

// ── Capability advertisement (cloister-9c196b) ────────────────────────────
//
// `cloister/credential-isolation/v1` is implemented (ADR-0024) and declared as
// a vaultProxy route, and until this landed it was invisible to any external
// reader. The MCP Registry spec reserves `_meta` for registries to extend, so
// it rides the surface that already exists rather than a new well-known path.

describe("registry _meta advertises derived capabilities", () => {
  const gw = (routes: unknown[]) =>
    ({ metadata: { name: "t", version: "0" }, routes, actor: {}, policy: {} } as never);

  it("a declared vaultProxy route yields credential-isolation/v1", () => {
    const caps = deriveCapabilities(
      gw([{ path: "/vault/proxy", kind: { vaultProxy: { bundleIdName: "x" } } }]),
    );
    expect(caps).toEqual(["cloister/credential-isolation/v1"]);
  });

  it("no vaultProxy route yields nothing — the route IS the evidence", () => {
    // Derived, not declared: absent route means the capability is genuinely
    // absent, not merely unlisted.
    expect(deriveCapabilities(gw([{ path: "/health", kind: { health: null } }]))).toEqual([]);
  });

  it("duplicate routes do not duplicate the capability", () => {
    const caps = deriveCapabilities(
      gw([
        { path: "/vault/proxy", kind: { vaultProxy: { bundleIdName: "a" } } },
        { path: "/vault/proxy2", kind: { vaultProxy: { bundleIdName: "b" } } },
      ]),
    );
    expect(caps).toEqual(["cloister/credential-isolation/v1"]);
  });

  it("the SHIPPED manifest advertises credential-isolation", async () => {
    // Against the real generated manifest, so this cannot pass vacuously
    // against an invented gateway.
    // `manifest` IS the Gateway — there is no nested .gateway on the
    // generated value, unlike cluster.ts where gateway is a field.
    const { manifest } = await import("../../src/generated/manifest.js");
    expect(deriveCapabilities(manifest)).toContain(
      "cloister/credential-isolation/v1",
    );
  });

  it("an empty capability set OMITS the key rather than emitting []", () => {
    // Absence and emptiness are different claims: no key means "does not
    // advertise capabilities", `[]` means "advertises none".
    // Was vacuous: a fixture with only a health route yields ZERO envelopes,
    // so the loop asserted nothing. Needs an mcp route to produce an envelope
    // AND no vaultProxy route so the capability set is genuinely empty.
    const envelopes = synthesizeAll(
      gw([{
        path: "/mcp",
        kind: { mcp: { backends: [{
          name: "lsp", handlesPrefix: "lsp_",
          kind: { mcpProxy: { urlBinding: "LLO_MCP_URL", tools: [
            { name: "lsp_hover", description: "Hover", inputSchemaJson: "{}" },
          ] } },
        }] } },
      }]),
      "https://example.test",
    );
    expect(envelopes.length).toBeGreaterThan(0);
    for (const e of envelopes) {
      expect(e._meta).not.toHaveProperty("art.cloister/v1");
    }
  });
});

describe("the _meta namespace is declared, not hardcoded", () => {
  // Must include an mcp route with an externally-shaped backend: registry
  // envelopes are synthesized per proxied server, so a fixture without one
  // yields [] and every assertion over it passes vacuously.
  const mcpRoute = {
    path: "/mcp",
    kind: {
      mcp: {
        backends: [{
          name: "lsp",
          handlesPrefix: "lsp_",
          kind: {
            mcpProxy: {
              urlBinding: "LLO_MCP_URL",
              tools: [{ name: "lsp_hover", description: "Hover", inputSchemaJson: "{}" }],
            },
          },
        }],
      },
    },
  };
  const gwNs = (ns?: string) =>
    ({
      metadata: { name: "t", version: "0", ...(ns === undefined ? {} : { metaNamespace: ns }) },
      routes: [mcpRoute, { path: "/vault/proxy", kind: { vaultProxy: { bundleIdName: "x" } } }],
      actor: {},
      policy: {},
    } as never);

  it("uses the namespace the manifest declares", () => {
    const [e] = synthesizeAll(gwNs("art.example/v9"), "https://x.test");
    expect(e._meta).toHaveProperty("art.example/v9");
    expect(e._meta).not.toHaveProperty("art.cloister/v1");
  });

  it("falls back to the default when the manifest predates the field", () => {
    // Back-compat: a manifest with no metaNamespace must keep working rather
    // than emitting under an empty key.
    const [e] = synthesizeAll(gwNs(undefined), "https://x.test");
    expect(e._meta).toHaveProperty("art.cloister/v1");
  });

  it("the SHIPPED manifest declares its namespace", async () => {
    // The point of the field: an external reader can learn the key from the
    // manifest instead of hardcoding it, which is what a cross-repo graph
    // generator was doing.
    const { manifest } = await import("../../src/generated/manifest.js");
    expect(manifest.metadata.metaNamespace).toBe("art.cloister/v1");
  });
});
