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
  computeNextLeaseStep,
  readLeaseCounter,
  writeLeaseCounterRow,
  type PeerLeaseCounter,
} from "./storage/peer-lease-counters.js";
import {
  SCHEMA_SEEN_NONCES,
  pruneSeenNoncesBefore,
  recordSeenNonce as recordSeenNonceHelper,
} from "./storage/seen-nonces.js";
import {
  SCHEMA_PENDING_ATTESTATIONS,
  commitPending as commitPendingHelper,
  enqueuePending as enqueuePendingHelper,
  listPendingForPeer as listPendingForPeerHelper,
  recordFailedAttempt as recordFailedAttemptHelper,
  type PendingAttestation,
} from "./storage/pending-attestations.js";
import {
  AttestationIntegrityError,
  SCHEMA_PEER_ATTESTATIONS,
  applyAttestation as applyAttestationHelper,
  findAttestationByContent as findAttestationByContentHelper,
  lastAttestationForPeer as lastAttestationForPeerHelper,
  listAttestationsForPeer as listAttestationsForPeerHelper,
  type ApplyAttestationResult,
  type PeerAttestation,
} from "./storage/peer-attestations.js";

const SCHEMA = `
${SCHEMA_PEER_LEASE_COUNTERS}
${SCHEMA_SEEN_NONCES}
${SCHEMA_PENDING_ATTESTATIONS}
${SCHEMA_PEER_ATTESTATIONS}
`;

/**
 * Internal sentinel thrown inside `verifyLeaseAndAdvanceChain`'s
 * `transactionSync` callback to roll back when the nonce was a
 * duplicate (replay attempt). Caught immediately by the surrounding
 * `try/catch` — never escapes the RPC method. Using a sentinel
 * (rather than a real Error subclass) keeps the rollback path free of
 * stack-trace allocation, and the `===` identity check is unambiguous.
 */
const REPLAY_SENTINEL: unique symbol = Symbol("replay-sentinel");

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
   * Atomically check the (cert_fp, nonce) replay ledger AND advance the
   * peer's lease counter chain in ONE DO RPC + ONE SQL transaction.
   *
   * Replaces the two-RPC sequence (`recordSeenNonce` + `upsertLeaseCounter`)
   * on the lease-middleware hot path. Two motivations (cloister-ee51b8):
   *
   *   1. **Perf.** The two cross-DO RPCs together accounted for ~85% of
   *      lease-pipeline cost (~760µs of 925µs on local workerd; 2–6ms
   *      on CF Workers prod). Coalescing them halves the cross-DO
   *      overhead at the call site.
   *
   *   2. **Correctness.** The two-RPC version was NOT atomic. Workerd's
   *      `sql.exec` auto-commits per call, so a crash between the
   *      seen_nonces INSERT and the peer_lease_counters UPSERT left the
   *      nonce consumed but the chain un-advanced — a §13.2 off-by-one
   *      ("silence is evidence" reads the missing counter advance as a
   *      malicious-cloister signal even though the cluster did nothing
   *      wrong). Wrapping the two writes in a single `transactionSync`
   *      closes this window.
   *
   * Return values:
   *
   *   - `{ replayed: true }`  — duplicate (cert_fp, nonce); caller MUST
   *     reject as replay. Counter NOT advanced.
   *   - `{ replayed: false, seq, last_chain_hash }` — fresh; counter
   *     advanced. Caller proceeds with dispatch.
   *
   * Atomicity model:
   *
   *   - The outer `blockConcurrencyWhile` holds the DO input gate across
   *     `await crypto.subtle.digest` so two concurrent same-peer calls
   *     can't read the same `prevHash` + fork the chain (cloister-c66fea
   *     pattern; same defense as the legacy `upsertLeaseCounter`).
   *   - The digest is computed BEFORE the `transactionSync` because
   *     `transactionSync` accepts only synchronous callbacks. Safe to
   *     compute outside the txn: it's pure SHA-256 over deterministic
   *     inputs, and the read of the prev row also happens inside the
   *     gate so the inputs to the digest are consistent with the row
   *     we're about to UPDATE.
   *   - Inside `transactionSync`: nonce INSERT-OR-NOTHING → if not
   *     fresh, throw to roll back (no counter write); if fresh, UPSERT
   *     the counter. Both writes commit atomically.
   *
   * The chain hash is byte-identical to `applyLeaseCounter` — both paths
   * route through `computeNextLeaseStep`. Parity verified against
   * `interlace-spec/0.1.0/test-vectors/lease-counter.json`.
   */
  async verifyLeaseAndAdvanceChain(args: {
    peerFp: string;
    certFp: string;
    nonce:  string;
    ts:     number;
  }): Promise<
    | { replayed: true }
    | { replayed: false; seq: number; last_chain_hash: string }
  > {
    return this.ctx.blockConcurrencyWhile(async () => {
      // Compute the next chain step OUTSIDE transactionSync — the
      // digest is async and transactionSync only accepts sync
      // callbacks. blockConcurrencyWhile ensures the prev-row read +
      // digest + write all see a consistent view (no concurrent same-
      // peer interleave).
      const step = await computeNextLeaseStep(
        this.db,
        args.peerFp,
        args.certFp,
        args.nonce,
        args.ts,
      );

      // Atomic write: nonce ledger + counter UPSERT in one txn. Throwing
      // inside transactionSync rolls back; we use a sentinel error to
      // signal the replay case so the counter UPSERT never lands when
      // the nonce was a duplicate.
      let replayed = false;
      try {
        this.ctx.storage.transactionSync(() => {
          const nonceResult = recordSeenNonceHelper(this.db, args.certFp, args.nonce, args.ts);
          if (!nonceResult.fresh) {
            replayed = true;
            throw REPLAY_SENTINEL;
          }
          writeLeaseCounterRow(
            this.db,
            args.peerFp,
            args.certFp,
            args.ts,
            step.seq,
            step.last_chain_hash,
          );
        });
      } catch (err) {
        if (err !== REPLAY_SENTINEL) throw err;
      }

      if (replayed) return { replayed: true };
      return {
        replayed: false,
        seq:             step.seq,
        last_chain_hash: step.last_chain_hash,
      };
    });
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

  // ── peer_attestations RPC (cloister-bdcbe7) ─────────────────────────────

  /**
   * Append one attestation row for a state-boundary write. The caller
   * (lease middleware on a state-mutating tools/call) supplies the
   * already-verified cert + canonical-bytes digest. Wrapped in
   * blockConcurrencyWhile so the read-then-write across the prev-ref
   * lookup holds the input gate.
   *
   * Returns the new (seq, row) pair on success. Throws
   * AttestationIntegrityError if prev_self_ref is wrong.
   */
  async applyAttestation(args: {
    peerFingerprint: string;
    contentHash:     string;
    contentType:     string;
    scope:           string;
    cert:            Uint8Array;
    sig:             Uint8Array;
    prevSelfRef:     string | null;
    prevPeerRef:     string | null;
    nowMs:           number;
  }): Promise<ApplyAttestationResult> {
    // Helper returns a Result; we just pass it through. blockConcurrencyWhile
    // serializes the read-then-write so concurrent calls can't both see the
    // same chain head + race to a fork (cloister-c66fea pattern).
    //
    // No throws cross the gate boundary — the integrity-failure path is
    // a Result. This eliminates the workerd-RPC unhandled-rejection
    // noise vitest used to see on the test reporter (cloister-175a3a).
    return this.ctx.blockConcurrencyWhile(async () =>
      applyAttestationHelper(this.db, args),
    );
  }

  /** Read the most-recent attestation for a peer, or null if none. */
  lastAttestationForPeer(peerFp: string): PeerAttestation | null {
    return lastAttestationForPeerHelper(this.db, peerFp);
  }

  /** List a peer's attestation chain from `fromSeq` ascending. */
  listAttestationsForPeer(
    peerFp: string,
    options: { fromSeq?: number; limit?: number } = {},
  ): PeerAttestation[] {
    return listAttestationsForPeerHelper(this.db, peerFp, options);
  }

  /** Lookup attestation by (peer, content_hash) — used for retry idempotency. */
  findAttestationByContent(peerFp: string, contentHash: string): PeerAttestation | null {
    return findAttestationByContentHelper(this.db, peerFp, contentHash);
  }

  // ── pending_attestations RPC (cloister-c6d378 retry queue) ──────────────

  /**
   * Enqueue a pending attestation after a TrustStore write fails or is
   * deferred. Idempotent on (peer_fp, content_hash). Returns whether a
   * new row was actually inserted (false = already pending).
   */
  enqueuePendingAttestation(args: {
    peerFp:      string;
    contentHash: string;
    scope:       string;
    cert:        Uint8Array;
    sig:         Uint8Array;
    nowMs:       number;
  }): { enqueued: boolean } {
    return enqueuePendingHelper(this.db, args);
  }

  /** Mark a pending row as committed (deleted) after successful retry. */
  commitPendingAttestation(peerFp: string, contentHash: string): { deleted: boolean } {
    return commitPendingHelper(this.db, peerFp, contentHash);
  }

  /** Increment retry attempts + push next_retry_at on failed retry. */
  recordPendingFailedAttempt(
    peerFp: string,
    contentHash: string,
    nowMs: number,
  ): { newAttempts: number; nextRetryAt: number | null } {
    return recordFailedAttemptHelper(this.db, peerFp, contentHash, nowMs);
  }

  /** List all pending rows for a peer (disclosure endpoint feed). */
  listPendingForPeer(peerFp: string): PendingAttestation[] {
    return listPendingForPeerHelper(this.db, peerFp);
  }
}

export { AttestationIntegrityError };
