// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Cloister-owned policy adapter for LLO execution/v1.
 *
 * This module deliberately knows the neutral request shape, but not LLO's
 * transport or Rust types. The generated client will be injected at the next
 * seam; keeping this mapping pure makes the policy boundary testable now.
 */

// execution/v1's field set. Every field is required and no field is optional,
// so this ONE list answers both questions the mapping asks — "is anything
// missing" and "is anything undeclared". Two lists would imply they can
// diverge; they cannot.
const FIELDS = [
  "artifactRef",
  "entrypoint",
  "argv",
  "workspaceGrant",
  "isolation",
  "filesystem",
  "network",
  "resources",
  "secrets",
  "receiptDestination",
];
const FIELD_SET = new Set(FIELDS);

export function buildRunSpec(policy) {
  if (!policy || typeof policy !== "object") {
    throw new TypeError("execution policy must be an object");
  }
  for (const field of FIELDS) {
    if (!(field in policy)) throw new TypeError(`execution policy is missing ${field}`);
  }
  for (const field of Object.keys(policy)) {
    if (!FIELD_SET.has(field)) {
      throw new TypeError(`unknown execution policy field ${JSON.stringify(field)}`);
    }
  }
  return { schema: "execution/v1", ...structuredClone(policy) };
}

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
