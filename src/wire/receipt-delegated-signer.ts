// SPDX-License-Identifier: AGPL-3.0-or-later
//
// receipt-delegated-signer — receipt signing delegated to notme's
// `ReceiptSigner` RPC entrypoint (notme ADR-014, cloister-35ccf7).
//
// ── Why this exists ──────────────────────────────────────────────────────────
//
// The alternative it replaces is `RECEIPT_SIGNING_KEY`: a 64-byte master
// keypair in cloister's env. That binds a master PRIVATE key into cloister,
// which ADR-0010 rules out (vault slices are the binding substrate) and which
// makes a second copy of a trust root whose entire property is that it never
// leaves notme. The env path stays for tests and Phase-1 local dev; anything
// deployed should reach notme.
//
// NOT a fetch to `/internal/sign-receipt`. notme declined to build that: an
// `/internal/` path prefix is publicly routable, and a prefix is not an access
// control. No header, shared secret, or `request.cf` inspection reliably
// distinguishes a service-binding fetch from an internet request. An RPC
// method has no URL, so non-routability is structural rather than enforced.
//
// ── Why the seam is the COMMITMENT, not the canonical bytes ──────────────────
//
// The obvious shape is `sign(canonicalBytes)`, matching the local signer. It
// cannot work here, and the reason is the retry:
//
// `epoch` is a FIELD INSIDE the commitment, so it is inside the bytes that get
// signed. notme rejects a commitment whose epoch disagrees with the
// authority's, and `EPOCH_MISMATCH` means "rotation moved underneath you —
// re-read the facts and try again". Acting on that requires REBUILDING the
// commitment with the new epoch and re-encoding. A function handed
// already-canonical bytes cannot do that; it can only fail. So the delegated
// signer takes the structured commitment and owns the encode.
//
// ── The retry is bounded at one, deliberately ────────────────────────────────
//
// notme's own guidance, and it is not arbitrary: rotation can move again
// between the re-read and the retry. An unbounded loop against a rotating
// authority is a retry storm aimed at the one service that can least afford
// it. One attempt converts the overwhelmingly common case (a single rotation
// raced a request) into a success and leaves the pathological case failing
// fast.

import type { ReceiptCommitment } from "./receipts.js";
import { b64urlEncode, encodeCommitment, encodeReceiptEnvelope } from "./receipts.js";

/**
 * The subset of notme's `ReceiptSigner` entrypoint this module uses.
 *
 * Declared structurally rather than imported: cloister cannot import types
 * across the service boundary, and restating the full class would be a hand
 * mirror of a contract cloister does not own. Only what is called is named.
 */
export interface NotmeReceiptSignerStub {
  /**
   * The `actor_fp` and `epoch` a commitment must carry.
   *
   * `actorFp` arrives ALREADY HASHED — SHA-256 of the raw Ed25519 master
   * public key, ready to place in the commitment verbatim. notme returns it
   * hashed on purpose: if cloister hashed it, cloister would own a derivation
   * notme then validates against, reintroducing exactly the drift this call
   * removes.
   */
  receiptFacts(): Promise<{ actorFp: Uint8Array; epoch: number }>;
  /**
   * Sign canonical CBOR commitment bytes. notme validates, canonically
   * re-encodes, and requires a byte-for-byte match before signing anything —
   * signing caller-supplied bytes with the CA master would be a compromise
   * rather than merely sloppy.
   */
  signReceipt(commitment: Uint8Array): Promise<
    | { ok: true; signature: Uint8Array; epoch: number }
    | { ok: false; code: string; message: string }
  >;
}

/** The one retryable code in notme's vocabulary. */
export const RETRYABLE_COMMITMENT_CODE = "EPOCH_MISMATCH";

export class DelegatedReceiptSignError extends Error {
  override readonly name = "DelegatedReceiptSignError";
  constructor(readonly code: string, message: string) {
    super(`notme rejected the receipt commitment (${code}): ${message}`);
  }
}

/**
 * A receipt signer backed by notme's RPC entrypoint.
 *
 * `facts()` is cached per instance. notme's guidance is to cache and re-read
 * on EPOCH_MISMATCH rather than poll, because rotation here is alarm-driven —
 * polling would add constant load to detect an event that announces itself.
 */
export class DelegatedReceiptSigner {
  #facts: { actorFp: Uint8Array; epoch: number } | null = null;

  constructor(private readonly remote: NotmeReceiptSignerStub) {}

  /** Authority-supplied `actor_fp` + `epoch`, cached after the first call. */
  async facts(): Promise<{ actorFp: Uint8Array; epoch: number }> {
    if (this.#facts === null) this.#facts = await this.remote.receiptFacts();
    return this.#facts;
  }

  /**
   * Confirm the far side really is notme's ReceiptSigner, by asking it for the
   * facts every commitment needs anyway.
   *
   * Returns the facts on success and null on any failure — a binding without
   * the entrypoint, a wrong entrypoint, notme unreachable. All three mean the
   * same thing to the caller: delegation is unavailable, fall back.
   *
   * This is a real probe rather than a shape check because a shape check
   * cannot work against an RPC Proxy (see `delegatedReceiptSignerFrom`). It
   * costs one round-trip per isolate, and the result is cached — the facts are
   * needed to build any commitment regardless, so nothing is wasted.
   */
  async probe(): Promise<{ actorFp: Uint8Array; epoch: number } | null> {
    try {
      const facts = await this.facts();
      // A fetch-only binding answers *something*; require the shape that only
      // the real entrypoint produces.
      if (!(facts?.actorFp instanceof Uint8Array)) return null;
      if (facts.actorFp.length !== 32) return null;
      if (!Number.isInteger(facts.epoch)) return null;
      return facts;
    } catch {
      // lint-allow-silent: probe predicate — null means "delegation unavailable",
      // and the caller logs the fallback. Distinguishing the causes here would
      // not change what happens next.
      this.invalidateFacts();
      return null;
    }
  }

  /** Drop the cache so the next `facts()` re-reads from the authority. */
  invalidateFacts(): void {
    this.#facts = null;
  }

  /**
   * Sign a commitment, refreshing the epoch and retrying ONCE on
   * EPOCH_MISMATCH.
   *
   * Returns the commitment ACTUALLY SIGNED alongside the signature — on a
   * retry it differs from the one passed in (new epoch), and the envelope must
   * carry the signed version. Returning only the signature would produce an
   * envelope whose commitment and signature disagree: a receipt that fails
   * verification everywhere, for a reason visible nowhere.
   */
  async signCommitment(
    commitment: ReceiptCommitment,
  ): Promise<{ signature: Uint8Array; commitment: ReceiptCommitment }> {
    const first = await this.remote.signReceipt(encodeCommitment(commitment));
    if (first.ok) return { signature: first.signature, commitment };

    if (first.code !== RETRYABLE_COMMITMENT_CODE) {
      throw new DelegatedReceiptSignError(first.code, first.message);
    }

    // Rotation moved underneath us. Re-read the facts and rebuild — the epoch
    // is inside the signed bytes, so a bare re-send would be rejected
    // identically.
    this.invalidateFacts();
    const fresh = await this.facts();
    const retried: ReceiptCommitment = {
      ...commitment,
      actorFp: fresh.actorFp,
      epoch:   fresh.epoch,
    };

    const second = await this.remote.signReceipt(encodeCommitment(retried));
    if (second.ok) return { signature: second.signature, commitment: retried };

    // Bounded at one. A second EPOCH_MISMATCH means rotation moved again
    // between the re-read and this call; looping would aim a retry storm at
    // the service least able to absorb it.
    throw new DelegatedReceiptSignError(second.code, second.message);
  }
}

/**
 * Build a delegated signer from the `NOTME_RECEIPTS` binding, or null when the
 * binding is absent.
 *
 * ── Why there is no shape check here ─────────────────────────────────────────
 *
 * There was one, and it did not work. The hazard is real — a plain service
 * binding without `entrypoint = "ReceiptSigner"` resolves to notme's DEFAULT
 * fetch handler, so a misconfigured binding is present, truthy, and useless —
 * but `typeof binding.signReceipt === "function"` does NOT detect it.
 *
 * workerd RPC stubs are Proxies. Property access on one synthesizes a callable
 * for ANY name, so the check passes against a fetch-only binding, a wrong
 * entrypoint, and a typo alike. It reads like a guard and is a tautology. It
 * was caught by the integration suite, where the miniflare fetch stub sailed
 * through it and then failed inside response assembly.
 *
 * Absence is still detectable (the binding is genuinely undefined), so that is
 * all this checks. Whether the far side actually implements the entrypoint is
 * settled by CALLING it — see `probe()`, which the emitter uses to decide
 * between delegation and the local fallback. A capability question that can
 * only be answered by invoking the capability should be answered that way.
 */
export function delegatedReceiptSignerFrom(binding: unknown): DelegatedReceiptSigner | null {
  if (!binding) return null;
  return new DelegatedReceiptSigner(binding as NotmeReceiptSignerStub);
}

/**
 * Delegated counterpart to `signCommitmentToHeader`.
 *
 * Returns the commitment actually signed alongside the header, because an
 * EPOCH_MISMATCH retry changes it. The envelope is built from THAT value —
 * building it from the caller's original would pair a stale commitment with a
 * signature over a different one, producing a receipt that fails verification
 * everywhere for a reason visible nowhere.
 */
export async function signDelegatedCommitmentToHeader(
  c: ReceiptCommitment,
  signer: DelegatedReceiptSigner,
): Promise<{ headerValue: string; envelopeBytes: Uint8Array; signature: Uint8Array; commitment: ReceiptCommitment }> {
  const { signature, commitment } = await signer.signCommitment(c);
  const envelopeBytes = encodeReceiptEnvelope({ commitment, signature });
  return { headerValue: b64urlEncode(envelopeBytes), envelopeBytes, signature, commitment };
}
