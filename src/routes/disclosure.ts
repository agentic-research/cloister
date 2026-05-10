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
// ## Auth gating (deferred to cloister-b89fdb wiring)
//
// ADR-0007 mandates this endpoint be auth-gated by the lease middleware
// with scope `disclosure:<fingerprint>`. The middleware orchestrator
// (`verifyAndUpsertLease`) is built and tested but not yet wired into
// the request hot path. **This route class is therefore NOT registered
// in `cloister.capnp` yet** — it's reachable only via direct
// instantiation in tests until cloister-b89fdb lands a notme bundle
// fetcher and wires the lease check into both /mcp and /interlace/*.
//
// When that wiring lands, registration is a one-line manifest addition
// — the route class doesn't need to know about the auth wrapper, since
// the manifest runtime composes auth around it.

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
  listAttestationsForPeer(
    peerFp: string,
    options?: { fromSeq?: number; limit?: number },
  ): Promise<PeerAttestation[]>;
  listPendingForPeer(peerFp: string): Promise<PendingAttestation[]>;
}

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
    const url = new URL(request.url);
    return url.pathname.startsWith("/interlace/peers/");
  }

  async handle(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const peerFp = decodeURIComponent(
      url.pathname.slice("/interlace/peers/".length),
    );
    if (!peerFp) {
      return constantTimeErrorResponse("not_found");
    }

    // Cursor — if present, MUST validate. Reject unsigned / tampered
    // cursors with a constant-time 404 (threat model §9.4: paginated-
    // tail oracle defense).
    const hmacKeyB64 = readEnvString(env, this.hmacKeyBinding);
    if (!hmacKeyB64) {
      return constantTimeErrorResponse("denied");
    }
    const hmacKey = await importHmacKey(hmacKeyB64);

    const cursorParam = url.searchParams.get("since");
    let fromSeq = 0;
    if (cursorParam) {
      const decoded = await verifyCursor(cursorParam, hmacKey);
      if (!decoded || decoded.peerFp !== peerFp) {
        return constantTimeErrorResponse("bad_cursor");
      }
      fromSeq = decoded.fromSeq;
    }

    const trust = trustStoreStub(env) as DurableObjectStub & TrustStoreRpc;
    const limit = DEFAULT_PAGE_SIZE;

    // Read both surfaces in parallel.
    const [attestations, pending] = await Promise.all([
      trust.listAttestationsForPeer(peerFp, { fromSeq, limit: limit + 1 }),
      trust.listPendingForPeer(peerFp),
    ]);

    // GAP: no rows in either table — unknown peer or active misbehavior.
    // The constant-time response makes those two cases externally
    // indistinguishable (threat model §9.2).
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
