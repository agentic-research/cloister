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
//   KEK via `vault/src/kek-source.ts` (URL-driven; supports env://,
//   file://, keychain://, http(s)://), and exposes the methods callers
//   need. See ADR-0014 for the KEK-source design.
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
//     explicit `subjectFp` (and `callerSub` on proxyRequest) string.
//     The DO trusts what's passed; callers MUST verify identity BEFORE
//     calling. Today only cloister-router itself reaches vault, so
//     callers are gateway-internal and trust-bounded — the router
//     threads `VerifiedLease.peerFp` (post lease-middleware) as the
//     `subjectFp` arg.
//
// ── Cross-bundle isolation: layered defense (cloister-26546a) ────────────
//
// ADR-0013 places cross-bundle isolation at the BINDING layer: each
// bundle should be wired to a distinct vault DO via its own
// `idFromName(...)` namespace, and the manifest grants are the
// load-bearing thing. That contract holds: if the manifest is correct,
// bundles can't even *reach* each other's vault namespaces.
//
// But within a single vault DO, before this revision, the `credentials`
// table used `service` alone as the primary key. If a manifest mistake
// (or a transitional shared-binding configuration) ever placed two
// bundles in the same vault DO, bundle A could call putCredential with
// any `service` string and clobber bundle B's row — `allowedSubs` only
// gates READS at proxyRequest time. The write side was a flat namespace.
//
// Defense-in-depth fix: the credentials table now has a composite
// primary key `(subject_fp, service)`. `subject_fp` is the verified
// caller's cert fingerprint (`VerifiedLease.peerFp` for in-router
// callers; same for service-binding callers when identity propagation
// lands). The DO never accepts a caller-supplied `subject_fp` from
// request input — it's a positional argument that the router (the
// only caller today) threads from post-verify lease state. All
// read/write/delete/list methods filter by `(subject_fp, service)`.
//
// Layered model:
//
//   - Binding layer (which DO instance): manifest-enforced. Two
//     bundles wired to the same `env.VAULT_STORE` namespace can reach
//     the same DO; bundles wired to distinct namespaces cannot.
//   - SQL layer (which row): subject_fp-enforced. Even if two callers
//     share a binding, they cannot read or overwrite each other's
//     credential rows. This is layered protection, not the primary
//     gate.
//
// If the manifest is correct, the SQL layer is unreachable for
// cross-bundle traffic. If the manifest is wrong, the SQL layer is the
// next line of defense.
//
// Migration note: vault is pre-1.0 and ships with no production data
// (no in-cluster bundles call it yet — see "Open" below). The
// CREATE TABLE installs the new schema cleanly; an old table (if it
// exists from a prior workerd run) is dropped DESTRUCTIVELY at
// constructor time after a PRAGMA table_info check. Documented as
// destructive recreate in the migration section of `cluster.capnp`
// when the first production deploy nears.
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
import { buildKekSource, type KekSource } from "../vault/src/kek-source.js";

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
 *
 * Every method takes a `subjectFp` argument — the verified caller's cert
 * fingerprint. Callers MUST derive this from `VerifiedLease.peerFp` (or
 * the service-binding identity once that lands); never from
 * request-supplied input. Per cloister-26546a.
 */
export interface VaultStoreRpc {
  putCredential(
    subjectFp: string,
    service: string,
    cred: { upstream: string; headers: Record<string, string>; allowedSubs: string[] },
  ): Promise<void>;

  getCredentialMetadata(
    subjectFp: string,
    service: string,
  ): Promise<{
    upstream: string;
    allowedSubs: string[];
  } | null>;

  deleteCredential(subjectFp: string, service: string): Promise<boolean>;

  listServices(subjectFp: string): Promise<string[]>;

  proxyRequest(
    subjectFp: string,
    service: string,
    callerSub: string,
    incomingRequest: Request,
  ): Promise<Response>;
}

export class CredentialVault extends DurableObject implements VaultStoreRpc {
  private kekPromise: Promise<CryptoKey> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Provision the credentials table once per DO lifetime. Composite PK
    // is `(subject_fp, service)` — every row is namespaced by the
    // verified caller's cert fingerprint. See file header for the
    // rationale (cloister-26546a, defense-in-depth against shared-
    // binding manifest mistakes).
    //
    // Same SQL Storage API shape as BeadStore / TrustStore / BlobStore.
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS credentials (
        subject_fp TEXT NOT NULL,
        service TEXT NOT NULL,
        upstream TEXT NOT NULL,
        sealed_headers TEXT NOT NULL,
        allowed_subs_json TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (subject_fp, service)
      )
    `);

    // Defensive migration: if the table existed previously with the OLD
    // schema (single PK `service`, no `subject_fp` column), the CREATE
    // TABLE IF NOT EXISTS above is a no-op and we'd silently retain the
    // unsafe shape. Detect that case via PRAGMA table_info and recreate
    // destructively. Pre-1.0; no production data exists. Runs once per
    // DO lifetime so the cost is negligible.
    const cols = ctx.storage.sql
      .exec("PRAGMA table_info(credentials)")
      .toArray() as unknown as Array<{ name: string }>;
    const hasSubjectFp = cols.some((c) => c.name === "subject_fp");
    if (!hasSubjectFp && cols.length > 0) {
      ctx.storage.sql.exec("DROP TABLE credentials");
      ctx.storage.sql.exec(`
        CREATE TABLE credentials (
          subject_fp TEXT NOT NULL,
          service TEXT NOT NULL,
          upstream TEXT NOT NULL,
          sealed_headers TEXT NOT NULL,
          allowed_subs_json TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          PRIMARY KEY (subject_fp, service)
        )
      `);
    }
  }

  /**
   * Build the storage adapter the pure `vault/` library expects, bound
   * to a specific verified subject fingerprint. Every (subjectFp,
   * service) tuple is its own row; the adapter scopes all CRUD to that
   * subject so the library never sees cross-subject data.
   */
  #storageFor(subjectFp: string): VaultStorage {
    return {
      get: (service: string) => this.#readRow(subjectFp, service),
      put: (service: string, cred: StoredCredential) =>
        this.#writeRow(subjectFp, service, cred),
      delete: (service: string) => this.#deleteRow(subjectFp, service),
      list: () => this.#listRows(subjectFp),
    };
  }

  async putCredential(
    subjectFp: string,
    service: string,
    cred: { upstream: string; headers: Record<string, string>; allowedSubs: string[] },
  ): Promise<void> {
    assertSubjectFp(subjectFp);
    await this.#storageFor(subjectFp).put(service, cred);
  }

  async getCredentialMetadata(
    subjectFp: string,
    service: string,
  ): Promise<{
    upstream: string;
    allowedSubs: string[];
  } | null> {
    assertSubjectFp(subjectFp);
    const row = await this.#readRow(subjectFp, service);
    if (!row) return null;
    return { upstream: row.upstream, allowedSubs: row.allowedSubs };
  }

  async deleteCredential(subjectFp: string, service: string): Promise<boolean> {
    assertSubjectFp(subjectFp);
    return this.#deleteRow(subjectFp, service);
  }

  async listServices(subjectFp: string): Promise<string[]> {
    assertSubjectFp(subjectFp);
    return this.#listRows(subjectFp);
  }

  async proxyRequest(
    subjectFp: string,
    service: string,
    callerSub: string,
    incomingRequest: Request,
  ): Promise<Response> {
    assertSubjectFp(subjectFp);

    const row = this.ctx.storage.sql.exec(
      "SELECT upstream, sealed_headers, allowed_subs_json FROM credentials WHERE subject_fp = ? AND service = ?",
      subjectFp,
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
      this.kekPromise = this.#resolveKekSource().resolve().then(deriveKEK);
    }
    return this.kekPromise;
  }

  /**
   * Resolve the KEK source URL for this DO. The order of precedence:
   *
   *   1. `env.VAULT_KEK_SOURCE` — explicit URL spec (env://NAME,
   *      file:///path, keychain://service, http://helper/...). The
   *      preferred path for new deployments.
   *   2. Legacy fallback — `env.VAULT_KEK_SECRET` present → behave as
   *      if `VAULT_KEK_SOURCE=env://VAULT_KEK_SECRET`. Keeps existing
   *      config.capnp / wrangler.toml / tests working unchanged.
   *
   * If neither is set, fail loudly — the DO refuses to operate with an
   * unresolvable KEK.
   */
  #resolveKekSource(): KekSource {
    // KekSourceEnv is a structural index-signature shape; widen via
    // `unknown` so the cloudflare `Env` interface (which has no string
    // index signature) flows through.
    const env = this.env as Env & {
      VAULT_KEK_SOURCE?: string;
      VAULT_KEK_SECRET?: string;
    };
    const kekEnv = this.env as unknown as Record<string, unknown>;
    const explicit = typeof env.VAULT_KEK_SOURCE === "string"
      ? env.VAULT_KEK_SOURCE.trim()
      : "";
    if (explicit.length > 0) {
      return buildKekSource(explicit, kekEnv);
    }
    if (typeof env.VAULT_KEK_SECRET === "string" && env.VAULT_KEK_SECRET.length > 0) {
      return buildKekSource("env://VAULT_KEK_SECRET", kekEnv);
    }
    throw new Error(
      "vault: neither VAULT_KEK_SOURCE nor VAULT_KEK_SECRET is set — " +
        "vault cannot derive its key",
    );
  }

  async #readRow(subjectFp: string, service: string): Promise<StoredCredential | null> {
    const rows = this.ctx.storage.sql.exec(
      "SELECT upstream, sealed_headers, allowed_subs_json FROM credentials WHERE subject_fp = ? AND service = ?",
      subjectFp,
      service,
    ).toArray() as unknown as StoredRow[];
    if (rows.length === 0) return null;
    return {
      upstream: rows[0].upstream,
      headers: {},
      allowedSubs: JSON.parse(rows[0].allowed_subs_json),
    };
  }

  async #writeRow(
    subjectFp: string,
    service: string,
    cred: StoredCredential,
  ): Promise<void> {
    const kek = await this.#getKEK();
    const sealed = await encrypt(cred.headers, kek);

    this.ctx.storage.sql.exec(
      `INSERT INTO credentials (subject_fp, service, upstream, sealed_headers, allowed_subs_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(subject_fp, service) DO UPDATE SET
         upstream = excluded.upstream,
         sealed_headers = excluded.sealed_headers,
         allowed_subs_json = excluded.allowed_subs_json,
         updated_at = datetime('now')`,
      subjectFp,
      service,
      cred.upstream,
      JSON.stringify(sealed),
      JSON.stringify(cred.allowedSubs),
    );
  }

  async #deleteRow(subjectFp: string, service: string): Promise<boolean> {
    const result = this.ctx.storage.sql.exec(
      "DELETE FROM credentials WHERE subject_fp = ? AND service = ?",
      subjectFp,
      service,
    );
    return result.rowsWritten > 0;
  }

  async #listRows(subjectFp: string): Promise<string[]> {
    return this.ctx.storage.sql.exec(
      "SELECT service FROM credentials WHERE subject_fp = ? ORDER BY service",
      subjectFp,
    )
      .toArray()
      .map((r) => (r as unknown as { service: string }).service);
  }
}

/**
 * Guard the load-bearing assumption: every RPC method takes a
 * non-empty subject fingerprint, and the DO refuses to operate
 * without one.
 *
 * This isn't authentication — the DO trusts what's passed (see file
 * header). It's a contract check: a caller forgetting to thread
 * `VerifiedLease.peerFp` through can't accidentally collapse to a
 * global namespace by passing `""`. Fail loud at the call site rather
 * than silent on the SQL row.
 */
function assertSubjectFp(subjectFp: string): void {
  if (typeof subjectFp !== "string" || subjectFp.length === 0) {
    throw new Error("vault: subjectFp is required and must be non-empty");
  }
  // Reject control characters — same family of injection concerns as
  // checkAccess (vault/src/vault.ts:137). subject_fp goes straight into
  // a SQL parameter, so the SQL driver handles quoting, but a control
  // char in here is a sign of upstream mishandling.
  if (/[\x00-\x1f]/.test(subjectFp)) {
    throw new Error("vault: subjectFp contains control characters");
  }
}
