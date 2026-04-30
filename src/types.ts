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
}

// Env bindings — matches wrangler.toml
export interface Env {
  // Durable Objects
  BEAD_STORE: DurableObjectNamespace;

  // Service bindings (workerd-native)
  NOTME: Fetcher; // notme-bot — agent identity, JWT/Ed25519 certs

  // Vars (local dev: process addresses for non-workerd backends)
  ROSARY_MCP_URL: string;  // rosary MCP HTTP endpoint
  SIGNET_URL:     string;  // signet key exchange (empty until deployed)
  LLO_MCP_URL:    string;  // ley-line-open MCP HTTP endpoint (`leyline daemon --mcp-port`)
  /// cloister-companion endpoint (ADR-0005). Empty disables LeylineNet
  /// backends; `task companion:stub` provides a local-dev listener.
  COMPANION_URL?: string;
  /// Comma-separated list of allowed CORS origins. "*" (default) is wildcard
  /// — fine for local dev, tighten before prod. Example: "https://notme.bot,http://localhost:*"
  ALLOWED_ORIGINS?: string;
}
