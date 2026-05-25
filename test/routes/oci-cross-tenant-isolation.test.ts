/// <reference types="@cloudflare/vitest-pool-workers/types" />
// Cross-tenant isolation tests for the OCI registry surface.
// Closes cloister-7c0a0b per ADR-0029 (slices 2 + 3): the OCI pull
// surface MUST gate on per-repo membership recorded at push time.
//
// Without this gate, the singleton BlobStore exposes blobs cross-
// tenant: pushing under repo A then GET-ing as repo B returns 200
// with the bytes. This test file asserts the opposite: cross-tenant
// pulls return constant-shape 404 (matching the §9.4 "exists but
// not yours" precedent from threat-model.md / ADR-0024 — the response
// shape is indistinguishable from "digest doesn't exist anywhere").

import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { OciRegistryRoute } from "../../src/routes/oci-registry.js";

beforeEach(async () => {
  // Reset TrustStore tables so prior tests don't grant cross-test membership.
  const trust = env.TRUST_STORE.get(env.TRUST_STORE.idFromName("cluster"));
  await runInDurableObject(trust, async (_inst, state) => {
    state.storage.sql.exec("DELETE FROM registry_tags");
    state.storage.sql.exec("DELETE FROM registry_blob_membership");
  });
});

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function mkReq(path: string, method: "POST" | "PUT" | "GET" | "HEAD", init: RequestInit = {}): Request {
  return new Request(`http://x${path}`, { method, ...init });
}

describe("OCI cross-tenant isolation (cloister-7c0a0b / ADR-0029)", () => {
  const route = new OciRegistryRoute();

  it("blob pushed under repo A is NOT readable from repo B (constant-shape 404)", async () => {
    const payload = new TextEncoder().encode("tenant-A-private-bytes");
    const digest  = await sha256Hex(payload);

    // Tenant A pushes the blob.
    const push = await route.handle(
      mkReq(`/v2/tenant-a/cache/blobs/uploads/?digest=sha256:${digest}`, "POST", { body: payload }),
      env,
    );
    expect(push.status).toBe(201);

    // Same tenant can pull it back (sanity — same-repo path still works).
    const sameRepoPull = await route.handle(
      mkReq(`/v2/tenant-a/cache/blobs/sha256:${digest}`, "GET"), env,
    );
    expect(sameRepoPull.status).toBe(200);

    // Tenant B attempts the cross-tenant pull — MUST be 404.
    const crossRepoPull = await route.handle(
      mkReq(`/v2/tenant-b/cache/blobs/sha256:${digest}`, "GET"), env,
    );
    expect(crossRepoPull.status).toBe(404);

    // Response shape MUST be the standard BLOB_UNKNOWN — the same body
    // a caller would see for a digest that doesn't exist at all. The
    // membership boundary is invisible to attackers probing the namespace.
    const body = await crossRepoPull.json() as { errors: { code: string }[] };
    expect(body.errors[0].code).toBe("BLOB_UNKNOWN");
  });

  it("HEAD blob also enforces cross-tenant boundary (no existence oracle)", async () => {
    const payload = new TextEncoder().encode("HEAD-probe-bytes");
    const digest  = await sha256Hex(payload);

    await route.handle(
      mkReq(`/v2/tenant-a/cache/blobs/uploads/?digest=sha256:${digest}`, "POST", { body: payload }),
      env,
    );

    const sameRepoHead = await route.handle(
      mkReq(`/v2/tenant-a/cache/blobs/sha256:${digest}`, "HEAD"), env,
    );
    expect(sameRepoHead.status).toBe(200);

    const crossRepoHead = await route.handle(
      mkReq(`/v2/tenant-b/cache/blobs/sha256:${digest}`, "HEAD"), env,
    );
    expect(crossRepoHead.status).toBe(404);
  });

  it("manifest pushed by digest under repo A is NOT readable from repo B", async () => {
    const manifestBody = new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        config: { mediaType: "application/vnd.test", digest: `sha256:${"a".repeat(64)}`, size: 0 },
        layers: [],
      }),
    );
    const digest = await sha256Hex(manifestBody);

    const push = await route.handle(
      mkReq(`/v2/tenant-a/cache/manifests/sha256:${digest}`, "PUT", {
        body: manifestBody,
        headers: { "content-type": "application/vnd.oci.image.manifest.v1+json" },
      }),
      env,
    );
    expect(push.status).toBe(201);

    const sameRepoPull = await route.handle(
      mkReq(`/v2/tenant-a/cache/manifests/sha256:${digest}`, "GET"), env,
    );
    expect(sameRepoPull.status).toBe(200);

    const crossRepoPull = await route.handle(
      mkReq(`/v2/tenant-b/cache/manifests/sha256:${digest}`, "GET"), env,
    );
    expect(crossRepoPull.status).toBe(404);
    const body = await crossRepoPull.json() as { errors: { code: string }[] };
    expect(body.errors[0].code).toBe("MANIFEST_UNKNOWN");
  });

  it("blob pushed to a sub-path repo (tenant-a/cache/sub) is not visible at parent (tenant-a)", async () => {
    // Multi-segment repo names are independent — tenant-a/cache/sub
    // is NOT the same scope as tenant-a/cache. OCI naming conventions
    // allow forward-slash hierarchy but each name is its own membership
    // key. (This prevents a sneaky "parent path" probe.)
    const payload = new TextEncoder().encode("sub-path-bytes");
    const digest  = await sha256Hex(payload);

    await route.handle(
      mkReq(`/v2/tenant-a/cache/sub/blobs/uploads/?digest=sha256:${digest}`, "POST", { body: payload }),
      env,
    );

    const subRepoPull = await route.handle(
      mkReq(`/v2/tenant-a/cache/sub/blobs/sha256:${digest}`, "GET"), env,
    );
    expect(subRepoPull.status).toBe(200);

    const parentRepoPull = await route.handle(
      mkReq(`/v2/tenant-a/cache/blobs/sha256:${digest}`, "GET"), env,
    );
    expect(parentRepoPull.status).toBe(404);
  });

  it("two tenants pushing the same bytes get independent memberships (no cross-leak via dedup)", async () => {
    // Content-addressed dedup at the BlobStore layer is preserved
    // (same bytes → one stored blob), but membership is per-repo, so
    // each tenant sees their push as their own and cannot read the
    // other's even though the bytes are byte-equal.
    const payload = new TextEncoder().encode("shared-bytes-different-tenants");
    const digest  = await sha256Hex(payload);

    // Tenant A pushes.
    const pushA = await route.handle(
      mkReq(`/v2/tenant-a/cache/blobs/uploads/?digest=sha256:${digest}`, "POST", { body: payload }),
      env,
    );
    expect(pushA.status).toBe(201);

    // Tenant B pushes the SAME bytes.
    const pushB = await route.handle(
      mkReq(`/v2/tenant-b/cache/blobs/uploads/?digest=sha256:${digest}`, "POST", { body: payload }),
      env,
    );
    expect(pushB.status).toBe(201);

    // Both can pull — each has their own membership row.
    const pullA = await route.handle(
      mkReq(`/v2/tenant-a/cache/blobs/sha256:${digest}`, "GET"), env,
    );
    expect(pullA.status).toBe(200);

    const pullB = await route.handle(
      mkReq(`/v2/tenant-b/cache/blobs/sha256:${digest}`, "GET"), env,
    );
    expect(pullB.status).toBe(200);

    // A third tenant who DIDN'T push cannot read either.
    const pullC = await route.handle(
      mkReq(`/v2/tenant-c/cache/blobs/sha256:${digest}`, "GET"), env,
    );
    expect(pullC.status).toBe(404);
  });
});
