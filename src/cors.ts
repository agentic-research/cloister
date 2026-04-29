/**
 * CORS allowlist — env-driven, dev-default-wildcard.
 *
 * Reads `ALLOWED_ORIGINS` (comma-separated). When unset or "*", returns the
 * request's Origin header verbatim (or "*" when there's no Origin) — this is
 * the dev-friendly default that matches today's behavior.
 *
 * Each entry is matched literally OR with a single trailing `*` glob on the
 * port (e.g. `http://localhost:*` matches any localhost port). No general
 * wildcards anywhere else — keep the rule trivially auditable.
 *
 * Wildcard with credentials is invalid per CORS spec; we don't echo
 * `Access-Control-Allow-Credentials` here, so wildcard is safe for our
 * "stateless JSON-RPC" surface.
 */

export type AllowOrigin = "*" | string;

export function pickAllowedOrigin(
  request: Request,
  allowedOrigins: string | undefined,
): AllowOrigin {
  const origin = request.headers.get("Origin");
  const list = (allowedOrigins ?? "").trim();

  // Unconfigured or explicit "*" → keep the wide-open dev default.
  if (list === "" || list === "*") {
    return origin ?? "*";
  }

  if (!origin) {
    // No Origin header on the request — don't expose CORS at all by echoing.
    // Returning the first configured entry is fine; browsers without an
    // Origin won't enforce CORS anyway.
    return list.split(",")[0]!.trim();
  }

  // Match against the configured allowlist.
  for (const raw of list.split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    if (matchOrigin(origin, entry)) return origin;
  }

  // Not allowed — return a sentinel that browsers will refuse, rather than
  // echoing the disallowed origin (which would defeat the policy).
  return "null";
}

function matchOrigin(origin: string, pattern: string): boolean {
  if (pattern === origin) return true;

  // Trailing-port wildcard: "http://localhost:*" matches any port on host.
  if (pattern.endsWith(":*")) {
    const prefix = pattern.slice(0, -1); // drop the "*"
    if (origin.startsWith(prefix)) {
      const tail = origin.slice(prefix.length);
      // Tail must be all digits — i.e. just a port number.
      return tail !== "" && /^[0-9]+$/.test(tail);
    }
  }
  return false;
}
