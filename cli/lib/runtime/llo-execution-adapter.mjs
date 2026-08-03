// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Cloister-owned policy adapter for LLO execution/v1.
 *
 * This module deliberately knows the neutral request shape, but not LLO's
 * transport or Rust types. The generated client will be injected at the next
 * seam; keeping this mapping pure makes the policy boundary testable now.
 */

const REQUIRED = [
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
const ALLOWED = new Set(REQUIRED);

export function buildRunSpec(policy) {
  if (!policy || typeof policy !== "object") {
    throw new TypeError("execution policy must be an object");
  }
  for (const field of REQUIRED) {
    if (!(field in policy)) throw new TypeError(`execution policy is missing ${field}`);
  }
  for (const field of Object.keys(policy)) {
    if (!ALLOWED.has(field)) {
      throw new TypeError(`unknown execution policy field ${JSON.stringify(field)}`);
    }
  }
  return { schema: "execution/v1", ...structuredClone(policy) };
}

export async function verifyExecutionReceipt(receipt, options = {}) {
  const verify = options.verify;
  if (typeof verify === "function" && await verify(receipt)) return receipt;

  if (options.allowUnverifiedEvidence === true && options.localFixture === true) {
    return receipt;
  }

  throw new Error(
    "execution receipt could not be verified; provide Cloister's real LLO verifier " +
      "or use the explicit local-fixture downgrade",
  );
}
