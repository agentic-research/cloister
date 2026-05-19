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

export class VaultDoCredentialStore implements CredentialStore {
  private readonly env:          Env;
  private readonly bundleIdName: string;

  constructor(deps: VaultDoCredentialStoreDeps) {
    this.env          = deps.env;
    this.bundleIdName = deps.bundleIdName;
  }

  /**
   * Plaintext credential bytes never cross the vault DO RPC boundary.
   * The route composition root pairs this impl with the `forward` path
   * (D2) which delegates the full Request to vault DO instead.
   */
  async resolve(_peerFp: string, _service: string): Promise<CredentialLookup | null> {
    return null;
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
        kind:          "error",
        source:        "cloister/credential-isolation/v1",
        location:      "VaultDoCredentialStore.forward",
        bundleIdName:  this.bundleIdName,
        service,
        error_class:   e.name,
        error_message: e.message,
        bead:          "cloister-6e6bfb",
      }));
      return errorResponse(502, JSON.stringify({ error: "upstream_unavailable" }));
    }
  }
}

