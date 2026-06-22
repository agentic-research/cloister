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
import { constantTimeErrorResponse } from "../storage/disclosure-cursor.js";

/**
 * 404 response shape — REUSE `constantTimeErrorResponse` from the
 * disclosure-cursor module so the bytes are BYTE-IDENTICAL to the
 * disclosure endpoint's 404. Per threat-model §13.7.1 + §9.4.b, every
 * 404 path on the substrate's outer wire MUST share the same shape so
 * an attacker can't distinguish "no such tenant" from "no such peer"
 * from "denied".
 *
 * Prior implementation used a 10-byte "Not Found\n" body — caught in
 * adversarial cycle 2026-06-22 (cloister-92e846 / C1): an attacker
 * probing `/t/<guess>/interlace/peers/<fp>` could distinguish
 * tenant-existence by the response length (10 bytes for unmatched
 * tenant vs 256 bytes for matched-but-no-peer). Now byte-equivalent.
 */
function notFoundResponse(): Response {
  return constantTimeErrorResponse("not_found");
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
 *
 * ## Timing properties
 *
 * Per threat-model §13.7.6(b) / cloister-92e846: this function does NOT
 * early-break on path-prefix match. Iterating the FULL path-prefix table
 * on every request closes the row-position oracle a previous version
 * shipped: with early-break, an attacker could probe `/t/<guess>` and
 * detect *where in the table* a tenant lives by request latency. After
 * this change, every path-prefix lookup walks the same N rows
 * regardless of which one (if any) matched.
 *
 * First-match precedence (table-order wins) is preserved — we record
 * the FIRST match and continue scanning rather than returning early.
 *
 * **Residual:** per-row work still depends on the prefix string's
 * length (`startsWith` + `slice` cost scales with prefix length). For
 * realistic deployments (single-digit tenants, prefix lengths <50
 * chars) this is below HTTP-level detection threshold. A truly
 * constant-time string compare would require constant-padded
 * comparisons against a max-prefix-length buffer — deferred until a
 * deployment with adversarial-tier probing requires it.
 */
export function matchTenant(
  table: CompiledTable,
  request: Request,
): { row: TenantDispatchRow; strippedPath: string } | null {
  const url = new URL(request.url);
  // SNI mode — exact host-header match. O(1) hash-table lookup; the
  // map's internal load-factor + hash distribution provides
  // probabilistic constant-time behavior. No row-position information
  // leaks because there are no row positions to speak of.
  const sniRow = table.sni.get(url.hostname);
  if (sniRow !== undefined) {
    return { row: sniRow, strippedPath: url.pathname };
  }
  // Path-prefix mode — FULL scan, first-match-precedence recorded.
  // No early-break: every request walks every row to deny the
  // row-position oracle (cloister-92e846 / §13.7.6(b)).
  let firstMatch: { row: TenantDispatchRow; strippedPath: string } | null = null;
  for (const row of table.pathPrefix) {
    const prefix = row.matchValue;
    // A path-prefix "/t/alice" matches "/t/alice", "/t/alice/", "/t/alice/foo",
    // but NOT "/t/alice-bar" (substring-but-not-prefix). The next-char
    // check after the prefix bytes prevents that.
    let isMatch = false;
    let strippedPath = "/";
    if (url.pathname === prefix) {
      isMatch = true;
    } else if (url.pathname.startsWith(prefix)) {
      const next = url.pathname.charAt(prefix.length);
      if (next === "/" || next === "") {
        isMatch = true;
        strippedPath = url.pathname.slice(prefix.length) || "/";
      }
    }
    // Record FIRST match (preserves table-order precedence) but DO NOT
    // break — that would re-introduce the row-position oracle.
    if (isMatch && firstMatch === null) {
      firstMatch = { row, strippedPath };
    }
  }
  return firstMatch;
}

// ── EdgeRoute implementation ─────────────────────────────────────────────

export class TenantDispatchRoute implements EdgeRoute {
  private readonly table: CompiledTable;
  /**
   * Bindings already warned about. Per cloister-9339c0 (C3 of adversarial
   * cycle 2026-06-22 / threat-model §13.7.6): the unwired-binding emit
   * used to fire on EVERY request, plus echoed `row.name` in plaintext.
   * A log-aggregator-tier observer could then enumerate the tenant table
   * by probing `/t/<guess>` against a deployment with any unwired binding.
   * Now: one emit per (binding) per route lifetime — that's all an operator
   * needs for triage, and the binding name is the manifest-static join key
   * (not a per-request oracle). Tenant name is elided from the emit.
   */
  private readonly warnedBindings = new Set<string>();
  /**
   * Per-request match cache. Per cloister-92e846 / threat-model §13.7.6(c):
   * `match()` and `handle()` BOTH used to call `matchTenant`, which meant
   * matched requests scanned 2× and unmatched requests scanned 1× — a
   * timing-amplified single-bit oracle on match status. Storing the
   * `matchTenant` result on the request via a `WeakMap` makes
   * `handle()` reuse `match()`'s work; both calls together cost
   * exactly one scan. The map is weak so the cache entry is GC'd with
   * the request object.
   *
   * Why a WeakMap and not a Symbol-keyed property mutation on Request:
   * workerd's Request type doesn't bless arbitrary property additions
   * and the V8 hidden-class invariants are easier to reason about with
   * an external Map.
   *
   * Why `has(...)` not `get(...) === undefined`: a successful match
   * stores a non-null value; a confirmed no-match stores `null`. Both
   * are valid cached results distinct from "not yet computed."
   */
  private readonly matchCache = new WeakMap<
    Request,
    { row: TenantDispatchRow; strippedPath: string } | null
  >();

  constructor(spec: TenantDispatchSpec) {
    this.table = compileDispatchTable(spec);
  }

  /**
   * Internal: compute the match result OR return the cached one.
   * Centralized so both `match()` and `handle()` go through the same
   * deduplication path.
   */
  private resolveMatch(
    request: Request,
  ): { row: TenantDispatchRow; strippedPath: string } | null {
    if (this.matchCache.has(request)) {
      // Cached — return without re-scanning. This is the §13.7.6(c)
      // fix: handle()'s scan is now a hash-map lookup, not a fresh
      // table walk.
      return this.matchCache.get(request) ?? null;
    }
    const result = matchTenant(this.table, request);
    this.matchCache.set(request, result);
    return result;
  }

  /**
   * The route is the FIRST matcher in the table — it claims any request
   * whose host or path matches a tenant row. Requests that don't match
   * fall through to subsequent routes. (If `match()` returns true but
   * the request can't be dispatched, `handle()` returns a 404 — the
   * router never sees the failure.)
   *
   * The result of `matchTenant` is cached on the request via `matchCache`,
   * so a subsequent `handle()` for the same request does NOT re-scan the
   * table (§13.7.6(c) / cloister-92e846).
   */
  match(request: Request): boolean {
    return this.resolveMatch(request) !== null;
  }

  async handle(request: Request, env: Env): Promise<Response> {
    const matched = this.resolveMatch(request);
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
      //
      // Throttle + redact per cloister-9339c0 (C3 / §13.7.6): one structured
      // emit per (binding) over route lifetime, tenant name elided. The
      // operator looks the binding up in cluster.toml's [[tenants]] list
      // to find the misconfigured row; row.name in the log would only
      // duplicate that information AND let a log-aggregator-tier observer
      // enumerate the tenant table by request-driven probing.
      if (!this.warnedBindings.has(row.binding)) {
        this.warnedBindings.add(row.binding);
        // eslint-disable-next-line no-console -- intentional structured emit
        console.warn(JSON.stringify({
          event:   "tenant_dispatch.unwired_binding",
          binding: row.binding,
          env_kind: typeof fetcher,
          bead:    "cloister-9339c0",
        }));
      }
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
