// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ADR-0065 decision 3 says confidence is DERIVED, never declared. That is only
// a real property if the derivation refuses to be generous — so these are
// written around the cases where being generous would be tempting:
// absent origin, partially-vouched origin, and a caller vouching for itself.

import { describe, expect, it } from "vitest";
import {
  CLOISTER_AUTHORITY,
  declaredOrigin,
  deriveConfidence,
  mayAttestFully,
  parseOrigins,
  peerOrigin,
  serializeOrigins,
  unionOrigins,
  unvouchedOrigin,
} from "../../src/wire/origin.js";

const PEER = "sha256:" + "a".repeat(64);
const TRUSTED = new Set([CLOISTER_AUTHORITY]);

describe("deriveConfidence", () => {
  it("an absent origin set is origin-unknown, never something stronger", () => {
    // The fail-closed half. A caller that declares NO origin must not thereby
    // obtain a better answer than one that honestly declared an unvouched
    // source — otherwise the incentive is to say nothing.
    expect(deriveConfidence([], TRUSTED)).toBe("origin-unknown");
    expect(mayAttestFully(deriveConfidence([], TRUSTED))).toBe(false);
  });

  it("cloister's own peer origin is attested — it is the one thing cloister verified", () => {
    expect(deriveConfidence([peerOrigin(PEER)], TRUSTED)).toBe("origin-attested");
  });

  it("a caller-declared upstream source is origin-asserted, not origin-attested", () => {
    // The central honesty property. cloister cannot check whether a peer's
    // claim about where content came from is true, so the peer is accountable
    // for the claim and cloister only for identifying the peer. If this ever
    // returns "origin-attested", cloister is vouching for something it never verified.
    const origins = unionOrigins([declaredOrigin("https://example.com/README", PEER)]);
    expect(deriveConfidence(origins, TRUSTED)).toBe("origin-asserted");
    expect(mayAttestFully(deriveConfidence(origins, TRUSTED))).toBe(false);
  });

  it("ONE unvouched source demotes the whole set — every, not some", () => {
    // Content derives from all of its sources, so "some of this is trustworthy"
    // is not a property a consumer can act on. Mixing a verified peer origin
    // with an unvouched fetch must not launder the fetch.
    const mixed = unionOrigins([peerOrigin(PEER)], [unvouchedOrigin("https://evil.example/x")]);
    expect(mixed).toHaveLength(2);
    expect(deriveConfidence(mixed, TRUSTED)).toBe("origin-asserted");
  });

  it("a peer cannot promote itself by vouching for its own claim", () => {
    // `declaredOrigin` attributes to `interlace:peer/<fp>`, which is not in the
    // evaluator's trust set. Were peers auto-trusted, any authenticated caller
    // could mint full confidence for arbitrary content — the escalation this
    // whole vocabulary exists to prevent.
    const selfVouched = unionOrigins([declaredOrigin("https://example.com/a", PEER)]);
    expect(selfVouched[0]?.vouchedBy).toBe(`interlace:peer/${PEER}`);
    expect(TRUSTED.has(selfVouched[0]?.vouchedBy ?? "")).toBe(false);
    expect(deriveConfidence(selfVouched, TRUSTED)).toBe("origin-asserted");
  });

  it("is relative to the EVALUATOR's trust set, not a module constant", () => {
    // Decision 2 paying off: the same origin set yields different answers for
    // different evaluators. A boolean baked in at ingest could not express this,
    // which is why the entry names an authority instead.
    const origins = unionOrigins([declaredOrigin("https://example.com/a", PEER)]);
    const federatedPeerTrustsIt = new Set([`interlace:peer/${PEER}`]);
    expect(deriveConfidence(origins, TRUSTED)).toBe("origin-asserted");
    expect(deriveConfidence(origins, federatedPeerTrustsIt)).toBe("origin-attested");
  });

  it("an empty trust set attests nothing — fail-closed like an empty authority", () => {
    expect(deriveConfidence([peerOrigin(PEER)], new Set())).toBe("origin-asserted");
  });
});

describe("unionOrigins", () => {
  it("is canonical — equal sets serialize to equal bytes regardless of order", () => {
    const a = unionOrigins([peerOrigin(PEER)], [unvouchedOrigin("https://b.example/")]);
    const b = unionOrigins([unvouchedOrigin("https://b.example/")], [peerOrigin(PEER)]);
    expect(serializeOrigins(a)).toBe(serializeOrigins(b));
  });

  it("dedups by the PAIR — one uri vouched by two authorities is two facts", () => {
    const merged = unionOrigins(
      [declaredOrigin("https://example.com/x", PEER)],
      [unvouchedOrigin("https://example.com/x")],
    );
    expect(merged).toHaveLength(2);
    // …while the identical pair collapses.
    expect(unionOrigins([peerOrigin(PEER)], [peerOrigin(PEER)])).toHaveLength(1);
  });

  it("unioning with an empty set is the identity — a stage with no new sources adds none", () => {
    const base = unionOrigins([peerOrigin(PEER)]);
    expect(serializeOrigins(unionOrigins(base, []))).toBe(serializeOrigins(base));
  });
});

describe("parseOrigins", () => {
  it("round-trips", () => {
    const origins = unionOrigins([peerOrigin(PEER)], [declaredOrigin("https://x.example/", PEER)]);
    expect(parseOrigins(serializeOrigins(origins))).toEqual(origins);
  });

  it("absent and malformed both read as origin-unknown, never as vouched", () => {
    // The one unacceptable reading per ADR-0065: absence must not be readable
    // as vouched. Rows written before this ADR make no provenance claim, and
    // "origin-unknown" is exactly that — so these must not throw either, or old rows
    // become unreadable.
    for (const raw of [null, undefined, "", "not json", "{}", "[1,2,3]"]) {
      const parsed = parseOrigins(raw);
      expect(parsed).toEqual([]);
      expect(deriveConfidence(parsed, TRUSTED)).toBe("origin-unknown");
    }
  });

  it("drops entries that are not well-formed rather than trusting a partial one", () => {
    const raw = JSON.stringify([
      { uri: "https://good.example/", vouchedBy: CLOISTER_AUTHORITY },
      { uri: 42, vouchedBy: CLOISTER_AUTHORITY },
      { vouchedBy: CLOISTER_AUTHORITY },
      { uri: "https://nov.example/" },
    ]);
    expect(parseOrigins(raw)).toEqual([
      { uri: "https://good.example/", vouchedBy: CLOISTER_AUTHORITY },
    ]);
  });
});
