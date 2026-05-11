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
  /// Secret used to derive the AES-GCM KEK that wraps per-credential
  /// DEKs in CredentialVault. Required when VAULT_STORE is bound.
  /// MUST be a high-entropy string (≥32 bytes); a leak compromises
  /// every credential in the vault.
  VAULT_KEK_SECRET?: string;

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
}
