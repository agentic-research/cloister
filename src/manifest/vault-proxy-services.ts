// src/manifest/vault-proxy-services.ts — pure manifest → route
// conversion for cloister/credential-isolation/v1 service declarations
// (cloister-8f57f0).
//
// Lives in its own module (separate from `runtime.ts`) so the
// build-time validator (`scripts/build-manifest.mjs`) can import it
// without pulling in `cloudflare:workers` (which `runtime.ts` does
// via the route classes). Single source of truth — same `buildServiceRegistry`
// runs at build time AND at boot time. Per cloister-8f57f0 + the
// Copilot review on PR #36.

import type { VaultProxyServiceConfig, VaultProxyInjection } from "./types.js";
import type { VaultProxyService as RouteVaultProxyService } from "../routes/vault-proxy.js";

/**
 * Build a Map-backed service registry from the manifest's
 * `vaultProxyServices` list. Throws TypeError with a precise
 * diagnostic on the first failure (duplicate name, missing required
 * field, malformed injection payload).
 */
export function buildServiceRegistry(
  configs: readonly VaultProxyServiceConfig[],
): Map<string, RouteVaultProxyService> {
  const map = new Map<string, RouteVaultProxyService>();
  for (const cfg of configs) {
    const converted = toRouteVaultProxyService(cfg);
    if (map.has(converted.name)) {
      throw new TypeError(
        `manifest: vaultProxyServices declares "${converted.name}" more than once`,
      );
    }
    map.set(converted.name, converted);
  }
  return map;
}

/**
 * Convert one manifest service config to the route-side shape with
 * full validation. Per Copilot review on PR #36:
 *
 *   - Capnp's JSON encoding OMITS default-empty pointer fields
 *     (lists default to null/undefined; strings default to empty).
 *     `cfg.defaultAllowedSubs` arrives as `undefined` when the
 *     operator omits the field. Treat undefined as []; the empty
 *     list is still meaningful (deny-all, safe-closed).
 *   - `name` MUST be non-empty (empty makes the service unreachable
 *     since the URL parser keys on the path segment).
 *   - `upstreamBaseUrl` MUST be non-empty + parseable as a URL
 *     (missing/invalid crashes later at `.replace()` or `new Request()`).
 *   - `rateLimitPerMinute` MUST be a non-negative finite integer.
 *   - Injection-union payload strings (`headerNamed.name`,
 *     `queryParam.name`, `bodyField.path`) MUST be non-empty —
 *     undefined would inject the credential into an `undefined` field.
 */
function toRouteVaultProxyService(
  cfg: VaultProxyServiceConfig,
): RouteVaultProxyService {
  // ── name: non-empty + single URL path segment ────────────────────
  // (Copilot #6 #9). `parseVaultProxyPath` splits the first path
  // segment as the service name, so a manifest entry like "foo/bar"
  // can never be resolved by `/vault/proxy/<service>/...`. Reject
  // at build time so a misconfig fails closed.
  const name = typeof cfg.name === "string" ? cfg.name : "";
  if (name === "") {
    throw new TypeError("manifest: vaultProxyService.name must be a non-empty string");
  }
  if (name.includes("/") || name.includes("%2F") || name.includes("%2f")) {
    throw new TypeError(
      `manifest: vaultProxyService.name "${name}" must be a single URL path segment (no '/' or encoded slash) — parseVaultProxyPath splits on '/'`,
    );
  }

  // ── upstreamBaseUrl: http/https only, no query/fragment ───────────
  // (Copilot #6 #11 #16). `new URL()` accepts ftp:/data:/mailto:/etc;
  // proxy fetches must be HTTP. AND: query/fragment can't be present
  // because proxyToUpstream composes upstream URL as
  // `baseUrl.replace(/\/+$/, "") + req.upstreamPath` — a base like
  // `https://api.test/v1?token=x` would yield
  // `https://api.test/v1?token=x/path` which misroutes traffic.
  const upstreamBaseUrl = typeof cfg.upstreamBaseUrl === "string" ? cfg.upstreamBaseUrl : "";
  if (upstreamBaseUrl === "") {
    throw new TypeError(
      `manifest: vaultProxyService "${name}".upstreamBaseUrl must be a non-empty string`,
    );
  }
  let parsedUrl: URL;
  try { parsedUrl = new URL(upstreamBaseUrl); } catch {
    throw new TypeError(
      `manifest: vaultProxyService "${name}".upstreamBaseUrl is not a valid URL: ${upstreamBaseUrl}`,
    );
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new TypeError(
      `manifest: vaultProxyService "${name}".upstreamBaseUrl must use http: or https: (got ${parsedUrl.protocol})`,
    );
  }
  if (parsedUrl.search !== "" || parsedUrl.hash !== "") {
    throw new TypeError(
      `manifest: vaultProxyService "${name}".upstreamBaseUrl must not have a query string or fragment — they don't compose with the appended upstream path`,
    );
  }

  // ── rateLimitPerMinute: non-negative integer ─────────────────────
  if (
    typeof cfg.rateLimitPerMinute !== "number"
    || !Number.isFinite(cfg.rateLimitPerMinute)
    || !Number.isInteger(cfg.rateLimitPerMinute)
    || cfg.rateLimitPerMinute < 0
  ) {
    throw new TypeError(
      `manifest: vaultProxyService "${name}".rateLimitPerMinute must be a non-negative integer; got ${String(cfg.rateLimitPerMinute)}`,
    );
  }

  // ── defaultAllowedSubs: capnp omits default-empty pointer fields ──
  // (Copilot #5). `undefined` is the common shape, not [].
  const subs = cfg.defaultAllowedSubs ?? [];
  return {
    name,
    upstreamBaseUrl,
    defaultAllowedSubs: [...subs],
    rateLimitPerMinute: cfg.rateLimitPerMinute,
    injection:          toRouteInjection(cfg.injection, name),
  };
}

/**
 * RFC 7230 §3.2.6 "tchar" — the only characters permitted in HTTP
 * header field names. `Headers.set()` throws at request time for any
 * other character; rejecting at build time turns a 500-at-traffic
 * into a clear manifest error. Per Copilot #10.
 */
const HTTP_HEADER_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function toRouteInjection(
  inj: VaultProxyInjection,
  serviceName: string,
): RouteVaultProxyService["injection"] {
  if ("authorizationBearer" in inj) return { kind: "authorizationBearer" };
  if ("authorizationBasic" in inj)  return { kind: "authorizationBasic" };
  if ("headerNamed" in inj) {
    const n = inj.headerNamed?.name;
    if (typeof n !== "string" || n === "") {
      throw new TypeError(
        `manifest: vaultProxyService "${serviceName}".injection.headerNamed.name must be a non-empty string`,
      );
    }
    // Copilot #10 — Headers.set() throws at request time on invalid
    // header tokens (spaces, colons, control chars). Fail at build
    // time instead of turning all matching requests into 500s.
    if (!HTTP_HEADER_TOKEN_RE.test(n)) {
      throw new TypeError(
        `manifest: vaultProxyService "${serviceName}".injection.headerNamed.name "${n}" is not a valid HTTP header token (RFC 7230 tchar)`,
      );
    }
    return { kind: "headerNamed", name: n };
  }
  if ("queryParam" in inj) {
    const n = inj.queryParam?.name;
    if (typeof n !== "string" || n === "") {
      throw new TypeError(
        `manifest: vaultProxyService "${serviceName}".injection.queryParam.name must be a non-empty string`,
      );
    }
    return { kind: "queryParam", name: n };
  }
  if ("bodyField" in inj) {
    const p = inj.bodyField?.path;
    if (typeof p !== "string" || p === "") {
      throw new TypeError(
        `manifest: vaultProxyService "${serviceName}".injection.bodyField.path must be a non-empty string`,
      );
    }
    // Copilot #15 — `.foo` or `auth..secret` would deep-set under an
    // empty-string key. Reject so the handler's split('.') never
    // observes an empty segment.
    if (p.split(".").some((seg) => seg === "")) {
      throw new TypeError(
        `manifest: vaultProxyService "${serviceName}".injection.bodyField.path "${p}" must not contain empty dotted segments (split on '.' yields no empty parts)`,
      );
    }
    return { kind: "bodyField", path: p };
  }
  const _exhaustive: never = inj;
  void _exhaustive;
  throw new TypeError(`manifest: unknown vault-proxy injection kind: ${JSON.stringify(inj)}`);
}
