// SPDX-License-Identifier: AGPL-3.0-or-later
//
// confinement-lattice — cloister/confinement/v1 documents ordered by
// permissiveness, with `meet` as the only operation that changes one.
//
// ## Why this exists
//
// Cloudflare's Agent Access Model (2026-08) proposes a "Trust Ratchet": trust
// becomes stateful within a run, so a protected event (the agent read something
// classified) narrows the capability set, and it can never widen again. A
// prompt injection landing afterward cannot exfiltrate, because the capability
// to do so no longer exists.
//
// Cloister does not need a new mechanism for that, because confinement/v1 is
// already a lattice. Its own schema says so without using the word:
//
//   "Every dimension defaults to DENY; the manifest names only what is allowed,
//    so an omitted block is a refusal and never an escape hatch."
//
// Five dimensions, each default-deny, is a PRODUCT of five component lattices.
// Bottom is `{version}` alone — total denial, and note that it is a VALID
// document, so fail-closed is expressible rather than exceptional. A ratchet
// step is then just `meet(current, restriction)`, and the properties the AAM
// paper has to specify and enforce fall out of the algebra instead:
//
//   "can only narrow"       meet is decreasing:  a ∧ b ≤ a.  Not a rule to
//                           enforce; a theorem. Widening is not expressible.
//   fail-closed on conflict meet with ⊥ is ⊥.    Absorbing element.
//   ordering does not matter associativity + commutativity.
//   duplicates do not matter idempotence.
//
// The last two are what let this skip the hard part of AAM's design. That paper
// requires "synchronized acknowledgment across all enforcement points before
// responses are released", because its ratchet state is a mutable variable that
// components must agree on. A meet-semilattice is the canonical state-based
// CRDT: enforcement points may apply the same events in any order, or twice,
// and still converge. The distributed-consensus problem does not get solved
// here — it stops existing.
//
// ## What this does NOT do
//
// Compute anything, enforce anything, or change what `cloister run` emits. This
// is the algebra only. Wiring it into the launch path changes the
// confinementDigest committed into every minted cert, and it needs a runner
// that accepts a refinement of the committed document rather than an equal one
// — see ADR-0068 for that ask, which is LLO's to answer.
//
// ## Why it lives beside the emitter
//
// `launch.mjs` produces the documents this orders, and ADR-0067's finding was
// that a check agreeing with a document nobody emits is a check that proves
// nothing. Same directory means the same `lint:harness-types` strictness and no
// way to drift from the producer.

/**
 * @typedef {object} Confinement
 * @property {string}  version
 * @property {{allow?: (string|{path: string, mode: "rw"})[]}} [fs]
 * @property {{allowHosts?: string[]}} [network]
 * @property {{bind: number, address?: string}} [port]
 * @property {{allow?: (string|{path: string, mode: "bind"|"connect-bind"})[]}} [unixSocket]
 * @property {string} [credentialSource]
 */

export const CONFINEMENT_VERSION = "cloister/confinement/v1";

/**
 * Bottom: every dimension denied. The schema requires only `version`, so ⊥ is
 * an ordinary valid document — which is the property that lets a conflict or a
 * timeout resolve to "deny everything" without inventing an error state.
 *
 * @returns {Confinement}
 */
export function bottom() {
  return { version: CONFINEMENT_VERSION };
}

/**
 * Path-prefix containment, on SEGMENTS rather than characters. `/a/b` covers
 * `/a/b/c` but not `/a/bc` — a string-prefix test would grant the second, which
 * is a widening dressed as an optimisation.
 *
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
function covers(parent, child) {
  if (parent === child) return true;
  return child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

/**
 * Normalize an `fs.allow` / `unixSocket.allow` entry to `{path, rights}`.
 *
 * §2 spells read-only as a bare string and read-write as `{mode: "rw"}`; §6
 * spells connect-only as a bare string, with `bind` and `connect-bind` as
 * objects. Both are the same shape — a path plus a set of rights — so both
 * normalize into one representation and meet by set intersection.
 *
 * @param {string | {path: string, mode: string}} entry
 * @param {readonly string[]} bareRights rights the bare-string form grants
 * @returns {{path: string, rights: Set<string>}}
 */
function normalizeEntry(entry, bareRights) {
  if (typeof entry === "string") return { path: entry, rights: new Set(bareRights) };
  if (entry.mode === "rw") return { path: entry.path, rights: new Set(["read", "write"]) };
  if (entry.mode === "bind") return { path: entry.path, rights: new Set(["bind"]) };
  if (entry.mode === "connect-bind") return { path: entry.path, rights: new Set(["connect", "bind"]) };
  throw new Error(`unknown confinement entry mode ${JSON.stringify(entry.mode)}`);
}

/**
 * Render a normalized fs entry back to §2's two spellings. Read-only MUST come
 * back as a bare string: §2's `mode` enum admits only `"rw"`, so an explicit
 * `{"mode":"ro"}` is a schema violation, not a verbose synonym.
 *
 * @param {{path: string, rights: Set<string>}} entry
 * @returns {string | {path: string, mode: "rw"}}
 */
function renderFsEntry(entry) {
  return entry.rights.has("write") ? { path: entry.path, mode: "rw" } : entry.path;
}

/**
 * Render a normalized unixSocket entry back to §6's three spellings.
 *
 * @param {{path: string, rights: Set<string>}} entry
 * @returns {string | {path: string, mode: "bind"|"connect-bind"}}
 */
function renderSocketEntry(entry) {
  const connect = entry.rights.has("connect");
  const bind = entry.rights.has("bind");
  if (connect && bind) return { path: entry.path, mode: "connect-bind" };
  if (bind) return { path: entry.path, mode: "bind" };
  return entry.path;
}

/**
 * Drop entries whose grant is already implied by another. `x` is redundant when
 * some other entry covers its path with a superset of its rights.
 *
 * Purely cosmetic on the reach-set — but NOT cosmetic on the digest, since §7
 * canonicalization is over the literal array. Without this, `meet` would be
 * order-sensitive in its output bytes while being order-insensitive in its
 * meaning, and the associativity property would fail on a technicality.
 *
 * @param {{path: string, rights: Set<string>}[]} entries
 * @returns {{path: string, rights: Set<string>}[]}
 */
function dropSubsumed(entries) {
  return entries.filter((x, i) => !entries.some((y, j) =>
    j !== i
    && covers(y.path, x.path)
    && [...x.rights].every((r) => y.rights.has(r))
    // A true duplicate would otherwise eliminate BOTH copies.
    && !(y.path === x.path && y.rights.size === x.rights.size && j > i)));
}

/**
 * Meet of two path-grant sets, under prefix semantics.
 *
 * The reach-set of a prefix grant `/a/` contains that of `/a/b/`, so their
 * intersection is the LONGER path. Two paths where neither covers the other
 * have disjoint reach-sets and contribute nothing. Rights intersect.
 *
 * @param {{path: string, rights: Set<string>}[]} left
 * @param {{path: string, rights: Set<string>}[]} right
 * @returns {{path: string, rights: Set<string>}[]}
 */
function meetGrants(left, right) {
  /** @type {{path: string, rights: Set<string>}[]} */
  const out = [];
  for (const a of left) {
    for (const b of right) {
      const path = covers(a.path, b.path) ? b.path : covers(b.path, a.path) ? a.path : null;
      if (path === null) continue;
      const rights = new Set([...a.rights].filter((r) => b.rights.has(r)));
      if (rights.size === 0) continue;
      out.push({ path, rights });
    }
  }
  return dropSubsumed(out).sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}

/**
 * Meet of two path-grant sets under EXACT-match semantics, for §6.
 *
 * §2 documents its paths as prefixes ("Path prefixes the bundle may traverse");
 * §6 says only "Socket paths". Absent a stated prefix rule, exact match is the
 * reading that cannot over-grant — a socket path is an endpoint, not a subtree.
 *
 * @param {{path: string, rights: Set<string>}[]} left
 * @param {{path: string, rights: Set<string>}[]} right
 * @returns {{path: string, rights: Set<string>}[]}
 */
function meetExactGrants(left, right) {
  /** @type {{path: string, rights: Set<string>}[]} */
  const out = [];
  for (const a of left) {
    const b = right.find((r) => r.path === a.path);
    if (!b) continue;
    const rights = new Set([...a.rights].filter((r) => b.rights.has(r)));
    if (rights.size === 0) continue;
    out.push({ path: a.path, rights });
  }
  return out.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}

/**
 * Does host pattern `outer` admit everything `inner` admits?
 *
 * `*.example.com` is read as STRICT subdomains, excluding the apex — the TLS
 * reading, and the one under which a mistake narrows rather than widens.
 *
 * @param {string} outer
 * @param {string} inner
 * @returns {boolean}
 */
function hostCovers(outer, inner) {
  if (outer === inner) return true;
  if (!outer.startsWith("*.")) return false;
  const suffix = outer.slice(1); // ".example.com"
  const bare = inner.startsWith("*.") ? inner.slice(1) : inner;
  // `endsWith(suffix)` alone is right here: the apex `example.com` does not end
  // with `.example.com`, so it is excluded without a special case, and the only
  // input for which `bare === suffix` is `inner === outer`, already returned
  // above. A guard for it would be unreachable — mutation testing showed
  // removing one changed no outcome, which is how dead code should be found.
  return bare.endsWith(suffix);
}

/**
 * Meet of two host allow-lists: the more specific pattern where one subsumes
 * the other, nothing where they are disjoint.
 *
 * @param {string[]} left
 * @param {string[]} right
 * @returns {string[]}
 */
function meetHosts(left, right) {
  /** @type {string[]} */
  const out = [];
  for (const a of left) {
    for (const b of right) {
      const kept = hostCovers(a, b) ? b : hostCovers(b, a) ? a : null;
      if (kept !== null && !out.includes(kept)) out.push(kept);
    }
  }
  return out
    .filter((x) => !out.some((y) => y !== x && hostCovers(y, x) && y !== x))
    .sort();
}

/**
 * Meet of two listener declarations.
 *
 * Different ports have no common listener, so the meet is "no listener at all"
 * — expressed as an OMITTED block, which §4 defines as "MUST NOT bind any
 * listener". `{bind: 0}` is not the spelling for absence and never was; that
 * mistake shipped once already (cloister-e81b521).
 *
 * `0.0.0.0` means every interface, so it is top and meets down to the other
 * side. Two distinct concrete addresses are incomparable interfaces, not nested
 * scopes, so they also meet to absent.
 *
 * @param {{bind: number, address?: string}} [left]
 * @param {{bind: number, address?: string}} [right]
 * @returns {{bind: number, address?: string} | undefined}
 */
function meetPort(left, right) {
  if (!left || !right) return undefined;
  if (left.bind !== right.bind) return undefined;
  const a = left.address ?? "127.0.0.1";
  const b = right.address ?? "127.0.0.1";
  const address = a === b ? a : a === "0.0.0.0" ? b : b === "0.0.0.0" ? a : null;
  if (address === null) return undefined;
  return address === "127.0.0.1" ? { bind: left.bind } : { bind: left.bind, address };
}

/**
 * The meet of two confinement documents: componentwise, over five independent
 * dimensions.
 *
 * This is the ONLY operation that produces a confinement document from other
 * confinement documents, and it is decreasing by construction. That is the
 * ratchet: `state = meet(state, restriction)` can narrow and cannot widen,
 * because no widening operation is defined.
 *
 * @param {Confinement} left
 * @param {Confinement} right
 * @returns {Confinement}
 */
export function meet(left, right) {
  if (left.version !== CONFINEMENT_VERSION || right.version !== CONFINEMENT_VERSION) {
    throw new Error(
      `meet is defined on ${CONFINEMENT_VERSION} only; got ` +
      `${JSON.stringify(left.version)} and ${JSON.stringify(right.version)}. ` +
      `Two versions are two contracts, and silently meeting them would produce a ` +
      `document neither runner agreed to.`,
    );
  }

  /** @type {Confinement} */
  const out = { version: CONFINEMENT_VERSION };

  const fs = meetGrants(
    (left.fs?.allow ?? []).map((e) => normalizeEntry(e, ["read"])),
    (right.fs?.allow ?? []).map((e) => normalizeEntry(e, ["read"])),
  );
  if (fs.length > 0) out.fs = { allow: fs.map(renderFsEntry) };

  const hosts = meetHosts(left.network?.allowHosts ?? [], right.network?.allowHosts ?? []);
  if (hosts.length > 0) out.network = { allowHosts: hosts };

  const port = meetPort(left.port, right.port);
  if (port) out.port = port;

  const sockets = meetExactGrants(
    (left.unixSocket?.allow ?? []).map((e) => normalizeEntry(e, ["connect"])),
    (right.unixSocket?.allow ?? []).map((e) => normalizeEntry(e, ["connect"])),
  );
  if (sockets.length > 0) out.unixSocket = { allow: sockets.map(renderSocketEntry) };

  if (left.credentialSource !== undefined && left.credentialSource === right.credentialSource) {
    out.credentialSource = left.credentialSource;
  }

  return out;
}

/**
 * Fold a sequence of restrictions onto an initial document. THE RATCHET.
 *
 * Order-independent and duplicate-insensitive, because meet is associative,
 * commutative and idempotent — which is why enforcement points do not need to
 * agree on an event ORDER, only on an event SET.
 *
 * @param {Confinement} initial
 * @param {readonly Confinement[]} restrictions
 * @returns {Confinement}
 */
export function ratchet(initial, restrictions) {
  return restrictions.reduce(meet, initial);
}

/**
 * Canonical form of a document: its own meet with itself.
 *
 * Normalization is not a separate routine — it is the diagonal of the
 * operation, so it cannot disagree with it.
 *
 * **`normalize(d)` is not byte-identical to `d`.** `meet` sorts grant arrays and
 * drops subsumed entries, and the document `confinementManifest()` emits is
 * neither sorted nor deduped. That is worth stating plainly rather than
 * engineering around, because it is the whole argument in ADR-0068: once
 * confinement is a lattice, two byte-different documents can denote the same
 * grant set, so BYTE EQUALITY IS ALREADY THE WRONG COMPARISON — before any
 * ratchet exists. Normalizing the emitted document instead would change the
 * confinementDigest and invalidate every minted cert, for no gain.
 *
 * @param {Confinement} d
 * @returns {Confinement}
 */
export function normalize(d) {
  return meet(d, d);
}

/**
 * Is `a` at most as permissive as `b`?
 *
 * DEFINED VIA MEET, deliberately: `a ≤ b` exactly when `a ∧ b = a`. A separate
 * comparison routine would be a second opinion on the ordering, free to drift
 * from the operation it describes — the duplication failure mode this repo
 * keeps rediscovering. There is one implementation of the order, and it is
 * `meet`.
 *
 * Compared against `normalize(a)` rather than `a`'s raw bytes, so the relation
 * is reflexive for documents that are not already in canonical form — including
 * every document cloister ships today.
 *
 * @param {Confinement} a
 * @param {Confinement} b
 * @returns {boolean}
 */
export function leq(a, b) {
  return canonicalJson(meet(a, b)) === canonicalJson(normalize(a));
}

/**
 * §7 canonical JSON: keys ASCII-sorted at every level, 2-space indent, no
 * trailing newline, null/undefined omitted.
 *
 * A local, deliberate re-spelling of `src/wire/confinement-digest.ts`'s
 * canonicalizer: that one is TypeScript on the Worker side and reaches BLAKE3
 * through wasm, which this layer must not require to compare two objects. The
 * digest remains that file's to own — nothing here hashes anything, so the two
 * cannot disagree about a digest, only about key order, which
 * `scripts/test/confinement-lattice.test.mjs` pins against it.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  return JSON.stringify(sortKeysDeep(value), null, 2);
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    /** @type {Record<string, unknown>} */
    const out = {};
    const source = /** @type {Record<string, unknown>} */ (value);
    for (const key of Object.keys(source).sort()) {
      const v = source[key];
      if (v === null || v === undefined) continue;
      out[key] = sortKeysDeep(v);
    }
    return out;
  }
  return value;
}
