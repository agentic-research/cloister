// SPDX-License-Identifier: AGPL-3.0-or-later
//
// bundle-token-verify — the CLOISTER-OWNED pieces of the ADR-0047 bundle→vault
// decision. The cryptographic verify (token EdDSA sig + ES256 DPoP proof + RFC
// 7638 cnf.jkt binding) now lives in the vendored notme SDK
// (`src/vendor/notme-dpop.ts`, `verifyDPoPToken`) — cloister no longer hand-rolls
// it (cloister-0ae913: the hand-rolled path was Ed25519-only and could not verify
// notme's ES256/EC-minted tokens). What stays here are the two policy helpers
// `authenticateBundleRequest` composes over that verify: scope-grant matching and
// the vault subject_fp derivation.

/**
 * Does the `granted` scope claim cover `requested`? OAuth `scope` is a
 * SPACE-DELIMITED set (notme mints it via `scopes.join(" ")`), so we test each
 * granted entry: exact match, or a `:*` suffix wildcard covering any `requested`
 * under that prefix (`vault:proxy:*` grants `vault:proxy:anthropic`). Deliberately
 * narrow — the bare admin `"*"` is rejected upstream in `authenticateBundleRequest`,
 * never matched here.
 */
export function scopeGrants(granted: string, requested: string): boolean {
  for (const g of granted.split(/\s+/).filter(Boolean)) {
    if (g === requested) return true;
    if (g.endsWith(":*") && requested.startsWith(g.slice(0, -1))) return true;
  }
  return false;
}

/** `sha256:<first-12-bytes-hex>` of the verified sub — the vault's subject_fp shape. */
export async function deriveSubjectFp(sub: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sub)));
  const hex = Array.from(digest.slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}
