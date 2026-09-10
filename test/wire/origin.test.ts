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
  MAX_DECLARED_ORIGINS,
  MAX_ORIGIN_URI_LENGTH,
  OriginBoundsError,
  deriveConfidence,
  fetchedOrigin,
  originsDigest,
  mayAttestFully,
  parseOrigins,
  serializeOrigins,
  unionOrigins,
  unvouchedOrigin,
} from "../../src/wire/origin.js";
import { buildContentOrigins } from "../../src/routes/bead-create-orchestrator.js";

const PEER = "sha256:" + "a".repeat(64);
const TRUSTED = new Set([CLOISTER_AUTHORITY]);

/**
 * An origin cloister itself minted. There is no constructor for this yet — it
 * arrives with phase 2, when the proxy labels what IT fetched, which is the only
 * content fact cloister can actually stand behind. Written inline as a fixture
 * rather than exported from the module, so nothing in `src/` can reach for it
 * before there is a real fetch behind it.
 */
/** Confidence ordering, weakest first — the ranking the incentive depends on. */
const RANK = { "origin-unknown": 0, "origin-asserted": 1, "origin-attested": 2 } as const; // lint-allow-confidence-literal: the ordering itself is the assertion

const cloisterMinted = (uri: string) => ({ uri, vouchedBy: CLOISTER_AUTHORITY });

describe("deriveConfidence", () => {
  it("an absent origin set is origin-unknown, never something stronger", () => {
    // The fail-closed half. A caller that declares NO origin must not thereby
    // obtain a better answer than one that honestly declared an unvouched
    // source — otherwise the incentive is to say nothing.
    expect(deriveConfidence([], TRUSTED)).toBe("origin-unknown");
    expect(mayAttestFully(deriveConfidence([], TRUSTED))).toBe(false);
  });

  it("cloister's own peer origin is attested — it is the one thing cloister verified", () => {
    expect(deriveConfidence([cloisterMinted("https://declared.example/")], TRUSTED)).toBe("origin-attested");
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
    const mixed = unionOrigins([cloisterMinted("https://declared.example/")], [unvouchedOrigin("https://evil.example/x")]);
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
    expect(deriveConfidence([cloisterMinted("https://declared.example/")], new Set())).toBe("origin-asserted");
  });
});

describe("unionOrigins", () => {
  it("is canonical — equal sets serialize to equal bytes regardless of order", () => {
    const a = unionOrigins([cloisterMinted("https://declared.example/")], [unvouchedOrigin("https://b.example/")]);
    const b = unionOrigins([unvouchedOrigin("https://b.example/")], [cloisterMinted("https://declared.example/")]);
    expect(serializeOrigins(a)).toBe(serializeOrigins(b));
  });

  it("dedups by the PAIR — one uri vouched by two authorities is two facts", () => {
    const merged = unionOrigins(
      [declaredOrigin("https://example.com/x", PEER)],
      [unvouchedOrigin("https://example.com/x")],
    );
    expect(merged).toHaveLength(2);
    // …while the identical pair collapses.
    expect(unionOrigins([cloisterMinted("https://declared.example/")], [cloisterMinted("https://declared.example/")])).toHaveLength(1);
  });

  it("unioning with an empty set is the identity — a stage with no new sources adds none", () => {
    const base = unionOrigins([cloisterMinted("https://declared.example/")]);
    expect(serializeOrigins(unionOrigins(base, []))).toBe(serializeOrigins(base));
  });
});

describe("parseOrigins", () => {
  it("round-trips", () => {
    const origins = unionOrigins([cloisterMinted("https://declared.example/")], [declaredOrigin("https://x.example/", PEER)]);
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

// ── the PATH, not just the function ──────────────────────────────────────
//
// The defect these guard against: `deriveConfidence([], TRUSTED)` was asserted
// to be origin-unknown, correctly, while the orchestrator unioned the submitter
// into every set and so never produced an empty one. The function was tested and
// the path was not, so silence derived origin-attested in production while the
// suite stayed green. These drive the real composition.

describe("buildContentOrigins — the bead_create path", () => {
  it("silence derives origin-unknown, NOT attested — the inverted incentive", () => {
    const origins = buildContentOrigins({ title: "t" }, PEER);
    expect(origins).toEqual([]);
    expect(deriveConfidence(origins, TRUSTED)).toBe("origin-unknown");
  });

  it("honesty ranks ABOVE silence — declaring an untrusted source is rewarded", () => {
    const silent = deriveConfidence(buildContentOrigins({}, PEER), TRUSTED);
    const honest = deriveConfidence(
      buildContentOrigins({ origins: ["https://evil.example/x"] }, PEER),
      TRUSTED,
    );
    expect(silent).toBe("origin-unknown");
    expect(honest).toBe("origin-asserted");
    // The ordering IS the property. If these are ever equal, or inverted, a
    // caller is better off saying nothing and the vocabulary is decorative.
    expect(RANK[honest]).toBeGreaterThan(RANK[silent]);
  });

  it("no declaration can reach origin-attested on this path", () => {
    // A caller cannot vouch itself into full confidence, however much it
    // declares. Reaching attested requires an origin cloister minted from its
    // own fetch — phase 2 — and until then this path tops out at asserted.
    for (const args of [
      { origins: ["https://a.example/"] },
      { origins: ["https://a.example/", "https://b.example/"] },
      { origins: [`interlace:peer/${PEER}`] },
    ]) {
      const c = deriveConfidence(buildContentOrigins(args, PEER), TRUSTED);
      expect(c).not.toBe("origin-attested");
      expect(mayAttestFully(c)).toBe(false);
    }
  });

  it("ignores malformed declarations rather than trusting them", () => {
    const origins = buildContentOrigins({ origins: ["", 42, null, "https://ok.example/"] }, PEER);
    expect(origins).toHaveLength(1);
    expect(origins[0]?.uri).toBe("https://ok.example/");
  });
});

// ── phase 2: ingress (ADR-0065, threat model §21) ────────────────────────

describe("fetchedOrigin — what cloister may vouch for at ingress", () => {
  it("is cloister-vouched, so a fetched endpoint CAN reach origin-attested", () => {
    // The first thing on any path that legitimately can. Phase 1 topped out at
    // origin-asserted precisely because nothing cloister observed was in play.
    expect(deriveConfidence([fetchedOrigin("http://localhost:8384/mcp")], TRUSTED))
      .toBe("origin-attested");
  });

  it("does NOT launder a caller declaration sitting beside it", () => {
    // §21.1, the channel-vs-content error one level up from phase 1's. A
    // cloister-observed channel must not attest sources cloister never saw.
    const mixed = unionOrigins(
      [fetchedOrigin("http://localhost:8384/mcp")],
      [declaredOrigin("https://evil.example/x", PEER)],
    );
    expect(deriveConfidence(mixed, TRUSTED)).toBe("origin-asserted");
  });
});

describe("§21.5 — declared origins are bounded, and REFUSED not truncated", () => {
  it("refuses an over-long declaration rather than keeping the first N", () => {
    // Truncating would record a claim NARROWER than the one made — a set that
    // reads complete while missing sources, which is the failure mode the whole
    // vocabulary exists to prevent.
    const many = Array.from({ length: MAX_DECLARED_ORIGINS + 1 }, (_, i) => `https://e.example/${i}`);
    expect(() => buildContentOrigins({ origins: many }, PEER)).toThrow(OriginBoundsError);
  });

  it("counts BEFORE filtering, so malformed padding cannot hide the size", () => {
    const padded = Array.from({ length: MAX_DECLARED_ORIGINS + 1 }, () => null);
    expect(() => buildContentOrigins({ origins: padded }, PEER)).toThrow(OriginBoundsError);
  });

  it("refuses an over-long single URI", () => {
    const long = "https://e.example/" + "a".repeat(MAX_ORIGIN_URI_LENGTH);
    expect(() => buildContentOrigins({ origins: [long] }, PEER)).toThrow(OriginBoundsError);
  });

  it("accepts a declaration at exactly the cap — the bound is not off by one", () => {
    const atCap = Array.from({ length: MAX_DECLARED_ORIGINS }, (_, i) => `https://e.example/${i}`);
    expect(buildContentOrigins({ origins: atCap }, PEER)).toHaveLength(MAX_DECLARED_ORIGINS);
  });
});

// ── phase 2b: consumption ─────────────────────────────────────────────────

describe("originsDigest — commit publicly, disclose under scope (§21.3)", () => {
  it("returns null for an empty set, so the receipt omits the field entirely", async () => {
    // This is what keeps a no-origins receipt byte-identical to a pre-ADR-0065
    // one, and therefore what stops absent from reading as vouched: there is
    // nothing on the wire to misread.
    expect(await originsDigest([])).toBeNull();
  });

  it("is 32 bytes and stable across equal sets built in different orders", async () => {
    const a = unionOrigins([fetchedOrigin("https://a.example/")], [unvouchedOrigin("https://b.example/")]);
    const b = unionOrigins([unvouchedOrigin("https://b.example/")], [fetchedOrigin("https://a.example/")]);
    const da = await originsDigest(a);
    const db = await originsDigest(b);
    expect(da).toHaveLength(32);
    expect(Array.from(da!)).toEqual(Array.from(db!));
  });

  it("distinguishes sets that differ only by vouching authority", async () => {
    // The digest must bind WHO vouched, not just which URIs appeared —
    // otherwise a caller-declared source and a cloister-fetched one commit to
    // the same value and the receipt cannot tell them apart.
    const declared = await originsDigest([declaredOrigin("https://x.example/", PEER)]);
    const fetched  = await originsDigest([fetchedOrigin("https://x.example/")]);
    expect(Array.from(declared!)).not.toEqual(Array.from(fetched!));
  });

  it("does not leak the URIs — the digest is the commitment", async () => {
    // §21.3 in one assertion: a receipt rides a response header, so the source
    // URI must not be recoverable from what it carries.
    const secret = "https://internal.example/very-specific-path";
    const digest = await originsDigest([fetchedOrigin(secret)]);
    const asText = new TextDecoder().decode(digest!);
    expect(asText).not.toContain("internal.example");
    expect(asText).not.toContain("very-specific-path");
  });
});
