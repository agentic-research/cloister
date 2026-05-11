// SPDX-License-Identifier: AGPL-3.0-or-later
//
// OCI Distribution Spec (v1.1) registry — Phase 1: READ-ONLY pull path.
// Per cloister-cabd57. The endpoints below are exactly what `docker pull`
// + `nerdctl pull` + `podman pull` exercise against the v2 API; the
// upload surface (`POST/PATCH/PUT /v2/<name>/blobs/uploads/*`) is
// deferred to a follow-up bead.
//
// Substrate map:
//   - Blobs (manifests + configs + layer tarballs) are content-addressed
//     and stored in `BlobStore` (ADR-0003 phase 1). The OCI digest
//     `sha256:<hex>` IS the BlobStore key sans-prefix.
//   - Tags are mutable pointers stored in `TrustStore.registry_tags`
//     (cloister-cabd57); a tag resolves to a manifest content digest
//     which is then loaded from BlobStore.
//
// Why this is a load-bearing demonstration of ADR-0002:
//   - The OCI wire shape (binary content, content-addressed multi-step
//     semantics, `application/vnd.oci.image.manifest.v1+json` media types)
//     has nothing in common with MCP JSON-RPC. The router-as-substrate
//     thesis says the same `EdgeRoute` seam serves both; this route is
//     the proof. Sibling to the identity bridge (cloister-c9922f) — two
//     non-MCP tenants now ride the same seam.
//
// Endpoint catalog (Phase 1):
//   - GET /v2/                                  -> version handshake
//   - GET /v2/_catalog                          -> repo listing
//   - GET /v2/<name>/tags/list                  -> tag listing for repo
//   - HEAD /v2/<name>/manifests/<reference>     -> existence check
//   - GET  /v2/<name>/manifests/<reference>     -> manifest bytes
//   - HEAD /v2/<name>/blobs/<digest>            -> blob existence check
//   - GET  /v2/<name>/blobs/<digest>            -> blob bytes
//
// `<reference>` may be a tag (e.g. "0.1.0", "latest") OR a digest in the
// `sha256:<hex>` form. The route disambiguates by prefix.
//
// Auth posture (Phase 1):
//   Reads are anonymous. The single-deploy story is "stand up a cluster,
//   `task registry:import cloister.tar`, `docker pull localhost:8787/cloister:0.1.0`
//   works." Phase 2 adds an `oci:push:<repo>` scope on the lease for
//   writes; gating reads behind `oci:pull` is a Phase-2 opt-in.
//
// Error shape:
//   The OCI spec mandates a specific JSON error envelope:
//     { "errors": [ { "code": "<CODE>", "message": "..." } ] }
//   Standard codes used here:
//     - BLOB_UNKNOWN     - blob digest not in BlobStore
//     - MANIFEST_UNKNOWN - manifest digest / tag not resolvable
//     - NAME_INVALID     - repo name failed validation
//     - NAME_UNKNOWN     - repo has no tags
//     - UNSUPPORTED      - method/path under /v2 we don't implement yet

import type { EdgeRoute } from "../router.js";
import type { Env } from "../types.js";
import { type Digest, asDigest, isDigest } from "../storage/types.js";

// ── URLPatterns (built once per instance) ─────────────────────────────────
//
// Web Platform standard, workerd-native, no regex. Each pattern matches
// exactly one endpoint shape. `:name+` allows multi-segment repo names
// (e.g. `cloister/router`); the OCI spec lets a repo path span several
// segments separated by `/`. URLPattern binds `:name` to the longest
// run that still lets the literal-suffix segments match — verified by
// the unit tests in test/routes/oci-registry.test.ts.

const PATTERN_VERSION  = new URLPattern({ pathname: "/v2/" });
// Some clients (older docker) request `/v2` without the trailing slash.
// The spec mandates `/v2/`, but we serve both to be forgiving.
const PATTERN_VERSION_NO_SLASH = new URLPattern({ pathname: "/v2" });
const PATTERN_CATALOG  = new URLPattern({ pathname: "/v2/_catalog" });
const PATTERN_TAGS     = new URLPattern({ pathname: "/v2/:name+/tags/list" });
const PATTERN_MANIFEST = new URLPattern({ pathname: "/v2/:name+/manifests/:reference" });
const PATTERN_BLOB     = new URLPattern({ pathname: "/v2/:name+/blobs/:digest" });

// ── Constants ─────────────────────────────────────────────────────────────

/** Required handshake header - every response carries it. */
const API_VERSION_HEADER = "Docker-Distribution-API-Version";
const API_VERSION_VALUE  = "registry/2.0";

/**
 * Default manifest content-type. The OCI spec defines several:
 *   application/vnd.oci.image.manifest.v1+json    - single-platform image
 *   application/vnd.oci.image.index.v1+json       - multi-platform index
 *   application/vnd.docker.distribution.manifest.v2+json - Docker v2
 *   application/vnd.docker.distribution.manifest.list.v2+json - Docker v2 list
 *
 * Phase 1 doesn't parse manifests - it just hands the bytes back. But
 * `docker pull` cares about the `Content-Type` header matching the
 * manifest's own `mediaType` field. We therefore peek at the bytes to
 * find the `mediaType` and echo it back. If we can't find one, we fall
 * back to the OCI v1 default.
 *
 * apko-built images use `application/vnd.oci.image.manifest.v1+json`;
 * Docker-built images use the `vnd.docker.distribution.*` variants.
 * Both work here.
 */
const DEFAULT_MANIFEST_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json";

/**
 * Repo-name validator. OCI spec § "Repository name" grammar:
 *   [a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*(?:/[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*)*
 * We use a permissive subset (lowercase alphanumeric + `_`, `-`, `.`,
 * `/`) - strictly tighter than what the spec rejects but everything
 * `docker pull` produces. Path-traversal and shell-metachars are barred.
 */
const REPO_NAME_RE = /^[a-z0-9][a-z0-9._/-]{0,254}$/;

/** Tag validator - OCI spec § "Tags" grammar (lightened). */
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

// ── TrustStore RPC surface used by this route ─────────────────────────────

interface TrustStoreRpc {
  getRegistryManifestDigestForTag(repo: string, tag: string): Promise<string | null>;
  listRegistryTagsForRepo(repo: string): Promise<string[]>;
  listRegistryRepos(): Promise<string[]>;
}

// ── Public route ──────────────────────────────────────────────────────────

export class OciRegistryRoute implements EdgeRoute {
  match(request: Request): boolean {
    const m = request.method;
    if (m !== "GET" && m !== "HEAD") return false;
    return (
      PATTERN_VERSION.test(request.url) ||
      PATTERN_VERSION_NO_SLASH.test(request.url) ||
      PATTERN_CATALOG.test(request.url) ||
      PATTERN_TAGS.test(request.url) ||
      PATTERN_MANIFEST.test(request.url) ||
      PATTERN_BLOB.test(request.url)
    );
  }

  async handle(request: Request, env: Env): Promise<Response> {
    const url    = request.url;
    const method = request.method;
    const isHead = method === "HEAD";

    // ── /v2/ - version handshake ─────────────────────────────────────────
    if (PATTERN_VERSION.test(url) || PATTERN_VERSION_NO_SLASH.test(url)) {
      return new Response("{}", {
        status: 200,
        headers: {
          "content-type":          "application/json; charset=utf-8",
          [API_VERSION_HEADER]:    API_VERSION_VALUE,
        },
      });
    }

    // ── /v2/_catalog ─────────────────────────────────────────────────────
    if (PATTERN_CATALOG.test(url)) {
      const trust = trustStoreStub(env);
      const repos = await trust.listRegistryRepos();
      return jsonResponse({ repositories: repos });
    }

    // ── /v2/<name>/tags/list ─────────────────────────────────────────────
    {
      const m = PATTERN_TAGS.exec(url);
      if (m) {
        const name = m.pathname.groups.name ?? "";
        if (!REPO_NAME_RE.test(name)) {
          return ociError(400, "NAME_INVALID", `invalid repository name: ${name}`);
        }
        const trust = trustStoreStub(env);
        const tags  = await trust.listRegistryTagsForRepo(name);
        if (tags.length === 0) {
          return ociError(404, "NAME_UNKNOWN", `repository name not known: ${name}`);
        }
        return jsonResponse({ name, tags });
      }
    }

    // ── /v2/<name>/manifests/<reference> ─────────────────────────────────
    {
      const m = PATTERN_MANIFEST.exec(url);
      if (m) {
        const name      = m.pathname.groups.name      ?? "";
        const reference = m.pathname.groups.reference ?? "";
        if (!REPO_NAME_RE.test(name)) {
          return ociError(400, "NAME_INVALID", `invalid repository name: ${name}`);
        }

        // Resolve reference -> manifest digest. Two cases:
        //  1. reference is "sha256:<hex>" - pass straight to BlobStore.
        //  2. reference is a tag - look it up in the tag index.
        let manifestDigest: Digest | null = null;
        if (reference.startsWith("sha256:")) {
          const hex = reference.slice("sha256:".length);
          if (!isDigest(hex)) {
            return ociError(404, "MANIFEST_UNKNOWN", `manifest unknown: ${reference}`);
          }
          manifestDigest = asDigest(hex);
        } else {
          if (!TAG_RE.test(reference)) {
            return ociError(404, "MANIFEST_UNKNOWN", `manifest unknown: ${reference}`);
          }
          const trust = trustStoreStub(env);
          const d = await trust.getRegistryManifestDigestForTag(name, reference);
          if (!d) {
            return ociError(404, "MANIFEST_UNKNOWN", `manifest unknown: ${reference}`);
          }
          // Stored form is "sha256:<hex>"; strip prefix to address BlobStore.
          if (!d.startsWith("sha256:")) {
            return ociError(500, "UNSUPPORTED", `tag-index digest has unexpected algorithm: ${d}`);
          }
          const hex = d.slice("sha256:".length);
          if (!isDigest(hex)) {
            return ociError(500, "UNSUPPORTED", `tag-index digest malformed: ${d}`);
          }
          manifestDigest = asDigest(hex);
        }

        const blob = blobStoreStub(env);
        if (isHead) {
          const exists = await blob.has(manifestDigest);
          if (!exists) {
            return ociError(404, "MANIFEST_UNKNOWN", `manifest unknown: ${reference}`);
          }
          return manifestHeadResponse(manifestDigest);
        }
        const bytes = await blob.get(manifestDigest);
        if (!bytes) {
          return ociError(404, "MANIFEST_UNKNOWN", `manifest unknown: ${reference}`);
        }
        return manifestResponse(bytes, manifestDigest);
      }
    }

    // ── /v2/<name>/blobs/<digest> ────────────────────────────────────────
    {
      const m = PATTERN_BLOB.exec(url);
      if (m) {
        const name   = m.pathname.groups.name   ?? "";
        const digest = m.pathname.groups.digest ?? "";
        if (!REPO_NAME_RE.test(name)) {
          return ociError(400, "NAME_INVALID", `invalid repository name: ${name}`);
        }
        if (!digest.startsWith("sha256:")) {
          return ociError(404, "BLOB_UNKNOWN", `blob unknown: ${digest}`);
        }
        const hex = digest.slice("sha256:".length);
        if (!isDigest(hex)) {
          return ociError(404, "BLOB_UNKNOWN", `blob unknown: ${digest}`);
        }
        const d = asDigest(hex);
        const blob = blobStoreStub(env);
        if (isHead) {
          const exists = await blob.has(d);
          if (!exists) {
            return ociError(404, "BLOB_UNKNOWN", `blob unknown: ${digest}`);
          }
          return blobHeadResponse(d);
        }
        const bytes = await blob.get(d);
        if (!bytes) {
          return ociError(404, "BLOB_UNKNOWN", `blob unknown: ${digest}`);
        }
        return blobResponse(bytes, d);
      }
    }

    // Unreachable: match() already gated. Belt-and-braces 404 in spec shape.
    return ociError(404, "UNSUPPORTED", "endpoint not implemented");
  }
}

// ── Response builders ─────────────────────────────────────────────────────

function jsonResponse(body: object): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type":       "application/json; charset=utf-8",
      [API_VERSION_HEADER]: API_VERSION_VALUE,
    },
  });
}

/**
 * Sniff a manifest's `mediaType` field so the response Content-Type
 * matches what the client expects. Cheap JSON parse - manifests are
 * small (few KB), bounded by spec. If parsing fails or the field is
 * missing, fall back to the OCI v1 default.
 */
function pickManifestMediaType(bytes: Uint8Array): string {
  try {
    // Default options: { fatal: false, ignoreBOM: false } — non-fatal
    // decoding is what we want (a manifest with malformed UTF-8 falls
    // through to the default media type rather than throwing).
    const text = new TextDecoder().decode(bytes);
    const obj  = JSON.parse(text) as { mediaType?: unknown };
    if (typeof obj.mediaType === "string" && obj.mediaType.length > 0) {
      return obj.mediaType;
    }
  } catch {
    // Fall through to default - non-JSON manifest bytes are not spec-
    // compliant, but we still want to serve them with a reasonable
    // type rather than fail the pull.
  }
  return DEFAULT_MANIFEST_MEDIA_TYPE;
}

function manifestResponse(bytes: Uint8Array, digest: Digest): Response {
  const mediaType = pickManifestMediaType(bytes);
  return new Response(bytes as BodyInit, {
    status: 200,
    headers: {
      "content-type":          mediaType,
      "content-length":        String(bytes.byteLength),
      "docker-content-digest": `sha256:${digest}`,
      [API_VERSION_HEADER]:    API_VERSION_VALUE,
      // ETag matches the content digest - caches can revalidate cheaply.
      "etag":                  `"sha256:${digest}"`,
    },
  });
}

function manifestHeadResponse(digest: Digest): Response {
  return new Response(null, {
    status: 200,
    headers: {
      "content-type":          DEFAULT_MANIFEST_MEDIA_TYPE,
      "docker-content-digest": `sha256:${digest}`,
      [API_VERSION_HEADER]:    API_VERSION_VALUE,
      "etag":                  `"sha256:${digest}"`,
    },
  });
}

function blobResponse(bytes: Uint8Array, digest: Digest): Response {
  return new Response(bytes as BodyInit, {
    status: 200,
    headers: {
      "content-type":          "application/octet-stream",
      "content-length":        String(bytes.byteLength),
      "docker-content-digest": `sha256:${digest}`,
      [API_VERSION_HEADER]:    API_VERSION_VALUE,
      "etag":                  `"sha256:${digest}"`,
    },
  });
}

function blobHeadResponse(digest: Digest): Response {
  return new Response(null, {
    status: 200,
    headers: {
      "content-type":          "application/octet-stream",
      "docker-content-digest": `sha256:${digest}`,
      [API_VERSION_HEADER]:    API_VERSION_VALUE,
      "etag":                  `"sha256:${digest}"`,
    },
  });
}

/**
 * OCI-spec error envelope. The shape is non-negotiable - `docker pull`
 * inspects `errors[].code` to decide whether to retry, fall back, or
 * surface a clear message.
 */
function ociError(status: number, code: string, message: string): Response {
  const body = JSON.stringify({ errors: [{ code, message }] });
  return new Response(body, {
    status,
    headers: {
      "content-type":       "application/json; charset=utf-8",
      [API_VERSION_HEADER]: API_VERSION_VALUE,
    },
  });
}

// ── Stub helpers ──────────────────────────────────────────────────────────

interface BlobStoreRpc {
  has(digest: Digest): Promise<boolean>;
  get(digest: Digest): Promise<Uint8Array | null>;
}

function blobStoreStub(env: Env): DurableObjectStub & BlobStoreRpc {
  return env.BLOB_STORE.get(env.BLOB_STORE.idFromName("cluster")) as
    DurableObjectStub & BlobStoreRpc;
}

function trustStoreStub(env: Env): DurableObjectStub & TrustStoreRpc {
  return env.TRUST_STORE.get(env.TRUST_STORE.idFromName("cluster")) as
    DurableObjectStub & TrustStoreRpc;
}
