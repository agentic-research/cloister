// SPDX-License-Identifier: AGPL-3.0-or-later
//
// actor-fingerprint — the ONE resolver for the Interlace actor fingerprint
// (cloister-5f7e5c, the first-party local-deployment thread).
//
// ── The problem this fixes ───────────────────────────────────────────────────
//
// `actor.fingerprint` gates two published surfaces: the Interlace discovery doc
// (src/routes/well-known.ts) and the multi-format identity bridge
// (src/routes/well-known-identity.ts, five paths including /oauth/token). Empty
// means "disabled", and every path 404s.
//
// That is a fine opt-out and a terrible default, because it is also what a
// deployment that MEANT to publish looks like before anyone fills it in. Both
// the root cluster.toml and `recipes/agent-cluster` — a recipe whose README
// calls it "the full identity-on cloister deployment... with the well-known
// discovery surface enabled" — declare the route and leave the fingerprint
// empty. Measured against a live local pair, `POST /oauth/token` answers:
//
//     404  identity bridge disabled
//
// The route is declared, the binding is connected, notme is running, and the
// endpoint is unreachable. Nothing reported it, because "disabled" and
// "misconfigured" were the same state.
//
// ── Why an env fallback, and why THIS one ────────────────────────────────────
//
// The fingerprint is DERIVABLE — it is `sha256:<hex>` over the master public
// key — so an empty fingerprint next to a present pubkey is underspecified
// rather than switched off. `RECEIPT_ACTOR_FP` already established exactly this
// shape for the receipt surface: "Actor fingerprint... When unset, derived from
// the pubkey at startup. Pinning it via binding lets the operator publish a
// stable fingerprint across pubkey reloads in dev." This is that, for the
// identity surface, so the two halves of one actor's identity stop resolving by
// different rules.
//
// The opt-out SURVIVES: neither manifest value nor env value means disabled.
// What changes is that "I have an identity but did not restate its digest in
// the manifest" stops being indistinguishable from "I have no identity".
//
// ── Why a resolver rather than two inline reads ──────────────────────────────
//
// `lint:trust-env-locality` requires a trust-surface env var to be read in its
// own resolver and nowhere else, and ADR-0053 records why: the lease gate had
// its authority read in several places and they drifted, so the posture
// depended on which one you looked at. Two routes need this value; two inline
// `env.INTERLACE_ACTOR_FP` reads would be that same shape at a smaller scale.

import type { Env } from "../types.js";
import type { Gateway } from "../manifest/types.js";

/** Manifest-declared fingerprint wins; env is the fallback. */
export const ACTOR_FP_BINDING = "INTERLACE_ACTOR_FP";

/**
 * `sha256:` followed by 64 lowercase hex chars — the format
 * `manifest/cloister.capnp` states for `Actor.fingerprint`.
 *
 * Validated rather than trusted because an operator-supplied env value lands
 * verbatim in a JWT `kid`, in the discovery doc, and in `sub`. A malformed one
 * would propagate to every consumer of those documents, and the failure would
 * surface as "your tokens don't verify" somewhere with no view of this file.
 */
const FINGERPRINT_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * Resolve the actor fingerprint, or null when the actor surface is genuinely
 * disabled.
 *
 * Precedence — manifest first, deliberately. The manifest is the committed
 * declaration and an env var must not be able to silently repoint a published
 * identity; the fallback exists for the case where the manifest says nothing,
 * not to override what it does say.
 */
export function resolveActorFingerprint(manifest: Gateway, env: Env): string | null {
  const declared = manifest.actor.fingerprint;
  if (declared) return declared;

  const fromEnv = env.INTERLACE_ACTOR_FP;
  if (typeof fromEnv !== "string") return null;

  const trimmed = fromEnv.trim();
  if (trimmed.length === 0) return null;
  // A malformed value is NOT a silent fall-through to "disabled": that would
  // reproduce the bug this file exists to fix, one level down — an operator who
  // set the variable and typoed it would see the same bare 404 as one who never
  // set it at all.
  if (!FINGERPRINT_RE.test(trimmed)) {
    throw new ActorFingerprintError(
      `${ACTOR_FP_BINDING} is set but malformed: expected "sha256:<64 lowercase hex>", ` +
      `got ${JSON.stringify(trimmed.slice(0, 80))}`,
    );
  }
  return trimmed;
}

export class ActorFingerprintError extends Error {
  override readonly name = "ActorFingerprintError";
}

/**
 * Derive the canonical fingerprint from raw master public-key bytes.
 *
 * Exported so `cloister dev bootstrap` and any operator tooling compute it the
 * same way the runtime validates it — a second derivation elsewhere is how the
 * published digest and the real key drift apart.
 */
export async function fingerprintFromPubkey(pubkey: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", pubkey));
  const hex = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}
