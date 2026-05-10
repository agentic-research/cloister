// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Disclosure endpoint — `GET /interlace/peers/{fingerprint}`.
//
// Per ADR-0007 §11 + the threat model §9. Streams a peer's
// `peer_attestations` chain plus pending-state for the `(actor, peer)`
// pair so a third-party verifier can reconstruct + audit the chain
// offline. Per ADR-0012, reads from `env.TRUST_STORE.idFromName("cluster")`
// — the singleton hypervisor-layer DO holding both completed
// attestations and pending retries.
//
// Wire shape: JSONL (newline-delimited JSON), one row per chain entry.
// Stream-friendly so chains don't have to fit in memory at either end.
// The first line is a HEADER record carrying the cluster's master
// public key + the cursor for the next page (if more rows follow).
//
// Three peer-chain states surfaced:
//   - COMPLETE — every state-write has a peer_attestations row
//   - PENDING  — pending_attestations row awaiting retry (status: "pending")
//   - GAP      — neither row exists; the dangerous case (404 via
//                constant-time error response, indistinguishable from
//                "no peer" so the endpoint can't be used as a peer-
//                existence oracle — threat model §9.2)
//
// ## Auth gating (cloister-bdef0c)
//
// ADR-0007 mandates this endpoint be auth-gated by the lease middleware
// with scope `disclosure:<fingerprint>`. The check is now INSIDE
// `handle()` — when `INTERLACE_ROOT_PUBKEY` is set, every request must
// carry a valid Signet envelope (Authorization/X-Signet-* headers, sig
// over canonical-bytes(GET, url, ts, nonce, "")) and the cert's scope
// must contain `disclosure:<peerFp>`. When unset, dev mode runs without
// auth — same deployment-binding-presence pattern as `/mcp`.
//
// Auth failure collapses into `constantTimeErrorResponse("denied")` so
// the response is byte-identical to "no such peer" — threat-model §9.2
// (no peer-existence + cert-validity oracle).

import type { EdgeRoute } from "../router.js";
import type { Env } from "../types.js";
import type { PeerAttestation } from "../storage/peer-attestations.js";
import type { PendingAttestation } from "../storage/pending-attestations.js";
import {
  CONSTANT_TIME_ERROR_BODY_LEN,
  constantTimeErrorResponse,
  importHmacKey,
  signCursor,
  verifyCursor,
} from "../storage/disclosure-cursor.js";
import { verifyAndUpsertLease } from "./lease-middleware.js";
import {
  CaUnavailableError,
  getCABundle,
} from "../storage/ca-bundle-cache.js";
import { notmeBundleFetcher } from "../storage/notme-bundle-fetcher.js";

/** Default page size for the JSONL stream. */
const DEFAULT_PAGE_SIZE = 100;

/** Header record emitted as the first line of the JSONL stream. */
interface HeaderRecord {
  type:                 "header";
  version:              "v1";
  peer_fingerprint:     string;
  /** Cluster master public key (base64-standard). For offline verification. */
  master_public_key:    string;
  /** Cursor for the next page; absent if `from_seq + page_size >= chain_head`. */
  next_cursor?:         string;
}

/** A completed-attestation row in the stream. */
interface AttestationRecord {
  type:           "attestation";
  seq:            number;
  prev_self_ref:  string | null;
  prev_peer_ref:  string | null;
  content_hash:   string;
  content_type:   string;
  scope:          string;
  cert_b64:       string;
  sig_b64:        string;
  created_at:     number;
}

/** A pending-retry row (PENDING-state for the (peer, content_hash)). */
interface PendingRecord {
  type:               "pending";
  content_hash:       string;
  scope:              string;
  attempts:           number;
  next_retry_at:      number;
  exhausted:          boolean;  // true once attempts == MAX_RETRY_ATTEMPTS
  created_at:         number;
  last_attempt_at:    number | null;
}

/** TrustStore RPC surface needed by the disclosure endpoint. */
interface TrustStoreRpc {
  /**
   * Constant-cost existence check — used by every 404 path so wall-
   * clock cost doesn't leak peer chain length (cloister-1c42ae).
   * Calling on a reject path is REQUIRED for §9.4 timing equality
   * across cases; calling on the happy path is also fine (the boolean
   * informs whether to fetch + emit).
   */
  peerHasChain(peerFp: string): Promise<boolean>;
  listAttestationsForPeer(
    peerFp: string,
    options?: { fromSeq?: number; limit?: number },
  ): Promise<PeerAttestation[]>;
  listPendingForPeer(peerFp: string): Promise<PendingAttestation[]>;
}

/**
 * URLPattern for `GET /interlace/peers/:fp`. Web Platform standard
 * (workerd-native, no regex, no string slicing). Constructed once
 * per instance — the constructor cost is non-trivial, but the match
 * cost on each request is tiny.
 *
 * The pattern rejects subpaths, trailing slashes, and empty fp
 * segments, so we don't need defensive parsing in `handle`.
 */
const PEER_DISCLOSURE_PATTERN = new URLPattern({
  pathname: "/interlace/peers/:fp",
});

export class DisclosureRoute implements EdgeRoute {
  /**
   * @param hmacKeyBinding name of the env binding holding the
   *                       INTERLACE_DISCLOSURE_HMAC_KEY (b64-std/url, 32+ bytes)
   * @param masterKeyBinding name of the env binding holding the
   *                         cluster master public key (b64-standard)
   */
  constructor(
    private readonly hmacKeyBinding:   string = "INTERLACE_DISCLOSURE_HMAC_KEY",
    private readonly masterKeyBinding: string = "INTERLACE_ROOT_PUBKEY",
  ) {}

  match(request: Request): boolean {
    if (request.method !== "GET") return false;
    return PEER_DISCLOSURE_PATTERN.test(request.url);
  }

  async handle(request: Request, env: Env): Promise<Response> {
    // ── §9.4 invariant: ALL 404 paths perform equivalent work ──────────
    //
    // Prior to cloister-1c42ae the route early-returned on auth/cursor/
    // missing-peer failures and only paid the TrustStore round-trip on
    // the "peer truly doesn't exist" path. That made the 404 cases
    // distinguishable by timing (~17×) for an in-DC attacker. Fix:
    // funnel every reject into one `rejectReason` flag and run the
    // same DO RPC pair regardless before returning. The DO calls use
    // the request's ACTUAL `peerFp` (which may be the empty string if
    // the URL match returned nothing — DO returns 0 rows for that,
    // same as for any other unknown peer). No placeholder values; the
    // request's own bytes drive the work.
    let rejectReason: "not_found" | "denied" | "bad_cursor" | null = null;

    const m = PEER_DISCLOSURE_PATTERN.exec(request.url);
    // `match()` already gates on URLPattern, so a null here means a
    // direct call (test/test) bypassed match — fail closed identically.
    const peerFp = m?.pathname.groups.fp ?? "";
    if (!peerFp) rejectReason ??= "not_found";

    const url = new URL(request.url);

    // Lease gate (cloister-bdef0c). Same deployment-binding contract as
    // /mcp: when INTERLACE_ROOT_PUBKEY is set, every request MUST carry
    // a valid Signet envelope with scope `disclosure:<peerFp>`. When
    // unset, the route runs in dev mode (no auth).
    //
    // Failure collapses into the constant-time 404 (threat-model §9.2
    // — success/auth-failure must be indistinguishable). The DO RPCs
    // at the bottom still run regardless so wall-clock converges.
    if (env.INTERLACE_ROOT_PUBKEY) {
      const gateOk = await this.verifyLease(request, env, peerFp);
      if (!gateOk) rejectReason ??= "denied";
    }

    // Cursor — if present, MUST validate. Reject unsigned / tampered
    // cursors with a constant-time 404 (threat model §9.4).
    const hmacKeyB64 = readEnvString(env, this.hmacKeyBinding);
    if (!hmacKeyB64) rejectReason ??= "denied";

    // Import the key once if available; both cursor-verify (incoming)
    // and cursor-sign (outgoing, for the next-page header) use it.
    // Hoisted out of the cursor-check block so the happy-path emit
    // below can reach it. If the binding is missing, rejectReason was
    // already set above and the response will 404; hmacKey staying
    // null on that path is fine because next_cursor signing happens
    // only on the happy path (which requires hmacKey by definition).
    const hmacKey: CryptoKey | null = hmacKeyB64
      ? await importHmacKey(hmacKeyB64)
      : null;

    const cursorParam = url.searchParams.get("since");
    let fromSeq = 0;
    if (cursorParam && hmacKey) {
      const decoded = await verifyCursor(cursorParam, hmacKey);
      if (!decoded || decoded.peerFp !== peerFp) {
        rejectReason ??= "bad_cursor";
      } else {
        fromSeq = decoded.fromSeq;
      }
    }

    // ── Existence probe: ALWAYS performed (constant-cost) ─────────────
    //
    // The §9.4 timing invariant requires every reject path AND every
    // existence-check to pay the same wall-clock cost regardless of
    // the requested peer's chain length. `peerHasChain` uses two
    // `SELECT 1 ... LIMIT 1` queries (one per table) — both SQL exec
    // time and RPC marshaling are effectively constant in N. This
    // closes the cross-peer enumeration oracle that `list*ForPeer`
    // would create (row-count-proportional marshaling).
    //
    // The rows themselves are fetched ONLY on the happy path below.
    const trust = trustStoreStub(env) as DurableObjectStub & TrustStoreRpc;
    const hasChain = await trust.peerHasChain(peerFp);

    // If any reject condition was set above, return now — `hasChain`
    // is discarded. The wall-clock cost matches every other 404 path
    // because the same constant-cost existence probe ran.
    if (rejectReason !== null) {
      return constantTimeErrorResponse(rejectReason);
    }

    // GAP: peer has no rows in either table — unknown peer or active
    // misbehavior. The constant-time response makes those two cases
    // externally indistinguishable (threat model §9.2).
    if (!hasChain) {
      return constantTimeErrorResponse("not_found");
    }

    // ── Happy path: fetch the actual page ─────────────────────────────
    //
    // Only reached when (a) every reject condition cleared AND (b) the
    // peer has at least one row in some table. The full chain fetch is
    // a different timing class than the 404 paths — that's fine; the
    // §9.4 invariant is about distinguishing AMONG 404 cases, not
    // between 404 and 200.
    const limit = DEFAULT_PAGE_SIZE;
    const [attestations, pending] = await Promise.all([
      trust.listAttestationsForPeer(peerFp, { fromSeq, limit: limit + 1 }),
      trust.listPendingForPeer(peerFp),
    ]);

    // Defensive: if both lists came back empty despite hasChain=true
    // (extremely unlikely race — rows deleted between the existence
    // probe and the list calls), fall through to the 404 path.
    if (attestations.length === 0 && pending.length === 0) {
      return constantTimeErrorResponse("not_found");
    }

    // Build header + page. If we read `limit + 1` rows, there's a
    // next page; emit a cursor that points at the next seq.
    const masterKeyB64 = readEnvString(env, this.masterKeyBinding) ?? "";
    const hasMore = attestations.length > limit;
    const page = hasMore ? attestations.slice(0, limit) : attestations;

    const header: HeaderRecord = {
      type:                "header",
      version:             "v1",
      peer_fingerprint:    peerFp,
      master_public_key:   masterKeyB64,
    };
    if (hasMore) {
      // Invariant: reaching the happy path means rejectReason stayed
      // null, which means hmacKeyB64 was present (otherwise it'd be
      // "denied"). Hence hmacKey is non-null. Assert defensively in
      // case the flow ever changes — better a loud failure here than
      // an unsigned cursor leaking.
      if (hmacKey === null) {
        throw new Error("disclosure: invariant — hmacKey null on happy path");
      }
      const lastSeq = page[page.length - 1]!.seq;
      header.next_cursor = await signCursor(
        { peerFp, fromSeq: lastSeq + 1, ts: Date.now() },
        hmacKey,
      );
    }

    const lines: string[] = [JSON.stringify(header)];
    for (const a of page) {
      const rec: AttestationRecord = {
        type:           "attestation",
        seq:            a.seq,
        prev_self_ref:  a.prev_self_ref,
        prev_peer_ref:  a.prev_peer_ref,
        content_hash:   a.content_hash,
        content_type:   a.content_type,
        scope:          a.scope,
        cert_b64:       b64Std(a.cert),
        sig_b64:        b64Std(a.sig),
        created_at:     a.created_at,
      };
      lines.push(JSON.stringify(rec));
    }
    // Pending rows trail the attestation chain so chronological readers
    // get the canonical chain first. Pending is a separate flat list;
    // exhausted rows are flagged.
    for (const p of pending) {
      const rec: PendingRecord = {
        type:               "pending",
        content_hash:       p.content_hash,
        scope:              p.scope,
        attempts:           p.attempts,
        next_retry_at:      p.next_retry_at,
        exhausted:          p.next_retry_at === Number.MAX_SAFE_INTEGER,
        created_at:         p.created_at,
        last_attempt_at:    p.last_attempt_at,
      };
      lines.push(JSON.stringify(rec));
    }

    return new Response(lines.join("\n") + "\n", {
      status: 200,
      headers: {
        "content-type":  "application/jsonl; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  /**
   * Run the lease pipeline for a GET disclosure request. Returns true
   * iff the request is authorized to read `peerFp`'s chain.
   *
   * Disclosure differs from POST /mcp in three ways:
   *  - No body (GET) — sig is over empty body
   *  - Scope is `disclosure:<peerFp>`, not derived from JSON-RPC
   *  - Auth-failure does NOT reveal which step failed; caller maps the
   *    boolean to `constantTimeErrorResponse("denied")`
   */
  private async verifyLease(
    request: Request,
    env:     Env,
    peerFp:  string,
  ): Promise<boolean> {
    const nowMs = Date.now();
    let bundle;
    try {
      bundle = await getCABundle(notmeBundleFetcher(env), nowMs, {
        rootPubkey: env.INTERLACE_ROOT_PUBKEY,
      });
    } catch (err) {
      if (err instanceof CaUnavailableError) return false;
      throw err;
    }
    const verdict = await verifyAndUpsertLease({
      req:    request,
      body:   "",                          // GET — no body
      id:     null,                        // GET — no JSON-RPC id
      method: "disclosure",                // synthetic; ignored when requestedScope is set
      params: undefined,
      env,
      bundle,
      nowMs,
      requestedScope: `disclosure:${peerFp}`,
    });
    return !("code" in verdict);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function trustStoreStub(env: Env): DurableObjectStub {
  return env.TRUST_STORE.get(env.TRUST_STORE.idFromName("cluster"));
}

function readEnvString(env: Env, binding: string): string | undefined {
  if (!binding) return undefined;
  const v = (env as unknown as Record<string, unknown>)[binding];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function b64Std(bytes: Uint8Array | ArrayBuffer): string {
  // Workerd RPC may deliver bytes as ArrayBuffer rather than Uint8Array;
  // SqlStorage row reads can do the same. Normalize before iterating.
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]!);
  return btoa(bin);
}

// Re-export the constant-time body length so tests can assert on it.
export { CONSTANT_TIME_ERROR_BODY_LEN };
