// SPDX-License-Identifier: AGPL-3.0-or-later
//
// lease-gate — the single authority-source resolver for the Interlace lease
// gate (ADR-0053, cloister-220c9d). Every lease-gated route calls
// `resolveLeaseGate(env).mode` instead of re-deriving the gate from
// INTERLACE_ROOT_PUBKEY / CLOISTER_MODE / DEV_CA_MASTER by hand at five sites.
//
// The 5-whys (cloister-220c9d) found the lease gate conflated three orthogonal
// axes — (A) enforce?, (B) which anchor?, (C) how to obtain the CA bundle —
// into an overloaded INTERLACE_ROOT_PUBKEY presence/value plus an ad-hoc
// CLOISTER_MODE/DEV_CA_MASTER pair. This resolver owns axis A (mode). Axes B+C
// stay in resolveCABundle (cloister-d2db6d), which the enforce path calls and
// which already fails closed on a missing anchor.

import type { Env } from "../types.js";

/** The two gate modes — a named type so call sites reference it, not literals. */
export type LeaseMode = "off" | "enforce";

/**
 * The resolved lease gate. `off` = auth not enforced (an explicit dev opt-out).
 * `enforce` = run the full verify pipeline; the CA bundle comes from
 * resolveCABundle, which fails closed when no trust anchor is configured.
 *
 * A single-field discriminated union rather than a bare boolean so the enforce
 * case can carry a payload later (e.g. a reason) without touching call sites.
 */
export interface LeaseGate {
  readonly mode: LeaseMode;
}

/**
 * Resolve the lease gate from env (ADR-0053). Pure over `env`.
 *
 * `off` is reachable ONLY through an explicit `CLOISTER_MODE=dev` opt-out with
 * no authority configured (rule 3). A production deploy (no `CLOISTER_MODE=dev`)
 * with an empty/absent authority resolves to `enforce` — and resolveCABundle
 * then fails CLOSED, so an accidentally-empty `INTERLACE_ROOT_PUBKEY` rejects
 * every request rather than silently serving unauthenticated (rule 5, the
 * empty-value fix). Dev relaxes only *where the trust root comes from*, never
 * *whether* it is checked — ADR-0007's "no per-request bypass", preserved.
 *
 * Rule table (first match wins):
 *   1. dev + DEV_CA_MASTER            → enforce (static dev bundle, harness:dev)
 *   2. dev + INTERLACE_ROOT_PUBKEY    → enforce (fetch notme + verify, local notme)
 *   3. dev + neither                  → off (the only silent off; explicit dev flag)
 *   4. prod + INTERLACE_ROOT_PUBKEY   → enforce (production fetch + verify)
 *   5. prod + no authority            → enforce → resolveCABundle fails CLOSED
 *   6. prod + DEV_CA_MASTER only      → enforce → devCaBundle ignores it (not dev),
 *                                       falls to (5) fail-closed; lint:no-dev-mode
 *                                       also rejects committed dev material.
 */
export function resolveLeaseGate(env: Env): LeaseGate {
  const isDev = env.CLOISTER_MODE === "dev";
  const hasAuthority = !!env.DEV_CA_MASTER || !!env.INTERLACE_ROOT_PUBKEY;

  // Rule 3 — the ONLY "off": an explicit dev opt-out with no authority.
  if (isDev && !hasAuthority) return { mode: "off" };

  // Rules 1,2,4,5,6 — enforce.
  return { mode: "enforce" };
}

/**
 * The uniform question every lease-gated route asks: is the gate enforcing?
 * Consume this instead of comparing `resolveLeaseGate(env).mode` to a string
 * literal, so all call sites phrase the condition identically. The per-route
 * *action* when not enforcing (pass through vs deny) stays route-local.
 */
export function leaseEnforced(env: Env): boolean {
  return resolveLeaseGate(env).mode === "enforce";
}
