// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Cloister-side receipt gate for LLO-executed runs.
 *
 * WHAT IS DELIBERATELY NOT HERE: a RunSpec builder.
 *
 * The run request is `cloister/execution/v1`, whose canonical schema is owned by
 * ley-line-open (`schema-spec/execution/v1/execution.capnp`). Cloister consumes
 * it through schema-bridge — the path that produces `src/generated/cluster.zod.ts`
 * — and does not enumerate its fields by hand. Per ADR-0063.
 *
 * This module previously carried a hand-written ten-field RunSpec. The canonical
 * struct has eleven fields and shares NONE of those ten names, so the mapping
 * emitted an object the contract rejects outright — and cloister's full gate
 * passed green the whole time. That is the cost of mirroring a schema you do not
 * own. It is not reconstructable from memory or inference; it is generated or it
 * is wrong.
 *
 * The builder returns when LLO publishes `execution/v1` to a tagged release and
 * schema-bridge emits TypeScript for it (`ley-line-open-6d811a`, tracked here as
 * `cloister-3e86e8`). It will model THREE structs, not one — RunSpec is intent
 * and explicitly "is not authority", RunGrant is the resolved authority bound to
 * a RunSpec digest, RunReceipt is terminal evidence. See ADR-0063 §2.
 *
 * What remains below is the half that does not depend on the wire shape: nothing
 * is accepted as evidence of a run without something that verifies it.
 */

/**
 * Accept an execution receipt only on evidence. Pure over `options.env`.
 *
 * Two rules, in this order, and the order is the security property:
 *
 *  1. If a verifier was supplied, its answer is FINAL — both ways. A verifier
 *     that ran and said no means the receipt was checked and found bad, which
 *     is strictly worse than one never checked. Nothing downstream may soften
 *     that; the downgrade in rule 2 exists for "no verifier was available",
 *     never for "the verifier rejected it".
 *  2. The local-fixture downgrade needs three things at once: both explicit
 *     option flags AND `CLOISTER_MODE=dev`. The env anchor is what keeps this
 *     from being the per-request auth bypass ADR-0007 removed — committed
 *     config can never set `CLOISTER_MODE=dev` (lint:no-dev-mode enforces
 *     that), so in any deployed configuration the two flags are inert and
 *     this function fails closed.
 *
 * `options.verify` is the INJECTION SEAM for LLO's real verifier
 * (`ley-line-open-20f7e5`). Cloister must never grow a parallel implementation
 * of that trust decision — per ADR-0035, and because two implementations of one
 * trust decision disagree exactly once, in production, in the accepting
 * direction. Note that the real verifier resolves TWO content-addressed
 * `EvidenceRef`s rather than answering one boolean: workload-identity evidence
 * (Interlace/WIMSE — *what is running*) and actor-provenance evidence (a Signet
 * bridge cert — *on whose behalf*). The boolean shape here is the seam, not the
 * contract; see ADR-0063 §3.
 */
export async function verifyExecutionReceipt(receipt, options = {}) {
  const verify = options.verify;
  if (typeof verify === "function") {
    if (await verify(receipt)) return receipt;
    throw new Error("execution receipt was rejected by the execution receipt verifier");
  }

  const env = options.env ?? process.env;
  if (
    options.allowUnverifiedEvidence === true &&
    options.localFixture === true &&
    env.CLOISTER_MODE === "dev"
  ) {
    return receipt;
  }

  throw new Error(
    "execution receipt could not be verified; provide Cloister's real LLO verifier " +
      "or use the explicit local-fixture downgrade under CLOISTER_MODE=dev",
  );
}
