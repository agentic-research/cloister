// src/routes/vault-do-credential-store.ts — production `CredentialStore`
// impl that delegates to the existing `CredentialVault` DO.
//
// Per cloister-e26ea8 (D1 of the DO saga / cloister-d98db2). Pairs
// with ADR-0013 (slice-grant: plaintext stays inside DO) and ADR-0021
// (per-bundle keying via `idFromName(<bundleIdName>)`).
//
// Two methods, by design:
//
//   - `resolve` — always returns `null`. Vault DO deliberately does not
//     expose credential bytes via RPC (`vault-store.ts:146` is explicit
//     about this). The composition root pairs this impl with the
//     `forward`-mode handler path (see D2 / cloister-e2a12a) so the
//     no-plaintext-RPC invariant holds end-to-end.
//
//   - `forward` — hands the entire Request to vault DO's `proxyRequest`,
//     which decrypts + injects + fetches upstream inside the DO. The
//     response is returned to the caller verbatim. Failures (404, 403,
//     429) come back through the same channel; vault DO RPC throws
//     collapse to a constant-shape 502.
//
// Per-bundle keying: the constructor takes `bundleIdName: string`. That
// string is what `env.VAULT_STORE.idFromName(...)` is called with —
// per ADR-0021, each bundle's composition root passes its own bundle
// name. Today the only caller is cloister-router (`bundleIdName: "router"`);
// notme-as-bundle (cloister-db99cd) will pass `"notme"` when that lands.

import type { Env } from "../types.js";
import type {
  CredentialLookup,
  CredentialStore,
} from "./vault-proxy-credential-store.js";
import { errorResponse } from "./vault-proxy.js";

/** Minimal RPC surface this impl consumes — narrower than the full `VaultStoreRpc`. */
interface VaultProxyRpc {
  putCredential(
    subjectFp: string,
    service: string,
    cred: { upstream: string; headers: Record<string, string>; allowedSubs: string[] },
  ): Promise<void>;
  proxyRequest(
    subjectFp: string,
    service: string,
    callerSub: string,
    incomingRequest: Request,
  ): Promise<Response>;
}

export interface VaultDoCredentialStoreDeps {
  /** Cloister env, must include `VAULT_STORE` binding for production use. */
  env: Env;
  /**
   * The string passed to `env.VAULT_STORE.idFromName(...)`. Per
   * ADR-0021, this is the bundle's logical name — `"router"` for
   * cloister-router, `"notme"` for notme-as-bundle, etc. Distinct
   * names produce distinct DO instances with independent storage,
   * which is the per-bundle isolation seam.
   */
  bundleIdName: string;
}

/**
 * Stable, non-cryptographic short fingerprint of a bundleIdName for
 * structured-log distinguishability. Per cloister-938b32 (C5 of
 * adversarial cycle 2026-06-22 / threat-model §13.7.6): the prior emit
 * dropped `bundleIdName` plaintext into the structured error log on
 * every decrypt-throw. Under a `VAULT_KEK_TENANT_SCOPED=0→1` rotation
 * that's a flood of plaintext bundle names visible to log-aggregator-
 * tier observers.
 *
 * FNV-1a 32-bit is sufficient because:
 *   - The threat is "log reader sees the bundle name in cleartext", not
 *     "attacker can reverse the hash" — a non-cryptographic stable hash
 *     is the right tool.
 *   - Operators with deploy-time access can precompute the same hash
 *     locally to match a fingerprint back to a known bundle when
 *     triaging.
 *   - Synchronous (no `crypto.subtle` await in the error path).
 */
function bundleIdFp(name: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Redact `bundleIdName` if it appears inside an exception message — a
 * defensive belt-and-suspenders. Stub RPC errors from workerd don't
 * normally echo our constructor args back at us, but a custom upstream
 * error path could (e.g. "no DO with id-name 'alice-vault'"). One pass
 * `replaceAll` covers it without depending on the exact error shape.
 *
 * If `bundleIdName` is empty (shouldn't happen — assertSubjectFp-style
 * guard isn't present at the CredentialStore boundary) the redaction
 * collapses to the identity function rather than `replaceAll("","X")`
 * which would explode the string.
 */
function redactBundleId(message: string, bundleIdName: string): string {
  if (bundleIdName.length === 0) return message;
  return message.split(bundleIdName).join("<bundleIdName>");
}

export class VaultDoCredentialStore implements CredentialStore {
  private readonly env:          Env;
  private readonly bundleIdName: string;
  private readonly bundleIdFp:   string;

  constructor(deps: VaultDoCredentialStoreDeps) {
    this.env          = deps.env;
    this.bundleIdName = deps.bundleIdName;
    this.bundleIdFp   = bundleIdFp(deps.bundleIdName);
  }

  /**
   * Plaintext credential bytes never cross the vault DO RPC boundary.
   * The route composition root pairs this impl with the `forward` path
   * (D2) which delegates the full Request to vault DO instead.
   */
  async resolve(_peerFp: string, _service: string): Promise<CredentialLookup | null> {
    return null;
  }

  async putCredential(
    peerFp: string,
    service: string,
    credential: string,
    options: { upstream?: string; headers?: Record<string, string>; allowedSubs?: string[] } = {},
  ): Promise<void> {
    const ns = this.env.VAULT_STORE;
    if (!ns) throw new Error("vault unavailable");
    if (!options.upstream) throw new Error("vault credential ingress missing upstream");
    const stub = ns.get(ns.idFromName(this.bundleIdName)) as DurableObjectStub & VaultProxyRpc;
    await stub.putCredential(peerFp, service, {
      upstream: options.upstream ?? "",
      headers: options.headers ?? { authorization: credential },
      allowedSubs: options.allowedSubs ?? [peerFp],
    });
  }

  async forward(
    peerFp:    string,
    service:   string,
    callerSub: string,
    request:   Request,
  ): Promise<Response> {
    const ns = this.env.VAULT_STORE;
    if (!ns) {
      return errorResponse(503, JSON.stringify({ error: "vault_unavailable" }));
    }

    try {
      const stub = ns.get(ns.idFromName(this.bundleIdName)) as DurableObjectStub & VaultProxyRpc;
      return await stub.proxyRequest(peerFp, service, callerSub, request);
    } catch (err) {
      // Obs O-OBS-4 (2026-05-18 cycle): bare catch {} dropped RPC
      // throw context entirely — vault DO outages were invisible to
      // operators internally even though the wire-side 502 was
      // visible to clients. Now we emit a structured error log
      // capturing the exception class + message so wrangler tail /
      // CF Workers Logs surface the failure for triage. The wire
      // response stays the constant SHAPE_U_ERROR_BODY (no internal
      // detail leaks to the caller).
      //
      // Bounded-cardinality fields only:
      // - service / bundleIdName: deploy-static identifiers
      // - error_class / error_message: from the caught exception
      //   (NOT the request body, NOT the caller's identity, NOT the
      //   credential bytes — those are all out of scope at this
      //   catch boundary anyway)
      const e = err instanceof Error ? err : new Error(String(err));
      // eslint-disable-next-line no-console -- intentional structured emit
      console.error(JSON.stringify({
        kind:            "error",
        source:          "cloister/credential-isolation/v1",
        location:        "VaultDoCredentialStore.forward",
        // bundleIdName plaintext omitted per cloister-938b32 (C5 /
        // §13.7.6). The fingerprint is the deploy-static join key for
        // operator triage; the plaintext is needless surface for log-
        // aggregator-tier observers, especially under VAULT_KEK_TENANT_
        // SCOPED rotation when every old-ciphertext decrypt throws.
        bundleIdFp:      this.bundleIdFp,
        service,
        error_class:     e.name,
        error_message:   redactBundleId(e.message, this.bundleIdName),
        bead:            "cloister-6e6bfb",
        c5_bead:         "cloister-938b32",
      }));
      return errorResponse(502, JSON.stringify({ error: "upstream_unavailable" }));
    }
  }
}
