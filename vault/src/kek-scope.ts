// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 cloister contributors

// Three-tier KEK scoping for the credential vault per ADR-0030 §A3.
//
// Background: ADR-0014 (URL-spec resolver in `kek-source.ts`) gave the
// operator a SINGLE knob — one URL spec → one KEK. ADR-0030's
// multi-workerd substrate adds tenant boundaries above that knob. Each
// per-tenant workerd needs ITS OWN KEK, but operators don't want to
// manage N independent secrets when N is "every tenant in the cluster."
//
// This module adds a SCOPE dimension on top of `kek-source.ts`:
//
//   - **cluster** scope — N tenants derive their KEKs from ONE root via
//     HKDF. Operator manages one secret; per-tenant KEKs are a
//     deterministic function of (root, tenantName). Different tenantName
//     → independent KEK bytes.
//   - **service** scope — operator-provisioned per service. Each service
//     declares its own URL spec; the resolver loads that spec via the
//     existing `kek-source.ts` rails. Service-tier secrets SURVIVE
//     cluster-master compromise.
//   - **user** scope — per authenticated peer (`subject_fp`).
//     DEFERRED to v2 per ADR-0030 §A3.
//
// The KekScope discriminator below prevents accidental cross-tier reads
// at the type level: code holding a `{kind: "cluster", ...}` can't
// silently pass it to a service-scope reader.
//
// Threat model §13.7.3 specifies the explicit boundary:
//   - cluster master compromise = all cluster-tier tenants compromised
//   - service-tier secrets remain independent (require separate
//     operator-provisioned source compromise)
//
// Per cloister-0f60a8 (ADR-0030 §A3 impl).

import { buildKekSource, type KekSource, type KekSourceEnv } from "./kek-source.js";

// ── Scope discriminator (compile-time tier separation) ────────────────────

export type KekScope =
  | { readonly kind: "cluster"; readonly tenantName: string }
  | { readonly kind: "service"; readonly name: string };

// ── HKDF derivation (cluster tier) ────────────────────────────────────────

/**
 * Canonical HKDF "info" string for cluster-tier per-tenant derivation.
 * Locked down so the bytes are deterministic across implementations.
 *
 * Shape: `cloister/cred-iso/v1/tenant/` + tenantName (UTF-8 encoded).
 *
 * The version segment (`v1`) is part of the substrate's published
 * security claim. Bumping it would invalidate every existing tenant's
 * KEK — that's the point: a v1→v2 transition is a deliberate operator
 * action (re-derive + re-encrypt), not a silent change.
 */
const HKDF_INFO_PREFIX = "cloister/cred-iso/v1/tenant/";

/**
 * Forbidden characters in tenantName. Conservative — only allow
 * lowercase ASCII, digits, hyphens, dots (for FQDN-shaped tenants).
 *
 * This rejects:
 *   - Path traversal attempts (`..`, `/`, `\`)
 *   - Whitespace (would survive HKDF but breaks operator readability)
 *   - Unicode lookalikes (would survive HKDF but breaks audit + UI)
 *
 * The substrate's published security claim is "different tenantName →
 * independent KEK." This validator prevents an attacker who controls
 * tenantName from constructing collisions via whitespace / encoding
 * tricks — the byte stream that goes into HKDF is constrained.
 */
function validateTenantName(name: string): string | null {
  if (typeof name !== "string") return "not a string";
  if (name.length === 0) return "empty";
  if (name.length > 253) return "exceeds 253 chars (DNS-style limit)";
  for (const ch of name) {
    const isLower = ch >= "a" && ch <= "z";
    const isDigit = ch >= "0" && ch <= "9";
    if (!(isLower || isDigit || ch === "-" || ch === ".")) {
      return `disallowed character ${JSON.stringify(ch)} (allowed: a-z, 0-9, -, .)`;
    }
  }
  if (name.startsWith(".") || name.endsWith(".")) return "leading/trailing dot";
  if (name.startsWith("-") || name.endsWith("-")) return "leading/trailing hyphen";
  if (name.includes("..")) return "doubled dot";
  return null;
}

/**
 * Derive a per-tenant cluster-scope KEK from the root KEK via HKDF-SHA256.
 *
 * Inputs:
 *   - `rootKek` — the raw bytes resolved from the operator's URL spec
 *                 (via `kek-source.ts buildKekSource(...).resolve()`)
 *   - `tenantName` — the tenant identifier (must satisfy
 *                    `validateTenantName`)
 *
 * Output: 32 bytes (256 bits) of derived KEK material, hex-encoded as a
 * lowercase string (64 ASCII chars). The downstream vault DO consumes
 * this string the same way it consumes the raw `KekSource.resolve()`
 * output today (UTF-8 bytes → HKDF importKey → AES-GCM key).
 *
 * Properties (asserted by tests + locked into the conformance vectors):
 *   - Determinism: same (rootKek, tenantName) → same output
 *   - Independence: different tenantName → independent output (HKDF
 *                   property; no derivable relationship)
 *   - Canonical: bytes match the Python ref-impl-py output for the
 *                same inputs (cross-implementation conformance)
 */
export async function deriveClusterTenantKek(
  rootKek: string,
  tenantName: string,
): Promise<string> {
  const problem = validateTenantName(tenantName);
  if (problem !== null) {
    throw new Error(
      `kek-scope: cluster-tier tenantName invalid (${problem}): ` +
        JSON.stringify(tenantName),
    );
  }
  if (typeof rootKek !== "string" || rootKek.length === 0) {
    throw new Error("kek-scope: rootKek must be a non-empty string");
  }

  const enc = new TextEncoder();
  const ikm = enc.encode(rootKek);
  const info = enc.encode(HKDF_INFO_PREFIX + tenantName);
  // Empty salt per RFC 5869 §3.1 — when no salt is available, an
  // all-zero string of HashLen is used. The Web Crypto HKDF API accepts
  // a zero-length salt and applies the same fallback internally.
  const salt = new Uint8Array(0);

  const ikmKey = await crypto.subtle.importKey(
    "raw",
    ikm,
    { name: "HKDF" },
    false,
    ["deriveBits"],
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    ikmKey,
    256,
  );
  return bytesToHex(new Uint8Array(derivedBits));
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    out += (b < 16 ? "0" : "") + b.toString(16);
  }
  return out;
}

// ── Scope-aware KEK source ────────────────────────────────────────────────

/**
 * Build a `KekSource` from a `KekScope` + the operator's per-scope
 * source declarations.
 *
 * For `{kind: "cluster", tenantName}`:
 *   - The operator declares ONE root URL spec (`clusterRootSpec`).
 *   - The returned `KekSource.resolve()` loads the root via
 *     `buildKekSource(clusterRootSpec, env)`, then HKDF-derives the
 *     per-tenant KEK via `deriveClusterTenantKek`.
 *
 * For `{kind: "service", name}`:
 *   - The operator declares per-service URL specs (`serviceSpecs.get(name)`).
 *   - The returned `KekSource.resolve()` loads the named service's spec
 *     directly via `buildKekSource`. NO HKDF derivation — the operator
 *     IS provisioning the per-service secret; the substrate doesn't
 *     derive from a shared root.
 *
 * This is the type-level cross-tier separation §13.7.3 requires: code
 * that wants service-tier MUST pass a `{kind: "service", name}` scope,
 * and that scope is incompatible with `{kind: "cluster"}` at compile
 * time. There is no way to silently get a service-tier read when you
 * have a cluster-tier scope handle (or vice versa).
 */
export function buildKekScopeSource(
  scope: KekScope,
  clusterRootSpec: string,
  serviceSpecs: ReadonlyMap<string, string>,
  env: KekSourceEnv,
): KekSource {
  if (scope.kind === "cluster") {
    return {
      async resolve(): Promise<string> {
        const root = await buildKekSource(clusterRootSpec, env).resolve();
        return deriveClusterTenantKek(root, scope.tenantName);
      },
    };
  }
  // scope.kind === "service"
  const spec = serviceSpecs.get(scope.name);
  if (spec === undefined) {
    throw new Error(
      `kek-scope: no URL spec declared for service ${JSON.stringify(scope.name)} ` +
        "(operator must add it to the [[services]] table)",
    );
  }
  return buildKekSource(spec, env);
}

// ── Re-exports for convenience (the bead's API surface) ──────────────────

export { HKDF_INFO_PREFIX };
