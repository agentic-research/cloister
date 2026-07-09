// SPDX-License-Identifier: AGPL-3.0-or-later
//
// OCI Distribution Spec (v1.1) registry — Phase 1 (pull) + Phase 2 (push).
//
// Phase 1 (cloister-cabd57): the read-only `/v2/` pull surface — exactly
// what `docker pull` / `nerdctl pull` / `podman pull` exercise against
// the v2 API.
//
// Phase 2 (cloister-3a3b0d): the upload surface — `POST/PATCH/PUT
// /v2/<name>/blobs/uploads/*` plus `PUT /v2/<name>/manifests/<reference>`.
// External tools (oras, cosign, Zarf, `docker push`, `crane push`) can
// push artifacts INTO cloister's BlobStore using the standard OCI
// Distribution Spec v1.1 wire shape.
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
// Endpoint catalog (Phase 1 + Phase 2):
//   - GET    /v2/                                       -> version handshake
//   - GET    /v2/_catalog                               -> repo listing
//   - GET    /v2/<name>/tags/list                       -> tag listing for repo
//   - HEAD   /v2/<name>/manifests/<reference>           -> existence check
//   - GET    /v2/<name>/manifests/<reference>           -> manifest bytes
//   - PUT    /v2/<name>/manifests/<reference>           -> store manifest + tag
//   - HEAD   /v2/<name>/blobs/<digest>                  -> blob existence check
//   - GET    /v2/<name>/blobs/<digest>                  -> blob bytes
//   - POST   /v2/<name>/blobs/uploads/                  -> begin blob upload session
//   - POST   /v2/<name>/blobs/uploads/?digest=...       -> single-shot (monolithic) blob upload
//   - PATCH  /v2/<name>/blobs/uploads/<uuid>            -> append chunk to upload
//   - PUT    /v2/<name>/blobs/uploads/<uuid>?digest=... -> finalize + verify digest
//
// `<reference>` may be a tag (e.g. "0.1.0", "latest") OR a digest in the
// `sha256:<hex>` form. The route disambiguates by prefix.
//
// Auth posture:
//   Reads are anonymous. Writes are lease-gated when `INTERLACE_ROOT_PUBKEY`
//   is set (deployment-binding granularity, parallel to the disclosure
//   endpoint pattern in `src/routes/disclosure.ts`). The required scope
//   is `oci:write:<name>` — derived from the repo path. When the env is
//   unset (dev mode), writes proceed without auth so `task registry:import`
//   and local `docker push localhost:8787/...` keep working without
//   minting a cert.
//
// Upload session state (Phase 2, v0.1):
//   Sessions live in an instance-local `Map<uuid, {name, chunks}>` —
//   ephemeral, no cross-instance resumability. The OCI spec ALLOWS this
//   (resumable uploads are a SHOULD, not a MUST) and the workerd model
//   means a single isolate handles each push in practice. A future phase
//   can promote this to a Durable Object if multi-isolate resume becomes
//   a real signal.
//
// Error shape:
//   The OCI spec mandates a specific JSON error envelope:
//     { "errors": [ { "code": "<CODE>", "message": "..." } ] }
//   Standard codes used here:
//     - BLOB_UNKNOWN          - blob digest not in BlobStore
//     - BLOB_UPLOAD_UNKNOWN   - upload UUID not in the session table
//     - BLOB_UPLOAD_INVALID   - upload request malformed (Phase 2)
//     - DIGEST_INVALID        - client-claimed digest disagrees with bytes (Phase 2)
//     - MANIFEST_UNKNOWN      - manifest digest / tag not resolvable
//     - MANIFEST_INVALID      - manifest body malformed (Phase 2)
//     - NAME_INVALID          - repo name failed validation
//     - NAME_UNKNOWN          - repo has no tags
//     - DENIED                - request was denied (auth failure on a write)
//     - UNSUPPORTED           - method/path under /v2 we don't implement yet

import type { EdgeRoute } from "../router.js";
import type { Env } from "../types.js";
import { type Digest, asDigest, isDigest } from "../storage/types.js";
import { digestBytes, blake3HexBytes } from "../storage/canonical.js";
import { verifyAndUpsertLease } from "./lease-middleware.js";
import {
  CaUnavailableError,
  getCABundle,
} from "../storage/ca-bundle-cache.js";
import { notmeBundleFetcher } from "../storage/notme-bundle-fetcher.js";

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
// Phase 2 upload-session paths. The trailing-slash variant is what
// `docker push` + `oras push` use to BEGIN an upload; the `:uuid`
// variant is what subsequent PATCH/PUT requests target. URLPattern
// disambiguates: `/v2/foo/blobs/uploads/` (literal trailing slash)
// matches PATTERN_UPLOAD_BEGIN; `/v2/foo/blobs/uploads/abc-123`
// matches PATTERN_UPLOAD_SESSION.
const PATTERN_UPLOAD_BEGIN   = new URLPattern({ pathname: "/v2/:name+/blobs/uploads/" });
const PATTERN_UPLOAD_SESSION = new URLPattern({ pathname: "/v2/:name+/blobs/uploads/:uuid" });

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
  upsertRegistryTag(
    repo: string, tag: string, manifestDigest: string, nowMs: number,
  ): Promise<void>;
  // ADR-0029 (cloister-7c0a0b): per-repo blob/manifest membership index.
  // hasRegistryMembership gates pull paths; recordRegistryMembership
  // is written on every successful push.
  hasRegistryMembership(
    repo: string, digest: string, kind: "blob" | "manifest",
  ): Promise<boolean>;
  recordRegistryMembership(
    repo: string, digest: string, kind: "blob" | "manifest",
    nowMs: number, peerFp?: string | null,
  ): Promise<void>;
}

// ── Upload sessions (Phase 2) ─────────────────────────────────────────────
//
// Holds in-flight chunked uploads keyed by an ephemeral UUID. The session
// table is INSTANCE-LOCAL — a worker restart drops all open sessions, and
// resumability is best-effort only. Per the bead acceptance criteria, this
// is fine for v0.1; tighter durability lives behind a future DO-backed
// session table.
//
// Each session accumulates Uint8Array chunks; the final PUT concatenates
// them, hashes once, verifies against the client-claimed digest, and
// hands the bytes to BlobStore. Memory footprint is bounded by the
// caller's push size (no global cap today — push of >100MB during dev
// would exceed workerd's per-isolate budget, that's the existing limit).

interface UploadSession {
  /** Repo name the upload was opened against. PUT must match. */
  name:    string;
  /** Accumulated chunks in arrival order. */
  chunks:  Uint8Array[];
  /** Total bytes written so far — kept current to avoid recomputing. */
  size:    number;
}

// ── Public route ──────────────────────────────────────────────────────────

/**
 * Default upper bound on push body bytes. 256 MiB — chosen so that
 * realistic mache `.db` chunks and OCI image layers fit comfortably,
 * while a single push cannot exhaust workerd's per-isolate heap budget.
 * Override per-instance via `new OciRegistryRoute({ maxBlobBytes })`
 * or per-deployment via the bundle manifest once the env-binding
 * surface lands.
 *
 * Adversarial review of cloister-667ea6 (dos-resilience-auditor)
 * flagged the unbounded `arrayBuffer()` calls on every push verb as
 * a cross-tenant memory-exhaustion vector — the cap closes that.
 */
export const DEFAULT_MAX_BLOB_BYTES = 256 * 1024 * 1024;

export interface OciRegistryRouteOptions {
  /** Maximum push body size in bytes. Defaults to DEFAULT_MAX_BLOB_BYTES. */
  maxBlobBytes?: number;
}

export class OciRegistryRoute implements EdgeRoute {
  /**
   * Open upload sessions, keyed by an ephemeral UUID. Instance-local.
   * Cleared when the worker isolate restarts.
   */
  private readonly uploads = new Map<string, UploadSession>();

  private readonly maxBlobBytes: number;

  constructor(options: OciRegistryRouteOptions = {}) {
    this.maxBlobBytes = options.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES;
  }

  /**
   * Cheap-reject if the client's Content-Length header (if present and
   * parseable) declares a body larger than the cap. Returns null when
   * the request is within budget, or a 413 response when it isn't.
   *
   * This is the FAST PATH — rejects before `arrayBuffer()` is called,
   * so the isolate never allocates the over-size body. Callers MUST
   * still check actual size after buffering (sizeExceedsCap) in case
   * the client omitted/spoofed Content-Length.
   */
  private checkContentLengthHeader(request: Request): Response | null {
    const cl = request.headers.get("content-length");
    if (cl === null) return null;
    const declared = Number.parseInt(cl, 10);
    if (!Number.isFinite(declared) || declared < 0) return null;
    if (declared > this.maxBlobBytes) {
      return ociError(
        413,
        "SIZE_INVALID",
        `body of ${declared} bytes exceeds maxBlobBytes=${this.maxBlobBytes}`,
      );
    }
    return null;
  }

  /**
   * Post-buffering check — catches clients that omit Content-Length
   * or send a body larger than declared. Returns null when the size
   * fits, or a 413 response when it doesn't.
   */
  private checkActualSize(actualBytes: number): Response | null {
    if (actualBytes > this.maxBlobBytes) {
      return ociError(
        413,
        "SIZE_INVALID",
        `body of ${actualBytes} bytes exceeds maxBlobBytes=${this.maxBlobBytes}`,
      );
    }
    return null;
  }

  match(request: Request): boolean {
    const m = request.method;
    // Reads (Phase 1).
    if (m === "GET" || m === "HEAD") {
      return (
        PATTERN_VERSION.test(request.url) ||
        PATTERN_VERSION_NO_SLASH.test(request.url) ||
        PATTERN_CATALOG.test(request.url) ||
        PATTERN_TAGS.test(request.url) ||
        PATTERN_MANIFEST.test(request.url) ||
        PATTERN_BLOB.test(request.url)
      );
    }
    // Writes (Phase 2). Manifest PUT lives on the same pattern matrix as
    // manifest GET — method dispatch in handle() picks the branch.
    if (m === "POST") return PATTERN_UPLOAD_BEGIN.test(request.url);
    if (m === "PATCH" || m === "PUT") {
      return (
        PATTERN_UPLOAD_SESSION.test(request.url) ||
        (m === "PUT" && PATTERN_MANIFEST.test(request.url))
      );
    }
    return false;
  }

  async handle(request: Request, env: Env): Promise<Response> {
    const url    = request.url;
    const method = request.method;
    const isHead = method === "HEAD";

    // ── Phase 2 push dispatch (POST/PATCH/PUT) ───────────────────────────
    //
    // Handled before the read-path matrix so the GET handlers below stay
    // method-untouched. Each push handler internally lease-gates on
    // `INTERLACE_ROOT_PUBKEY` (parallel to disclosure.ts).
    if (method === "POST" && PATTERN_UPLOAD_BEGIN.test(url)) {
      return this.handleUploadBegin(request, env);
    }
    if (method === "PATCH" && PATTERN_UPLOAD_SESSION.test(url)) {
      return this.handleUploadPatch(request, env);
    }
    if (method === "PUT" && PATTERN_UPLOAD_SESSION.test(url)) {
      return this.handleUploadFinalize(request, env);
    }
    if (method === "PUT" && PATTERN_MANIFEST.test(url)) {
      return this.handleManifestPut(request, env);
    }

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

        // ADR-0029 pull-gate: consult per-repo membership BEFORE
        // BlobStore.get/has. A `false` return collapses to the same
        // constant-shape 404 a non-existent manifest would produce —
        // the response body is byte-identical so an attacker probing
        // cross-tenant namespace cannot distinguish "exists but not
        // yours" from "doesn't exist anywhere" (§9.4 / ADR-0024).
        const trustForRead = trustStoreStub(env);
        const memberOK = await trustForRead.hasRegistryMembership(name, manifestDigest, "manifest");
        if (!memberOK) {
          return ociError(404, "MANIFEST_UNKNOWN", `manifest unknown: ${reference}`);
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
        // ADR-0029 pull-gate — see manifest pull above for rationale.
        // Cross-tenant blob probes return constant-shape BLOB_UNKNOWN.
        const trustForRead = trustStoreStub(env);
        const memberOK = await trustForRead.hasRegistryMembership(name, d, "blob");
        if (!memberOK) {
          return ociError(404, "BLOB_UNKNOWN", `blob unknown: ${digest}`);
        }
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

  // ── Phase 2 push handlers ──────────────────────────────────────────────

  /**
   * `POST /v2/<name>/blobs/uploads/`
   *
   * Two shapes:
   *   1. Without `?digest=` — open an upload session. Allocate a UUID,
   *      seed a session with the request body (if any), return 202 Accepted
   *      with `Location: /v2/<name>/blobs/uploads/<uuid>` and `Range: 0-N`.
   *   2. With `?digest=sha256:...` — monolithic single-shot upload. Hash
   *      the body, verify against the claimed digest, BlobStore.put, and
   *      return 201 Created with `Location: /v2/<name>/blobs/<digest>`.
   */
  private async handleUploadBegin(request: Request, env: Env): Promise<Response> {
    const m = PATTERN_UPLOAD_BEGIN.exec(request.url);
    const name = m?.pathname.groups.name ?? "";
    if (!REPO_NAME_RE.test(name)) {
      return ociError(400, "NAME_INVALID", `invalid repository name: ${name}`);
    }

    const authResult = await this.gateWrite(request, env, name);
    if (authResult !== null) return authResult;

    const url = new URL(request.url);
    const claimedDigest = url.searchParams.get("digest");

    // Monolithic upload: the entire blob is in this request body and the
    // client claims the digest up front. We hash + verify + persist in one
    // shot — no session bookkeeping needed.
    if (claimedDigest !== null) {
      if (parseSha256Param(claimedDigest) === null) {
        return ociError(400, "DIGEST_INVALID", `digest must be sha256:<64-hex>: ${claimedDigest}`);
      }
      const clReject = this.checkContentLengthHeader(request);
      if (clReject !== null) return clReject;
      const body = new Uint8Array(await request.arrayBuffer());
      const sizeReject = this.checkActualSize(body.byteLength);
      if (sizeReject !== null) return sizeReject;
      const verified = await verifyClaimedDigest(body, claimedDigest);
      if (!verified.ok) {
        return ociError(
          400,
          "DIGEST_INVALID",
          `digest mismatch: client=${claimedDigest} body matches neither sha256 nor blake3`,
        );
      }
      const blob = blobStoreStub(env);
      await blob.put(body, asDigest(verified.key));
      // ADR-0029 push-record: write per-repo membership so the
      // subsequent pull (or any tenant's pull of the same digest)
      // is gated correctly. Same ordering as the §"BlobStore.put
      // first, then index" discipline from ADR-0012.
      const trust = trustStoreStub(env);
      await trust.recordRegistryMembership(name, verified.key, "blob", Date.now());
      return blobCreatedResponse(name, asDigest(verified.key));
    }

    // Otherwise: open a session. Per the spec, the body MAY contain initial
    // bytes (rare in practice — most clients send an empty POST, then one
    // or more PATCHes). We accept either.
    const clReject = this.checkContentLengthHeader(request);
    if (clReject !== null) return clReject;
    const uuid = newUploadId();
    const seed = await request.arrayBuffer();
    const seedBytes = new Uint8Array(seed);
    const sizeReject = this.checkActualSize(seedBytes.byteLength);
    if (sizeReject !== null) return sizeReject;
    this.uploads.set(uuid, {
      name,
      chunks: seedBytes.byteLength > 0 ? [seedBytes] : [],
      size:   seedBytes.byteLength,
    });
    return uploadAcceptedResponse(name, uuid, seedBytes.byteLength);
  }

  /**
   * `PATCH /v2/<name>/blobs/uploads/<uuid>`
   *
   * Append the request body to the session. Per spec we return 202
   * Accepted with `Range: 0-N` reflecting the new size. We do NOT enforce
   * `Content-Range` strictly — Phase 2 v0.1 treats every PATCH as
   * append-only; out-of-order writes simply concat. (Adding strict
   * Content-Range checks is a follow-up bead — most clients send chunks
   * sequentially anyway.)
   */
  private async handleUploadPatch(request: Request, env: Env): Promise<Response> {
    const m = PATTERN_UPLOAD_SESSION.exec(request.url);
    const name = m?.pathname.groups.name ?? "";
    const uuid = m?.pathname.groups.uuid ?? "";
    if (!REPO_NAME_RE.test(name)) {
      return ociError(400, "NAME_INVALID", `invalid repository name: ${name}`);
    }

    const authResult = await this.gateWrite(request, env, name);
    if (authResult !== null) return authResult;

    const sess = this.uploads.get(uuid);
    if (sess === undefined || sess.name !== name) {
      return ociError(404, "BLOB_UPLOAD_UNKNOWN", `upload not found: ${uuid}`);
    }
    const clReject = this.checkContentLengthHeader(request);
    if (clReject !== null) return clReject;
    const chunk = new Uint8Array(await request.arrayBuffer());
    // Cumulative size check: this chunk PLUS already-accumulated session
    // bytes must fit under the cap. Catches clients that pace small
    // PATCHes to grow the session past the cap incrementally.
    const sizeReject = this.checkActualSize(sess.size + chunk.byteLength);
    if (sizeReject !== null) return sizeReject;
    if (chunk.byteLength > 0) {
      sess.chunks.push(chunk);
      sess.size += chunk.byteLength;
    }
    return uploadAcceptedResponse(name, uuid, sess.size);
  }

  /**
   * `PUT /v2/<name>/blobs/uploads/<uuid>?digest=sha256:...`
   *
   * Finalize: append any trailing body, hash the concatenated bytes,
   * verify against the client-claimed digest, BlobStore.put, drop the
   * session. The OCI spec REQUIRES the `digest` query parameter on the
   * finalize PUT — we reject 400 if it's absent.
   */
  private async handleUploadFinalize(request: Request, env: Env): Promise<Response> {
    const m = PATTERN_UPLOAD_SESSION.exec(request.url);
    const name = m?.pathname.groups.name ?? "";
    const uuid = m?.pathname.groups.uuid ?? "";
    if (!REPO_NAME_RE.test(name)) {
      return ociError(400, "NAME_INVALID", `invalid repository name: ${name}`);
    }

    const authResult = await this.gateWrite(request, env, name);
    if (authResult !== null) return authResult;

    const sess = this.uploads.get(uuid);
    if (sess === undefined || sess.name !== name) {
      return ociError(404, "BLOB_UPLOAD_UNKNOWN", `upload not found: ${uuid}`);
    }

    const url = new URL(request.url);
    const claimedDigest = url.searchParams.get("digest");
    if (claimedDigest === null) {
      return ociError(400, "DIGEST_INVALID", "finalize PUT requires ?digest=sha256:<hex>");
    }
    if (parseSha256Param(claimedDigest) === null) {
      return ociError(400, "DIGEST_INVALID", `digest must be sha256:<64-hex>: ${claimedDigest}`);
    }

    // Append any trailing body — some clients (older docker) ship the
    // final chunk on the PUT itself rather than via a separate PATCH.
    const clReject = this.checkContentLengthHeader(request);
    if (clReject !== null) return clReject;
    const trailing = new Uint8Array(await request.arrayBuffer());
    // Cumulative session bytes (previously accumulated + this trailing)
    // must fit under the cap.
    const sizeReject = this.checkActualSize(sess.size + trailing.byteLength);
    if (sizeReject !== null) return sizeReject;
    if (trailing.byteLength > 0) {
      sess.chunks.push(trailing);
      sess.size += trailing.byteLength;
    }

    // Concat → hash → verify (SHA-256 fast path, BLAKE3 fallback per
    // build-cache/v1 wire compatibility — see verifyClaimedDigest doc).
    const full = concatChunks(sess.chunks, sess.size);
    const verified = await verifyClaimedDigest(full, claimedDigest);
    if (!verified.ok) {
      // Don't drop the session — let the client retry the finalize (it
      // may have sent the wrong digest claim against the right bytes,
      // or vice versa). The OCI spec doesn't require we keep it, but
      // dropping it would force a full re-push.
      return ociError(
        400,
        "DIGEST_INVALID",
        `digest mismatch: client=${claimedDigest} body matches neither sha256 nor blake3`,
      );
    }
    const parsed = verified.key;

    const blob = blobStoreStub(env);
    await blob.put(full, asDigest(parsed));
    // ADR-0029 push-record — see handleUploadBegin for rationale.
    const trust = trustStoreStub(env);
    await trust.recordRegistryMembership(name, parsed, "blob", Date.now());
    this.uploads.delete(uuid);
    return blobCreatedResponse(name, asDigest(parsed));
  }

  /**
   * `PUT /v2/<name>/manifests/<reference>`
   *
   * Store the manifest body in BlobStore + (if reference is a tag)
   * update the tag → digest mapping in TrustStore.registry_tags. If a
   * client-provided `Docker-Content-Digest` header is present, verify it
   * against the computed digest.
   *
   * The `<reference>` may be either a tag or a digest. If it's a digest,
   * we just verify the body hashes to it and skip the tag write.
   */
  private async handleManifestPut(request: Request, env: Env): Promise<Response> {
    const m = PATTERN_MANIFEST.exec(request.url);
    const name      = m?.pathname.groups.name      ?? "";
    const reference = m?.pathname.groups.reference ?? "";
    if (!REPO_NAME_RE.test(name)) {
      return ociError(400, "NAME_INVALID", `invalid repository name: ${name}`);
    }

    const authResult = await this.gateWrite(request, env, name);
    if (authResult !== null) return authResult;

    const clReject = this.checkContentLengthHeader(request);
    if (clReject !== null) return clReject;
    const body = new Uint8Array(await request.arrayBuffer());
    const sizeReject = this.checkActualSize(body.byteLength);
    if (sizeReject !== null) return sizeReject;
    if (body.byteLength === 0) {
      return ociError(400, "MANIFEST_INVALID", "empty manifest body");
    }

    // Determine the storage key. Two reference shapes:
    //   - sha256:<hex>  → verify body matches it (SHA-256 fast path,
    //                     BLAKE3 fallback per build-cache/v1). Storage
    //                     key is the verified hex.
    //   - <tag>         → no claim to verify; storage key is the body's
    //                     real SHA-256 (OCI-native tag semantics).
    let storageKey: string;
    if (reference.startsWith("sha256:")) {
      const verified = await verifyClaimedDigest(body, reference);
      if (!verified.ok) {
        return ociError(
          400,
          "DIGEST_INVALID",
          `manifest digest mismatch: ref=${reference} body matches neither sha256 nor blake3`,
        );
      }
      storageKey = verified.key;
    } else {
      if (!TAG_RE.test(reference)) {
        return ociError(400, "MANIFEST_INVALID", `invalid tag: ${reference}`);
      }
      storageKey = await digestBytes(body);
    }
    const storageRef = `sha256:${storageKey}`;

    // Cross-check the client's optional `Docker-Content-Digest` header
    // against either algorithm (matching the verifyClaimedDigest contract).
    const headerDigest = request.headers.get("docker-content-digest");
    if (headerDigest !== null) {
      const headerVerified = await verifyClaimedDigest(body, headerDigest);
      if (!headerVerified.ok) {
        return ociError(
          400,
          "DIGEST_INVALID",
          `header digest mismatch: header=${headerDigest} body matches neither sha256 nor blake3`,
        );
      }
    }

    // Persist bytes + tag. BlobStore.put is idempotent so re-pushing the
    // same manifest is a no-op at the blob level; the tag UPSERT replaces
    // any existing mapping for (repo, tag).
    const blob  = blobStoreStub(env);
    const trust = trustStoreStub(env);
    await blob.put(body, asDigest(storageKey));
    // ADR-0029 push-record: write per-repo membership so the manifest
    // pull (this repo's, any tenant's) goes through the gate.
    await trust.recordRegistryMembership(name, storageKey, "manifest", Date.now());
    if (!reference.startsWith("sha256:")) {
      await trust.upsertRegistryTag(name, reference, storageRef, Date.now());
    }
    return manifestCreatedResponse(name, reference, asDigest(storageKey));
  }

  /**
   * Lease-gate a write. Returns `null` when the write is allowed (no
   * pubkey set, or lease verified successfully). Returns a 401 OCI-spec
   * error response otherwise.
   *
   * Scope grammar: `oci:write:<name>` — parallel to `disclosure:<fp>`
   * in src/routes/disclosure.ts. The `<name>` segment is the repo path
   * (which may contain `/`), so the scope-match grammar must accept
   * `oci:write:cloister/router` as a sibling to `oci:write:notme`.
   * Glob containment (`scopeAllows`) handles `oci:write:*` for the
   * cluster-wide push role.
   */
  private async gateWrite(
    request: Request,
    env:     Env,
    name:    string,
  ): Promise<Response | null> {
    if (!env.INTERLACE_ROOT_PUBKEY) {
      return null; // dev mode: no gate
    }
    // Read the body once and stash it on the request via a cloned-body
    // approach — actually, we DON'T read the body here. The signature
    // pipeline reads from a clone via `await request.arrayBuffer()` only
    // when canonicalRequestBytes needs it. To avoid double-consuming the
    // body in the handler, we pass the body bytes through. But for
    // simplicity at v0.1, the handlers above read the body AFTER the
    // gate, and the gate reads the body via `request.clone()` here.
    // verifyAndUpsertLease signs over the body, so we MUST hand it the
    // exact bytes the client sent.
    const bodyText = await request.clone().text();
    const nowMs = Date.now();
    let bundle;
    try {
      bundle = await getCABundle(notmeBundleFetcher(env), nowMs, {
        rootPubkey: env.INTERLACE_ROOT_PUBKEY,
      });
    } catch (err) {
      if (err instanceof CaUnavailableError) {
        return ociError(401, "DENIED", "CA bundle unavailable");
      }
      throw err;
    }
    const verdict = await verifyAndUpsertLease({
      req:    request,
      body:   bodyText,
      id:     null,
      method: "oci-write",
      params: undefined,
      env,
      bundle,
      nowMs,
      requestedScope: `oci:write:${name}`,
    });
    if ("code" in verdict) {
      // Collapse every lease-pipeline failure to a generic 401 DENIED.
      // The OCI spec doesn't distinguish among auth failure modes; a
      // detailed message (cert expired, scope denied, etc.) would help
      // operators but also gives an attacker the same precise oracle
      // disclosure.ts works to suppress. Keep it terse.
      return ociError(401, "DENIED", "authentication required");
    }
    return null;
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

// ── Phase 2 response builders ─────────────────────────────────────────────

/**
 * `202 Accepted` for opened / appended upload sessions.
 *
 * The spec requires:
 *   Location: /v2/<name>/blobs/uploads/<uuid>
 *   Range:    0-<bytes-written>           (closed range, inclusive)
 *   Docker-Upload-UUID: <uuid>            (legacy header; docker push reads it)
 *
 * `Range` reports the bytes already written, so the client knows where
 * to start the next PATCH. Empty session → "0-0" per common practice
 * (some clients want a Range even on an empty session).
 */
function uploadAcceptedResponse(name: string, uuid: string, size: number): Response {
  // Range is inclusive; for an empty session we emit "0-0" rather than
  // a degenerate "0--1" — matches what go-containerregistry/registry/v2
  // returns on a freshly-opened session.
  const rangeEnd = size === 0 ? 0 : size - 1;
  return new Response(null, {
    status: 202,
    headers: {
      "location":            `/v2/${name}/blobs/uploads/${uuid}`,
      "range":               `0-${rangeEnd}`,
      "content-length":      "0",
      "docker-upload-uuid":  uuid,
      [API_VERSION_HEADER]:  API_VERSION_VALUE,
    },
  });
}

/**
 * `201 Created` for a finalized blob upload.
 *
 *   Location: /v2/<name>/blobs/<digest>
 *   Docker-Content-Digest: sha256:<hex>
 */
function blobCreatedResponse(name: string, digest: Digest): Response {
  return new Response(null, {
    status: 201,
    headers: {
      "location":              `/v2/${name}/blobs/sha256:${digest}`,
      "docker-content-digest": `sha256:${digest}`,
      "content-length":        "0",
      [API_VERSION_HEADER]:    API_VERSION_VALUE,
    },
  });
}

/**
 * `201 Created` for a stored manifest. The Location echoes the
 * reference the client used (tag or digest); the Docker-Content-Digest
 * always echoes the computed digest so the client can address the
 * manifest by content even if it was pushed by tag.
 */
function manifestCreatedResponse(name: string, reference: string, digest: Digest): Response {
  return new Response(null, {
    status: 201,
    headers: {
      "location":              `/v2/${name}/manifests/${reference}`,
      "docker-content-digest": `sha256:${digest}`,
      "content-length":        "0",
      [API_VERSION_HEADER]:    API_VERSION_VALUE,
    },
  });
}

// ── Phase 2 helpers ───────────────────────────────────────────────────────

/**
 * Parse a `sha256:<64-hex>` value (from a query param or header).
 * Returns the bare hex on success, `null` on any malformed input.
 */
function parseSha256Param(value: string): string | null {
  if (!value.startsWith("sha256:")) return null;
  const hex = value.slice("sha256:".length);
  return isDigest(hex) ? hex : null;
}

/**
 * Verify a client's claimed digest against the body. Returns `ok: true`
 * if the body hashes to the claimed hex under SHA-256 OR BLAKE3.
 *
 * The BLAKE3 fallback exists for build-cache/v1 wire compatibility
 * (leyline-schema-spec/build-cache/v1/README.md §"Digest encoding" reuses
 * `sha256:` prefix for BLAKE3 hex). cloister-as-build-cache-provider
 * needs to accept either; existing OCI-native clients (Docker, ORAS,
 * cosign) hit the SHA-256 fast-path and never pay BLAKE3 compute.
 *
 * Returns `ok: false` with both computed hashes in the error payload
 * so the client diagnostic names what cloister actually saw.
 *
 * Cryptographic argument: a collision in either SHA-256 or BLAKE3 is
 * infeasible under current adversary budgets. A client that claims
 * `sha256:<X>` and whose body hashes to X under either algorithm is
 * either honest or has broken cryptography; either way, the substrate
 * accepts the bytes as-claimed.
 */
async function verifyClaimedDigest(
  body: Uint8Array,
  claimedDigest: string,
): Promise<
  | { ok: true; key: string }
  | { ok: false; sha256: string; blake3: string }
> {
  const parsed = parseSha256Param(claimedDigest);
  if (parsed === null) {
    return { ok: false, sha256: "?invalid-claim?", blake3: "?invalid-claim?" };
  }
  const sha256 = await digestBytes(body);
  if (sha256 === parsed) return { ok: true, key: parsed };
  const blake3 = blake3HexBytes(body);
  if (blake3 === parsed) return { ok: true, key: parsed };
  return { ok: false, sha256, blake3 };
}

/**
 * Concatenate accumulated chunks into one contiguous Uint8Array.
 *
 * Bounded by `size` (precomputed across PATCHes) so we don't have to
 * walk the chunk list twice. Single allocation, single copy.
 */
function concatChunks(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/**
 * Allocate an upload UUID. We use `crypto.randomUUID()` (workerd-native,
 * Web Platform standard). The UUIDs are ephemeral, instance-local, and
 * not security-bearing — the lease scope handles authorization. We use
 * a UUID anyway so an attacker can't enumerate active sessions cheaply.
 */
function newUploadId(): string {
  return crypto.randomUUID();
}

// ── Stub helpers ──────────────────────────────────────────────────────────

interface BlobStoreRpc {
  has(digest: Digest): Promise<boolean>;
  get(digest: Digest): Promise<Uint8Array | null>;
  put(bytes: Uint8Array, key?: Digest): Promise<Digest>;
}

function blobStoreStub(env: Env): DurableObjectStub & BlobStoreRpc {
  return env.BLOB_STORE.get(env.BLOB_STORE.idFromName("cluster")) as
    DurableObjectStub & BlobStoreRpc;
}

function trustStoreStub(env: Env): DurableObjectStub & TrustStoreRpc {
  return env.TRUST_STORE.get(env.TRUST_STORE.idFromName("cluster")) as
    DurableObjectStub & TrustStoreRpc;
}
