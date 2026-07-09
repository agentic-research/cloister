/// <reference types="@cloudflare/vitest-pool-workers/types" />
// Phase 2 OCI registry tests (cloister-3a3b0d). Covers the /v2/ PUSH
// path: blob uploads (monolithic + chunked), manifest PUT + tag update,
// digest verification, and the auth gate. The pull-side coverage in
// `oci-registry.test.ts` remains unchanged — these tests deliberately
// exercise round-trip flows that mix push and pull.

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

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function mkReq(
  path: string,
  method: "POST" | "PUT" | "PATCH" | "GET" | "HEAD",
  init: RequestInit = {},
): Request {
  return new Request(`http://x${path}`, { method, ...init });
}

// Each test resets the registry table so case ordering doesn't matter.
beforeEach(async () => {
  const trust = env.TRUST_STORE.get(env.TRUST_STORE.idFromName("cluster"));
  await runInDurableObject(trust, async (_, state) => {
    state.storage.sql.exec("DELETE FROM registry_tags");
  });
});

// ── match() — push verbs ─────────────────────────────────────────────────

describe("OciRegistryRoute.match — push verbs", () => {
  const route = new OciRegistryRoute();

  it("matches POST /v2/<name>/blobs/uploads/", () => {
    expect(route.match(mkReq("/v2/notme/blobs/uploads/", "POST"))).toBe(true);
  });

  it("matches PATCH /v2/<name>/blobs/uploads/<uuid>", () => {
    expect(route.match(mkReq("/v2/notme/blobs/uploads/abc-123", "PATCH"))).toBe(true);
  });

  it("matches PUT /v2/<name>/blobs/uploads/<uuid>", () => {
    expect(route.match(mkReq("/v2/notme/blobs/uploads/abc-123", "PUT"))).toBe(true);
  });

  it("matches PUT /v2/<name>/manifests/<reference>", () => {
    expect(route.match(mkReq("/v2/notme/manifests/0.1.0", "PUT"))).toBe(true);
  });

  it("matches push on multi-segment repo names", () => {
    expect(route.match(mkReq("/v2/cloister/router/blobs/uploads/", "POST"))).toBe(true);
    expect(route.match(mkReq("/v2/cloister/router/manifests/latest", "PUT"))).toBe(true);
  });

  it("does NOT match POST on non-upload paths", () => {
    expect(route.match(mkReq("/v2/notme/blobs/sha256:" + "a".repeat(64), "POST"))).toBe(false);
    expect(route.match(mkReq("/v2/notme/manifests/latest", "POST"))).toBe(false);
  });

  it("does NOT match DELETE (out of scope per bead)", () => {
    expect(route.match(mkReq("/v2/notme/blobs/uploads/abc-123", "DELETE" as "PUT"))).toBe(false);
  });
});

// ── Monolithic blob upload ───────────────────────────────────────────────

describe("OciRegistryRoute — monolithic blob upload", () => {
  const route = new OciRegistryRoute();

  it("POST .../uploads/?digest=... with body returns 201 + blob stored", async () => {
    const payload = new TextEncoder().encode("monolithic-payload-bytes");
    const digest  = await sha256Hex(payload);

    const res = await route.handle(
      mkReq(`/v2/notme/blobs/uploads/?digest=sha256:${digest}`, "POST", { body: payload }),
      env,
    );

    expect(res.status).toBe(201);
    expect(res.headers.get("location")).toBe(`/v2/notme/blobs/sha256:${digest}`);
    expect(res.headers.get("docker-content-digest")).toBe(`sha256:${digest}`);

    // Confirm blob is reachable via the BlobStore directly.
    const stored = await blobStoreStub().get(digest as Digest);
    expect(stored).not.toBeNull();
    expect(Array.from(stored!)).toEqual(Array.from(payload));

    // Pull-side round-trip: blob is now readable via the existing GET
    // handler.
    const pull = await route.handle(mkReq(`/v2/notme/blobs/sha256:${digest}`, "GET"), env);
    expect(pull.status).toBe(200);
    const pulledBytes = new Uint8Array(await pull.arrayBuffer());
    expect(Array.from(pulledBytes)).toEqual(Array.from(payload));
  });

  it("POST .../uploads/?digest=... with mismatched digest returns 400 DIGEST_INVALID", async () => {
    const payload = new TextEncoder().encode("real-bytes");
    const wrongDigest = "sha256:" + "0".repeat(64);

    const res = await route.handle(
      mkReq(`/v2/notme/blobs/uploads/?digest=${wrongDigest}`, "POST", { body: payload }),
      env,
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { errors: { code: string }[] };
    expect(body.errors[0]!.code).toBe("DIGEST_INVALID");
  });

  it("POST .../uploads/?digest=<malformed> returns 400 DIGEST_INVALID", async () => {
    const res = await route.handle(
      mkReq("/v2/notme/blobs/uploads/?digest=sha256:NOT_HEX", "POST", { body: new Uint8Array([1, 2, 3]) }),
      env,
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { errors: { code: string }[] };
    expect(body.errors[0]!.code).toBe("DIGEST_INVALID");
  });
});

// ── Chunked blob upload ──────────────────────────────────────────────────

describe("OciRegistryRoute — chunked blob upload", () => {
  const route = new OciRegistryRoute();

  it("POST -> PATCH -> PUT round-trip stores the concatenated blob", async () => {
    // 1. POST to open the session.
    const begin = await route.handle(
      mkReq("/v2/notme/blobs/uploads/", "POST"),
      env,
    );
    expect(begin.status).toBe(202);
    const loc = begin.headers.get("location") ?? "";
    expect(loc).toMatch(/^\/v2\/notme\/blobs\/uploads\/[0-9a-f-]+$/);
    expect(begin.headers.get("docker-upload-uuid")).toBeTruthy();
    expect(begin.headers.get("range")).toBe("0-0");

    // 2. PATCH two chunks.
    const chunk1 = new TextEncoder().encode("chunk-one-bytes-");
    const patch1 = await route.handle(mkReq(loc, "PATCH", { body: chunk1 }), env);
    expect(patch1.status).toBe(202);
    expect(patch1.headers.get("range")).toBe(`0-${chunk1.byteLength - 1}`);

    const chunk2 = new TextEncoder().encode("chunk-two-bytes");
    const patch2 = await route.handle(mkReq(loc, "PATCH", { body: chunk2 }), env);
    expect(patch2.status).toBe(202);
    const total = chunk1.byteLength + chunk2.byteLength;
    expect(patch2.headers.get("range")).toBe(`0-${total - 1}`);

    // 3. PUT to finalize. Hash the concatenated bytes; client passes the
    //    digest as a query param.
    const full = new Uint8Array(total);
    full.set(chunk1, 0);
    full.set(chunk2, chunk1.byteLength);
    const digest = await sha256Hex(full);
    const finalize = await route.handle(
      mkReq(`${loc}?digest=sha256:${digest}`, "PUT"),
      env,
    );
    expect(finalize.status).toBe(201);
    expect(finalize.headers.get("docker-content-digest")).toBe(`sha256:${digest}`);
    expect(finalize.headers.get("location")).toBe(`/v2/notme/blobs/sha256:${digest}`);

    // 4. Verify via the GET pull path — byte-identical.
    const pull = await route.handle(mkReq(`/v2/notme/blobs/sha256:${digest}`, "GET"), env);
    const back = new Uint8Array(await pull.arrayBuffer());
    expect(Array.from(back)).toEqual(Array.from(full));
  });

  it("PUT finalize with mismatched digest returns 400 DIGEST_INVALID + envelope", async () => {
    const begin = await route.handle(mkReq("/v2/notme/blobs/uploads/", "POST"), env);
    const loc = begin.headers.get("location") ?? "";
    const body = new TextEncoder().encode("the-true-bytes");
    await route.handle(mkReq(loc, "PATCH", { body }), env);

    const wrongDigest = "sha256:" + "f".repeat(64);
    const fin = await route.handle(mkReq(`${loc}?digest=${wrongDigest}`, "PUT"), env);
    expect(fin.status).toBe(400);
    const envBody = await fin.json() as { errors: { code: string; message: string }[] };
    expect(envBody.errors).toHaveLength(1);
    expect(envBody.errors[0]!.code).toBe("DIGEST_INVALID");
    expect(envBody.errors[0]!.message).toContain("digest mismatch");
  });

  it("PUT finalize without ?digest= returns 400 DIGEST_INVALID", async () => {
    const begin = await route.handle(mkReq("/v2/notme/blobs/uploads/", "POST"), env);
    const loc = begin.headers.get("location") ?? "";
    await route.handle(mkReq(loc, "PATCH", { body: new TextEncoder().encode("x") }), env);

    const fin = await route.handle(mkReq(loc, "PUT"), env);
    expect(fin.status).toBe(400);
    const body = await fin.json() as { errors: { code: string }[] };
    expect(body.errors[0]!.code).toBe("DIGEST_INVALID");
  });

  it("PATCH on unknown upload UUID returns 404 BLOB_UPLOAD_UNKNOWN", async () => {
    const res = await route.handle(
      mkReq("/v2/notme/blobs/uploads/does-not-exist-uuid", "PATCH", {
        body: new TextEncoder().encode("ignored"),
      }),
      env,
    );
    expect(res.status).toBe(404);
    const body = await res.json() as { errors: { code: string }[] };
    expect(body.errors[0]!.code).toBe("BLOB_UPLOAD_UNKNOWN");
  });

  it("session is scoped to its repo (different repo on PUT -> 404)", async () => {
    const begin = await route.handle(mkReq("/v2/notme/blobs/uploads/", "POST"), env);
    const loc = begin.headers.get("location") ?? "";  // /v2/notme/blobs/uploads/<uuid>
    const uuid = loc.split("/").pop()!;

    // Try to finalize against a different repo path with the same uuid.
    const res = await route.handle(
      mkReq(`/v2/other-repo/blobs/uploads/${uuid}?digest=sha256:${"0".repeat(64)}`, "PUT"),
      env,
    );
    expect(res.status).toBe(404);
    const body = await res.json() as { errors: { code: string }[] };
    expect(body.errors[0]!.code).toBe("BLOB_UPLOAD_UNKNOWN");
  });

  it("PUT may carry the final chunk (older docker push)", async () => {
    const begin = await route.handle(mkReq("/v2/notme/blobs/uploads/", "POST"), env);
    const loc = begin.headers.get("location") ?? "";

    const part1 = new TextEncoder().encode("first-half-");
    await route.handle(mkReq(loc, "PATCH", { body: part1 }), env);
    const part2 = new TextEncoder().encode("second-half");
    const full = new Uint8Array(part1.byteLength + part2.byteLength);
    full.set(part1, 0);
    full.set(part2, part1.byteLength);
    const digest = await sha256Hex(full);

    const fin = await route.handle(
      mkReq(`${loc}?digest=sha256:${digest}`, "PUT", { body: part2 }),
      env,
    );
    expect(fin.status).toBe(201);
    expect(fin.headers.get("docker-content-digest")).toBe(`sha256:${digest}`);

    const pull = await route.handle(mkReq(`/v2/notme/blobs/sha256:${digest}`, "GET"), env);
    const back = new Uint8Array(await pull.arrayBuffer());
    expect(Array.from(back)).toEqual(Array.from(full));
  });
});

// ── Manifest PUT ─────────────────────────────────────────────────────────

describe("OciRegistryRoute — manifest PUT", () => {
  const route = new OciRegistryRoute();

  it("stores the manifest + tag, then GET by tag returns the same bytes", async () => {
    const manifest = {
      schemaVersion: 2,
      mediaType:     "application/vnd.oci.image.manifest.v1+json",
      config:        { mediaType: "application/vnd.oci.image.config.v1+json",
                       digest: "sha256:" + "0".repeat(64), size: 0 },
      layers:        [],
    };
    const bytes  = new TextEncoder().encode(JSON.stringify(manifest));
    const digest = await sha256Hex(bytes);

    const put = await route.handle(
      mkReq("/v2/notme/manifests/0.1.0", "PUT", { body: bytes }),
      env,
    );
    expect(put.status).toBe(201);
    expect(put.headers.get("docker-content-digest")).toBe(`sha256:${digest}`);

    // Tag is in TrustStore.
    const tagDigest = await trustStoreStub().getRegistryManifestDigestForTag("notme", "0.1.0");
    expect(tagDigest).toBe(`sha256:${digest}`);

    // GET by tag -> identical bytes.
    const pull = await route.handle(mkReq("/v2/notme/manifests/0.1.0", "GET"), env);
    expect(pull.status).toBe(200);
    expect(pull.headers.get("docker-content-digest")).toBe(`sha256:${digest}`);
    const back = new Uint8Array(await pull.arrayBuffer());
    expect(Array.from(back)).toEqual(Array.from(bytes));
  });

  it("PUT by digest reference verifies + persists, but doesn't write a tag", async () => {
    const bytes  = new TextEncoder().encode("{\"schemaVersion\":2}");
    const digest = await sha256Hex(bytes);

    const put = await route.handle(
      mkReq(`/v2/notme/manifests/sha256:${digest}`, "PUT", { body: bytes }),
      env,
    );
    expect(put.status).toBe(201);

    // No tag written.
    const tags = await trustStoreStub().listRegistryTagsForRepo("notme");
    expect(tags).toEqual([]);

    // Manifest reachable by digest.
    const pull = await route.handle(mkReq(`/v2/notme/manifests/sha256:${digest}`, "GET"), env);
    expect(pull.status).toBe(200);
  });

  it("PUT by digest reference where digest disagrees with body -> 400 DIGEST_INVALID", async () => {
    const bytes = new TextEncoder().encode("{\"schemaVersion\":2}");
    const wrong = "sha256:" + "0".repeat(64);

    const put = await route.handle(
      mkReq(`/v2/notme/manifests/${wrong}`, "PUT", { body: bytes }),
      env,
    );
    expect(put.status).toBe(400);
    const body = await put.json() as { errors: { code: string }[] };
    expect(body.errors[0]!.code).toBe("DIGEST_INVALID");
  });

  it("PUT with Docker-Content-Digest header disagreeing with body -> 400 DIGEST_INVALID", async () => {
    const bytes = new TextEncoder().encode("{\"schemaVersion\":2}");
    const wrong = "sha256:" + "f".repeat(64);

    const put = await route.handle(
      new Request("http://x/v2/notme/manifests/0.1.0", {
        method: "PUT",
        headers: { "docker-content-digest": wrong },
        body: bytes,
      }),
      env,
    );
    expect(put.status).toBe(400);
    const body = await put.json() as { errors: { code: string }[] };
    expect(body.errors[0]!.code).toBe("DIGEST_INVALID");
  });

  it("empty manifest body -> 400 MANIFEST_INVALID", async () => {
    const put = await route.handle(
      mkReq("/v2/notme/manifests/latest", "PUT", { body: new Uint8Array(0) }),
      env,
    );
    expect(put.status).toBe(400);
    const body = await put.json() as { errors: { code: string }[] };
    expect(body.errors[0]!.code).toBe("MANIFEST_INVALID");
  });

  it("re-tagging an existing manifest overwrites in place", async () => {
    const bytesA = new TextEncoder().encode("{\"schemaVersion\":2,\"mediaType\":\"a\"}");
    const bytesB = new TextEncoder().encode("{\"schemaVersion\":2,\"mediaType\":\"b\"}");
    const digA = await sha256Hex(bytesA);
    const digB = await sha256Hex(bytesB);

    await route.handle(mkReq("/v2/notme/manifests/latest", "PUT", { body: bytesA }), env);
    await route.handle(mkReq("/v2/notme/manifests/latest", "PUT", { body: bytesB }), env);

    const cur = await trustStoreStub().getRegistryManifestDigestForTag("notme", "latest");
    expect(cur).toBe(`sha256:${digB}`);
    // Both manifests still readable by digest (BlobStore is idempotent +
    // additive). Pulled via /manifests/ since that's where they were
    // pushed — ADR-0029 per-repo membership is kind-scoped, so a
    // manifest PUT does not grant blob-kind membership on the same bytes
    // (and shouldn't — OCI's pull surface separates the two).
    const pullA = await route.handle(mkReq(`/v2/notme/manifests/sha256:${digA}`, "GET"), env);
    expect(pullA.status).toBe(200);
    const pullB = await route.handle(mkReq(`/v2/notme/manifests/sha256:${digB}`, "GET"), env);
    expect(pullB.status).toBe(200);
  });
});

// ── End-to-end: push then pull a complete image ───────────────────────────

describe("OciRegistryRoute — push-then-pull round-trip", () => {
  const route = new OciRegistryRoute();

  it("config blob + layer blob + manifest with tag round-trips byte-identical", async () => {
    // 1. Push a tiny config blob (monolithic upload).
    const config = new TextEncoder().encode("{\"architecture\":\"arm64\",\"os\":\"linux\"}");
    const configDigest = await sha256Hex(config);
    {
      const r = await route.handle(
        mkReq(`/v2/cloister/blobs/uploads/?digest=sha256:${configDigest}`, "POST", { body: config }),
        env,
      );
      expect(r.status).toBe(201);
    }

    // 2. Push a "layer" blob via chunked upload (two chunks).
    const layerA = new TextEncoder().encode("layer-data-chunk-A:");
    const layerB = new TextEncoder().encode("layer-data-chunk-B");
    const layer = new Uint8Array(layerA.byteLength + layerB.byteLength);
    layer.set(layerA, 0);
    layer.set(layerB, layerA.byteLength);
    const layerDigest = await sha256Hex(layer);

    const begin = await route.handle(mkReq("/v2/cloister/blobs/uploads/", "POST"), env);
    const loc = begin.headers.get("location") ?? "";
    await route.handle(mkReq(loc, "PATCH", { body: layerA }), env);
    await route.handle(mkReq(loc, "PATCH", { body: layerB }), env);
    const fin = await route.handle(mkReq(`${loc}?digest=sha256:${layerDigest}`, "PUT"), env);
    expect(fin.status).toBe(201);

    // 3. Compose the manifest pointing at both.
    const manifest = {
      schemaVersion: 2,
      mediaType:     "application/vnd.oci.image.manifest.v1+json",
      config:        {
        mediaType: "application/vnd.oci.image.config.v1+json",
        digest:    `sha256:${configDigest}`,
        size:      config.byteLength,
      },
      layers: [{
        mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
        digest:    `sha256:${layerDigest}`,
        size:      layer.byteLength,
      }],
    };
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
    const manifestDigest = await sha256Hex(manifestBytes);

    // 4. PUT the manifest under tag "0.1.0".
    const putM = await route.handle(
      mkReq("/v2/cloister/manifests/0.1.0", "PUT", { body: manifestBytes }),
      env,
    );
    expect(putM.status).toBe(201);
    expect(putM.headers.get("docker-content-digest")).toBe(`sha256:${manifestDigest}`);

    // 5. Pull-side: every blob + manifest is reachable.
    const pulledManifest = await route.handle(
      mkReq("/v2/cloister/manifests/0.1.0", "GET"),
      env,
    );
    expect(pulledManifest.status).toBe(200);
    const pmBytes = new Uint8Array(await pulledManifest.arrayBuffer());
    expect(Array.from(pmBytes)).toEqual(Array.from(manifestBytes));

    const pulledConfig = await route.handle(
      mkReq(`/v2/cloister/blobs/sha256:${configDigest}`, "GET"),
      env,
    );
    expect(pulledConfig.status).toBe(200);
    expect(Array.from(new Uint8Array(await pulledConfig.arrayBuffer())))
      .toEqual(Array.from(config));

    const pulledLayer = await route.handle(
      mkReq(`/v2/cloister/blobs/sha256:${layerDigest}`, "GET"),
      env,
    );
    expect(pulledLayer.status).toBe(200);
    expect(Array.from(new Uint8Array(await pulledLayer.arrayBuffer())))
      .toEqual(Array.from(layer));

    // 6. tags/list now sees the tag.
    const tagsList = await route.handle(mkReq("/v2/cloister/tags/list", "GET"), env);
    expect(tagsList.status).toBe(200);
    const tagsBody = await tagsList.json() as { name: string; tags: string[] };
    expect(tagsBody.tags).toEqual(["0.1.0"]);
  });
});

// ── Auth gate ────────────────────────────────────────────────────────────
//
// When INTERLACE_ROOT_PUBKEY is set, writes must carry a valid Signet
// envelope. The pull path stays anonymous regardless. We don't test the
// full crypto plumbing (covered in `lease-middleware.test.ts` /
// `disclosure.test.ts`); these tests verify the GATE FIRES — every
// auth-deficient write 401s with the DENIED envelope.

const MASTER_PUBKEY = "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=";

function envWithGate(notmeResponder: (req: Request) => Promise<Response>): typeof env {
  return Object.assign({}, env, {
    INTERLACE_ROOT_PUBKEY: MASTER_PUBKEY,
    NOTME: { fetch: notmeResponder } as unknown as typeof env.NOTME,
  }) as typeof env;
}

describe("OciRegistryRoute — auth gate (INTERLACE_ROOT_PUBKEY set)", () => {
  const route = new OciRegistryRoute();

  it("POST upload without auth headers -> 401 DENIED", async () => {
    const e = envWithGate(async () => new Response("no bundle", { status: 503 }));
    const res = await route.handle(mkReq("/v2/notme/blobs/uploads/", "POST"), e);
    expect(res.status).toBe(401);
    const body = await res.json() as { errors: { code: string }[] };
    expect(body.errors[0]!.code).toBe("DENIED");
  });

  it("PATCH chunk without auth headers -> 401 DENIED", async () => {
    const e = envWithGate(async () => new Response("no bundle", { status: 503 }));
    const res = await route.handle(
      mkReq("/v2/notme/blobs/uploads/any-uuid", "PATCH", { body: new Uint8Array([1]) }),
      e,
    );
    expect(res.status).toBe(401);
  });

  it("PUT manifest without auth headers -> 401 DENIED", async () => {
    const e = envWithGate(async () => new Response("no bundle", { status: 503 }));
    const res = await route.handle(
      mkReq("/v2/notme/manifests/0.1.0", "PUT", {
        body: new TextEncoder().encode("{\"schemaVersion\":2}"),
      }),
      e,
    );
    expect(res.status).toBe(401);
    const body = await res.json() as { errors: { code: string }[] };
    expect(body.errors[0]!.code).toBe("DENIED");
  });

  it("GET pull paths stay anonymous even with the gate on", async () => {
    const e = envWithGate(async () => new Response("no bundle", { status: 503 }));
    // /v2/ handshake is always anonymous.
    const v2 = await route.handle(mkReq("/v2/", "GET"), e);
    expect(v2.status).toBe(200);
    // Blob pull is also anonymous (Phase 1 read posture preserved).
    const blob = await route.handle(
      mkReq("/v2/notme/blobs/sha256:" + "a".repeat(64), "GET"),
      e,
    );
    // 404 BLOB_UNKNOWN (not 401) — the gate didn't engage on the pull.
    expect(blob.status).toBe(404);
    const body = await blob.json() as { errors: { code: string }[] };
    expect(body.errors[0]!.code).toBe("BLOB_UNKNOWN");
  });
});

// ── build-cache/v1 push surface (cloister-4d376e) ──────────────────────
//
// Tests cloister's `/v2/` as a build-cache/v1 provider. The build-cache/v1
// wire spec (leyline-schema-spec/build-cache/v1/README.md §"Digest encoding")
// reuses the `sha256:` prefix but the bytes inside are BLAKE3. This
// contradicts cloister's existing DIGEST_INVALID verification, which
// computes real SHA-256. These tests surface that gap.

import { blake3Hex } from "../../src/wire/cas-hash.js";

describe("OciRegistryRoute — build-cache/v1 push (RED — exposes spec/reality gap)", () => {
  const route = new OciRegistryRoute();

  it("POST /v2/<scope>/blobs/uploads/?digest=sha256:<blake3-hex> with body whose BLAKE3 matches", async () => {
    const payload = new TextEncoder().encode(
      "build-cache/v1 chunk content — would hash to BLAKE3, not SHA-256",
    );
    const wireDigest = "sha256:" + blake3Hex(payload);

    // Per the spec, this SHOULD be accepted (digest claim is the BLAKE3
    // hex with sha256: prefix; cloister-as-provider needs to honor it).
    // Today this returns 400 DIGEST_INVALID because cloister verifies
    // with real SHA-256.
    const res = await route.handle(
      mkReq(`/v2/mache/test-repo/abc123/blobs/uploads/?digest=${wireDigest}`, "POST", {
        body: payload,
      }),
      env,
    );

    expect(res.status).toBe(201);
    expect(res.headers.get("docker-content-digest")).toBe(wireDigest);
  });
});

// ── Body-size cap (cloister: post-conformance hardening) ──────────────────
//
// PR #84's conformance harness proved the wire correctness. This describe
// block covers the substrate-hardening surface — push paths MUST enforce
// an upper bound on body bytes to defend against memory-exhaustion attacks
// against the shared isolate. See cloister-667ea6 adversarial review
// (dos-resilience-auditor) for the threat model.

describe("OciRegistryRoute — body-size cap (push paths)", () => {
  const CAP = 1024; // 1KiB — small enough to test without ballooning memory.

  it("monolithic POST with body > cap returns 413 PAYLOAD_TOO_LARGE", async () => {
    const route   = new OciRegistryRoute({ maxBlobBytes: CAP });
    const payload = new Uint8Array(CAP + 1); // 1 byte over
    payload.fill(0x61); // ASCII 'a'
    const digest  = await sha256Hex(payload);

    const res = await route.handle(
      mkReq(`/v2/notme/blobs/uploads/?digest=sha256:${digest}`, "POST", { body: payload }),
      env,
    );

    expect(res.status).toBe(413);
    const body = await res.json() as { errors: { code: string; message: string }[] };
    expect(body.errors[0].code).toBe("SIZE_INVALID");
    expect(body.errors[0].message).toContain(String(CAP));
  });

  it("monolithic POST with Content-Length header > cap returns 413 (without buffering)", async () => {
    const route = new OciRegistryRoute({ maxBlobBytes: CAP });
    // Small actual body but Content-Length claims big — the cheap check
    // rejects on the header alone without paying arrayBuffer().
    const tiny = new Uint8Array(10);
    const digest = await sha256Hex(tiny);

    const res = await route.handle(
      new Request(`http://x/v2/notme/blobs/uploads/?digest=sha256:${digest}`, {
        method: "POST",
        body: tiny,
        headers: { "content-length": String(CAP + 1) },
      }),
      env,
    );

    expect(res.status).toBe(413);
    const body = await res.json() as { errors: { code: string; message: string }[] };
    expect(body.errors[0].code).toBe("SIZE_INVALID");
  });

  it("chunked upload PATCH accumulating > cap returns 413", async () => {
    const route = new OciRegistryRoute({ maxBlobBytes: CAP });

    // Begin a chunked upload.
    const begin = await route.handle(mkReq("/v2/notme/blobs/uploads/", "POST"), env);
    expect(begin.status).toBe(202);
    const loc = begin.headers.get("location")!;

    // First PATCH fits.
    const half1 = new Uint8Array(CAP / 2);
    half1.fill(0x62);
    const p1 = await route.handle(mkReq(loc, "PATCH", { body: half1 }), env);
    expect(p1.status).toBe(202);

    // Second PATCH would push cumulative over cap.
    const half2over = new Uint8Array(CAP / 2 + 1);
    half2over.fill(0x63);
    const p2 = await route.handle(mkReq(loc, "PATCH", { body: half2over }), env);
    expect(p2.status).toBe(413);
    const body = await p2.json() as { errors: { code: string; message: string }[] };
    expect(body.errors[0].code).toBe("SIZE_INVALID");
  });

  it("manifest PUT with body > cap returns 413", async () => {
    const route = new OciRegistryRoute({ maxBlobBytes: CAP });
    const oversize = new Uint8Array(CAP + 1);
    oversize.fill(0x7b); // '{' — start of JSON, harmless for size check

    const res = await route.handle(
      mkReq("/v2/notme/manifests/v0", "PUT", {
        body: oversize,
        headers: { "content-type": "application/vnd.oci.image.manifest.v1+json" },
      }),
      env,
    );

    expect(res.status).toBe(413);
    const body = await res.json() as { errors: { code: string; message: string }[] };
    expect(body.errors[0].code).toBe("SIZE_INVALID");
  });

  it("body exactly at cap is accepted (boundary — 201)", async () => {
    const route = new OciRegistryRoute({ maxBlobBytes: CAP });
    const atCap = new Uint8Array(CAP);
    atCap.fill(0x64);
    const digest = await sha256Hex(atCap);

    const res = await route.handle(
      mkReq(`/v2/notme/blobs/uploads/?digest=sha256:${digest}`, "POST", { body: atCap }),
      env,
    );

    expect(res.status).toBe(201);
  });
});

// ── DIGEST_INVALID error shape — no hash disclosure (cloister-667ea6 P2) ──
//
// Adversarial review (enumeration-oracle-hunter, dos-resilience-auditor)
// flagged that DIGEST_INVALID error responses included BOTH the computed
// sha256= and blake3= hashes of the client-posted body — turning cloister
// into a free hash-as-a-service oracle. The error MUST still tell the
// client *which algorithm checks ran* so diagnostics aren't useless, but
// MUST NOT leak the hex values themselves.

describe("OciRegistryRoute — DIGEST_INVALID error shape (no hash disclosure)", () => {
  const route = new OciRegistryRoute();
  const HEX_64 = /\b[0-9a-f]{64}\b/g;

  // Helper: assert the error body mentions sha256 + blake3 (so the client
  // knows what was checked) but does NOT contain a bare 64-hex digest
  // OTHER than the client's own claim (echoing the claim is fine — they
  // already know it).
  async function assertNoHashLeak(res: Response, clientClaim: string) {
    expect(res.status).toBe(400);
    const body = await res.json() as { errors: { code: string; message: string }[] };
    expect(body.errors[0].code).toBe("DIGEST_INVALID");
    const msg = body.errors[0].message;
    // Algorithm names MUST be present.
    expect(msg.toLowerCase()).toContain("sha256");
    expect(msg.toLowerCase()).toContain("blake3");
    // Strip the client's claim before scanning — echoing it is OK.
    const claimHex = clientClaim.startsWith("sha256:") ? clientClaim.slice(7) : "";
    const stripped = claimHex ? msg.replaceAll(claimHex, "") : msg;
    const leaked = stripped.match(HEX_64) ?? [];
    expect(leaked).toEqual([]); // no other 64-hex strings = no body-hash leak
  }

  it("monolithic POST with mismatched digest does not leak computed hash", async () => {
    const payload = new TextEncoder().encode("attacker-chosen-bytes-for-hash-oracle-probe");
    const wrongClaim = "sha256:" + "0".repeat(64);
    const res = await route.handle(
      mkReq(`/v2/notme/blobs/uploads/?digest=${wrongClaim}`, "POST", { body: payload }),
      env,
    );
    await assertNoHashLeak(res, wrongClaim);
  });

  it("chunked PUT finalize with mismatched digest does not leak computed hash", async () => {
    const begin = await route.handle(mkReq("/v2/notme/blobs/uploads/", "POST"), env);
    const loc = begin.headers.get("location")!;
    const payload = new TextEncoder().encode("attacker-bytes-for-finalize-oracle");
    await route.handle(mkReq(loc, "PATCH", { body: payload }), env);
    const wrongClaim = "sha256:" + "1".repeat(64);
    const fin = await route.handle(
      mkReq(`${loc}?digest=${wrongClaim}`, "PUT"), env,
    );
    await assertNoHashLeak(fin, wrongClaim);
  });

  it("manifest PUT by digest with mismatched ref does not leak computed hash", async () => {
    const payload = new TextEncoder().encode(JSON.stringify({ probe: "oracle" }));
    const wrongRef = "sha256:" + "2".repeat(64);
    const res = await route.handle(
      mkReq(`/v2/notme/manifests/${wrongRef}`, "PUT", {
        body: payload,
        headers: { "content-type": "application/vnd.oci.image.manifest.v1+json" },
      }),
      env,
    );
    await assertNoHashLeak(res, wrongRef);
  });

  it("manifest PUT with Docker-Content-Digest header mismatch does not leak", async () => {
    // Manifest pushed by tag (reference is a tag, not a digest) but with
    // a wrong Docker-Content-Digest header — exercises the header-mismatch path.
    const payload = new TextEncoder().encode(JSON.stringify({ schemaVersion: 2 }));
    const wrongHeader = "sha256:" + "3".repeat(64);
    const res = await route.handle(
      mkReq("/v2/notme/manifests/v9", "PUT", {
        body: payload,
        headers: {
          "content-type": "application/vnd.oci.image.manifest.v1+json",
          "docker-content-digest": wrongHeader,
        },
      }),
      env,
    );
    await assertNoHashLeak(res, wrongHeader);
  });
});
