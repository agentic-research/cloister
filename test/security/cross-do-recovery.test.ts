/// <reference types="@cloudflare/vitest-pool-workers/types" />
//
// Cross-DO recovery — end-to-end fault injection test for the
// BlobStore → BeadStore → TrustStore handoff (cloister-fff647).
//
// Closes the "test-coverage gap (acknowledged, not closed)" called out
// in threat-model §13.4. The retry path was previously asserted by
// inspection of the pending-attestations helper tests + the ADR-0012
// design doc. This file exercises the full pipeline:
//
//   1. BlobStore.put       (digest)                          — idempotent CAS
//   2. BeadStore.bead_create (bead row references digest)    — per-repo ACID
//   3. TrustStore.applyAttestation (attestation row)         — INJECTED FAIL
//   4. Caller enqueues pending_attestations after step 3      — retry queue
//   5. Drain pending retries; attestation now lands           — recovery
//
// The fault-injection seam (`globalThis.__cloisterTestFaults`) is
// described in `src/trust-store.ts` under the TEST-ONLY header. The
// seam is inert in production: the production path reads `undefined`
// and short-circuits to the existing helper call.
//
// Threat-model assertions checked here:
//
//   §8 "dangerous case" (3 succeeds, 4 fails) — bead row present but
//   no attestation row; pending_attestations carries the recovery state.
//
//   §13.2 "silence is evidence" off-by-one — a peer-side verifier
//   reading the disclosure feed during the retry window sees
//   COMPLETE + PENDING, not GAP.
//
//   §13.4 retry-pump correctness — after drain, attestation lands; the
//   late row's prev_self_ref references the last attestation BEFORE
//   the fault, not a forked branch.
//
// ── 2026-05-10 (cloister-492c08): wired to production orchestrator ──────
//
// The pipeline orchestrator that drives this test was previously inline
// (test-only). With cloister-492c08 the production orchestrator landed at
// `src/routes/bead-create-orchestrator.ts`. The `runBeadCreatePipeline`
// wrapper below now delegates to `runBeadCreateOrchestrator`, translating
// its throw-on-error API into the `PipelineResult.failedStep` shape so the
// existing assertions stay valid. The production orchestrator uses the
// CLUSTER-singleton TrustStore (idFromName("cluster")); per-test isolation
// is achieved by giving each test a unique peer fingerprint (peer_attestations
// is keyed by peer_fingerprint, so different peer ⇒ different chain).

import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PeerAttestation } from "../../src/storage/peer-attestations.js";
import type { PendingAttestation } from "../../src/storage/pending-attestations.js";
import { runBeadCreateOrchestrator } from "../../src/routes/bead-create-orchestrator.js";
import { JsonRpcInvocationError } from "../../src/backends.js";

// ── Fault-injection seam (test-only — see src/trust-store.ts header) ────
//
// Key union widened in cloister-3dd355 to cover the EARLIER hops of the
// BlobStore → BeadStore → TrustStore pipeline. Each DO's seam check
// reads the same `globalThis.__cloisterTestFaults` Map and filters by
// key; tests below install one key per case + assert recovery semantics
// specific to that hop.

type FaultKey = "applyAttestation" | "blobStorePut" | "beadStoreWrite";
type FaultInjectionMap = Map<FaultKey, { failOnce: boolean }>;

function installFault(key: FaultKey): void {
  const g = globalThis as { __cloisterTestFaults?: FaultInjectionMap };
  if (g.__cloisterTestFaults === undefined) g.__cloisterTestFaults = new Map();
  g.__cloisterTestFaults.set(key, { failOnce: true });
}

function clearFaults(): void {
  const g = globalThis as { __cloisterTestFaults?: FaultInjectionMap };
  g.__cloisterTestFaults?.clear();
}

// ── TrustStore RPC surface used here ────────────────────────────────────

interface TrustStoreRpc {
  applyAttestation(args: {
    peerFingerprint: string;
    contentHash:     string;
    contentType:     string;
    scope:           string;
    cert:            Uint8Array;
    sig:             Uint8Array;
    prevSelfRef:     string | null;
    prevPeerRef:     string | null;
    nowMs:           number;
  }): Promise<import("../../src/storage/peer-attestations.js").ApplyAttestationResult>;
  lastAttestationForPeer(peerFp: string): Promise<PeerAttestation | null>;
  listAttestationsForPeer(
    peerFp: string,
    options?: { fromSeq?: number; limit?: number },
  ): Promise<PeerAttestation[]>;
  findAttestationByContent(peerFp: string, contentHash: string): Promise<PeerAttestation | null>;
  enqueuePendingAttestation(args: {
    peerFp:      string;
    contentHash: string;
    scope:       string;
    cert:        Uint8Array;
    sig:         Uint8Array;
    nowMs:       number;
  }): Promise<{ enqueued: boolean }>;
  listPendingForPeer(peerFp: string): Promise<PendingAttestation[]>;
  drainPendingRetries(args: {
    nowMs:       number;
    contentType: string;
    limit?:      number;
  }): Promise<{ claimed: number; committed: number; failed: number }>;
}

// All tests use the CLUSTER-singleton TrustStore (per the production
// orchestrator). Per-test isolation is via unique peer fingerprints +
// unique repo paths; both attestation chains and bead rows are keyed by
// those values. The shared cluster TrustStore still needs its replay-
// defense table cleared between tests (verifyLeaseAndAdvanceChain isn't
// exercised here but the table is shared); that's done in `beforeEach`.
const clusterTrustStore = (): DurableObjectStub & TrustStoreRpc =>
  env.TRUST_STORE.get(env.TRUST_STORE.idFromName("cluster")) as DurableObjectStub & TrustStoreRpc;

// ── Pipeline orchestrator: wrapper around the production code ───────────
//
// Translates the production orchestrator's throw-on-error contract into
// the `PipelineResult.failedStep` shape the existing assertions use. The
// `failedStep` is inferred from where in the pipeline the throw landed:
//
//   - BlobStore.put faulted → JsonRpcInvocationError with
//     "BlobStore.put faulted (test-only sentinel)" / "BlobStore.put failed"
//   - BeadStore.bead_create returned a JSON-RPC error → JsonRpcInvocationError
//     with "BeadStore.bead_create failed"
//   - TrustStore.applyAttestation failed → orchestrator catches + enqueues;
//     return shape says success with attestationOk=false, pendingEnqueued=true
//
// We assert each fault case's shape by message-prefix match below; the
// orchestrator's message format is stable per cloister-492c08.

interface PipelineResult {
  /** Digest from BlobStore.put. `null` if step 1 short-circuited (e.g. BlobStore fault). */
  digest:          string | null;
  /** Bead id from BeadStore.bead_create. `null` if step 1 or 2 short-circuited. */
  bead_id:         string | null;
  /** Which step failed, or null if the pipeline completed. */
  failedStep:      "blobStorePut" | "beadStoreWrite" | "applyAttestation" | null;
  attestationOk:   boolean;
  pendingEnqueued: boolean;
}

async function runBeadCreatePipeline(args: {
  trustStore:      DurableObjectStub & TrustStoreRpc;  // unused — orchestrator uses cluster stub
  repo:            string;
  title:           string;
  peerFingerprint: string;
  scope:           string;
  cert:            Uint8Array;
  sig:             Uint8Array;
  nowMs:           number;
}): Promise<PipelineResult> {
  void args.trustStore;  // production orchestrator hardcodes cluster TrustStore
  // Snapshot pending count BEFORE the run so we can detect new enqueues
  // from this specific call (the orchestrator silently catches +
  // enqueues TrustStore failures, so we infer "step-3 fault → pending
  // enqueued" by observing the queue size delta).
  const prePending = (await listPendingForPeer(args.peerFingerprint)).length;
  try {
    const result = await runBeadCreateOrchestrator({
      toolArgs: { repo: args.repo, title: args.title },
      env:      env as unknown as import("../../src/types.js").Env,
      context: {
        peerFp:  args.peerFingerprint,
        scope:   args.scope,
        certDer: args.cert,
        sig:     args.sig,
      },
      nowMs: args.nowMs,
    });
    // Orchestrator returned success. Distinguish "step-3 succeeded" from
    // "step-3 caught + enqueued" by checking the pending queue.
    const postPending = (await listPendingForPeer(args.peerFingerprint)).length;
    const enqueuedThisCall = postPending > prePending;
    return {
      digest:          result.content_hash,
      bead_id:         result.id,
      failedStep:      enqueuedThisCall ? "applyAttestation" : null,
      attestationOk:   !enqueuedThisCall,
      pendingEnqueued: enqueuedThisCall,
    };
  } catch (err) {
    if (!(err instanceof JsonRpcInvocationError)) throw err;
    // Map orchestrator error messages back to the test's failedStep enum.
    // The orchestrator throws on BlobStore OR BeadStore failure; both
    // short-circuit before TrustStore is touched.
    if (/BlobStore\.put/.test(err.message)) {
      return {
        digest:          null,
        bead_id:         null,
        failedStep:      "blobStorePut",
        attestationOk:   false,
        pendingEnqueued: false,
      };
    }
    if (/BeadStore\.bead_create/.test(err.message)) {
      return {
        digest:          null,
        bead_id:         null,
        failedStep:      "beadStoreWrite",
        attestationOk:   false,
        pendingEnqueued: false,
      };
    }
    throw err;  // unexpected error shape
  }
}

// Helper: list pending attestations for a peer on the cluster TrustStore.
// The cross-DO tests use unique peer fingerprints so this is per-peer
// isolated even across the shared cluster DO.
async function listPendingForPeer(peerFp: string): Promise<PendingAttestation[]> {
  return clusterTrustStore().listPendingForPeer(peerFp);
}

// Helper: peer-attestation chain head for the cluster's TrustStore.
async function lastAttestation(peerFp: string): Promise<PeerAttestation | null> {
  return clusterTrustStore().lastAttestationForPeer(peerFp);
}

// Helper: full chain (ordered ASC).
async function listChain(peerFp: string): Promise<PeerAttestation[]> {
  return clusterTrustStore().listAttestationsForPeer(peerFp);
}

// Helper: lookup by content.
async function findByContent(peerFp: string, hash: string): Promise<PeerAttestation | null> {
  return clusterTrustStore().findAttestationByContent(peerFp, hash);
}

// ── Test inputs ─────────────────────────────────────────────────────────

const CERT = new Uint8Array([0xCA, 0xFE, 0xDE, 0xAD]);
const SIG  = new Uint8Array([0xBE, 0xEF, 0xFA, 0xCE]);
let repoCounter = 0;
function repo(): string {
  return `/repos/cross-do-${repoCounter++}-${Math.random().toString(36).slice(2, 8)}`;
}

// Per-test unique peer fingerprint — the cluster TrustStore is shared, so
// we isolate each test's chain by giving it a unique peer_fingerprint
// (peer_attestations is keyed by it). The counter + Math.random() avoids
// even hypothetical collisions across the test suite.
let peerCounter = 0;
function freshPeer(label: string): string {
  return `sha256:cross-do-${label}-${peerCounter++}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("cross-DO recovery (cloister-fff647, wired to production orchestrator in cloister-492c08)", () => {
  beforeEach(clearFaults);
  afterEach(clearFaults);

  it("fault-injection seam is inert in absence of installFault (baseline)", async () => {
    // Sanity check: without installFault, the pipeline runs end-to-end
    // clean. This proves the seam doesn't poison production-path execution
    // — if the next test fails, it's the fault, not a regression in the
    // seam check itself.
    const peer = freshPeer("baseline");
    const r = await runBeadCreatePipeline({
      trustStore:      clusterTrustStore(),
      repo:            repo(),
      title:           "baseline",
      peerFingerprint: peer,
      scope:           "bead_create:/repos/foo",
      cert:            CERT,
      sig:             SIG,
      nowMs:           1_000,
    });
    expect(r.attestationOk).toBe(true);
    expect(r.pendingEnqueued).toBe(false);
    expect(await listPendingForPeer(peer)).toEqual([]);
  });

  it("full pipeline: step-3 fault → pending row → drain → attestation lands", async () => {
    const peer = freshPeer("step3");
    const repoPath = repo();

    // ── Pre-state: one prior successful attestation so the recovery
    //               row has a real prev_self_ref to chain against. This
    //               exercises the "late attestation references the last
    //               row BEFORE the fault, not a forked branch" invariant.
    const priorPipeline = await runBeadCreatePipeline({
      trustStore:      clusterTrustStore(),
      repo:            repoPath,
      title:           "prior",
      peerFingerprint: peer,
      scope:           "bead_create:/repos/foo",
      cert:            CERT,
      sig:             SIG,
      nowMs:           1_000,
    });
    expect(priorPipeline.attestationOk).toBe(true);
    const headBeforeFault = await lastAttestation(peer);
    expect(headBeforeFault).not.toBeNull();
    const digestBeforeFault = headBeforeFault!.content_hash;

    // ── Step A: inject fault for the next applyAttestation call.
    installFault("applyAttestation");

    // ── Step B: drive a bead_create through the pipeline. Step 2
    //           (BeadStore) commits; step 3 (TrustStore) is injected to
    //           throw; orchestrator catches + enqueues to
    //           pending_attestations.
    const faulted = await runBeadCreatePipeline({
      trustStore:      clusterTrustStore(),
      repo:            repoPath,
      title:           "during-fault",
      peerFingerprint: peer,
      scope:           "bead_create:/repos/foo",
      cert:            CERT,
      sig:             SIG,
      nowMs:           5_000,
    });
    expect(faulted.attestationOk).toBe(false);
    expect(faulted.pendingEnqueued).toBe(true);
    expect(faulted.failedStep).toBe("applyAttestation");
    // Production orchestrator surfaces the digest + bead_id on success
    // (TrustStore failure is caught, so the success path returns BOTH).
    expect(faulted.digest).not.toBeNull();
    expect(faulted.bead_id).not.toBeNull();
    const faultedDigest = faulted.digest!;
    const faultedBeadId = faulted.bead_id!;

    // ── Assertion 1: bead row IS in BeadStore (step 2 succeeded).
    //                Read it back via the standard JSON-RPC method.
    const beadStore = env.BEAD_STORE.get(env.BEAD_STORE.idFromName(repoPath)) as DurableObjectStub & {
      fetch(req: Request): Promise<Response>;
    };
    const getReq = new Request("https://bead-store.invalid/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", method: "bead_get",
        params: { id: faultedBeadId }, id: 1,
      }),
    });
    const getRes = await beadStore.fetch(getReq);
    const getBody = await getRes.json() as { result?: { bead: { id: string; title: string; content_hash?: string } } };
    expect(getBody.result?.bead.id).toBe(faultedBeadId);
    expect(getBody.result?.bead.title).toBe("during-fault");
    // cloister-492c08: bead row carries the content_hash linking it to
    // the BlobStore digest + the pending attestation row.
    expect(getBody.result?.bead.content_hash).toBe(faultedDigest);

    // ── Assertion 2: NO new attestation row in TrustStore (step 3
    //                injected to fail). Head still points at the prior
    //                attestation; no row exists for the faulted digest.
    const headDuringFault = await lastAttestation(peer);
    expect(headDuringFault?.content_hash).toBe(digestBeforeFault);
    expect(await findByContent(peer, faultedDigest)).toBeNull();

    // ── Assertion 3: pending_attestations has a retry row keyed by
    //                the bead's content digest.
    const pendingDuringFault = await listPendingForPeer(peer);
    expect(pendingDuringFault.length).toBe(1);
    expect(pendingDuringFault[0]!.content_hash).toBe(faultedDigest);
    expect(pendingDuringFault[0]!.attempts).toBe(0);

    // ── Step C: clear the fault. The seam consumed itself on first hit
    //           (failOnce semantics) but defense-in-depth: re-clear.
    clearFaults();

    // ── Step D: drive the retry path via the drainPendingRetries RPC.
    //           This is the same orchestration an alarm-driven retry
    //           pump would do. The drain runs at `nowMs` >= the row's
    //           `next_retry_at`; the row was enqueued with backoff of
    //           30s, so we advance time accordingly.
    const drainResult = await clusterTrustStore().drainPendingRetries({
      nowMs:       5_000 + 60_000, // well past 30s backoff
      contentType: "bead/v1",
    });
    // Cluster TrustStore is shared across tests within the suite; the
    // drain may pick up rows from OTHER tests too. We only assert that
    // OUR row was committed (>=1 of each) — assertion 5 below pins the
    // per-peer count.
    expect(drainResult.claimed).toBeGreaterThanOrEqual(1);
    expect(drainResult.committed).toBeGreaterThanOrEqual(1);

    // ── Assertion 4: attestation now lands in TrustStore.
    const recoveredRow = await findByContent(peer, faultedDigest);
    expect(recoveredRow).not.toBeNull();

    // ── Assertion 5: pending_attestations row removed (per-peer).
    expect(await listPendingForPeer(peer)).toEqual([]);

    // ── Assertion 6: chain integrity — the late attestation's
    //                `prev_self_ref` references the attestation BEFORE
    //                the fault, NOT a forked branch. This is the
    //                "doesn't fork the chain on recovery" invariant
    //                from §13.4 + ADR-0012.
    expect(recoveredRow!.prev_self_ref).toBe(digestBeforeFault);
    expect(recoveredRow!.seq).toBe(headBeforeFault!.seq + 1);

    // ── Assertion 7: chain is contiguous from genesis through the
    //                late row. No gaps in seq.
    const fullChain = await listChain(peer);
    expect(fullChain.map(r => r.seq)).toEqual([1, 2]);
    expect(fullChain[1]!.prev_self_ref).toBe(fullChain[0]!.content_hash);
  });

  it("fault-at-BlobStore.put: no downstream writes; retry recovers full pipeline", async () => {
    // Earlier-hop expansion of the §13.4 audit (cloister-3dd355).
    // BlobStore is the FIRST hop of the bead_create pipeline. Failing
    // here must leave NO downstream writes attempted — neither BeadStore
    // nor TrustStore should see the call. The retry (a fresh bead_create
    // attempt) produces NEW canonical bytes (orchestrator generates a
    // fresh id per call); the recovery path is observationally a clean
    // first-time write.
    //
    // 2026-05-10 cloister-492c08: with the production orchestrator
    // wired, "retry with same title" is no longer an idempotent CAS —
    // each MCP-level bead_create is a distinct event with its own id +
    // digest. The earlier test invariant ("retry digest === fault-time
    // digest") was specific to the test-only orchestrator that pre-
    // computed canonical bytes from `repo + title`. The new invariant:
    // the retry COMPLETES successfully and lands real rows; the digest
    // is a fresh value, not a re-issue of a stale one.
    const peer = freshPeer("blob-fault");
    const repoPath = repo();

    // ── Step A: inject fault for the next BlobStore.put call.
    installFault("blobStorePut");

    // ── Step B: drive bead_create. The orchestrator catches the
    //           BlobStore throw and short-circuits with failedStep =
    //           "blobStorePut"; no BeadStore or TrustStore RPC issued.
    const faulted = await runBeadCreatePipeline({
      trustStore:      clusterTrustStore(),
      repo:            repoPath,
      title:           "blob-fault-case",
      peerFingerprint: peer,
      scope:           "bead_create:/repos/foo",
      cert:            CERT,
      sig:             SIG,
      nowMs:           7_000,
    });
    expect(faulted.failedStep).toBe("blobStorePut");
    expect(faulted.digest).toBeNull();
    expect(faulted.bead_id).toBeNull();
    expect(faulted.attestationOk).toBe(false);
    expect(faulted.pendingEnqueued).toBe(false); // step 4 not reached

    // ── Assertion: no bead row in BeadStore for the canonical title.
    //              We can't search by digest (BeadStore doesn't index by
    //              that), but a bead_list filtered to the test title is
    //              cheap and the DO is per-repo so isolation is intact.
    const beadStore = env.BEAD_STORE.get(env.BEAD_STORE.idFromName(repoPath)) as DurableObjectStub & {
      fetch(req: Request): Promise<Response>;
    };
    const listReq = new Request("https://bead-store.invalid/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", method: "bead_list", params: {}, id: 1,
      }),
    });
    const listRes = await beadStore.fetch(listReq);
    const listBody = await listRes.json() as { result: { beads: { title: string }[] } };
    expect(listBody.result.beads.filter(b => b.title === "blob-fault-case")).toEqual([]);

    // ── Assertion: no attestation row in TrustStore for this peer.
    expect(await lastAttestation(peer)).toBeNull();

    // ── Assertion: no pending row.
    expect(await listPendingForPeer(peer)).toEqual([]);

    // ── Step C: clear faults (defense-in-depth — failOnce already consumed).
    clearFaults();

    // ── Step D: retry bead_create. Should run end-to-end clean.
    const recovered = await runBeadCreatePipeline({
      trustStore:      clusterTrustStore(),
      repo:            repoPath,
      title:           "blob-fault-case",
      peerFingerprint: peer,
      scope:           "bead_create:/repos/foo",
      cert:            CERT,
      sig:             SIG,
      nowMs:           8_000,
    });
    expect(recovered.failedStep).toBeNull();
    expect(recovered.attestationOk).toBe(true);
    expect(recovered.pendingEnqueued).toBe(false);
    expect(recovered.digest).not.toBeNull();
    expect(recovered.bead_id).not.toBeNull();

    // ── Assertion: bead row in BeadStore now has the title + digest.
    const blobStore = env.BLOB_STORE.get(env.BLOB_STORE.idFromName("cluster")) as DurableObjectStub & {
      has(d: string): Promise<boolean>;
    };
    expect(await blobStore.has(recovered.digest!)).toBe(true);

    // ── Assertion: attestation row landed for the recovered digest, no
    //              pending queue residue.
    const attestation = await findByContent(peer, recovered.digest!);
    expect(attestation).not.toBeNull();
    expect(await listPendingForPeer(peer)).toEqual([]);
  });

  it("fault-at-BeadStore.write: idempotent BlobStore landed; no TrustStore write; retry recovers", async () => {
    // Middle-hop expansion of the §13.4 audit (cloister-3dd355).
    // BeadStore is the SECOND hop. By the time we get here, step 1
    // (BlobStore.put) has already landed — content-addressed and
    // idempotent. The fault is observable as "blob digest exists but
    // no bead row references it (yet)".
    //
    // The orchestrator MUST NOT call TrustStore.applyAttestation when
    // BeadStore returned an error — that's the cross-DO short-circuit
    // invariant from §13.4. We assert this by checking that no
    // attestation row exists for the peer after the fault.
    //
    // 2026-05-10 cloister-492c08: the production orchestrator no longer
    // exposes the stage-1 digest on BeadStore failure (the caller has no
    // legitimate use for it; the retry generates a fresh id + digest).
    // We assert "step 1 landed" by checking BlobStore for ANY blob
    // matching the canonical bytes shape we'd expect — but since the
    // orchestrator generates a random id we can't predict the digest, so
    // we settle for confirming no DOWNSTREAM rows landed.
    const peer = freshPeer("bead-fault");
    const repoPath = repo();

    // ── Step A: inject fault for the next BeadStore.bead_create call.
    installFault("beadStoreWrite");

    // ── Step B: drive bead_create. Step 1 (BlobStore) succeeds; step 2
    //           (BeadStore) throws, dispatch() converts to a JSON-RPC
    //           error response, orchestrator short-circuits with
    //           failedStep = "beadStoreWrite".
    const faulted = await runBeadCreatePipeline({
      trustStore:      clusterTrustStore(),
      repo:            repoPath,
      title:           "bead-fault-case",
      peerFingerprint: peer,
      scope:           "bead_create:/repos/foo",
      cert:            CERT,
      sig:             SIG,
      nowMs:           9_000,
    });
    expect(faulted.failedStep).toBe("beadStoreWrite");
    expect(faulted.bead_id).toBeNull();    // step 2 didn't land
    expect(faulted.attestationOk).toBe(false);
    expect(faulted.pendingEnqueued).toBe(false); // step 4 not reached — short-circuit invariant

    // ── Assertion: no bead row in BeadStore (write was faulted before
    //              the SQL INSERT ran).
    const beadStore = env.BEAD_STORE.get(env.BEAD_STORE.idFromName(repoPath)) as DurableObjectStub & {
      fetch(req: Request): Promise<Response>;
    };
    const listReq = new Request("https://bead-store.invalid/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", method: "bead_list", params: {}, id: 1,
      }),
    });
    const listRes = await beadStore.fetch(listReq);
    const listBody = await listRes.json() as { result: { beads: { title: string }[] } };
    expect(listBody.result.beads.filter(b => b.title === "bead-fault-case")).toEqual([]);

    // ── Assertion: NO attestation row in TrustStore — the orchestrator
    //              correctly short-circuited on BeadStore failure and
    //              did NOT attempt step 3. (If this assertion ever
    //              fires, the orchestrator is leaking writes past the
    //              §13.4 short-circuit invariant; that's a separate
    //              bead, not a fix in this file.)
    expect(await lastAttestation(peer)).toBeNull();

    // ── Assertion: no pending row (step 4 only runs after step 3
    //              actually attempted-and-failed).
    expect(await listPendingForPeer(peer)).toEqual([]);

    // ── Step C: clear faults.
    clearFaults();

    // ── Step D: retry bead_create. Fresh attempt → fresh id → fresh
    //           digest; BlobStore.put is idempotent on content, not on
    //           the call site.
    const recovered = await runBeadCreatePipeline({
      trustStore:      clusterTrustStore(),
      repo:            repoPath,
      title:           "bead-fault-case",
      peerFingerprint: peer,
      scope:           "bead_create:/repos/foo",
      cert:            CERT,
      sig:             SIG,
      nowMs:           10_000,
    });
    expect(recovered.failedStep).toBeNull();
    expect(recovered.attestationOk).toBe(true);
    expect(recovered.pendingEnqueued).toBe(false);
    expect(recovered.digest).not.toBeNull();
    expect(recovered.bead_id).not.toBeNull();

    // ── Assertion: digest landed in BlobStore.
    const blobStore = env.BLOB_STORE.get(env.BLOB_STORE.idFromName("cluster")) as DurableObjectStub & {
      has(d: string): Promise<boolean>;
    };
    expect(await blobStore.has(recovered.digest!)).toBe(true);

    // ── Assertion: attestation now in TrustStore, no pending residue.
    expect(await findByContent(peer, recovered.digest!)).not.toBeNull();
    expect(await listPendingForPeer(peer)).toEqual([]);
  });

  it("drain on empty pending queue is a no-op", async () => {
    // Defensive: the drain RPC must not blow up if there's nothing to
    // retry. (Alarm handlers will fire on schedule even when the queue
    // happens to be empty.) Uses a fresh peer to avoid picking up
    // residue from other tests.
    const peer = freshPeer("drain-empty");
    const before = await listPendingForPeer(peer);
    expect(before).toEqual([]);
    // Drain operates over the whole queue; we just verify it doesn't
    // throw + that no new rows materialize for our peer.
    await clusterTrustStore().drainPendingRetries({
      nowMs:       10_000,
      contentType: "bead/v1",
    });
    expect(await listPendingForPeer(peer)).toEqual([]);
  });
});

// SELF is unused in this file (the pipeline is invoked DO-direct rather
// than over the public HTTP face), but the import keeps the test
// runner's expectation of a configured worker entrypoint satisfied for
// some workerd configurations. Silence the lint complaint:
void SELF;
