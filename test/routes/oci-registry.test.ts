/// <reference types="@cloudflare/vitest-pool-workers/types" />
// Phase 1 OCI registry tests (cloister-cabd57). Covers the /v2/ pull
// path: handshake, catalog, tags/list, manifest + blob pull (both tag
// and digest reference shapes), HEAD verbs, and the OCI-spec error
// envelope. The headline assertion is the byte-equality round-trip
// between BlobStore.put and a registry pull — that's what `docker pull`
// will see when it asks the cluster for an image.

import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { OciRegistryRoute } from "../../src/routes/oci-registry.js";
import { type Digest } from "../../src/storage/types.js";

// ── Helpers ──────────────────────────────────────────────────────────────

interface BlobStoreRpc {
  put(bytes: Uint8Array): Promise<Digest>;
  get(digest: Digest): Promise<Uint8Array | null>;
  has(digest: Digest): Promise<boolean>;
}

interface TrustStoreRegistryRpc {
  upsertRegistryTag(
    repo: string, tag: string, manifestDigest: string, nowMs: number,
  ): Promise<void>;
  getRegistryManifestDigestForTag(repo: string, tag: string): Promise<string | null>;
  listRegistryTagsForRepo(repo: string): Promise<string[]>;
  listRegistryRepos(): Promise<string[]>;
  // ADR-0029 (cloister-7c0a0b): the OCI pull route consults this.
  // Tests that pre-populate BlobStore directly (bypassing the push
  // route) MUST also write membership, otherwise the new pull-gate
  // returns 404.
  hasRegistryMembership(
    repo: string, digest: string, kind: "blob" | "manifest",
  ): Promise<boolean>;
  recordRegistryMembership(
    repo: string, digest: string, kind: "blob" | "manifest",
    nowMs: number, peerFp?: string | null,
  ): Promise<void>;
}

function blobStoreStub() {
  return env.BLOB_STORE.get(env.BLOB_STORE.idFromName("cluster")) as
    DurableObjectStub & BlobStoreRpc;
}

function trustStoreStub() {
  return env.TRUST_STORE.get(env.TRUST_STORE.idFromName("cluster")) as
    DurableObjectStub & TrustStoreRegistryRpc;
}

function makeReq(path: string, method: "GET" | "HEAD" = "GET"): Request {
  return new Request(`http://x${path}`, { method });
}

// Reset registry_tags between tests so case ordering doesn't matter.
beforeEach(async () => {
  const trust = env.TRUST_STORE.get(env.TRUST_STORE.idFromName("cluster"));
  await runInDurableObject(trust, async (_, state) => {
    state.storage.sql.exec("DELETE FROM registry_tags");
  });
});

// ── match() ──────────────────────────────────────────────────────────────

describe("OciRegistryRoute.match", () => {
  const route = new OciRegistryRoute();

  it("matches GET /v2/", () => {
    expect(route.match(makeReq("/v2/"))).toBe(true);
  });

  it("matches GET /v2 (no trailing slash; older docker compat)", () => {
    expect(route.match(makeReq("/v2"))).toBe(true);
  });

  it("matches GET /v2/_catalog", () => {
    expect(route.match(makeReq("/v2/_catalog"))).toBe(true);
  });

  it("matches GET /v2/<name>/tags/list (single-segment name)", () => {
    expect(route.match(makeReq("/v2/notme/tags/list"))).toBe(true);
  });

  it("matches GET /v2/<name>/tags/list (multi-segment name)", () => {
    expect(route.match(makeReq("/v2/cloister/router/tags/list"))).toBe(true);
  });

  it("matches GET /v2/<name>/manifests/<reference> (tag)", () => {
    expect(route.match(makeReq("/v2/notme/manifests/0.1.0"))).toBe(true);
  });

  it("matches GET /v2/<name>/manifests/<reference> (digest)", () => {
    expect(route.match(makeReq("/v2/notme/manifests/sha256:" + "a".repeat(64)))).toBe(true);
  });

  it("matches GET /v2/<name>/blobs/<digest>", () => {
    expect(route.match(makeReq("/v2/notme/blobs/sha256:" + "a".repeat(64)))).toBe(true);
  });

  it("matches HEAD verbs for manifests + blobs", () => {
    expect(route.match(makeReq("/v2/notme/blobs/sha256:" + "a".repeat(64), "HEAD"))).toBe(true);
    expect(route.match(makeReq("/v2/notme/manifests/0.1.0", "HEAD"))).toBe(true);
  });

  it("rejects POST / PUT / PATCH / DELETE — Phase 1 read-only", () => {
    for (const m of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const r = new Request("http://x/v2/notme/blobs/sha256:" + "a".repeat(64), { method: m });
      expect(route.match(r)).toBe(false);
    }
  });

  it("does not match unrelated paths", () => {
    expect(route.match(makeReq("/health"))).toBe(false);
    expect(route.match(makeReq("/mcp"))).toBe(false);
    expect(route.match(makeReq("/interlace/peers/sha256:abc"))).toBe(false);
    expect(route.match(makeReq("/v3/foo"))).toBe(false);
  });
});

// ── /v2/ handshake ───────────────────────────────────────────────────────

describe("OciRegistryRoute — /v2/ handshake", () => {
  const route = new OciRegistryRoute();

  it("returns 200 + empty object body for /v2/", async () => {
    const res = await route.handle(makeReq("/v2/"), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("{}");
  });

  it("includes the Docker-Distribution-API-Version header", async () => {
    const res = await route.handle(makeReq("/v2/"), env);
    expect(res.headers.get("Docker-Distribution-API-Version")).toBe("registry/2.0");
  });

  it("/v2 (no slash) responds identically — older docker compat", async () => {
    const res = await route.handle(makeReq("/v2"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Docker-Distribution-API-Version")).toBe("registry/2.0");
  });
});

// ── /v2/_catalog ─────────────────────────────────────────────────────────

describe("OciRegistryRoute — /v2/_catalog", () => {
  const route = new OciRegistryRoute();

  it("returns empty repositories list when nothing imported", async () => {
    const res  = await route.handle(makeReq("/v2/_catalog"), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { repositories: string[] };
    expect(body.repositories).toEqual([]);
  });

  it("returns all repos with at least one tag, lex-ascending", async () => {
    const trust = trustStoreStub();
    const digest = "sha256:" + "a".repeat(64);
    await trust.upsertRegistryTag("notme",            "0.1.0",  digest, 1_000);
    await trust.upsertRegistryTag("cloister/router",  "latest", digest, 1_000);
    await trust.upsertRegistryTag("mache",            "0.2.3",  digest, 1_000);

    const res  = await route.handle(makeReq("/v2/_catalog"), env);
    const body = await res.json() as { repositories: string[] };
    expect(body.repositories).toEqual(["cloister/router", "mache", "notme"]);
  });
});

// ── /v2/<name>/tags/list ─────────────────────────────────────────────────

describe("OciRegistryRoute — tags/list", () => {
  const route = new OciRegistryRoute();

  it("404 NAME_UNKNOWN for a repo with no imported tags", async () => {
    const res = await route.handle(makeReq("/v2/unknown/tags/list"), env);
    expect(res.status).toBe(404);
    const body = await res.json() as { errors: { code: string; message: string }[] };
    expect(body.errors[0]!.code).toBe("NAME_UNKNOWN");
  });

  it("lists tags lex-ascending for a known repo", async () => {
    const trust = trustStoreStub();
    const digest = "sha256:" + "b".repeat(64);
    await trust.upsertRegistryTag("notme", "0.1.0",  digest, 1_000);
    await trust.upsertRegistryTag("notme", "latest", digest, 1_000);
    await trust.upsertRegistryTag("notme", "0.2.0",  digest, 2_000);

    const res = await route.handle(makeReq("/v2/notme/tags/list"), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { name: string; tags: string[] };
    expect(body.name).toBe("notme");
    expect(body.tags).toEqual(["0.1.0", "0.2.0", "latest"]);
  });

  it("supports multi-segment repo names", async () => {
    const trust = trustStoreStub();
    const digest = "sha256:" + "c".repeat(64);
    await trust.upsertRegistryTag("cloister/router", "0.1.0", digest, 1_000);

    const res = await route.handle(makeReq("/v2/cloister/router/tags/list"), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { name: string; tags: string[] };
    expect(body.name).toBe("cloister/router");
    expect(body.tags).toEqual(["0.1.0"]);
  });

  it("400 NAME_INVALID on uppercase repo names (spec violation)", async () => {
    const res = await route.handle(makeReq("/v2/UPPERCASE/tags/list"), env);
    expect(res.status).toBe(400);
    const body = await res.json() as { errors: { code: string }[] };
    expect(body.errors[0]!.code).toBe("NAME_INVALID");
  });
});

// ── Manifest pull ────────────────────────────────────────────────────────

describe("OciRegistryRoute — manifest pull", () => {
  const route = new OciRegistryRoute();

  it("404 MANIFEST_UNKNOWN for an unknown tag", async () => {
    const res = await route.handle(makeReq("/v2/notme/manifests/0.1.0"), env);
    expect(res.status).toBe(404);
    const body = await res.json() as { errors: { code: string }[] };
    expect(body.errors[0]!.code).toBe("MANIFEST_UNKNOWN");
  });

  it("returns manifest bytes byte-equal to BlobStore content (tag lookup)", async () => {
    const manifest = {
      schemaVersion: 2,
      mediaType:     "application/vnd.oci.image.manifest.v1+json",
      config:        { mediaType: "application/vnd.oci.image.config.v1+json",
                       digest: "sha256:" + "0".repeat(64), size: 0 },
      layers:        [],
    };
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));

    const blob   = blobStoreStub();
    const digest = await blob.put(manifestBytes);
    const trust  = trustStoreStub();
    await trust.upsertRegistryTag("notme", "0.1.0", "sha256:" + digest, 1_000);
    await trust.recordRegistryMembership("notme", digest, "manifest", 1_000);

    const res = await route.handle(makeReq("/v2/notme/manifests/0.1.0"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/vnd.oci.image.manifest.v1+json",
    );
    expect(res.headers.get("docker-content-digest")).toBe("sha256:" + digest);
    expect(res.headers.get("content-length")).toBe(String(manifestBytes.byteLength));

    const bodyBytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bodyBytes)).toEqual(Array.from(manifestBytes));
  });

  it("supports digest-direct manifest pull (bypasses tag index)", async () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json" }),
    );
    const blob   = blobStoreStub();
    const digest = await blob.put(bytes);
    const trust  = trustStoreStub();
    await trust.recordRegistryMembership("notme", digest, "manifest", 1_000);

    const res = await route.handle(
      makeReq(`/v2/notme/manifests/sha256:${digest}`),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/vnd.oci.image.index.v1+json",
    );
  });

  it("HEAD returns headers + empty body when manifest exists", async () => {
    const bytes  = new TextEncoder().encode(JSON.stringify({ schemaVersion: 2 }));
    const blob   = blobStoreStub();
    const digest = await blob.put(bytes);
    const trust  = trustStoreStub();
    await trust.upsertRegistryTag("notme", "latest", "sha256:" + digest, 1_000);
    await trust.recordRegistryMembership("notme", digest, "manifest", 1_000);

    const res = await route.handle(makeReq("/v2/notme/manifests/latest", "HEAD"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("docker-content-digest")).toBe("sha256:" + digest);
    const body = await res.text();
    expect(body).toBe("");
  });

  it("falls back to OCI v1 default media type when manifest is not JSON", async () => {
    const bytes  = new TextEncoder().encode("not-json-bytes");
    const blob   = blobStoreStub();
    const digest = await blob.put(bytes);
    const trust  = trustStoreStub();
    await trust.recordRegistryMembership("x", digest, "manifest", 1_000);

    const res = await route.handle(
      makeReq(`/v2/x/manifests/sha256:${digest}`),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/vnd.oci.image.manifest.v1+json",
    );
  });

  it("404 when the tag-index points at a digest absent from BlobStore", async () => {
    const trust = trustStoreStub();
    await trust.upsertRegistryTag(
      "notme", "0.9.9",
      "sha256:" + "f".repeat(64),
      1_000,
    );
    const res = await route.handle(makeReq("/v2/notme/manifests/0.9.9"), env);
    expect(res.status).toBe(404);
    const body = await res.json() as { errors: { code: string }[] };
    expect(body.errors[0]!.code).toBe("MANIFEST_UNKNOWN");
  });
});

// ── Blob pull ────────────────────────────────────────────────────────────

describe("OciRegistryRoute — blob pull", () => {
  const route = new OciRegistryRoute();

  it("404 BLOB_UNKNOWN for an unknown digest (with spec error shape)", async () => {
    const res = await route.handle(
      makeReq("/v2/notme/blobs/sha256:" + "0".repeat(64)),
      env,
    );
    expect(res.status).toBe(404);
    const body = await res.json() as { errors: { code: string; message: string }[] };
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]!.code).toBe("BLOB_UNKNOWN");
    expect(typeof body.errors[0]!.message).toBe("string");
  });

  it("byte-equality across BlobStore.put -> /v2/.../blobs/{digest}", async () => {
    // High-bit values included so we know we're not silently UTF-8-mangling.
    const payload = new Uint8Array(1024);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + 7) & 0xff;

    const blob   = blobStoreStub();
    const digest = await blob.put(payload);
    const trust  = trustStoreStub();
    await trust.recordRegistryMembership("cloister", digest, "blob", 1_000);

    const res = await route.handle(
      makeReq(`/v2/cloister/blobs/sha256:${digest}`),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-length")).toBe(String(payload.byteLength));
    expect(res.headers.get("docker-content-digest")).toBe("sha256:" + digest);

    const got = new Uint8Array(await res.arrayBuffer());
    expect(got.byteLength).toBe(payload.byteLength);
    for (let i = 0; i < payload.length; i++) {
      expect(got[i]).toBe(payload[i]);
    }
  });

  it("HEAD returns 200 + content headers when blob exists", async () => {
    const blob   = blobStoreStub();
    const digest = await blob.put(new TextEncoder().encode("head-blob"));
    const trust  = trustStoreStub();
    await trust.recordRegistryMembership("cloister", digest, "blob", 1_000);
    const res    = await route.handle(
      makeReq(`/v2/cloister/blobs/sha256:${digest}`, "HEAD"),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("docker-content-digest")).toBe("sha256:" + digest);
    expect(await res.text()).toBe("");
  });

  it("HEAD returns 404 BLOB_UNKNOWN when blob doesn't exist", async () => {
    const res = await route.handle(
      makeReq("/v2/cloister/blobs/sha256:" + "e".repeat(64), "HEAD"),
      env,
    );
    expect(res.status).toBe(404);
  });

  it("rejects non-sha256 digest prefixes (forward-compat: future algos return 404)", async () => {
    const res = await route.handle(
      makeReq("/v2/cloister/blobs/sha512:" + "a".repeat(128)),
      env,
    );
    expect(res.status).toBe(404);
    const body = await res.json() as { errors: { code: string }[] };
    expect(body.errors[0]!.code).toBe("BLOB_UNKNOWN");
  });

  it("rejects malformed digest (non-hex bytes after sha256:)", async () => {
    const res = await route.handle(
      makeReq("/v2/cloister/blobs/sha256:NOT_HEX"),
      env,
    );
    expect(res.status).toBe(404);
    const body = await res.json() as { errors: { code: string }[] };
    expect(body.errors[0]!.code).toBe("BLOB_UNKNOWN");
  });
});

// ── Spec-shape error envelope ────────────────────────────────────────────

describe("OciRegistryRoute — OCI-spec error envelope shape", () => {
  const route = new OciRegistryRoute();

  it("error body is {errors:[{code,message}]}", async () => {
    const res = await route.handle(
      makeReq("/v2/x/blobs/sha256:" + "0".repeat(64)),
      env,
    );
    const body = await res.json() as unknown;
    expect(typeof body).toBe("object");
    const shape = body as { errors?: unknown };
    expect(Array.isArray(shape.errors)).toBe(true);
    const errs = shape.errors as { code?: unknown; message?: unknown }[];
    expect(errs.length).toBeGreaterThan(0);
    expect(typeof errs[0]!.code).toBe("string");
    expect(typeof errs[0]!.message).toBe("string");
  });

  it("every error response carries the Docker-Distribution-API-Version header", async () => {
    const res = await route.handle(
      makeReq("/v2/x/blobs/sha256:" + "0".repeat(64)),
      env,
    );
    expect(res.headers.get("Docker-Distribution-API-Version")).toBe("registry/2.0");
  });
});
