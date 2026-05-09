// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 cloister contributors
// Origin: agentic-research/notme (Apache-2.0); see ../NOTICE.

// Credential vault — stores third-party API keys, proxies requests
// with identity-based scope checks. No secrets in pipelines.
//
// Identity: verified via notme shared SDK (bridge certs or DPoP tokens).
// Storage: injected interface (DO SQLite in prod, in-memory in tests).

/** A stored credential for a named service. */
export interface StoredCredential {
  /** The upstream URL to proxy to. */
  upstream: string;
  /** Headers to inject (e.g. { "apiKey": "sk-..." }). */
  headers: Record<string, string>;
  /** Glob patterns for allowed subs (e.g. ["repo:org/venturi:*"]). */
  allowedSubs: string[];
}

/** Minimal storage interface — matches DO SQLite patterns. */
export interface VaultStorage {
  get(service: string): Promise<StoredCredential | null>;
  put(service: string, cred: StoredCredential): Promise<void>;
  delete(service: string): Promise<boolean>;
  list(): Promise<string[]>;
}

// ── CRUD ────────────────────────────────────────────────────────────────────

export async function storeCredential(
  storage: VaultStorage,
  service: string,
  cred: StoredCredential,
): Promise<void> {
  await storage.put(service, cred);
}

export async function getCredential(
  storage: VaultStorage,
  service: string,
): Promise<StoredCredential | null> {
  return storage.get(service);
}

export async function deleteCredential(
  storage: VaultStorage,
  service: string,
): Promise<boolean> {
  return storage.delete(service);
}

export async function listServices(
  storage: VaultStorage,
): Promise<string[]> {
  return storage.list();
}

// ── Validation ──────────────────────────────────────────────────────────────

/** Validate a service name — alphanumeric + hyphens + underscores only. No paths. */
export function validateServiceName(name: string): boolean {
  if (!name) return false;
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name);
}

/**
 * Validate an upstream URL — must be HTTPS to a public domain name.
 *
 * ALLOWLIST approach (not blocklist). Only accepts:
 *   - HTTPS protocol
 *   - No userinfo (username/password in URL)
 *   - Domain names only (no IP addresses, no IPv6, no localhost)
 *
 * This eliminates entire classes of SSRF bypass:
 *   - IPv4-mapped IPv6 (::ffff:169.254.169.254)
 *   - Hex/octal IP representations
 *   - DNS rebinding is mitigated by CF Workers' fetch() which blocks
 *     private IPs at the network level regardless of DNS resolution
 */
export function validateUpstreamUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== "https:") return false;

  // Block credentials in URL (userinfo)
  if (parsed.username || parsed.password) return false;

  const host = parsed.hostname.toLowerCase();

  // Must be a domain name — reject everything else.
  // Domain names: letters, digits, hyphens, dots. No brackets, no colons.
  // This rejects all IP addresses (v4 and v6), localhost, and special names.

  // Reject IPv6 (contains brackets or colons)
  if (host.includes("[") || host.includes("]") || host.includes(":")) return false;

  // Reject if hostname is all digits and dots (IPv4 address)
  if (/^[\d.]+$/.test(host)) return false;

  // Reject localhost and other special hostnames
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host.endsWith(".internal")) return false;  // metadata.google.internal etc.

  // Must look like a domain: has at least one dot, only valid DNS chars
  if (!host.includes(".")) return false;
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host)) return false;

  return true;
}

// ── Error responses — never leak credentials ────────────────────────────────

export function buildErrorResponse(
  type: string,
  sub: string,
  service: string,
  _cred: StoredCredential | null,
): { error: string; service: string } {
  // Deliberately ignores _cred to prevent accidental credential leakage.
  // The credential parameter exists so callers don't build their own error
  // messages that might include credential values.
  return { error: type, service };
}

// ── Access control ──────────────────────────────────────────────────────────

/** Check if a subject matches any of the allowed glob patterns. */
export function checkAccess(allowedSubs: string[], sub: string): boolean {
  // Reject subs with control characters (newlines, tabs, etc.)
  // Prevents injection of multi-line values that could bypass glob matching
  if (/[\x00-\x1f]/.test(sub)) return false;
  return allowedSubs.some((pattern) => globMatch(pattern, sub));
}

/** Simple glob matching — supports * as wildcard segment. No regex (ReDoS-safe). */
function globMatch(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === value;

  // Split on * and match segments sequentially (no regex, no backtracking)
  const segments = pattern.split("*");
  let pos = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === "") continue;

    if (i === 0) {
      // First segment must match at the start
      if (!value.startsWith(seg)) return false;
      pos = seg.length;
    } else if (i === segments.length - 1) {
      // Last segment must match at the end
      if (!value.endsWith(seg)) return false;
      // Ensure no overlap with earlier matches
      if (value.length - seg.length < pos) return false;
    } else {
      // Middle segments: find next occurrence after current position
      const idx = value.indexOf(seg, pos);
      if (idx === -1) return false;
      pos = idx + seg.length;
    }
  }

  return true;
}

// ── Response sanitization ───────────────────────────────────────────────────

/**
 * Response headers allowed through from upstream. Allowlist approach:
 * anything not explicitly listed is stripped. This prevents leaking upstream
 * infrastructure info (Server, X-Powered-By, cloud provider headers)
 * and prevents upstream cookies from reaching the caller.
 */
const ALLOWED_RESPONSE_HEADERS = new Set([
  "content-type",
  "content-length",
  "content-encoding",
  "cache-control",
  "etag",
  "last-modified",
  "date",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "retry-after",
]);

/** Sanitize an upstream response — only allow safe headers through. */
export function sanitizeResponse(upstream: Response): Response {
  const headers = new Headers();
  for (const [key, value] of upstream.headers) {
    if (ALLOWED_RESPONSE_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

// ── Proxy ───────────────────────────────────────────────────────────────────

/**
 * Headers that MUST NOT be forwarded from the caller to the upstream.
 * Three categories:
 *   1. Caller auth headers (would leak caller identity to upstream)
 *   2. CF-injected headers (would leak caller IP, location, routing info)
 *   3. Hop-by-hop headers (meaningless after proxy)
 */
const STRIPPED_HEADERS = [
  // Caller auth — never forward identity material to upstream
  "authorization",
  "x-client-cert",
  "dpop",
  "cookie",
  // CF-injected — caller IP, geo, routing
  "cf-connecting-ip",
  "cf-ray",
  "cf-visitor",
  "cf-ipcountry",
  "cf-worker",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-real-ip",
  // Hop-by-hop
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "upgrade",
];

/** Build a proxied request: caller's URL params + credential headers → upstream. */
export function buildProxyRequest(
  incoming: Request,
  cred: StoredCredential,
): Request {
  const incomingUrl = new URL(incoming.url);
  const upstreamUrl = new URL(cred.upstream);

  // Merge query params from incoming request onto upstream URL
  for (const [key, value] of incomingUrl.searchParams) {
    upstreamUrl.searchParams.set(key, value);
  }

  // Build headers: start clean, add safe incoming headers, inject credential headers
  const headers = new Headers();
  for (const [key, value] of incoming.headers) {
    if (!STRIPPED_HEADERS.includes(key.toLowerCase())) {
      headers.set(key, value);
    }
  }
  for (const [key, value] of Object.entries(cred.headers)) {
    headers.set(key, value);
  }

  const hasBody = incoming.method !== "GET" && incoming.method !== "HEAD";
  return new Request(upstreamUrl.toString(), {
    method: incoming.method,
    headers,
    body: hasBody ? incoming.body : undefined,
    ...(hasBody ? { duplex: "half" } : {}),
  } as RequestInit);
}
