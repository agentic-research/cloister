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
