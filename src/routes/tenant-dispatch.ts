// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Per-tenant dispatch route — entry-point for ADR-0030 §A2 multi-tenant
// routing (cloister-0f144c).
//
// Inbound request → match table → forward to that tenant's workerd via
// a service-binding Fetcher. Two match modes:
//
//   - "sni"         — exact match against the URL's host header. O(1)
//                     hash-table lookup. Right for TLS-terminating
//                     deployments where each tenant gets a distinct
//                     subdomain (alice.cluster.example.com).
//   - "path-prefix" — prefix match against the URL's pathname. First-
//                     match-wins scan (table order is the precedence).
//                     The prefix is STRIPPED before forwarding so the
//                     tenant's bundles see the inner path. Right for
//                     internal / dev / single-host deployments.
//
// Mixed mode is permitted: different tenants in the same table may use
// different modes. The router checks SNI first (O(1)), then path-prefix
// (linear). A tenant that matches BOTH modes (e.g. operator declares
// the same name twice with different modes) is rejected at instantiation
// — names must be unique.
//
// Per threat-model §13.7.1:
//
//   - Unknown tenant collapses into a constant-time 404 — same response
//     shape as the disclosure endpoint (§9.2), so the entry-point isn't
//     a cross-tenant peer-existence oracle.
//   - Lease verification still happens BEFORE dispatch (the per-tenant
//     scope is part of lease verification per ADR-0007). This route is
//     the routing primitive; it doesn't make access-control decisions.

import type { EdgeRoute } from "../router.js";
import type { TenantDispatchSpec, TenantDispatchRow } from "../manifest/types.js";
import type { Env } from "../types.js";

/**
 * 404 body shape — exact bytes mirror the constant-time-error pattern
 * used elsewhere in cloister (e.g. `disclosure-cursor.ts`). Operators
 * can't distinguish "no such tenant" from "request didn't match any
 * tenant row" — both collapse to the same response.
 */
const NOT_FOUND_BODY = "Not Found\n";

function notFoundResponse(): Response {
  return new Response(NOT_FOUND_BODY, {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-length": String(NOT_FOUND_BODY.length),
      "cache-control": "no-store",
    },
  });
}

// ── Compile-time route construction ──────────────────────────────────────

/**
 * Compiled dispatch table. Built once at construction; reused across
 * requests. SNI rows go in a Map for O(1) lookup; path-prefix rows
 * stay in an array (first-match scan, table order is precedence).
 */
interface CompiledTable {
  readonly sni: ReadonlyMap<string, TenantDispatchRow>;
  readonly pathPrefix: readonly TenantDispatchRow[];
}

/**
 * Compile + validate a TenantDispatchSpec. Throws on operator errors:
 *
 *   - Empty `name`, `mode`, `matchValue`, or `binding`
 *   - Unknown `mode` (must be "sni" | "path-prefix")
 *   - Duplicate `name` across rows
 *   - Duplicate SNI `matchValue` (two tenants can't claim the same host)
 *
 * Exported for the test suite + the runtime instantiator.
 */
export function compileDispatchTable(spec: TenantDispatchSpec): CompiledTable {
  const sni = new Map<string, TenantDispatchRow>();
  const pathPrefix: TenantDispatchRow[] = [];
  const seenNames = new Set<string>();

  for (const row of spec.tenants) {
    if (!row.name) {
      throw new TypeError("tenantDispatch: empty tenant name in row");
    }
    if (seenNames.has(row.name)) {
      throw new TypeError(`tenantDispatch: duplicate tenant name ${JSON.stringify(row.name)}`);
    }
    seenNames.add(row.name);

    if (!row.matchValue) {
      throw new TypeError(
        `tenantDispatch: tenant ${JSON.stringify(row.name)} has empty matchValue`,
      );
    }
    if (!row.binding) {
      throw new TypeError(
        `tenantDispatch: tenant ${JSON.stringify(row.name)} has empty binding`,
      );
    }

    if (row.mode === "sni") {
      if (sni.has(row.matchValue)) {
        throw new TypeError(
          `tenantDispatch: duplicate SNI matchValue ${JSON.stringify(row.matchValue)} ` +
            `(tenants ${JSON.stringify(sni.get(row.matchValue)!.name)} and ${JSON.stringify(row.name)})`,
        );
      }
      sni.set(row.matchValue, row);
    } else if (row.mode === "path-prefix") {
      // Path-prefix duplicates are NOT rejected at compile time — the
      // table-order precedence handles them at request time. Operators
      // can layer specific prefixes over general ones (e.g.
      // `/t/alice-staging` before `/t/alice`).
      pathPrefix.push(row);
    } else {
      throw new TypeError(
        `tenantDispatch: tenant ${JSON.stringify(row.name)} has unknown mode ` +
          `${JSON.stringify(row.mode)} (allowed: "sni", "path-prefix")`,
      );
    }
  }

  return { sni, pathPrefix };
}

// ── Request-time matching ────────────────────────────────────────────────

/**
 * Look up the tenant row matching this request. Returns null if no row
 * matches (caller collapses into a constant-time 404).
 *
 * Exported for the test suite.
 */
export function matchTenant(
  table: CompiledTable,
  request: Request,
): { row: TenantDispatchRow; strippedPath: string } | null {
  const url = new URL(request.url);
  // SNI mode — exact host-header match. O(1).
  const sniRow = table.sni.get(url.hostname);
  if (sniRow !== undefined) {
    return { row: sniRow, strippedPath: url.pathname };
  }
  // Path-prefix mode — first-match scan. The prefix is stripped from
  // the URL before forwarding.
  for (const row of table.pathPrefix) {
    const prefix = row.matchValue;
    // A path-prefix "/t/alice" matches "/t/alice", "/t/alice/", "/t/alice/foo",
    // but NOT "/t/alice-bar" (substring-but-not-prefix). The next-char
    // check after the prefix bytes prevents that.
    if (url.pathname === prefix) {
      return { row, strippedPath: "/" };
    }
    if (url.pathname.startsWith(prefix)) {
      const next = url.pathname.charAt(prefix.length);
      if (next === "/" || next === "") {
        const strippedPath = url.pathname.slice(prefix.length) || "/";
        return { row, strippedPath };
      }
    }
  }
  return null;
}

// ── EdgeRoute implementation ─────────────────────────────────────────────

export class TenantDispatchRoute implements EdgeRoute {
  private readonly table: CompiledTable;

  constructor(spec: TenantDispatchSpec) {
    this.table = compileDispatchTable(spec);
  }

  /**
   * The route is the FIRST matcher in the table — it claims any request
   * whose host or path matches a tenant row. Requests that don't match
   * fall through to subsequent routes. (If `match()` returns true but
   * the request can't be dispatched, `handle()` returns a 404 — the
   * router never sees the failure.)
   *
   * Note: `match()` is intentionally lightweight (boolean only); the
   * actual table lookup runs again in `handle()`. The duplicate work is
   * O(1) for SNI mode + O(N) for path-prefix where N is small in
   * practice (single-digit tenants per typical deployment).
   */
  match(request: Request): boolean {
    return matchTenant(this.table, request) !== null;
  }

  async handle(request: Request, env: Env): Promise<Response> {
    const matched = matchTenant(this.table, request);
    if (matched === null) {
      // Defensive: match() returned true but matchTenant returned null.
      // Can't happen unless the request object mutates between calls.
      return notFoundResponse();
    }
    const { row, strippedPath } = matched;
    const fetcher = (env as unknown as Record<string, unknown>)[row.binding] as Fetcher | undefined;
    if (!fetcher || typeof fetcher.fetch !== "function") {
      // Operator declared a binding that isn't wired. Return 404 (not
      // 500) so the failure mode is indistinguishable from "no tenant"
      // — keeps the constant-time-404 invariant intact even under
      // misconfiguration. The misconfig surfaces in logs, not in the
      // response shape.
      console.warn(
        `tenant-dispatch: binding ${JSON.stringify(row.binding)} for tenant ` +
          `${JSON.stringify(row.name)} is not bound (env[${row.binding}] is ${typeof fetcher})`,
      );
      return notFoundResponse();
    }

    // Build the forwarded request. For path-prefix mode, swap the URL's
    // pathname; for SNI mode, forward the URL unchanged.
    const url = new URL(request.url);
    let forwardUrl = request.url;
    if (strippedPath !== url.pathname) {
      url.pathname = strippedPath;
      forwardUrl = url.toString();
    }
    const forwardedRequest = new Request(forwardUrl, request);
    return fetcher.fetch(forwardedRequest);
  }
}
