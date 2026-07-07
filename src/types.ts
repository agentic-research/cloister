// JSON-RPC 2.0 wire types — `id` is string | number | null per spec §4.
// `null` is required for parse-error responses (where the server can't read
// the request's id) and SHOULD be rejected as a request id.
export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
  id: JsonRpcId;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  id: JsonRpcId;
}

export function okResponse(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

export function errResponse(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// MCP tool descriptor
export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// Bead model — matches rosary's Bead struct
export type BeadState = "open" | "in_progress" | "done" | "blocked";
export type BeadPriority = 0 | 1 | 2 | 3 | 4; // 0=none, 1=low, 2=medium, 3=high, 4=urgent

export interface Bead {
  id: string;
  title: string;
  description: string;
  state: BeadState;
  priority: BeadPriority;
  labels: string[];
  created_at: string;
  updated_at: string;
  created_by?: string;
  repo: string;
  notes?: string; // JSON blob for provenance / extras
  /**
   * sha256-hex digest of the canonical `bead/v1` bytes for the row, as
   * computed by the cross-DO bead_create orchestrator (cloister-492c08).
   * Links a bead row to its BlobStore entry + its TrustStore
   * peer_attestations row. NULL for rows created before the orchestrator
   * landed; the disclosure endpoint flags those as "legacy" since they
   * predate the attestation regime.
   */
  content_hash?: string;
}

// Env bindings — matches wrangler.toml
export interface Env {
  // Durable Objects
  // BeadStore is bundle-layer (per-repo, idFromName(repo)). Holds work-item
  // state — beads + comments. See src/beads.ts.
  BEAD_STORE: DurableObjectNamespace;
  // TrustStore is hypervisor-layer (singleton per cluster). Holds trust
  // state — peer_lease_counters today, peer_attestations + vault planned.
  // Per ADR-0011 + the 2026-05-09 review. See src/trust-store.ts.
  TRUST_STORE: DurableObjectNamespace;
  // BlobStore is hypervisor-layer (singleton per cluster). Content-
  // addressed substrate per ADR-0003 phase 1. Cross-DO writes
  // (BeadStore + TrustStore) reference the same blobs by digest;
  // idempotent puts make the multi-step handoff recoverable per
  // ADR-0012. See src/blob-store.ts.
  BLOB_STORE: DurableObjectNamespace;
  // CredentialVault is hypervisor-layer (singleton per cluster).
  // Per-cluster credential vault — envelope-encrypted credentials,
  // per-service allowedSubs glob enforcement, plaintext-stays-in-DO
  // proxying. Per ADR-0010 (architectural frame) + ADR-0013
  // (enforcement model: V8-isolate + service-binding-as-syscall).
  // Identity propagation from in-cluster bundles to vault is
  // unresolved until the first workerd-bundle Worker ships — see
  // src/vault-store.ts header comment for the open options.
  VAULT_STORE?: DurableObjectNamespace;
  /// URL spec telling the vault DO where to resolve its KEK from. MUST
  /// be a non-empty URL spec per ADR-0014 v2 (cloister-125199). Schemes:
  /// `env://NAME` (today: plaintext env binding; v2b will require
  /// age-encrypted carrier), `file:///path` (via KEK_DISK binding),
  /// `keychain://service-name` (via KEK_HELPER sidecar, macOS),
  /// `secret-tool://name` (Linux libsecret, future), `http(s)://...`
  /// (generic helper). Empty/unset throws at vault-DO construction.
  /// See ADR-0014 + `vault/src/kek-source.ts`.
  VAULT_KEK_SOURCE?: string;
  /// Workerd disk-service binding for `file://` KEK sources. The
  /// bound directory holds the keyfile; `file:///kek.bin` resolves
  /// to a GET against that disk service for `/kek.bin`. Optional —
  /// only consulted when VAULT_KEK_SOURCE uses `file://`.
  KEK_DISK?: Fetcher;
  /// HTTP service binding for `keychain://` and `http(s)://` KEK
  /// sources. Points at the leyline-sign-helper Rust binary
  /// (rs/crates/sign/, ADR-0019) which translates these URLs to
  /// OS-keystore calls. Optional — only consulted when
  /// VAULT_KEK_SOURCE uses one of those schemes. See ADR-0014.
  KEK_HELPER?: Fetcher;

  // Service bindings (workerd-native)
  NOTME: Fetcher; // notme-bot — agent identity, JWT/Ed25519 certs

  // Vars (local dev: process addresses for non-workerd backends)
  ROSARY_MCP_URL: string;  // rosary MCP HTTP endpoint
  SIGNET_URL:     string;  // signet key exchange (empty until deployed)
  LLO_MCP_URL:    string;  // ley-line-open MCP HTTP endpoint (`leyline daemon --mcp-port`)
  /// mache MCP HTTP endpoint (`mache serve --http :7532`). Used by the
  /// `mache_*` backend with dynamicTools=true (ADR-0006). Empty disables it.
  MACHE_MCP_URL?: string;
  /// cloister-companion endpoint (ADR-0005). Empty disables LeylineNet
  /// backends; `task companion:stub` provides a local-dev listener.
  COMPANION_URL?: string;
  /// Bead storage backend (cloister-decf0d / ADR-0033 D5 amendment).
  /// "do" (default) — Step 2 of the bead-create orchestrator writes to
  ///                  cloister's BeadStore DurableObject. The legacy path.
  /// "rsry" — Step 2 calls rsry's `rsry_bead_create` MCP tool via the
  ///          ROSARY_BUNDLE service binding, landing the row in bd-managed
  ///          Dolt. cloister-c8b907 migration toward BeadStore-DO deprecation.
  /// Both paths preserve the §13.4 audit chain via the bead_id column on
  /// TrustStore's peer_attestations (sub-bead 1, cloister-dea77c).
  /// Empty / unset / unrecognized → defaults to "do" for back-compat.
  BEAD_STORAGE_BACKEND?: string;
  /// Comma-separated list of allowed CORS origins. "*" (default) is wildcard
  /// — fine for local dev, tighten before prod. Example: "https://notme.bot,http://localhost:*"
  ALLOWED_ORIGINS?: string;
  /// Cluster root Ed25519 public key (base64-standard, 32 bytes). Pinned
  /// trust root for CA bundle signature verification (cloister-c614ae).
  /// Bundles fetched from notme that don't verify against this key are
  /// rejected. Empty disables verification (dev only — production MUST
  /// have it set).
  INTERLACE_ROOT_PUBKEY?: string;
  /// HMAC key (base64-standard or base64url, 32+ bytes) used to sign
  /// disclosure-endpoint cursors (cloister-bdef0c / threat model §9.4).
  /// Same key on every replica so cursors round-trip across instances.
  /// Empty disables disclosure responses (dev only — production MUST
  /// have it set).
  INTERLACE_DISCLOSURE_HMAC_KEY?: string;
  /// Receipt signing keypair (base64-standard, 64 bytes = seed||pub),
  /// used to emit Interlace 0.2.0 signed receipts (cloister-ae713f /
  /// RECEIPTS.md §2.1, §2.4). The matching 32-byte raw pubkey MUST
  /// match what `.well-known/interlace/index.json` advertises as the
  /// signing key for the current epoch. Production deployments
  /// delegate signing to notme — when this binding is unset and
  /// `env.NOTME` is configured, the receipt emitter forwards to
  /// notme's `/internal/sign-receipt` endpoint (followup bead to
  /// land the notme-side handler). Empty AND no NOTME binding means
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
  /// Dev vault seed (JSON) — one credential the vault DO ingests at first
  /// use when `CLOISTER_MODE === "dev"`, via the existing putCredential
  /// (in-boundary, no external write route). Shape:
  /// `{ "peerFp", "service", "upstream", "headers": {..}, "allowedSubs": [..] }`.
  /// Dev-only; production uses the designed ingestion surface (future ADR).
  DEV_VAULT_SEED?: string;
  /// Dev authz overlay (JSON array of peerFp strings, or comma-separated).
  /// When `CLOISTER_MODE === "dev"`, the vault-proxy route overlays these onto
  /// every matched service's `defaultAllowedSubs` so the dev identity passes
  /// the manifest-side gate (which is `[]` = deny-all by default). Dev-only;
  /// production opts peers in via the committed manifest. Per ADR-0042.
  DEV_ALLOWED_SUBS?: string;
}
