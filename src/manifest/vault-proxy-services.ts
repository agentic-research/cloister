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
  const name = typeof cfg.name === "string" ? cfg.name : "";
  if (name === "") {
    throw new TypeError("manifest: vaultProxyService.name must be a non-empty string");
  }
  const upstreamBaseUrl = typeof cfg.upstreamBaseUrl === "string" ? cfg.upstreamBaseUrl : "";
  if (upstreamBaseUrl === "") {
    throw new TypeError(
      `manifest: vaultProxyService "${name}".upstreamBaseUrl must be a non-empty string`,
    );
  }
  try { new URL(upstreamBaseUrl); } catch {
    throw new TypeError(
      `manifest: vaultProxyService "${name}".upstreamBaseUrl is not a valid URL: ${upstreamBaseUrl}`,
    );
  }
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
  // Capnp omits default-empty pointer fields → undefined is the
  // common shape, not [] (a real client never observes []).
  const subs = cfg.defaultAllowedSubs ?? [];
  return {
    name,
    upstreamBaseUrl,
    defaultAllowedSubs: [...subs],
    rateLimitPerMinute: cfg.rateLimitPerMinute,
    injection:          toRouteInjection(cfg.injection, name),
  };
}

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
    return { kind: "bodyField", path: p };
  }
  const _exhaustive: never = inj;
  void _exhaustive;
  throw new TypeError(`manifest: unknown vault-proxy injection kind: ${JSON.stringify(inj)}`);
}
