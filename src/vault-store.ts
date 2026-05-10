// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CredentialVault — Durable Object hosting the cluster's credential vault.
//
// Per ADR-0013 (slice-grant enforcement via V8 isolate + service-binding-
// as-syscall) + ADR-0011 three-criterion test, vault is hypervisor-tier:
//
//   - **mediates** every credential read across every tool bundle
//   - **multi-bundle blast radius** if compromised (every bundle's grants
//     gone)
//   - **singleton** per cluster — one vault, one master KEK, one set of
//     `allowedSubs` per credential
//
// Keying: SINGLETON per cluster, reached via
// `env.VAULT_STORE.idFromName("cluster")`. Same convention as TrustStore
// and BlobStore.
//
// What this file wraps:
//
//   The pure library code in `vault/src/{vault,crypto,handler}.ts` (lifted
//   from notme/vault/ per cloister-9ad9eb, AGPL-3.0). Those files are
//   storage-and-runtime-agnostic — they take an injected `VaultStorage`
//   interface. This DO supplies the SQLite-backed storage, derives the
//   KEK from `env.VAULT_KEK_SECRET`, and exposes the methods callers
//   need.
//
// What this file does NOT wrap (deliberate):
//
//   - **No HTTP route surface** — vault is not addressable at /vault on
//     cloister's public face. Reachability is via the DO binding from
//     inside cloister-router; future tool-bundle Workers will reach it
//     via a service binding (per ADR-0013). Wiring tool-bundle Workers
//     to vault is a separate concern (the identity-propagation question
//     is unresolved until the first such Worker actually ships — see
//     "Open: in-cluster bundle identity propagation" below).
//
//   - **No automatic identity verification** — every method takes an
//     explicit `callerSub` string. The DO trusts what's passed; callers
//     must verify identity BEFORE calling. Today only cloister-router
//     itself reaches vault, so callers are gateway-internal and
//     trust-bounded.
//
// ── Open: in-cluster bundle identity propagation ─────────────────────────
//
// When the first workerd-bundle Worker is declared in cluster.capnp
// (today the kind is schema-reserved with no users), how it authenticates
// to vault is undecided. Options on the table per ADR-0013:
//
//   (a) Pre-issued DPoP token in the bundle's env var. Bundle presents
//       to vault. Vault verifies via notme's JWKS. Requires deploy-time
//       injection + DPoP path in this DO.
//
//   (b) Service-binding-caller name + workerd config correlation. Needs
//       workerd to surface "which Worker is calling me" — unclear today.
//
//   (c) Cloister-router fetches token per-request and proxies vault
//       calls on the bundle's behalf. Puts the router in the credential
//       path — substrate-isolation regression.
//
// Pick whichever makes sense at the time of the first real bundle.
// Until then this DO ships with the gateway-internal-only contract.
//
// Filed: cloister-ac30e7 covers the substrate-property lint that will
// accompany whichever choice gets made.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types.js";
import {
  buildErrorResponse,
  buildProxyRequest,
  checkAccess,
  sanitizeResponse,
  type StoredCredential,
  type VaultStorage,
} from "../vault/src/vault.js";
import {
  decrypt,
  deriveKEK,
  encrypt,
  type SealedCredential,
} from "../vault/src/crypto.js";

/** SQLite row shape — sealed_headers is JSON-serialized SealedCredential. */
interface StoredRow {
  upstream: string;
  sealed_headers: string;
  allowed_subs_json: string;
}

/**
 * Public RPC surface for VaultStore.
 *
 * The DO RPC contract intentionally omits a "get the decrypted credential"
 * method. Plaintext credential bytes never cross the RPC boundary —
 * `proxyRequest` decrypts inside the DO and performs the upstream fetch
 * from here. Callers see the proxied response, never the credential.
 */
export interface VaultStoreRpc {
  putCredential(
    service: string,
    cred: { upstream: string; headers: Record<string, string>; allowedSubs: string[] },
  ): Promise<void>;

  getCredentialMetadata(service: string): Promise<{
    upstream: string;
    allowedSubs: string[];
  } | null>;

  deleteCredential(service: string): Promise<boolean>;

  listServices(): Promise<string[]>;

  proxyRequest(
    service: string,
    callerSub: string,
    incomingRequest: Request,
  ): Promise<Response>;
}

export class CredentialVault extends DurableObject implements VaultStoreRpc {
  private kekPromise: Promise<CryptoKey> | null = null;
  private readonly storage: VaultStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Provision the credentials table once per DO lifetime. SQL .exec()
    // is the workerd Storage API (NOT a process exec) — same call shape
    // as BeadStore / TrustStore / BlobStore use.
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS credentials (
        service TEXT PRIMARY KEY,
        upstream TEXT NOT NULL,
        sealed_headers TEXT NOT NULL,
        allowed_subs_json TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    // Adapter shape required by vault/src/vault.ts pure helpers. The
    // shape exists so the library can be unit-tested with in-memory
    // storage — we plug SQLite in for the DO.
    this.storage = {
      get: async (service: string) => this.#readRow(service),
      put: async (service: string, cred: StoredCredential) => this.#writeRow(service, cred),
      delete: async (service: string) => this.#deleteRow(service),
      list: async () => this.#listRows(),
    };
  }

  async putCredential(
    service: string,
    cred: { upstream: string; headers: Record<string, string>; allowedSubs: string[] },
  ): Promise<void> {
    await this.storage.put(service, cred);
  }

  async getCredentialMetadata(service: string): Promise<{
    upstream: string;
    allowedSubs: string[];
  } | null> {
    const row = await this.#readRow(service);
    if (!row) return null;
    return { upstream: row.upstream, allowedSubs: row.allowedSubs };
  }

  async deleteCredential(service: string): Promise<boolean> {
    return this.storage.delete(service);
  }

  async listServices(): Promise<string[]> {
    return this.storage.list();
  }

  async proxyRequest(
    service: string,
    callerSub: string,
    incomingRequest: Request,
  ): Promise<Response> {
    const row = this.ctx.storage.sql.exec(
      "SELECT upstream, sealed_headers, allowed_subs_json FROM credentials WHERE service = ?",
      service,
    ).toArray() as unknown as StoredRow[];

    if (row.length === 0) {
      return Response.json(
        buildErrorResponse("not_found", callerSub, service, null),
        { status: 404 },
      );
    }

    const sealedJson = row[0].sealed_headers;
    const upstream   = row[0].upstream;
    const allowedSubs = JSON.parse(row[0].allowed_subs_json) as string[];

    if (!checkAccess(allowedSubs, callerSub)) {
      return Response.json(
        // buildErrorResponse takes cred for callsite ergonomics but
        // deliberately omits its value from the response — pinned by
        // test/security/prompt-injection.test.ts scenario 2.
        buildErrorResponse("forbidden", callerSub, service, {
          upstream,
          headers: {},
          allowedSubs,
        }),
        { status: 403 },
      );
    }

    const kek = await this.#getKEK();
    const sealed = JSON.parse(sealedJson) as SealedCredential;
    const headers = await decrypt(sealed, kek);

    const cred: StoredCredential = { upstream, headers, allowedSubs };
    const proxyReq = buildProxyRequest(incomingRequest, cred);
    const upstreamResponse = await fetch(proxyReq);
    return sanitizeResponse(upstreamResponse);
  }

  override async fetch(_request: Request): Promise<Response> {
    return new Response("credential-vault: no inbound HTTP surface; use RPC", {
      status: 405,
      headers: { "content-type": "text/plain" },
    });
  }

  #getKEK(): Promise<CryptoKey> {
    if (!this.kekPromise) {
      const secret = (this.env as Env & { VAULT_KEK_SECRET?: string }).VAULT_KEK_SECRET;
      if (!secret) {
        throw new Error("VAULT_KEK_SECRET binding is unset — vault cannot derive its key");
      }
      this.kekPromise = deriveKEK(secret);
    }
    return this.kekPromise;
  }

  async #readRow(service: string): Promise<StoredCredential | null> {
    const rows = this.ctx.storage.sql.exec(
      "SELECT upstream, sealed_headers, allowed_subs_json FROM credentials WHERE service = ?",
      service,
    ).toArray() as unknown as StoredRow[];
    if (rows.length === 0) return null;
    return {
      upstream: rows[0].upstream,
      headers: {},
      allowedSubs: JSON.parse(rows[0].allowed_subs_json),
    };
  }

  async #writeRow(service: string, cred: StoredCredential): Promise<void> {
    const kek = await this.#getKEK();
    const sealed = await encrypt(cred.headers, kek);

    this.ctx.storage.sql.exec(
      `INSERT INTO credentials (service, upstream, sealed_headers, allowed_subs_json)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(service) DO UPDATE SET
         upstream = excluded.upstream,
         sealed_headers = excluded.sealed_headers,
         allowed_subs_json = excluded.allowed_subs_json,
         updated_at = datetime('now')`,
      service,
      cred.upstream,
      JSON.stringify(sealed),
      JSON.stringify(cred.allowedSubs),
    );
  }

  async #deleteRow(service: string): Promise<boolean> {
    const result = this.ctx.storage.sql.exec(
      "DELETE FROM credentials WHERE service = ?",
      service,
    );
    return result.rowsWritten > 0;
  }

  async #listRows(): Promise<string[]> {
    return this.ctx.storage.sql.exec("SELECT service FROM credentials ORDER BY service")
      .toArray()
      .map((r) => (r as unknown as { service: string }).service);
  }
}
