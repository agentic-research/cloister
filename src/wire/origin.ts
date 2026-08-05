// SPDX-License-Identifier: AGPL-3.0-or-later
//
// origin — the provenance vocabulary cloister did not have. Per ADR-0065.
//
// Before this module, cloister carried trust labels for EXECUTORS
// (`trustedTier` on a workerd instance, `provenance` on a harness target) and
// none for DATA. Receipts committed to `bodyHash` — which bytes moved — and
// nothing said where the content came from. A body cloister composed and a body
// containing a README fetched from a hostile host hash equally well.
//
// That asymmetry is the trusted-tool-loads-untrusted-input problem: every
// boundary cloister enforces (ADR-0013 slice grants, confinement/v1 default-DENY,
// Inv 1's no-egress rule) bounds what a COMPROMISED tool can reach, and none of
// them says what a CORRECTLY BEHAVING tool was told.
//
// This is APAS L4 ("Verified Inputs") vocabulary. L3 proves the dispatch stayed
// inside its declared boundary and states plainly what it does not prove: that
// the inputs were not poisoned.

/**
 * One source the content derives from, and WHO says so.
 *
 * `vouchedBy` is an authority identifier, deliberately not a `trusted: boolean`
 * — ADR-0065 decision 2. Two reasons, and the second is the load-bearing one:
 *
 *   1. `manifest/cluster.capnp:534` already makes this argument for a sibling
 *      field ("A REASON, not a boolean").
 *   2. Trust is DEPLOYMENT-RELATIVE and the ingest point does not know it. A
 *      host an internal deployment trusts is one a federated peer does not. A
 *      bit computed at fetch time freezes one deployment's answer into bytes
 *      that outlive it and travel to peers who would answer differently.
 *      Naming the authority defers the trust decision to whoever evaluates the
 *      receipt, against THEIR trust set — which is how `resolveLeaseGate`
 *      already treats CA authority.
 */
export interface OriginEntry {
  /** Where the content came from. Opaque to this module — a URI, a peer ref. */
  readonly uri: string;
  /**
   * The authority asserting that `uri` is the source. Empty string means
   * ingested-and-unvouched: nobody stands behind this claim.
   *
   * Unvouched is NOT an error. It is the ordinary case for anything an agent
   * fetched off the open web, and being able to say so precisely — as opposed
   * to saying nothing — is the entire point of the field.
   */
  readonly vouchedBy: string;
}

/** A canonically-ordered, deduplicated set of origins. */
export type OriginSet = readonly OriginEntry[];

/**
 * The authority cloister itself speaks as.
 *
 * cloister vouches for exactly one class of fact: the identity of the peer that
 * submitted content, because `verifyAndUpsertLease` established it — cert chain,
 * epoch, validity window, request signature, scope, replay check. That is a real
 * verification and cloister can stand behind it.
 *
 * It does NOT vouch for anything a caller says about upstream sources. cloister
 * has no way to check whether a peer's claim "this came from example.com" is
 * true. Attributing those to the peer rather than to cloister is what keeps this
 * module from manufacturing the confidence it exists to derive.
 */
export const CLOISTER_AUTHORITY = "cloister/lease-gate";

/**
 * How much a fact's provenance supports it. DERIVED, never declared — ADR-0065
 * decision 3.
 *
 * A confidence someone writes is a claim. A confidence computed from the origin
 * set is a fact. That distinction is the general fix for a defect class this
 * codebase has hit repeatedly: an artifact asserting a property of its own
 * provenance that nothing verified (a cert hardcoding `authMethod: "passkey"`
 * for an invite session; a digest computed faithfully over a document that was
 * never schema-valid). A validation rule can be forgotten at one call site. A
 * derivation has no call site to forget.
 */
export type Confidence =
  /**
   * Every origin is vouched by an authority in the evaluator's trust set.
   *
   * The `origin-` prefix on all three is not decoration: `lint:origin-derivation`
   * enforces that these literals appear only in this module, and a bare
   * "unknown" collides with author fields, error codes and HTTP shapes all over
   * `src/`. An un-prefixed vocabulary made that rail fire seven times, every one
   * a false positive — the same under-catch/over-catch trap `lint:schema-claim`
   * hit when LLO adopted a name cloister already owned.
   */
  | "origin-attested"
  /** Origins exist, but only unvouched or untrusted authorities stand behind them. */
  | "origin-asserted"
  /** No origin set at all — a pre-ADR-0065 write, or a caller that declared none. */
  | "origin-unknown";

/**
 * There is deliberately NO `peerOrigin` / `submitterOrigin` constructor.
 *
 * The first cut of this module had one, and the bead-create orchestrator unioned
 * it into every origin set. The result inverted the incentive the whole design
 * exists to create:
 *
 *   caller declares nothing            -> origin-attested
 *   caller declares an untrusted source -> origin-asserted
 *
 * Silence outranked honesty, and a bead built from a poisoned issue body reached
 * FULL confidence as long as nobody mentioned the issue. The unit test that was
 * supposed to catch this asserted `deriveConfidence([], TRUSTED) === "unknown"`,
 * which was true and irrelevant: the orchestrator never produced an empty set,
 * because it always injected the submitter.
 *
 * The defect is a category error, not an off-by-one. WHO SUBMITTED is a fact
 * about an actor; WHERE CONTENT CAME FROM is a fact about a proposition. Putting
 * them in one set lets an authenticated identity launder into content
 * provenance — which is the self-issued authority claim this vocabulary was
 * written to refuse, reintroduced by the vocabulary itself.
 *
 * The submitter is not missing from the record. It is `peer_fingerprint` and
 * `cert` on the same attestation row, where it always was, indexed by principal
 * because that is what it is.
 */

/**
 * An origin cloister MINTED because cloister performed the fetch (ADR-0065
 * phase 2). The only content fact cloister can stand behind.
 *
 * Asserts exactly this: cloister dialled this endpoint, and the endpoint was
 * named by an operator-declared binding rather than by the caller. The URL comes
 * from `env[urlBinding]` / a service binding, declared on both deployment paths
 * and enforced by `lint:binding-parity`, so a caller cannot steer it (§21.2).
 *
 * It asserts NOTHING about the bytes that came back, and the distinction is the
 * whole reason this constructor is separate from `declaredOrigin`. "cloister
 * dialled E" is a fact about the CHANNEL. If E is itself a proxy — mache serving
 * a file it read, an MCP server relaying a web fetch — then E's content has
 * origins of its own, and vouching for the channel does not vouch for them
 * (§21.1). Where an upstream does not propagate its own set, cloister's set is
 * INCOMPLETE, not wrong, and incompleteness must present as origin-asserted
 * rather than attesting the missing part.
 *
 * This is the same category error phase 1 made one level down, where the
 * SUBMITTER sat in the content set and made silence outrank honesty. The lesson
 * generalises: a fact about how content ARRIVED is not a fact about where it
 * CAME FROM, however trustworthy the arrival.
 */
export function fetchedOrigin(url: string): OriginEntry {
  return { uri: url, vouchedBy: CLOISTER_AUTHORITY };
}

/**
 * Bounds on caller-declared origins (threat model §21.5).
 *
 * Declared origins are caller-controlled input written to DO storage, so an
 * unbounded declaration is a resource attack on the attestation row. Phase 1
 * filtered malformed entries and bounded nothing; the threat-model row that
 * named the gap is landing with the code that closes it rather than after.
 *
 * REFUSED, not truncated. Silently keeping the first N would record a
 * provenance claim narrower than the one the caller made — a set that reads as
 * complete while missing sources, which is the failure this vocabulary exists
 * to prevent. An over-long declaration is a malformed request, and the caller
 * is told so.
 */
export const MAX_DECLARED_ORIGINS = 64;
export const MAX_ORIGIN_URI_LENGTH = 2048;

/** Raised when a declaration exceeds the §21.5 bounds. */
export class OriginBoundsError extends Error {
  override readonly name = "OriginBoundsError";
}

/**
 * An upstream source a CALLER declared, attributed to that caller.
 *
 * Not to cloister: a caller-declared origin is itself untrusted input, and
 * recording it as though cloister had checked it would be exactly the
 * received-not-derived defect this module exists to prevent. The peer is
 * accountable for the claim; cloister is accountable for identifying the peer.
 */
export function declaredOrigin(uri: string, declaringPeerFp: string): OriginEntry {
  return { uri, vouchedBy: `interlace:peer/${declaringPeerFp}` };
}

/** An origin nobody vouches for. Ordinary, and distinct from "no origin at all". */
export function unvouchedOrigin(uri: string): OriginEntry {
  return { uri, vouchedBy: "" };
}

/**
 * Union origin sets, canonically. THE compose operation — ADR-0065 decision 4.
 *
 * Every stage that combines content must union its inputs' sets. A stage that
 * emits content whose origin set is empty when its inputs' were not has dropped
 * provenance, and a dropped origin set is strictly WORSE than an absent one: it
 * reads as verified provenance while being a guess, so a consumer that trusts it
 * ends up worse off than one that knew nothing.
 *
 * Canonical ordering (ASCII by uri, then vouchedBy) because this value is
 * recorded alongside a content digest and compared across implementations —
 * same discipline as confinement/v1 §7 canonical JSON. Dedup is by the PAIR:
 * the same uri vouched by two different authorities is two facts, not one.
 */
export function unionOrigins(...sets: OriginSet[]): OriginSet {
  const seen = new Map<string, OriginEntry>();
  for (const set of sets) {
    for (const entry of set) {
      seen.set(`${entry.uri} ${entry.vouchedBy}`, entry);
    }
  }
  return [...seen.values()].sort(
    (a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : a.vouchedBy < b.vouchedBy ? -1 : a.vouchedBy > b.vouchedBy ? 1 : 0),
  );
}

/**
 * Derive how much the provenance supports the content. The ONLY way to obtain a
 * `Confidence` — there is no constructor, no literal, no override.
 *
 * `trustedAuthorities` is the EVALUATOR's trust set, passed in rather than read
 * from a module constant, because the same origin set must be able to yield
 * different answers for cloister and for a federated peer. That is decision 2
 * paying off: had the entry carried a boolean, this function would have nothing
 * to decide.
 *
 * Fail-closed on the empty set, matching every other authority question in the
 * substrate: `resolveLeaseGate` treats no-authority as enforce-then-fail rather
 * than off (ADR-0053), confinement dimensions are default-DENY with no
 * unrestricted mode, and the capability matchmaker fails the build on an
 * unsatisfied declaration rather than resolving one arbitrarily (ADR-0027).
 * An empty origin set is the same shape as an empty authority.
 */
export function deriveConfidence(
  origins: OriginSet,
  trustedAuthorities: ReadonlySet<string>,
): Confidence {
  if (origins.length === 0) return "origin-unknown";
  // Every entry, not any: one unvouched source is enough to stop the whole
  // fact being attested, because the content derives from all of them. "Some
  // of this is trustworthy" is not a property a consumer can act on.
  return origins.every((o) => o.vouchedBy !== "" && trustedAuthorities.has(o.vouchedBy))
    ? "origin-attested"
    : "origin-asserted";
}

/**
 * May a fact with this provenance be recorded as fully confident?
 *
 * The ADR-0065 decision-3 rule, in one place so it cannot drift between call
 * sites. Only origin-attested qualifies — origin-unknown and origin-asserted are both
 * refused, and refusing origin-unknown is the fail-closed half: a caller that declares no
 * origin must not thereby obtain a stronger claim than one that honestly
 * declared an unvouched source.
 */
export function mayAttestFully(confidence: Confidence): boolean {
  return confidence === "origin-attested";
}

/**
 * Serialize for storage next to a content digest. Canonical: the array is
 * already ordered by `unionOrigins`, and the object keys are emitted in a fixed
 * order rather than whatever insertion produced, so equal sets serialize to
 * equal bytes across implementations.
 */
export function serializeOrigins(origins: OriginSet): string {
  return JSON.stringify(origins.map((o) => ({ uri: o.uri, vouchedBy: o.vouchedBy })));
}

/**
 * Read a stored origin set back.
 *
 * Returns an EMPTY set for absent or malformed input, which then derives
 * `"unknown"` rather than throwing. Deliberate: a row written before ADR-0065
 * makes no provenance claim, and that is exactly what "unknown" means. Throwing
 * would make old rows unreadable; returning something more confident than
 * origin-unknown would let absence read as vouched, which the ADR names as the one
 * unacceptable reading.
 */
export function parseOrigins(raw: string | null | undefined): OriginSet {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    // lint-allow-silent: a malformed origin column is indistinguishable from an
    // absent one for trust purposes — both yield "unknown", the weakest answer.
    // Surfacing it as an error would fail a read whose correct outcome is
    // "this row makes no provenance claim".
    return [];
  }
  if (!Array.isArray(value)) return [];
  const entries: OriginEntry[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const { uri, vouchedBy } = item as Record<string, unknown>;
    if (typeof uri !== "string" || typeof vouchedBy !== "string") continue;
    entries.push({ uri, vouchedBy });
  }
  return unionOrigins(entries);
}

/**
 * SHA-256 over the canonical serialization of an origin set (ADR-0065 phase 2b).
 *
 * A receipt commits to this DIGEST, never to the set itself, and threat model
 * §21.3 is why: a receipt travels to the caller in a response header, so putting
 * source URIs there would publish what an agent read to everyone who sees the
 * response — on the surface where peer existence was already an oracle. The set
 * lives on the attestation row, disclosed under scope; the receipt binds to it
 * without leaking it. Commit publicly, disclose under scope.
 *
 * SHA-256 rather than BLAKE3 because this is an application-layer digest over an
 * application-layer structure, matching `content_hash` and the attestation
 * references — the substrate-digest half (BLAKE3 via leyline-cas-ffi) is for
 * blob identity. Both algorithms are deliberate; see CLAUDE.md.
 *
 * Returns null for an empty set, so a receipt with no provenance claim omits the
 * field entirely and encodes byte-identically to a pre-ADR-0065 receipt. That is
 * what keeps existing verifiers working, and what keeps absent from reading as
 * vouched: there is nothing to misread.
 */
export async function originsDigest(origins: OriginSet): Promise<Uint8Array | null> {
  if (origins.length === 0) return null;
  const bytes = new TextEncoder().encode(serializeOrigins(origins));
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}
