// SPDX-License-Identifier: AGPL-3.0-or-later
//
// roots-state.ts — per-peer filesystem-roots cache (cloister-65a30f).
//
// MCP roots primitive (spec 2025-06-18, §Client Features → Roots):
// external clients declare `capabilities.roots` on `initialize` and MAY
// include a roots list inline, or send it on demand via `roots/list`.
// They also emit `notifications/roots/list_changed` when their root set
// changes if they advertised `listChanged: true`.
//
// Cloister, as an MCP proxy, holds this state per peer (keyed by the
// `peerFp` from the `VerifiedLease`) so that:
//   - upstream-initiated reverse-RPC `roots/list` requests can be answered
//     inline on the same SSE channel (see mcp-proxy.ts handleReverseRpc),
//   - `notifications/roots/list_changed` can invalidate the cache and
//     fan-out to upstreams that opted in.
//
// Sessions without a lease (dev / test mode where `INTERLACE_ROOT_PUBKEY`
// is unset) all share the `__anonymous__` key so the primitive still
// works locally.

/**
 * A single filesystem-root entry. Per the MCP spec, `uri` MUST be a
 * `file://...` URI. Optional human-readable `name` for display.
 */
export interface Root {
  uri:   string;
  name?: string;
}

export interface RootsState {
  /** Roots declared by (or fetched from) the peer. */
  roots:                 Root[];
  /** Whether the peer declared the roots capability on initialize. */
  capabilityDeclared:    boolean;
  /** Whether the peer set `listChanged: true` on the capability. */
  listChangedSupported:  boolean;
}

/** Sentinel key used when the request rides anonymous (no lease) mode. */
export const ANONYMOUS_PEER = "__anonymous__";

const store = new Map<string, RootsState>();

/**
 * Get the current roots state for a peer. Returns `undefined` if the
 * peer has neither declared the capability nor had any roots set.
 */
export function getRoots(peerFp: string): RootsState | undefined {
  return store.get(peerFp);
}

/**
 * Mark the peer as having declared `capabilities.roots`. Idempotent —
 * declaring twice with different `listChanged` values updates the flag.
 * Pre-existing `roots` array is preserved.
 */
export function setCapability(peerFp: string, listChanged: boolean): void {
  const prev = store.get(peerFp);
  store.set(peerFp, {
    roots:                prev?.roots ?? [],
    capabilityDeclared:   true,
    listChangedSupported: listChanged,
  });
}

/**
 * Replace the cached roots list for a peer. Preserves the previously
 * recorded capability flags; if no capability was ever declared, this
 * still records the roots (some clients include them inline on
 * `initialize` even when not strictly declaring the capability).
 */
export function setRoots(peerFp: string, roots: Root[]): void {
  const prev = store.get(peerFp);
  store.set(peerFp, {
    roots:                [...roots],
    capabilityDeclared:   prev?.capabilityDeclared   ?? false,
    listChangedSupported: prev?.listChangedSupported ?? false,
  });
}

/**
 * Drop a peer's cached state entirely. Called on
 * `notifications/roots/list_changed` so the next read returns nothing
 * until either an inline update arrives or an upstream `roots/list`
 * reverse-RPC re-populates the cache.
 */
export function clearRoots(peerFp: string): void {
  store.delete(peerFp);
}

/**
 * Test-only helper — drop every peer's state. Production code never
 * calls this; tests use it for isolation between cases.
 */
export function resetRootsStateForTests(): void {
  store.clear();
}
