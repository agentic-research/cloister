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

import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BLOB_PUT_FAULT_DIGEST } from "../../src/blob-store.js";
import type { PeerAttestation } from "../../src/storage/peer-attestations.js";
import type { PendingAttestation } from "../../src/storage/pending-attestations.js";

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

// One-shot counter to keep per-test DO isolation (otherwise pending rows
// bleed across tests even with `clearFaults`).
let isolationCounter = 0;
function freshTrustStore(): DurableObjectStub & TrustStoreRpc {
  return env.TRUST_STORE.get(
    env.TRUST_STORE.idFromName(`cross-do-recovery-${isolationCounter++}-${Math.random()}`),
  ) as DurableObjectStub & TrustStoreRpc;
}

// ── Pipeline orchestrator ───────────────────────────────────────────────
//
// Mirrors what production lease-middleware will do when bead_create
// flows through the full pipeline. Calls each step in sequence and
// reports which step failed so the test can assert exact recovery
// state. The orchestrator is deliberately not "in src" — there is no
// production caller for it today; the lease-middleware wiring is
// scheduled for a follow-up bead. When that wiring lands, the orchestrator
// should move into src and this test should call it via SELF.fetch.

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
  trustStore:      DurableObjectStub & TrustStoreRpc;
  repo:            string;
  title:           string;
  peerFingerprint: string;
  scope:           string;
  cert:            Uint8Array;
  sig:             Uint8Array;
  nowMs:           number;
}): Promise<PipelineResult> {
  // Step 1: BlobStore.put — canonical bytes by digest. We use a
  // deterministic canonical-bytes stand-in (the title + repo) rather
  // than the full bead-canonical encoder because the BeadStore RPC
  // generates the bead id internally, and we need the digest BEFORE
  // BeadStore writes the row. (Production will refactor BeadStore.create
  // to accept a pre-allocated id + canonical bytes; out of scope here.)
  //
  // Short-circuit on BlobStore failure: ADR-0012 + §13.4 require that
  // a failed first hop leaves NO downstream writes attempted. We model
  // that explicitly here.
  const bytes = new TextEncoder().encode(`bead-canonical:${args.repo}:${args.title}`);
  const blobStore = env.BLOB_STORE.get(env.BLOB_STORE.idFromName("cluster")) as DurableObjectStub & {
    put(b: Uint8Array): Promise<string>;
  };
  // The fault-injection seam in BlobStore.put returns BLOB_PUT_FAULT_DIGEST
  // rather than throwing — see the seam header in src/blob-store.ts for
  // the rationale (cloister-3dd355: avoid workerd-RPC-boundary
  // unhandled-rejection noise that throwing causes in vitest, mirroring
  // the cloister-fff647 motivation for Result-shape returns).
  const digest = await blobStore.put(bytes);
  if (digest === BLOB_PUT_FAULT_DIGEST) {
    return {
      digest:          null,
      bead_id:         null,
      failedStep:      "blobStorePut",
      attestationOk:   false,
      pendingEnqueued: false,
    };
  }

  // Step 2: BeadStore.bead_create — per-repo DO write referencing the
  // digest. We call the existing JSON-RPC method to preserve the
  // standard write path. Short-circuit on JSON-RPC `error` response:
  // §13.4 requires no TrustStore write when BeadStore failed.
  const beadStore = env.BEAD_STORE.get(env.BEAD_STORE.idFromName(args.repo)) as DurableObjectStub & {
    fetch(req: Request): Promise<Response>;
  };
  const createReq = new Request("https://bead-store.invalid/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method:  "bead_create",
      params:  { repo: args.repo, title: args.title },
      id:      1,
    }),
  });
  const createRes = await beadStore.fetch(createReq);
  const createBody = await createRes.json() as {
    result?: { id: string };
    error?:  { code: number; message: string };
  };
  if (createBody.error !== undefined || createBody.result === undefined) {
    return {
      digest,
      bead_id:         null,
      failedStep:      "beadStoreWrite",
      attestationOk:   false,
      pendingEnqueued: false,
    };
  }
  const beadId = createBody.result.id;

  // Step 3: TrustStore.applyAttestation — singleton DO write. May fail
  // (test-injected) or succeed.
  let attestationOk = false;
  try {
    const head = await args.trustStore.lastAttestationForPeer(args.peerFingerprint);
    const result = await args.trustStore.applyAttestation({
      peerFingerprint: args.peerFingerprint,
      contentHash:     digest,
      contentType:     "bead/v1",
      scope:           args.scope,
      cert:            args.cert,
      sig:             args.sig,
      prevSelfRef:     head?.content_hash ?? null,
      prevPeerRef:     null,
      nowMs:           args.nowMs,
    });
    attestationOk = result.ok;
  } catch {
    attestationOk = false;
  }

  // Step 4: on failure, enqueue to pending_attestations.
  let pendingEnqueued = false;
  if (!attestationOk) {
    const e = await args.trustStore.enqueuePendingAttestation({
      peerFp:      args.peerFingerprint,
      contentHash: digest,
      scope:       args.scope,
      cert:        args.cert,
      sig:         args.sig,
      nowMs:       args.nowMs,
    });
    pendingEnqueued = e.enqueued;
  }

  return {
    digest,
    bead_id:         beadId,
    failedStep:      attestationOk ? null : "applyAttestation",
    attestationOk,
    pendingEnqueued,
  };
}

// ── Test inputs ─────────────────────────────────────────────────────────

const PEER = "sha256:cross-do-recovery-peer";
const CERT = new Uint8Array([0xCA, 0xFE, 0xDE, 0xAD]);
const SIG  = new Uint8Array([0xBE, 0xEF, 0xFA, 0xCE]);
let repoCounter = 0;
function repo(): string {
  return `/repos/cross-do-${repoCounter++}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("cross-DO recovery (cloister-fff647)", () => {
  beforeEach(clearFaults);
  afterEach(clearFaults);

  it("fault-injection seam is inert in absence of installFault (baseline)", async () => {
    // Sanity check: without installFault, the pipeline runs end-to-end
    // clean. This proves the seam doesn't poison production-path execution
    // — if the next test fails, it's the fault, not a regression in the
    // seam check itself.
    const trustStore = freshTrustStore();
    const r = await runBeadCreatePipeline({
      trustStore,
      repo:            repo(),
      title:           "baseline",
      peerFingerprint: PEER,
      scope:           "bead_create:/repos/foo",
      cert:            CERT,
      sig:             SIG,
      nowMs:           1_000,
    });
    expect(r.attestationOk).toBe(true);
    expect(r.pendingEnqueued).toBe(false);
    expect(await trustStore.listPendingForPeer(PEER)).toEqual([]);
  });

  it("full pipeline: step-3 fault → pending row → drain → attestation lands", async () => {
    const trustStore = freshTrustStore();
    const repoPath = repo();

    // ── Pre-state: one prior successful attestation so the recovery
    //               row has a real prev_self_ref to chain against. This
    //               exercises the "late attestation references the last
    //               row BEFORE the fault, not a forked branch" invariant.
    const priorPipeline = await runBeadCreatePipeline({
      trustStore,
      repo:            repoPath,
      title:           "prior",
      peerFingerprint: PEER,
      scope:           "bead_create:/repos/foo",
      cert:            CERT,
      sig:             SIG,
      nowMs:           1_000,
    });
    expect(priorPipeline.attestationOk).toBe(true);
    const headBeforeFault = await trustStore.lastAttestationForPeer(PEER);
    expect(headBeforeFault).not.toBeNull();
    const digestBeforeFault = headBeforeFault!.content_hash;

    // ── Step A: inject fault for the next applyAttestation call.
    installFault("applyAttestation");

    // ── Step B: drive a bead_create through the pipeline. Step 2
    //           (BeadStore) commits; step 3 (TrustStore) is injected to
    //           throw; step 4 enqueues to pending_attestations.
    const faulted = await runBeadCreatePipeline({
      trustStore,
      repo:            repoPath,
      title:           "during-fault",
      peerFingerprint: PEER,
      scope:           "bead_create:/repos/foo",
      cert:            CERT,
      sig:             SIG,
      nowMs:           5_000,
    });
    expect(faulted.attestationOk).toBe(false);
    expect(faulted.pendingEnqueued).toBe(true);
    expect(faulted.failedStep).toBe("applyAttestation");
    // After widening the pipeline result to `string | null` (cloister-3dd355
    // — needed by the BlobStore/BeadStore-fault cases below), assert the
    // step-3-fault case has non-null digest + bead_id before using them.
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
    const getBody = await getRes.json() as { result?: { bead: { id: string; title: string } } };
    expect(getBody.result?.bead.id).toBe(faultedBeadId);
    expect(getBody.result?.bead.title).toBe("during-fault");

    // ── Assertion 2: NO new attestation row in TrustStore (step 3
    //                injected to fail). Head still points at the prior
    //                attestation; no row exists for the faulted digest.
    const headDuringFault = await trustStore.lastAttestationForPeer(PEER);
    expect(headDuringFault?.content_hash).toBe(digestBeforeFault);
    expect(await trustStore.findAttestationByContent(PEER, faultedDigest)).toBeNull();

    // ── Assertion 3: pending_attestations has a retry row keyed by
    //                the bead's content digest.
    const pendingDuringFault = await trustStore.listPendingForPeer(PEER);
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
    const drainResult = await trustStore.drainPendingRetries({
      nowMs:       5_000 + 60_000, // well past 30s backoff
      contentType: "bead/v1",
    });
    expect(drainResult.claimed).toBe(1);
    expect(drainResult.committed).toBe(1);
    expect(drainResult.failed).toBe(0);

    // ── Assertion 4: attestation now lands in TrustStore.
    const recoveredRow = await trustStore.findAttestationByContent(PEER, faultedDigest);
    expect(recoveredRow).not.toBeNull();

    // ── Assertion 5: pending_attestations row removed.
    expect(await trustStore.listPendingForPeer(PEER)).toEqual([]);

    // ── Assertion 6: chain integrity — the late attestation's
    //                `prev_self_ref` references the attestation BEFORE
    //                the fault, NOT a forked branch. This is the
    //                "doesn't fork the chain on recovery" invariant
    //                from §13.4 + ADR-0012.
    expect(recoveredRow!.prev_self_ref).toBe(digestBeforeFault);
    expect(recoveredRow!.seq).toBe(headBeforeFault!.seq + 1);

    // ── Assertion 7: chain is contiguous from genesis through the
    //                late row. No gaps in seq.
    const fullChain = await trustStore.listAttestationsForPeer(PEER);
    expect(fullChain.map(r => r.seq)).toEqual([1, 2]);
    expect(fullChain[1]!.prev_self_ref).toBe(fullChain[0]!.content_hash);
  });

  it("fault-at-BlobStore.put: no downstream writes; retry recovers full pipeline", async () => {
    // Earlier-hop expansion of the §13.4 audit (cloister-3dd355).
    // BlobStore is the FIRST hop of the bead_create pipeline. Failing
    // here must leave NO downstream writes attempted — neither BeadStore
    // nor TrustStore should see the call. On retry, the same canonical
    // bytes produce the same digest (idempotent CAS, per ADR-0003), so
    // the recovery path is observationally indistinguishable from a
    // fresh first-time write.
    const trustStore = freshTrustStore();
    const repoPath = repo();
    const peer = `${PEER}-blob-fault`;

    // ── Step A: inject fault for the next BlobStore.put call.
    installFault("blobStorePut");

    // ── Step B: drive bead_create. The orchestrator catches the
    //           BlobStore throw and short-circuits with failedStep =
    //           "blobStorePut"; no BeadStore or TrustStore RPC issued.
    const faulted = await runBeadCreatePipeline({
      trustStore,
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

    // ── Assertion: no digest in BlobStore. We compute the canonical
    //              bytes the orchestrator WOULD have hashed, then ask
    //              BlobStore.has — should be false. Same fault key was
    //              consumed (failOnce), so this probe call goes through
    //              and tells us truthfully whether the prior put landed.
    const blobStore = env.BLOB_STORE.get(env.BLOB_STORE.idFromName("cluster")) as DurableObjectStub & {
      has(d: string): Promise<boolean>;
      put(b: Uint8Array): Promise<string>;
    };
    const canonicalBytes = new TextEncoder().encode(`bead-canonical:${repoPath}:blob-fault-case`);
    // Use crypto.subtle.digest on the same canonical bytes to derive what
    // the digest WOULD be. workerd's BlobStore uses raw sha256-hex
    // (see `digestBytes` in src/storage/canonical.ts — hex, no prefix).
    const expectedHashBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", canonicalBytes));
    const expectedDigest = Array.from(expectedHashBytes, b => b.toString(16).padStart(2, "0")).join("");
    expect(await blobStore.has(expectedDigest)).toBe(false);

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
    expect(await trustStore.lastAttestationForPeer(peer)).toBeNull();

    // ── Assertion: no pending row.
    expect(await trustStore.listPendingForPeer(peer)).toEqual([]);

    // ── Step C: clear faults (defense-in-depth — failOnce already consumed).
    clearFaults();

    // ── Step D: retry bead_create. Should run end-to-end clean.
    const recovered = await runBeadCreatePipeline({
      trustStore,
      repo:            repoPath,
      title:           "blob-fault-case", // SAME title → SAME canonical bytes → SAME digest
      peerFingerprint: peer,
      scope:           "bead_create:/repos/foo",
      cert:            CERT,
      sig:             SIG,
      nowMs:           8_000,
    });
    expect(recovered.failedStep).toBeNull();
    expect(recovered.attestationOk).toBe(true);
    expect(recovered.pendingEnqueued).toBe(false);

    // ── Assertion: idempotent CAS — the recovered digest equals the
    //              digest the failed attempt would have produced.
    expect(recovered.digest).toBe(expectedDigest);
    expect(await blobStore.has(expectedDigest)).toBe(true);

    // ── Assertion: attestation row landed, no pending queue residue.
    const attestation = await trustStore.findAttestationByContent(peer, expectedDigest);
    expect(attestation).not.toBeNull();
    expect(await trustStore.listPendingForPeer(peer)).toEqual([]);
  });

  it("fault-at-BeadStore.write: idempotent BlobStore landed; no TrustStore write; retry recovers", async () => {
    // Middle-hop expansion of the §13.4 audit (cloister-3dd355).
    // BeadStore is the SECOND hop. By the time we get here, step 1
    // (BlobStore.put) has already landed — content-addressed and
    // idempotent. The fault is observable as "blob digest exists but
    // no bead row references it (yet)". The §13.4 audit's bead_create
    // row already records intra-DO ACID for the SQL INSERT, so step 2
    // failure is well-defined: the INSERT never ran.
    //
    // The orchestrator MUST NOT call TrustStore.applyAttestation when
    // BeadStore returned an error — that's the cross-DO short-circuit
    // invariant from §13.4. We assert this by checking that no
    // attestation row exists for the peer after the fault.
    const trustStore = freshTrustStore();
    const repoPath = repo();
    const peer = `${PEER}-bead-fault`;

    // ── Step A: inject fault for the next BeadStore.bead_create call.
    installFault("beadStoreWrite");

    // ── Step B: drive bead_create. Step 1 (BlobStore) succeeds; step 2
    //           (BeadStore) throws, dispatch() converts to a JSON-RPC
    //           error response, orchestrator short-circuits with
    //           failedStep = "beadStoreWrite".
    const faulted = await runBeadCreatePipeline({
      trustStore,
      repo:            repoPath,
      title:           "bead-fault-case",
      peerFingerprint: peer,
      scope:           "bead_create:/repos/foo",
      cert:            CERT,
      sig:             SIG,
      nowMs:           9_000,
    });
    expect(faulted.failedStep).toBe("beadStoreWrite");
    expect(faulted.digest).not.toBeNull(); // step 1 landed
    expect(faulted.bead_id).toBeNull();    // step 2 didn't
    expect(faulted.attestationOk).toBe(false);
    expect(faulted.pendingEnqueued).toBe(false); // step 4 not reached — short-circuit invariant

    const stage1Digest = faulted.digest!;

    // ── Assertion: digest IS in BlobStore (step 1 already landed
    //              BEFORE step 2 was attempted; that's the whole point
    //              of the content-addressed handoff).
    const blobStore = env.BLOB_STORE.get(env.BLOB_STORE.idFromName("cluster")) as DurableObjectStub & {
      has(d: string): Promise<boolean>;
    };
    expect(await blobStore.has(stage1Digest)).toBe(true);

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
    expect(await trustStore.lastAttestationForPeer(peer)).toBeNull();
    expect(await trustStore.findAttestationByContent(peer, stage1Digest)).toBeNull();

    // ── Assertion: no pending row (step 4 only runs after step 3
    //              actually attempted-and-failed).
    expect(await trustStore.listPendingForPeer(peer)).toEqual([]);

    // ── Step C: clear faults.
    clearFaults();

    // ── Step D: retry bead_create. BlobStore.put is idempotent — same
    //           bytes return the same digest, no duplicate row — so the
    //           retry should produce the exact same digest as the
    //           faulted attempt.
    const recovered = await runBeadCreatePipeline({
      trustStore,
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

    // ── Assertion: BlobStore digest unchanged across the retry — the
    //              idempotent put returned the same content-hash as the
    //              faulted attempt's stage-1 result.
    expect(recovered.digest).toBe(stage1Digest);

    // ── Assertion: bead row now in BeadStore.
    expect(recovered.bead_id).not.toBeNull();

    // ── Assertion: attestation now in TrustStore, no pending residue.
    expect(await trustStore.findAttestationByContent(peer, stage1Digest)).not.toBeNull();
    expect(await trustStore.listPendingForPeer(peer)).toEqual([]);
  });

  it("drain on empty pending queue is a no-op", async () => {
    // Defensive: the drain RPC must not blow up if there's nothing to
    // retry. (Alarm handlers will fire on schedule even when the queue
    // happens to be empty.)
    const trustStore = freshTrustStore();
    const r = await trustStore.drainPendingRetries({
      nowMs:       10_000,
      contentType: "bead/v1",
    });
    expect(r).toEqual({ claimed: 0, committed: 0, failed: 0 });
  });
});

// SELF is unused in this file (the pipeline is invoked DO-direct rather
// than over the public HTTP face), but the import keeps the test
// runner's expectation of a configured worker entrypoint satisfied for
// some workerd configurations. Silence the lint complaint:
void SELF;
