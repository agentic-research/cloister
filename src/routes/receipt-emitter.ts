// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Receipt emitter — wraps responses with the Interlace-Receipt header
// per RECEIPTS.md §2.1 / §2.6.
//
// Wired into the route layer ABOVE the actual handler. The emitter:
//
//   1. Captures the original Response object after the route handler
//      builds it.
//   2. Computes the canonical commitment over the request + response
//      surface.
//   3. Signs with the master Ed25519 key (env-direct or via notme).
//   4. Returns a NEW Response carrying the original body + an added
//      `Interlace-Receipt` header.
//
// Streaming responses are handled by the sibling
// `wrapSseWithReceiptStream` helper (RECEIPTS.md §2.4).
//
// ## When does a receipt get emitted?
//
// Per §2.6:
//   - 2xx authenticated responses  → MUST emit
//   - 4xx / 5xx                   → MAY omit (no admission to commit to)
//   - unauthenticated /.well-known → MAY omit (no §13.2 stake)
//   - constant-time 404 (§9.4)    → MUST NOT emit (admission did not occur)
//
// The emitter's policy: emit on 200-299 IFF the receipt context is set
// (lease verified, peer fingerprint known, signer configured). Other
// status codes flow through unchanged. The caller is responsible for
// supplying the right context.

import type { Env } from "../types.js";
import {
  HEADER_ALLOWLIST,
  INTERLACE_RECEIPT_HEADER,
  buildHeadersCommittedBytes,
  makeReceiptSignerFromKeypair,
  type ReceiptSigner,
  sha256,
  signCommitmentToHeader,
  type ReceiptCommitment,
  b64stdDecode,
} from "../wire/receipts.js";
import {
  type DelegatedReceiptSigner,
  delegatedReceiptSignerFrom,
  signDelegatedCommitmentToHeader,
} from "../wire/receipt-delegated-signer.js";
import { canonicalRequestBytes } from "./lease-middleware.js";
import { logEvent } from "../obs/log.js";
import { originsDigest, type OriginSet } from "../wire/origin.js";

// One-shot guard so the "receipt emission disabled" signal (cloister-21e42e)
// logs once per isolate, not on every emission attempt.
let receiptEmissionDisabledLogged = false;

// ── Receipt context (built per-request by the route layer) ────────────────

/**
 * Context the route handler passes to the emitter. Most fields come
 * directly from the lease verification result + request capture.
 *
 * Optional fields:
 *   - `actorFp` and `epoch` default to env-derived values when unset.
 *   - When `signer` is undefined the emitter passes the response through
 *     unchanged (no receipt). This is the Phase 1 migration mode (§8.2).
 */
export interface ReceiptEmissionContext {
  /** Server clock at admission time (already snapshotted by the route). */
  nowMs: number;
  /** The full request canonical bytes used as lease-envelope input. */
  requestCanon: Uint8Array;
  /** The request nonce from the lease envelope (raw bytes). */
  nonce: Uint8Array;
  /** Pre-built receipt signer, OR null if Phase 1 (no emission). */
  signer: ReceiptSigner | null;
  /**
   * Delegated signer (notme's ReceiptSigner RPC entrypoint), when the
   * `NOTME_RECEIPTS` binding is present. Takes precedence over `signer`.
   *
   * Separate field rather than a variant of `signer` because the two have
   * genuinely different seams: the local signer signs canonical BYTES, while
   * this one must own the encode so it can rebuild the commitment on an
   * EPOCH_MISMATCH retry — the epoch is a field inside the bytes being signed.
   */
  delegated?: DelegatedReceiptSigner | null;
  /** Actor fingerprint (32 bytes, raw). */
  actorFp: Uint8Array;
  /** Actor epoch. */
  epoch: number;
  /**
   * Content-origin set for the response this receipt covers (ADR-0065 phase
   * 2b). Unioned by the caller from the `contentOrigin()` of whichever backends
   * served the call; empty when none declared one.
   *
   * The receipt commits to its DIGEST, computed here rather than passed in, so
   * no call site can supply a hash that does not match a set it also supplies —
   * the same received-not-derived shape the whole ADR exists to close, one layer
   * out.
   */
  origins?: OriginSet;
}

// ── Env-side context builder ──────────────────────────────────────────────

/**
 * Build a per-request emission context from request + env. Returns null
 * if the deployment isn't configured to emit receipts (no signing key
 * material) — caller treats null as "Phase 1, no receipt emitted."
 *
 * `requestCanon` and `nonce` MUST be supplied by the caller — those
 * come from the lease envelope parse (already done by the lease
 * middleware before this is called).
 */
export async function buildEmissionContext(args: {
  env:          Env;
  nowMs:        number;
  requestCanon: Uint8Array;
  nonce:        Uint8Array;
}): Promise<ReceiptEmissionContext | null> {
  // Delegation first: RECEIPT_SIGNING_KEY puts a master PRIVATE key in
  // cloister's env, which ADR-0010 rules out and which makes a second copy of
  // a trust root whose whole property is that it never leaves notme. When both
  // are configured the binding wins — an operator who wired the binding did
  // not mean to keep signing locally.
  const delegated = delegatedReceiptSignerFrom(args.env.NOTME_RECEIPTS);
  // probe(), not a shape check: workerd RPC stubs are Proxies that synthesize a
  // callable for any property name, so `typeof x.signReceipt === "function"` is
  // true for a fetch-only binding too. The only way to learn whether the far
  // side implements the entrypoint is to call it.
  //
  // actor_fp and epoch come from the AUTHORITY, not from local config: notme
  // rejects any commitment whose facts disagree with its own, so deriving them
  // here would reintroduce exactly the drift receiptFacts() exists to remove.
  // `actorFp` arrives already hashed for the same reason.
  const facts = delegated === null ? null : await delegated.probe();
  if (delegated !== null && facts !== null) {
    return {
      nowMs: args.nowMs,
      requestCanon: args.requestCanon,
      nonce: args.nonce,
      signer: null,
      delegated,
      actorFp: facts.actorFp,
      epoch: facts.epoch,
    };
  }
  if (delegated !== null) {
    // Bound but unusable — the operator wired NOTME_RECEIPTS and it does not
    // answer. Falling through to the env path silently would hide a
    // misconfigured trust root behind a working-looking deployment, which is
    // the §13.2 "silence is evidence" failure in miniature.
    logEvent("warn", {
      target: "receipt_emitter", op: "load_signer",
      outcome: "delegation_unavailable_falling_back",
    });
  }

  const signer = await loadReceiptSigner(args.env);
  if (signer === null) return null;
  const actorFp = await resolveActorFingerprint(args.env, signer.pubkey);
  const epoch = resolveEpoch(args.env);
  return {
    nowMs: args.nowMs,
    requestCanon: args.requestCanon,
    nonce: args.nonce,
    signer,
    delegated: null,
    actorFp,
    epoch,
  };
}

/**
 * Resolve the receipt signer from env bindings. Returns null when no
 * signing material is configured — Phase 1 deployments (§8.2) run
 * without receipt emission.
 *
 * This is the LOCAL/Phase-1 path only. Production delegates to notme's
 * `ReceiptSigner` RPC entrypoint via `NOTME_RECEIPTS` — see
 * `buildEmissionContext`, which prefers it. Not a fetch to
 * `/internal/sign-receipt`: notme declined to build that, because an
 * `/internal/` prefix is publicly routable and a prefix is not an access
 * control. Per cloister-35ccf7.
 */
export async function loadReceiptSigner(env: Env): Promise<ReceiptSigner | null> {
  const raw = env.RECEIPT_SIGNING_KEY;
  if (!raw || raw.length === 0) {
    // cloister-21e42e: an empty RECEIPT_SIGNING_KEY disables receipt emission —
    // the §8.2 Phase-1 posture, and intended. But "empty value silently means
    // off" is exactly this audit's target: §13.2 "silence is evidence" breaks if
    // an operator can't tell "no receipts because Phase 1" from "no receipts
    // because the key went missing." Make the disabled state OBSERVABLE once per
    // isolate rather than a fully silent no-op. (Emptiness stays fail-SAFE here —
    // no receipt is a missing §13.2 stake, not an auth bypass — so we log, not throw.)
    if (!receiptEmissionDisabledLogged) {
      receiptEmissionDisabledLogged = true;
      logEvent("warn", { target: "receipt_emitter", op: "load_signer", outcome: "disabled_no_signing_key" });
    }
    return null;
  }
  try {
    const kp = b64stdDecode(raw);
    if (kp.length !== 64) {
      // Wrong shape — treat as misconfigured (don't crash the deploy;
      // log via thrown-then-caught in the receipt-emitter wrap).
      return null;
    }
    return await makeReceiptSignerFromKeypair(kp);
  } catch {
    // lint-allow-silent: misconfigured signer — surfaced by the receipt-emitter wrap (see above)
    return null;
  }
}

/**
 * Derive the actor fingerprint. Priority:
 *   1. env.RECEIPT_ACTOR_FP (hex, 64 chars) — operator pin
 *   2. SHA-256(pubkey)                       — derived from signer
 */
async function resolveActorFingerprint(env: Env, pubkey: Uint8Array): Promise<Uint8Array> {
  if (env.RECEIPT_ACTOR_FP && /^[0-9a-fA-F]{64}$/.test(env.RECEIPT_ACTOR_FP)) {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      out[i] = parseInt(env.RECEIPT_ACTOR_FP.substring(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
  return sha256(pubkey);
}

function resolveEpoch(env: Env): number {
  if (!env.RECEIPT_EPOCH) return 1;
  const n = Number.parseInt(env.RECEIPT_EPOCH, 10);
  if (!Number.isFinite(n) || n < 0) return 1;
  return n;
}

// ── Per-request emission ──────────────────────────────────────────────────

/**
 * Wrap a non-streaming response with an `Interlace-Receipt` header.
 *
 * Behavior:
 *   - status outside 200..299 → return unchanged.
 *   - response body is a stream (e.g. SSE)  → return unchanged; caller
 *     should use the streaming wrapper instead.
 *   - context.signer is null → return unchanged (Phase 1).
 *   - otherwise: read the body, hash it, sign, attach header, return
 *     a new Response with the body bytes already buffered in memory.
 *
 * Body buffering matters: workerd Response bodies are usually streams,
 * so to commit to `body_hash` we read the body once. For typical
 * cloister responses (JSON-RPC over POST /mcp) the bodies are small
 * (KB range), so buffering is cheap. SSE responses NEVER hit this
 * function — they use the streaming wrapper.
 *
 * NB: the call MUST happen AFTER the original response is built;
 * callers should not pre-buffer.
 */
export async function attachReceipt(
  response: Response,
  ctx: ReceiptEmissionContext,
): Promise<Response> {
  if (!ctx.signer && !ctx.delegated) return response;
  if (response.status < 200 || response.status >= 300) return response;

  // SSE / streaming detection: if the content-type is event-stream OR
  // there's no Content-Length AND the body is a non-byte stream, defer
  // to the streaming wrapper. We're conservative — only the explicit
  // event-stream content-type triggers the deferral.
  const ct = (response.headers.get("content-type") ?? "").toLowerCase();
  if (ct.startsWith("text/event-stream")) {
    // Caller should be using wrapSseWithReceiptStream; pass through.
    return response;
  }

  // Read body bytes for hashing. workerd's Response stream is read-once.
  const bodyBuf = new Uint8Array(await response.arrayBuffer());
  const bodyHash = await sha256(bodyBuf);

  // Build the final outgoing header set BEFORE hashing — the receipt's
  // `headers_hash` (per §2.1) commits to the headers P actually
  // observes, which includes our ACE-Headers entry (the receipt itself
  // is not in HEADER_ALLOWLIST so we add it after).
  const outgoingHeaders = new Headers(response.headers);
  appendAccessControlExposeHeader(outgoingHeaders, INTERLACE_RECEIPT_HEADER);

  const headersBytes = buildHeadersCommittedBytes(outgoingHeaders);
  const headersHash = await sha256(headersBytes);

  const requestHash = await sha256(ctx.requestCanon);

  // Digest computed HERE from the set, never accepted as a hash. See the field
  // doc: a call site that could pass a precomputed digest could pass one that
  // does not match its set.
  const originsHash = ctx.origins ? await originsDigest(ctx.origins) : null;

  const commitment: ReceiptCommitment = {
    nonce:       ctx.nonce,
    requestHash,
    status:      response.status,
    bodyHash,
    headersHash,
    timestampMs: ctx.nowMs,
    actorFp:     ctx.actorFp,
    epoch:       ctx.epoch,
    // Omitted, not null, when there is nothing to claim — keeps the encoding
    // byte-identical to a pre-ADR-0065 receipt.
    ...(originsHash ? { originsHash } : {}),
  };

  // Delegated path owns its own encode so it can rebuild on EPOCH_MISMATCH;
  // it returns the commitment ACTUALLY signed, which differs from the one
  // built above when a retry happened. Building the envelope from the
  // original would emit a receipt whose commitment and signature disagree.
  const { headerValue } = ctx.delegated
    ? await signDelegatedCommitmentToHeader(commitment, ctx.delegated)
    : await signCommitmentToHeader(commitment, ctx.signer!);

  // Now stamp the receipt header on. Not in HEADER_ALLOWLIST so this
  // does NOT affect the headers_hash we just computed.
  const newHeaders = outgoingHeaders;
  newHeaders.set(INTERLACE_RECEIPT_HEADER, headerValue);

  return new Response(bodyBuf, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

/**
 * Append a header name to `Access-Control-Expose-Headers` if not already
 * present (case-insensitive). RFC mandates lowercase comparison.
 */
function appendAccessControlExposeHeader(headers: Headers, name: string): void {
  const cur = headers.get("access-control-expose-headers");
  if (!cur || cur.length === 0) {
    headers.set("access-control-expose-headers", name);
    return;
  }
  const existing = cur.split(/,\s*/).map((s) => s.toLowerCase());
  if (existing.includes(name.toLowerCase())) return;
  headers.set("access-control-expose-headers", `${cur}, ${name}`);
}

// ── Re-exports for callers ───────────────────────────────────────────────

export { canonicalRequestBytes, HEADER_ALLOWLIST };
