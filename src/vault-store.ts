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
//     to vault is a separate concern — the identity-propagation question
//     is now RESOLVED by ADR-0047 (per-bundle DO + notme DPoP verify); the
//     verify core has landed, the DO wiring is in progress. See "Bundle
//     identity propagation: resolved by ADR-0047" below.
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
// ── Bundle identity propagation: resolved by ADR-0047 ────────────────────
//
// How the first workerd-bundle Worker authenticates to vault is DECIDED
// (ADR-0047): a HYBRID of (1) per-bundle DO instances (ADR-0021 — the manifest
// binding IS the identity, since each bundle reaches exactly one DO) and (2) the
// vault VERIFYING a scoped notme DPoP access token, deriving `subjectFp` from the
// *verified* `sub`. That is option (a) from the old list — now cheap because
// notme ships `mintDPoPToken` (an `at+jwt` EdDSA, `cnf.jkt`-bound token). The
// ADR-0021 "(a)/(b)/(c) add machinery to retain a singleton" rejection is
// superseded: notme built the machinery. Threat model §20 covers the seam.
//
// Status: the auth logic is BUILT + tested. The cryptographic verify is the
// notme SDK (`@agentic-research/dpop`, `verifyDPoPToken` — EdDSA token
// + ES256/EC DPoP proof + RFC 7638 cnf.jkt binding, byte-identical to the notme
// issuer; cloister-0ae913 retired the hand-rolled Ed25519-only fork that could
// not verify notme's ES256-minted tokens). `src/routes/bundle-auth.ts`
// (`authenticateBundleRequest`) composes over it: the composed decision: token-or-deny
// [§20.9] + `token.sub == expectedSub` [§20.10] + DPoP proof + jti-replay +
// revocation, returning `subjectFp` derived from the verified `sub`). Remaining
// (cloister-2b98c0, gated on the FIRST real bundle per ADR-0047 migration order):
// JWK-by-`kid` fetch (caller plumbing) + WIRING this DO's bundle-facing entrypoint
// to call `authenticateBundleRequest` with the DO's pinned `expectedSub` + a
// seen-`jti` ledger. Until wired, the DO keeps the gateway-internal-only contract
// (only the router calls it, threading VerifiedLease.peerFp).
//
// Filed: cloister-ac30e7 (the substrate-property lint accompanying the choice).

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types.js";
import { logEvent } from "./obs/log.js";
import {
  buildErrorResponse,
  buildProxyRequest,
  checkAccess,
  sanitizeResponse,
  validateCredentialPayload,
  type StoredCredential,
  type VaultStorage,
} from "../vault/src/vault.js";
import { buildDenialAuditEntry } from "../vault/src/handler.js";
import {
  decrypt,
  deriveKEK,
  encrypt,
  type SealedCredential,
} from "../vault/src/crypto.js";
import { buildKekSource, type KekSource } from "../vault/src/kek-source.js";
import { buildKekScopeSource } from "../vault/src/kek-scope.js";
import { RATE_LIMITS, refillBucket, tryConsume } from "../vault/src/rate-bucket.js";
import { errorResponse } from "./routes/vault-proxy.js";

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

// Per-caller rate budget (cloister-211b68 / dos-friend F1). The bucket
// math is pure and lives in vault/src/rate-bucket.ts so it can be tested
// exhaustively without going through the workerd RPC harness. This DO
// is the persistence + dispatch layer: load state from SQL, call refill
// + tryConsume, persist updated state back, gate the RPC.

export class CredentialVault extends DurableObject implements VaultStoreRpc {
  private kekPromise: Promise<CryptoKey> | null = null;
  /**
   * In-flight proxy-call counter, sharded by `subject_fp` per DoS F2 from
   * the 2026-05-18 adversarial cycle. Pre-this-fix this was a single
   * scalar `private inflight = 0` — one slow-upstream peer could saturate
   * the MAX_INFLIGHT cap and deny every other peer on the same DO. Now
   * each peer has its own per-(subject_fp) bucket against MAX_INFLIGHT;
   * entries are removed when the count returns to zero so the Map can't
   * grow unboundedly under unique-subject probing. Per cloister-6f21dc.
   */
  private inflightBySubject = new Map<string, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Rate-bucket table provisioned alongside credentials. Same SQL
    // Storage API; idempotent CREATE. tokens stored as REAL because
    // refill is sub-token-precise (10/sec means each ms is 0.01 token).
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS rate_buckets (
        subject_fp     TEXT    PRIMARY KEY,
        tokens         REAL    NOT NULL,
        last_refill_ms INTEGER NOT NULL
      )
    `);

    // Vault-state table: scalar key/value pairs that need to survive
    // DO eviction. Currently used to pin VAULT_KEK_SOURCE spec on
    // first resolve so a config-write attacker can't swap the spec
    // between DO instantiations (cloister-fbc6eb / notme-69b3fd).
    // Per ADR-0014 v2 — the URL spec is a deployment-time decision,
    // not a runtime one. Schema: `(key TEXT PRIMARY KEY, value TEXT)`.
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS vault_state (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

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
   * Token-bucket budget consume. Per-subject_fp, persisted in SQL so a
   * DO eviction doesn't reset an attacker's budget. Workerd serializes
   * RPC handlers per DO id, so the SELECT/UPSERT pair is atomic without
   * a transaction. Math lives in vault/src/rate-bucket.ts as pure
   * functions (refillBucket + tryConsume); this method is the
   * persistence + log-emit shim.
   *
   * Open: the rate_buckets table grows with unique subject_fps. Pre-1.0
   * this is bounded by notme's cert-mint rate (itself rate-limited).
   * Filed as future cleanup: LRU eviction or TTL sweep, mirror the
   * seen_nonces retention sweep playbook.
   */
  #consumeBudget(
    subjectFp: string,
    cost: number,
  ): { ok: true } | { ok: false; retryAfterSec: number } {
    const now = Date.now();
    const rows = this.ctx.storage.sql.exec(
      "SELECT tokens, last_refill_ms FROM rate_buckets WHERE subject_fp = ?",
      subjectFp,
    ).toArray() as unknown as Array<{ tokens: number; last_refill_ms: number }>;

    const prev = rows.length === 0
      ? null
      : { tokens: rows[0]!.tokens, lastRefillMs: rows[0]!.last_refill_ms };
    const refilled = refillBucket(prev, now);
    const result = tryConsume(refilled, cost);

    // Persist updated bucket state regardless of accept/reject so the
    // refill timestamp advances (attacker can't "freeze time" by hammering
    // a depleted bucket).
    this.ctx.storage.sql.exec(
      "INSERT INTO rate_buckets (subject_fp, tokens, last_refill_ms) VALUES (?, ?, ?) ON CONFLICT(subject_fp) DO UPDATE SET tokens = excluded.tokens, last_refill_ms = excluded.last_refill_ms",
      subjectFp,
      result.next.tokens,
      result.next.lastRefillMs,
    );

    if (!result.ok) {
      // Structured emit so an operational-log audit can pick this up without
      // re-parsing a message. cloister-bd7e51: on the shared {target,op,outcome}
      // schema (was an ad-hoc {event:...} shape with camelCase field drift).
      logEvent("warn", {
        target: "vault",
        op: "rate_limit",
        outcome: "reject",
        subject_fp: subjectFp,
        cost,
        tokens_available: Number(refilled.tokens.toFixed(3)),
        retry_after_sec: result.retryAfterSec,
      });
      return { ok: false, retryAfterSec: result.retryAfterSec };
    }
    return { ok: true };
  }

  /**
   * Burst gate: workerd serializes handler dispatch per DO, but proxy's
   * upstream await yields, letting more handlers queue. Cap concurrent
   * in-flight RPCs **per subject_fp** so a slow-upstream attack from one
   * peer can't deny every other peer (DoS F2 from the 2026-05-18 cycle;
   * pre-fix this was a single shared scalar). Each verified peer gets
   * its own MAX_INFLIGHT allowance.
   */
  #checkInflight(subjectFp: string): { ok: true } | { ok: false } {
    const current = this.inflightBySubject.get(subjectFp) ?? 0;
    if (current >= RATE_LIMITS.MAX_INFLIGHT) {
      logEvent("warn", {
        target: "vault",
        op: "inflight_gate",
        outcome: "reject",
        subject_fp: subjectFp,
        inflight: current,
        cap: RATE_LIMITS.MAX_INFLIGHT,
      });
      return { ok: false };
    }
    return { ok: true };
  }

  #incInflight(subjectFp: string): void {
    this.inflightBySubject.set(subjectFp, (this.inflightBySubject.get(subjectFp) ?? 0) + 1);
  }

  /**
   * Decrement + GC: when a subject's count returns to 0 the entry is
   * removed so the Map can't grow unboundedly under unique-subject
   * probing (related to the keystore-cache concern in cloister-d9a3c6
   * resolved earlier — same "Map of state keyed by attacker-controlled
   * identifier" footgun).
   */
  #decInflight(subjectFp: string): void {
    const next = (this.inflightBySubject.get(subjectFp) ?? 1) - 1;
    if (next <= 0) this.inflightBySubject.delete(subjectFp);
    else this.inflightBySubject.set(subjectFp, next);
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
    // F1 gate: token-bucket budget. Write cost (3) — encrypt + SQL.
    const b = this.#consumeBudget(subjectFp, RATE_LIMITS.COST.write);
    if (!b.ok) throw new Error(`vault: rate limited — retry after ${b.retryAfterSec}s`);
    // F4 gate: reject oversized payloads before they touch encrypt + SQL write
    // (cloister-21b5eb). Without this gate, a single putCredential with
    // megabyte headers blocks the single-threaded DO on AES-GCM + SQLite
    // write while queueing every co-resident call.
    const v = validateCredentialPayload(cred);
    if (!v.ok) throw new Error(`vault: rejected credential — ${v.reason}`);
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
    const b = this.#consumeBudget(subjectFp, RATE_LIMITS.COST.read);
    if (!b.ok) throw new Error(`vault: rate limited — retry after ${b.retryAfterSec}s`);
    const row = await this.#readRow(subjectFp, service);
    if (!row) return null;
    return { upstream: row.upstream, allowedSubs: row.allowedSubs };
  }

  async deleteCredential(subjectFp: string, service: string): Promise<boolean> {
    assertSubjectFp(subjectFp);
    const b = this.#consumeBudget(subjectFp, RATE_LIMITS.COST.read);
    if (!b.ok) throw new Error(`vault: rate limited — retry after ${b.retryAfterSec}s`);
    return this.#deleteRow(subjectFp, service);
  }

  async listServices(subjectFp: string): Promise<string[]> {
    assertSubjectFp(subjectFp);
    const b = this.#consumeBudget(subjectFp, RATE_LIMITS.COST.read);
    if (!b.ok) throw new Error(`vault: rate limited — retry after ${b.retryAfterSec}s`);
    return this.#listRows(subjectFp);
  }

  /** Ephemeral in-instance guard so the dev seed runs at most once per DO. */
  #devSeeded = false;

  /**
   * Dev boot-seed (ADR-0042). When `CLOISTER_MODE === "dev"` and
   * `DEV_VAULT_SEED` is set, ingest one credential via the existing
   * `putCredential` on first `proxyRequest` — in-boundary, no external write
   * route. Idempotent (`putCredential` overwrites); the flag just avoids
   * re-parsing per request. A no-op outside dev mode, so production is
   * untouched. Failures are logged, never thrown — a bad seed must not brick
   * the proxy path.
   */
  async #maybeDevSeed(): Promise<void> {
    if (this.#devSeeded) return;
    this.#devSeeded = true;
    const env = this.env as Env;
    if (env.CLOISTER_MODE !== "dev" || !env.DEV_VAULT_SEED) return;
    try {
      const seed = JSON.parse(env.DEV_VAULT_SEED) as {
        peerFp: string;
        service: string;
        upstream: string;
        headers: Record<string, string>;
        allowedSubs?: string[];
      };
      await this.putCredential(seed.peerFp, seed.service, {
        upstream: seed.upstream,
        headers: seed.headers,
        allowedSubs: seed.allowedSubs ?? [],
      });
      // eslint-disable-next-line no-console -- operator-facing dev signal
      console.log(JSON.stringify({
        kind: "info", source: "cloister/dev", event: "vault_seeded",
        service: seed.service, peerFp: seed.peerFp,
      }));
    } catch (e) {
      // eslint-disable-next-line no-console -- operator-facing dev signal
      console.error(JSON.stringify({
        kind: "error", source: "cloister/dev", event: "vault_seed_failed",
        message: e instanceof Error ? e.message : String(e),
      }));
    }
  }

  async proxyRequest(
    subjectFp: string,
    service: string,
    callerSub: string,
    incomingRequest: Request,
  ): Promise<Response> {
    assertSubjectFp(subjectFp);

    // Dev boot-seed (ADR-0042) — ingest DEV_VAULT_SEED on first use when
    // CLOISTER_MODE=dev, via the existing putCredential (in-boundary, no
    // external write route). No-op outside dev mode.
    await this.#maybeDevSeed();

    // F1 burst gate: concurrent in-flight proxies are capped because
    // each one holds the DO during upstream fetch. Reject overflow with
    // a 429 (web-shaped — proxyRequest returns Response, unlike the
    // other RPC methods which throw).
    const inflight = this.#checkInflight(subjectFp);
    if (!inflight.ok) {
      // denial-audit emit (cloister-fb1ea2): structured log on the denial
      // so an operator can see burst-overflow rates per tenant. Wire
      // body stays constant-shape per the §9.4.b oracle invariant.
      console.log(JSON.stringify(buildDenialAuditEntry({
        event: "rate_limited_burst",
        subjectFp,
        callerSub,
        service,
        retryAfterSec: 1,
      })));
      return errorResponse(
        429,
        JSON.stringify(buildErrorResponse("rate_limited", callerSub, service, null)),
        { "retry-after": "1" },
      );
    }

    // F1 sustained gate: token-bucket budget. Proxy cost (5) is the
    // highest — it does encrypt + SQL read + upstream fetch.
    const budget = this.#consumeBudget(subjectFp, RATE_LIMITS.COST.proxy);
    if (!budget.ok) {
      console.log(JSON.stringify(buildDenialAuditEntry({
        event: "rate_limited",
        subjectFp,
        callerSub,
        service,
        retryAfterSec: budget.retryAfterSec,
      })));
      return errorResponse(
        429,
        JSON.stringify(buildErrorResponse("rate_limited", callerSub, service, null)),
        { "retry-after": String(budget.retryAfterSec) },
      );
    }

    this.#incInflight(subjectFp);
    try {
      return await this.#proxyRequestInner(subjectFp, service, callerSub, incomingRequest);
    } finally {
      this.#decInflight(subjectFp);
    }
  }

  async #proxyRequestInner(
    subjectFp: string,
    service: string,
    callerSub: string,
    incomingRequest: Request,
  ): Promise<Response> {
    const row = this.ctx.storage.sql.exec(
      "SELECT upstream, sealed_headers, allowed_subs_json FROM credentials WHERE subject_fp = ? AND service = ?",
      subjectFp,
      service,
    ).toArray() as unknown as StoredRow[];

    // ── cloister-aa9376: constant-shape rejection (mirrors disclosure §9.4.b) ─
    //
    // Two rejection paths used to distinguish — 403 for "row exists but
    // callerSub not in allowedSubs," 404 for "no row at all." That status
    // code split is a single-bit oracle that enumerates the service-name
    // namespace under a verified subject_fp (compromised in-cluster bundle
    // holding A's lease but excluded from A's allowedSubs for every
    // service). The bit composes with the planned in-cluster bundle Worker
    // future — P2 today, P1 the moment the first such bundle ships.
    //
    // Closure: collapse both rejections to a byte-identical 404
    // (`buildErrorResponse("not_found", ...)`) with the same wire shape.
    // Internal audit still distinguishes via structured logs at the call
    // site (proxyRequest's pre-#proxyRequestInner emit captures
    // callerSub + service + outcome) — only the wire collapses.
    //
    // Timing equalizer: both branches now run `checkAccess` so the per-
    // branch CPU profile matches at workerd's 1ms quantization floor.

    if (row.length === 0) {
      // Run the same shape of work as the row-present path so timing
      // doesn't leak existence. checkAccess against [] is always false;
      // result is intentionally discarded.
      void checkAccess([], callerSub);
      // denial-audit emit (cloister-fb1ea2): structured log distinguishes
      // missing-credential from ACL-deny INTERNALLY; the wire body
      // stays byte-identical per §9.4.b.
      console.log(JSON.stringify(buildDenialAuditEntry({
        event: "credential_missing",
        subjectFp,
        callerSub,
        service,
      })));
      return errorResponse(
        404,
        JSON.stringify(buildErrorResponse("not_found", callerSub, service, null)),
      );
    }

    const sealedJson = row[0].sealed_headers;
    const upstream   = row[0].upstream;
    const allowedSubs = JSON.parse(row[0].allowed_subs_json) as string[];

    if (!checkAccess(allowedSubs, callerSub)) {
      // Byte-identical to the no-row branch above. `buildErrorResponse`
      // omits `_cred` by construction (pinned by
      // test/security/prompt-injection.test.ts scenario 2), so this
      // path cannot leak upstream / headers / allowedSubs into the wire.
      console.log(JSON.stringify(buildDenialAuditEntry({
        event: "credential_denied",
        subjectFp,
        callerSub,
        service,
      })));
      return errorResponse(
        404,
        JSON.stringify(buildErrorResponse("not_found", callerSub, service, null)),
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
      // Pin the VAULT_KEK_SOURCE spec to DO storage on first resolve;
      // throw on subsequent mismatch. Blocks the config-write attack
      // path (notme-69b3fd / cloister-fbc6eb): a deployment that
      // flips spec from `keychain://prod` to `env://ATTACKER` between
      // DO evictions would otherwise silently mint a new KEK from
      // attacker-controlled bytes. Now: surface as a hard failure
      // with operator guidance. The pin check is cheap (one
      // SELECT + string compare); runs once per DO lifetime here at
      // first KEK derive.
      this.#assertKekSourceSpecPinned();

      // Memoize the in-flight derive so concurrent callers share work.
      // CRITICAL: clear the slot on rejection — otherwise a single
      // transient helper flake at cold-start caches a rejected promise
      // for the DO instance lifetime, turning a recoverable failure into
      // a vault-wide outage with no retry path (cloister-2176e4 / dos-friend
      // pilot finding F3). The `=== p` guard handles the race where
      // another caller has already started a fresh derive.
      const p = this.#resolveKekSource().resolve().then(deriveKEK);
      p.catch(() => {
        if (this.kekPromise === p) this.kekPromise = null;
      });
      this.kekPromise = p;
    }
    return this.kekPromise;
  }

  /**
   * Pin VAULT_KEK_SOURCE on first call; require equality on every
   * subsequent call. Throws with an actionable hint on mismatch.
   *
   * Per cloister-fbc6eb (migrated from notme-69b3fd): a config-write
   * attacker can swap VAULT_KEK_SOURCE from `keychain://prod` to
   * `env://ATTACKER` between DO instantiations. Without this pin, the
   * new DO derives a KEK from attacker-controlled bytes and silently
   * accepts new sealed credentials under that key. With the pin, the
   * spec mismatch surfaces as a hard `Error` at the next KEK derive —
   * the operator sees it in `wrangler tail`.
   *
   * Rotation playbook (intentional spec change): manually
   * `DELETE FROM vault_state WHERE key = 'kek_source'`, then redeploy
   * with the new spec. The OLD sealed credentials in `credentials`
   * become undecryptable under the new KEK; operators MUST also
   * `DELETE FROM credentials` and re-upload, OR ship a `rotateKEK()`
   * admin RPC (deferred follow-up — out of scope for this bead).
   *
   * VAULT_KEK_TENANT_SCOPED flag is also pinned (same table, different
   * key): flipping it on/off changes the derived KEK, same destructive
   * recovery semantics.
   */
  #assertKekSourceSpecPinned(): void {
    const env = this.env as Env & {
      VAULT_KEK_SOURCE?: string;
      VAULT_KEK_TENANT_SCOPED?: string;
    };
    const currentSpec = typeof env.VAULT_KEK_SOURCE === "string"
      ? env.VAULT_KEK_SOURCE.trim()
      : "";
    const currentTenantScoped = typeof env.VAULT_KEK_TENANT_SCOPED === "string"
      && env.VAULT_KEK_TENANT_SCOPED.trim() === "1"
      ? "1"
      : "0";

    const rows = this.ctx.storage.sql.exec(
      "SELECT key, value FROM vault_state WHERE key IN ('kek_source', 'kek_tenant_scoped')",
    ).toArray() as unknown as Array<{ key: string; value: string }>;

    const pinned = new Map(rows.map((r) => [r.key, r.value]));
    const pinnedSpec = pinned.get("kek_source");
    const pinnedTenantScoped = pinned.get("kek_tenant_scoped");

    if (pinnedSpec === undefined) {
      // First call: write the pin. Don't throw — this is the
      // bootstrap path. Spec emptiness still fails in
      // #resolveKekSource (KekSourceUnset) downstream, with a
      // dedicated error message; this method is silent on bootstrap.
      this.ctx.storage.sql.exec(
        "INSERT INTO vault_state (key, value) VALUES ('kek_source', ?)",
        currentSpec,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO vault_state (key, value) VALUES ('kek_tenant_scoped', ?)",
        currentTenantScoped,
      );
      return;
    }

    if (pinnedSpec !== currentSpec) {
      throw new Error(
        "vault: VAULT_KEK_SOURCE pin mismatch — the DO storage records " +
          `kek_source=${JSON.stringify(pinnedSpec.slice(0, 40))}... but env ` +
          `currently provides ${JSON.stringify(currentSpec.slice(0, 40))}...`
          + " This DO was previously bootstrapped against a different spec. "
          + "A spec change between DO instantiations is the config-write "
          + "attack path described by notme-69b3fd / cloister-fbc6eb — refusing "
          + "to derive a new KEK silently. To intentionally rotate: clear the "
          + "pin (DELETE FROM vault_state WHERE key='kek_source') and reset "
          + "credentials (DELETE FROM credentials) — the existing sealed rows "
          + "become undecryptable under the new KEK.",
      );
    }

    if (pinnedTenantScoped !== currentTenantScoped) {
      throw new Error(
        "vault: VAULT_KEK_TENANT_SCOPED pin mismatch — the DO storage records " +
          `kek_tenant_scoped=${JSON.stringify(pinnedTenantScoped)} but env ` +
          `currently provides ${JSON.stringify(currentTenantScoped)}.` +
          " Toggling this flag mid-lifetime changes the derived KEK " +
          "(per ADR-0030 §A3 HKDF), making existing sealed credentials " +
          "undecryptable. To intentionally flip: clear the pin and reset " +
          "credentials (same playbook as the kek_source rotation).",
      );
    }
  }

  /**
   * Resolve the KEK source URL for this DO.
   *
   * Per ADR-0014 v2 (amendment 2026-05-12 / cloister-125199):
   * `VAULT_KEK_SOURCE` MUST be a non-empty URL spec. The legacy
   * `VAULT_KEK_SECRET` plaintext fallback has been removed — there is
   * no path that reads a key value directly from a `text` binding
   * anymore. Dev contributors run `cloister dev bootstrap` to produce a
   * `keychain://` (macOS) / `secret-tool://` (Linux) / `file://` (CI)
   * source URL; production sets `VAULT_KEK_SOURCE` via
   * `wrangler secret put` pointing at a `kms://` or `http(s)://`
   * helper.
   *
   * Empty / unset throws `KekSourceUnset` with an actionable message.
   *
   * ## Tenant-scoped KEK (ADR-0030 §A3 — opt-in via `VAULT_KEK_TENANT_SCOPED=1`)
   *
   * When the env var `VAULT_KEK_TENANT_SCOPED` is set to `"1"`, the
   * resolver wraps the URL-spec loader with `buildKekScopeSource`'s
   * cluster-scope path: the raw root from the operator's URL spec
   * gets HKDF-derived per tenant (tenantName = this DO's
   * `bundleIdName`), so each tenant's vault DO holds a DIFFERENT KEK
   * even though the operator manages ONE root.
   *
   * This is OPT-IN to preserve data-recoverability on existing
   * deployments: flipping it on changes the derived KEK for every
   * tenant, making existing encrypted credentials unrecoverable
   * (different KEK → different AES key → ciphertext won't decrypt).
   * Operators flipping this on MUST migrate their stored credentials
   * — that's their explicit decision under threat-model §13.7.3.
   *
   * Default (env var absent / not "1"): legacy single-KEK derivation.
   * The ADR-0030 §D2 polymorphic boundary still works at the DO
   * INSTANCE level via ADR-0021 `idFromName(bundleIdName)` (different
   * SQLite storage per tenant); only the KEK is shared. Acceptable for
   * the OSS-launch default; insufficient for cluster-master-compromise
   * defense — which is exactly the trade-off threat-model §13.7.3
   * makes explicit.
   */
  #resolveKekSource(): KekSource {
    const env = this.env as Env & {
      VAULT_KEK_SOURCE?: string;
      VAULT_KEK_TENANT_SCOPED?: string;
    };
    const kekEnv = this.env as unknown as Record<string, unknown>;
    const explicit = typeof env.VAULT_KEK_SOURCE === "string"
      ? env.VAULT_KEK_SOURCE.trim()
      : "";
    if (explicit.length === 0) {
      throw new Error(
        "vault: VAULT_KEK_SOURCE is unset — per ADR-0014 v2, the vault DO " +
          "requires an explicit URL spec (env:// with age carrier, file://, " +
          "keychain://, secret-tool://, or http(s)://helper). " +
          "Dev setup: run `cloister dev bootstrap`. " +
          "Production: `wrangler secret put VAULT_KEK_SOURCE` pointing at " +
          "your keystore / KMS / helper endpoint.",
      );
    }
    const tenantScoped = typeof env.VAULT_KEK_TENANT_SCOPED === "string"
      && env.VAULT_KEK_TENANT_SCOPED.trim() === "1";
    if (tenantScoped) {
      // ADR-0030 §A3 cluster-tier KEK: HKDF-derive per tenant from the
      // operator's root URL spec. Service-tier KEKs (operator-provisioned
      // per service) are not in scope here — vault-1 only consumes
      // cluster-tier; service-tier loaders live with the per-service
      // routes that consume them.
      //
      // The tenantName is the DO's id.name (set when the route stub
      // constructed via `idFromName(bundleIdName)` — ADR-0021 X-3
      // seam). When `ctx.id.name` is undefined (id created via a
      // path other than `idFromName`), fall back to "cluster" as the
      // sentinel tenant — same KEK derivation across all DOs of this
      // class. Operators flipping VAULT_KEK_TENANT_SCOPED=1 are
      // expected to construct DOs via idFromName per ADR-0021; this
      // fallback prevents a misconfig from minting an undecryptable
      // KEK (cred-iso conformance stays parseable).
      const tenantName = this.ctx.id.name ?? "cluster";
      return buildKekScopeSource(
        { kind: "cluster", tenantName },
        explicit,
        new Map(),
        kekEnv,
      );
    }
    return buildKekSource(explicit, kekEnv);
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
