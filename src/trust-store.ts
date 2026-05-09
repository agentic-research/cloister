// SPDX-License-Identifier: AGPL-3.0-or-later
//
// TrustStore — Durable Object holding cluster-singleton trust state.
//
// Per ADR-0011 + the 2026-05-09 adversarial review of the BeadStore/TrustStore
// split: trust state belongs in a hypervisor-layer DO, separate from the
// per-repo BeadStore (which is bundle-layer per ADR-0011's three-criterion
// test). Trust state is:
//
//   - peer_lease_counters — per-peer hash-chained counter, UPSERT per
//     authenticated request. Captures every authenticated call so spec
//     §13.2 "silence is evidence" holds even on read-only traffic.
//
//   - peer_attestations (planned, cloister-bdcbe7) — per-(actor, peer)
//     bilateral chain entries on state-boundary writes.
//
//   - vault entries (planned, ADR-0010 phases 3-4) — sealed credentials.
//
// Keying: SINGLETON per cluster. The DO is reached via
// `env.TRUST_STORE.idFromName("cluster")`. (When ADR-0010 phase 3 ships
// multi-cluster deploys, the key becomes the cluster's actor fingerprint.)
// This is distinct from BeadStore (per-repo, idFromName(repo)).
//
// Cross-DO transactional contract:
//
// ADR-0007's bolded transactional rule — attestation rows are written
// "inside the same SQL transaction as the underlying state change" — held
// when both tables lived in BeadStore. After the split, beads live in
// BeadStore (per-repo) and attestations live in TrustStore (singleton).
// Workerd's DO ACID is per-DO; cross-DO writes have no distributed
// transaction primitive. The 2026-05-09 review identified this as
// catastrophic if not handled.
//
// The handoff design (per the math friend's recommendation, requires
// ADR-0003 phase 1 to land):
//
//   1. bead_create writes the canonical bead bytes to BlobStore (CAS;
//      idempotent — same bytes → same digest).
//   2. BlobStore returns the digest.
//   3. BeadStore writes a row referencing the digest (per-repo DO; ACID).
//   4. TrustStore writes a peer_attestations row referencing the digest
//      (singleton DO; ACID).
//
// Failure between steps is recoverable: the blob is content-addressed,
// so step 1 is idempotent; a missing peer_attestations row is exactly
// the §13.2 evidence the audit amendment was designed to detect.
//
// Until ADR-0003 phase 1 ships, peer_attestations writes are NOT yet
// transactionally safe across the BeadStore/TrustStore boundary. Only
// peer_lease_counters writes (which don't reference bead state) are
// landed in this DO today; peer_attestations waits.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types.js";
import {
  SCHEMA_PEER_LEASE_COUNTERS,
  applyLeaseCounter,
  readLeaseCounter,
  type PeerLeaseCounter,
} from "./storage/peer-lease-counters.js";
import {
  SCHEMA_SEEN_NONCES,
  pruneSeenNoncesBefore,
  recordSeenNonce as recordSeenNonceHelper,
} from "./storage/seen-nonces.js";
import {
  SCHEMA_PENDING_ATTESTATIONS,
} from "./storage/pending-attestations.js";

const SCHEMA = `
${SCHEMA_PEER_LEASE_COUNTERS}
${SCHEMA_SEEN_NONCES}
${SCHEMA_PENDING_ATTESTATIONS}
`;

export class TrustStore extends DurableObject {
  private readonly db: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = ctx.storage.sql;
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(SCHEMA);
  }

  // The DO has no inbound HTTP handler today — it's accessed by other
  // bundles within the cluster via direct method calls (workerd's
  // Durable Object stub-and-method pattern). The lease middleware
  // (cloister-bd7770) imports the helpers in src/storage/peer-lease-counters.ts
  // and calls them with `this.db` as the SqlExecutor. Future endpoints
  // (disclosure, vault read) will surface as methods here.
  override async fetch(_request: Request): Promise<Response> {
    return new Response("trust-store: no inbound HTTP surface", {
      status: 405,
      headers: { "content-type": "text/plain" },
    });
  }

  /**
   * UPSERT the lease counter for a peer + return the new (seq, hash).
   *
   * Called by the lease middleware (cloister-bd7770) on every
   * authenticated POST /mcp. ACID inside this DO; the chain hash is
   * deterministic so a peer-side verifier can independently
   * reconstruct it.
   *
   * The middleware passes `(peerFp, certFp, nonce, ts)` after
   * verifying the cert; we don't re-verify here — the DO trusts that
   * the unforgeable service-binding-as-capability means the caller
   * already passed the cert checks.
   */
  async upsertLeaseCounter(
    peerFp: string,
    certFp: string,
    nonce: string,
    ts: number,
  ): Promise<{ seq: number; last_chain_hash: string }> {
    // blockConcurrencyWhile holds the input gate across the await on
    // crypto.subtle.digest inside applyLeaseCounter. Without this,
    // workerd releases the gate during non-I/O awaits, letting two
    // concurrent same-peer upserts read the same prevHash + prevSeq
    // and fork the chain (cloister-c66fea / threat-model §7.3).
    return this.ctx.blockConcurrencyWhile(async () =>
      applyLeaseCounter(this.db, peerFp, certFp, nonce, ts),
    );
  }

  /** Read the current counter for a peer; null if no observations yet. */
  getLeaseCounter(peerFp: string): PeerLeaseCounter | null {
    return readLeaseCounter(this.db, peerFp);
  }

  /**
   * Record a (cert_fp, nonce) tuple for replay defense (cloister-c5c846).
   * Single SQL statement — no read-then-write race; safe outside
   * blockConcurrencyWhile. Returns whether this is the first time we've
   * seen this tuple. Caller (lease middleware) rejects on `fresh: false`.
   */
  recordSeenNonce(
    certFp: string,
    nonce: string,
    tsMs: number,
  ): { fresh: boolean } {
    return recordSeenNonceHelper(this.db, certFp, nonce, tsMs);
  }

  /**
   * Garbage-collect nonces older than `beforeTsMs`. Intended to be
   * called periodically (e.g. by a scheduled handler) with a cutoff of
   * `now - max_cert_ttl_ms`. Returns the number of rows deleted.
   */
  pruneSeenNonces(beforeTsMs: number): number {
    return pruneSeenNoncesBefore(this.db, beforeTsMs);
  }
}
