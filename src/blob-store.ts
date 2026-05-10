// SPDX-License-Identifier: AGPL-3.0-or-later
//
// BlobStore — Durable Object holding the cluster-singleton content-addressed
// blob substrate.
//
// Per ADR-0003 phase 1 (content-addressed storage) + ADR-0012 (cross-DO
// transactional consistency via content-addressed handoff): when a state-
// boundary write happens, the canonical bytes go to BlobStore FIRST,
// idempotently, and only then do BeadStore (per-repo) and TrustStore
// (singleton) write rows referencing the resulting digest. Failure between
// steps is recoverable because BlobStore's `put` is idempotent — the same
// bytes always produce the same digest, so a retry of step 1 cannot create
// a divergent blob.
//
// Keying: SINGLETON per cluster, reached via
// `env.BLOB_STORE.idFromName("cluster")` — same convention as TrustStore.
// One BlobStore for the whole cluster keeps the content-addressed property
// global: any blob put by any caller is reachable by digest from any other
// caller. (Per-repo BlobStores would partition reachability and break the
// monoid axiom in ADR-0003.)
//
// API surface (RPC, via `extends DurableObject`):
//   - put(bytes)    -> Digest         (idempotent)
//   - get(digest)   -> Uint8Array | null
//   - has(digest)   -> boolean
//
// All three methods delegate to `WorkerdBlobStore` (src/storage/workerd.ts)
// which carries the actual SQLite-backed implementation. This DO is the
// addressing wrapper — it adds a binding and a singleton key; the storage
// substrate underneath is the same one tested in test/storage/workerd.test.ts.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types.js";
import { WorkerdBlobStore } from "./storage/workerd.js";
import type { Digest } from "./storage/types.js";

// ── TEST-ONLY — DO NOT USE IN PRODUCTION ─────────────────────────────────
//
// Fault-injection seam for the cross-DO recovery test
// (`test/security/cross-do-recovery.test.ts`, cloister-3dd355). Mirrors
// the seam in `src/trust-store.ts` (cloister-fff647) for the earlier
// hops of the BlobStore → BeadStore → TrustStore pipeline. Same shape,
// same safety argument:
//
//   - `globalThis.__cloisterTestFaults` is `undefined` at runtime in a
//     deployed worker. The Map.get below short-circuits to `undefined`
//     and the production path proceeds unchanged.
//   - The seam is reachable ONLY when a test explicitly installs the
//     map + the fault key. Tests install + remove the fault in
//     `beforeEach`/`afterEach` so cross-test bleed is impossible.
//   - A `globalThis` Map check is unambiguously test-only (production
//     code never reads from it), unlike an env-var gate which could in
//     principle be flipped at deploy time.
//
// Reviewers: if you see code reading from `__cloisterTestFaults`
// anywhere outside this seam-check site, that is a bug; the seam
// should never have callers, only this defender's check.
type FaultKey = "applyAttestation" | "blobStorePut" | "beadStoreWrite";
type FaultInjectionMap = Map<FaultKey, { failOnce: boolean }>;
function checkAndConsumeFault(key: FaultKey): boolean {
  const faults = (globalThis as { __cloisterTestFaults?: FaultInjectionMap })
    .__cloisterTestFaults;
  if (faults === undefined) return false;
  const entry = faults.get(key);
  if (entry === undefined) return false;
  if (entry.failOnce) {
    // Single-shot: consume the fault so the retry path sees a clean store.
    faults.delete(key);
    return true;
  }
  return false;
}

/**
 * Sentinel returned by `BlobStore.put` ONLY when the test fault-injection
 * seam fires (cloister-3dd355). Not a valid hex sha256 digest — its
 * `__fault:` prefix is reserved + the total length exceeds 64 chars, so
 * downstream code that mistakes it for a real digest fails closed (the
 * SELECT against `store_blobs` returns no row). The cross-DO recovery
 * test recognizes this sentinel and treats it as the "first hop failed"
 * signal. Exported so tests can compare against it without duplicating
 * the magic string.
 */
export const BLOB_PUT_FAULT_DIGEST = "__fault:blobStorePut" as Digest;

export class BlobStore extends DurableObject {
  private readonly inner: WorkerdBlobStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.inner = new WorkerdBlobStore(ctx.storage.sql, "store");
  }

  /**
   * Idempotent write. Same bytes → same digest, no double-row.
   *
   * Callers should pass canonical bytes (see src/storage/bead-canonical.ts)
   * for any value whose digest must be reproducible from a struct rather
   * than from a specific encoder. The DO does NOT canonicalize — it hashes
   * exactly the bytes it was handed. That keeps the digest-to-bytes map
   * one-to-one and lets callers verify offline.
   */
  async put(bytes: Uint8Array): Promise<Digest> {
    // TEST-ONLY fault-injection seam (cloister-3dd355). The check is
    // inert in production: `globalThis.__cloisterTestFaults` is
    // `undefined` outside of cross-DO-recovery tests. See the
    // checkAndConsumeFault header above for the safety argument.
    //
    // We return a sentinel "fault digest" (BLOB_PUT_FAULT_DIGEST below)
    // rather than throwing. Throwing across the workerd RPC boundary
    // surfaces in the vitest reporter as an unhandled rejection even
    // when the test's awaiter catches it cleanly — same motivation as
    // cloister-fff647's switch to Result-shape returns on
    // applyAttestation. The sentinel is NOT a valid sha256 hex digest
    // (it's longer than 64 chars + uses `:`), so any downstream code
    // that misuses it as a real digest fails closed.
    if (checkAndConsumeFault("blobStorePut")) {
      return BLOB_PUT_FAULT_DIGEST;
    }
    return this.inner.put(bytes);
  }

  /** Read bytes by digest, or null if absent. */
  async get(digest: Digest): Promise<Uint8Array | null> {
    return this.inner.get(digest);
  }

  /** Cheap existence check — useful for cross-DO recovery probes. */
  async has(digest: Digest): Promise<boolean> {
    return this.inner.has(digest);
  }

  // No inbound HTTP — BlobStore is a pure cross-bundle RPC target.
  override async fetch(_request: Request): Promise<Response> {
    return new Response("blob-store: no inbound HTTP surface", {
      status: 405,
      headers: { "content-type": "text/plain" },
    });
  }
}
