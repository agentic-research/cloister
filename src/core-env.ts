// SPDX-License-Identifier: AGPL-3.0-or-later
//
// core-env.ts — what core reads from its environment (ADR-0081).
//
// Core is what every deployment guarantees, so every placement gives it these
// names. They are declared here, in core, so that core does not type itself
// against one driver's bindings. The workerd driver's `Env` (src/types.ts)
// extends this interface; another placement provides the same names from its
// own configuration.
//
// Two kinds of thing are declared:
//   - configuration: strings, which any placement can set;
//   - endpoints core calls, each typed by the calls core makes rather than by
//     a platform's binding type. A workerd service binding satisfies
//     `HttpEndpoint`, and so does any client that answers `fetch`.
//
// Not declared here: the Durable Object namespaces through which the workerd
// driver hosts the trust store and the vault (TRUST_STORE, VAULT_STORE). The
// core files that use them still import `Env`, and lint/layers.mjs lists each
// such import until those components are reached through ports of their own.

/** Anything that answers an HTTP request: a workerd service binding, or a client for a URL. */
export interface HttpEndpoint {
  fetch(request: Request): Promise<Response>;
}

export interface CoreEnv {
  // ── Authority: the trust root and the lease gate (ADR-0053) ────────────

  /// Cluster root Ed25519 public key (base64-standard, 32 bytes). Pinned
  /// trust root for CA bundle signature verification (cloister-c614ae).
  /// Bundles fetched from notme that don't verify against this key are
  /// rejected. Empty disables verification (dev only — production MUST
  /// have it set).
  INTERLACE_ROOT_PUBKEY?: string;
  /// Interlace ACTOR fingerprint — "sha256:<64 lowercase hex>" over the master
  /// public key. Read ONLY by src/routes/actor-fingerprint.ts
  /// (`lint:trust-env-locality`).
  ///
  /// Fallback for `manifest.actor.fingerprint` when that is empty, which gates
  /// BOTH published identity surfaces: the Interlace discovery doc and the
  /// five-path identity bridge. The manifest value wins when set — an env var
  /// must not silently repoint a committed identity.
  ///
  /// Exists because the fingerprint is DERIVABLE from the pubkey, so an empty
  /// manifest value beside a present key is underspecified rather than
  /// switched off — and "disabled" and "not filled in yet" were previously the
  /// same 404. Same shape as `RECEIPT_ACTOR_FP` below, which already resolved
  /// the receipt half of one actor's identity this way.
  ///
  /// Neither set still means disabled. `cloister dev bootstrap` derives and
  /// writes this so a local scaffold publishes a live surface instead of a
  /// declared-but-dead one.
  INTERLACE_ACTOR_FP?: string;
  /// notme-bot — agent identity, JWT/Ed25519 certs, and the CA bundle the
  /// lease gate verifies against (src/storage/notme-bundle-fetcher.ts).
  NOTME: HttpEndpoint;

  /// ── Dev-mode bindings (ADR-0042) ─────────────────────────────────
  /// Set to "dev" to enable the turnkey local-run seams (`task harness:dev`).
  /// MUST be unset / "prod" in every committed production-tier config —
  /// enforced by `lint:no-dev-mode`. Gates the dev CA-bundle source + the
  /// vault boot-seed. It never weakens per-request verification (ADR-0042
  /// safety rail; same discipline as ADR-0007's no-INTERLACE_DEV_BYPASS).
  CLOISTER_MODE?: string;
  /// Dev CA master pubkey (base64-STANDARD, 32-byte Ed25519) minted by
  /// `mint-dev-cert`. When `CLOISTER_MODE === "dev"`, the lease verifier
  /// builds a static CA bundle from this instead of fetching from notme.
  /// Dev-only; production always fetches + signature-verifies via notme.
  DEV_CA_MASTER?: string;
  /// Dev CA bundle epoch (decimal). Must equal the dev cert's epoch.
  /// Defaults to 1 when unset. Dev-only.
  DEV_CA_EPOCH?: string;

  // ── Audit: receipt signing (RECEIPTS.md §2.1, §2.4) ───────────────────

  /// Receipt signing keypair (base64-standard, 64 bytes = seed||pub),
  /// used to emit Interlace 0.2.0 signed receipts (cloister-ae713f /
  /// RECEIPTS.md §2.1, §2.4). The matching 32-byte raw pubkey MUST
  /// match what `.well-known/interlace/index.json` advertises as the
  /// signing key for the current epoch. Production deployments
  /// delegate signing to notme — but NOT via `/internal/sign-receipt`,
  /// which notme declined to build because a `/internal/` path prefix
  /// is publicly routable and is therefore not an access control. The
  /// shape is an RPC entrypoint; see `src/wire/receipts.ts` §"Key
  /// surface" for the call and the binding it needs (which is NOT this
  /// `NOTME` one — that is the `/identity/*` fetch binding). Empty AND
  /// no signer binding means
  /// receipts are NOT emitted (dev/test mode; the 0.2.0 spec Phase 1
  /// migration allows this — see RECEIPTS.md §8.2).
  RECEIPT_SIGNING_KEY?: string;
  /// Current key epoch for this actor (decimal uint). Defaults to 1
  /// when unset. Increments when the master signing key rotates; old
  /// epochs remain resolvable via TrustStore's actor_ca_bundle table.
  RECEIPT_EPOCH?: string;
  /// Actor fingerprint (SHA-256 of master pubkey, hex). Committed to
  /// every receipt's `actor_fp` field. When unset, derived from the
  /// pubkey at startup. Pinning it via binding lets the operator
  /// publish a stable fingerprint across pubkey reloads in dev.
  RECEIPT_ACTOR_FP?: string;
  /// Interlace receipt signing delegated to notme's `ReceiptSigner` RPC
  /// entrypoint (notme ADR-014 / cloister-35ccf7). Its OWN binding, NOT an
  /// `entrypoint` pinned on `NOTME` above — that binding is live for the
  /// `/identity/*` fetch proxy, and pinning an entrypoint on it would redirect
  /// that traffic to a class with no `fetch` handler and break identity.
  /// notme's own comment records that an earlier draft said to do exactly
  /// that, and that it would have broken the first integrator to follow it.
  ///
  /// Preferred over `RECEIPT_SIGNING_KEY` when present: that binding puts a
  /// master PRIVATE key in cloister's env, which ADR-0010 rules out and which
  /// makes a second copy of a trust root whose whole property is that it never
  /// leaves notme.
  NOTME_RECEIPTS?: {
    /// `actor_fp` (ALREADY SHA-256 hashed) + `epoch` a commitment must carry.
    /// Hashed on notme's side on purpose: if cloister hashed it, cloister
    /// would own a derivation notme then validates against.
    receiptFacts(): Promise<{ actorFp: Uint8Array; epoch: number }>;
    /// Sign canonical CBOR commitment bytes. Branch on `{ok: false, code}`
    /// rather than catching a throw; `EPOCH_MISMATCH` is the only retryable
    /// code and MUST be bounded to one retry.
    signReceipt(commitment: Uint8Array): Promise<
      | { ok: true; signature: Uint8Array; epoch: number }
      | { ok: false; code: string; message: string }
    >;
  };

  // ── Credentials: the vault's key (ADR-0014) ────────────────────────────

  /// URL spec telling the vault DO where to resolve its KEK from. MUST
  /// be a non-empty URL spec per ADR-0014 v2 (cloister-125199). Schemes:
  /// `env://NAME` (today: plaintext env binding; v2b will require
  /// age-encrypted carrier), `file:///path` (via KEK_DISK binding),
  /// `keychain://service-name` (via KEK_HELPER sidecar, macOS),
  /// `secret-tool://name` (Linux libsecret, future), `http(s)://...`
  /// (generic helper). Empty/unset throws at vault-DO construction.
  /// See ADR-0014 + `vault/src/kek-source.ts`.
  VAULT_KEK_SOURCE?: string;
  /// "1" derives the vault's KEK per tenant (ADR-0030 §A3); anything else,
  /// or unset, derives one KEK for the cluster. Pinned in the vault's own
  /// storage on first use, like VAULT_KEK_SOURCE, because flipping it changes
  /// the derived key. See `src/vault-store.ts` §"Tenant-scoped KEK".
  VAULT_KEK_TENANT_SCOPED?: string;
  /// Workerd disk-service binding for `file://` KEK sources. The
  /// bound directory holds the keyfile; `file:///kek.bin` resolves
  /// to a GET against that disk service for `/kek.bin`. Optional —
  /// only consulted when VAULT_KEK_SOURCE uses `file://`.
  KEK_DISK?: HttpEndpoint;
  /// HTTP service binding for `keychain://` and `http(s)://` KEK
  /// sources. Points at the leyline-sign-helper Rust binary
  /// (LLO's `rs/ll-open/sign/`, ADR-0019) which translates these URLs to
  /// OS-keystore calls. Optional — only consulted when
  /// VAULT_KEK_SOURCE uses one of those schemes. See ADR-0014.
  KEK_HELPER?: HttpEndpoint;
  /// Dev vault seed (JSON) — one credential the vault DO ingests at first
  /// use when `CLOISTER_MODE === "dev"`, via the existing putCredential
  /// (in-boundary, no external write route). Shape:
  /// `{ "peerFp", "service", "upstream", "headers": {..}, "allowedSubs": [..] }`.
  /// Dev-only; production uses the designed ingestion surface (future ADR).
  DEV_VAULT_SEED?: string;
}
