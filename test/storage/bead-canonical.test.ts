/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it } from "vitest";
import {
  BEAD_CANONICAL_VERSION,
  beadCanonicalBytesV1,
  beadCanonicalDigestV1,
} from "../../src/storage/bead-canonical.js";
import type { Bead } from "../../src/types.js";

// ── Fixture ──────────────────────────────────────────────────────────────

function fixtureBead(overrides: Partial<Bead> = {}): Bead {
  return {
    id:          "cloister-test01",
    title:       "test bead",
    description: "fixture for canonical-bytes tests",
    state:       "open",
    priority:    2,
    labels:      ["x", "y", "z"],
    created_at:  "2026-05-09T20:00:00Z",
    updated_at:  "2026-05-09T20:00:00Z",
    repo:        "cloister",
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("beadCanonicalBytesV1", () => {
  it("includes a v:1 preamble + bead type tag", () => {
    const bytes = beadCanonicalBytesV1(fixtureBead());
    const text  = new TextDecoder().decode(bytes);
    expect(text).toContain('"v":1');
    expect(text).toContain('"type":"bead"');
    expect(BEAD_CANONICAL_VERSION).toBe(1);
  });

  it("is byte-stable: same input -> same bytes (idempotent encoding)", () => {
    const a = beadCanonicalBytesV1(fixtureBead());
    const b = beadCanonicalBytesV1(fixtureBead());
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("is byte-stable across struct-key insertion order (canonical sorts keys)", () => {
    // Build the struct with keys in a different runtime order; the encoder
    // sorts internally so the bytes shouldn't depend on this.
    const reordered: Bead = {
      repo:        "cloister",
      labels:      ["x", "y", "z"],
      updated_at:  "2026-05-09T20:00:00Z",
      created_at:  "2026-05-09T20:00:00Z",
      priority:    2,
      state:       "open",
      description: "fixture for canonical-bytes tests",
      title:       "test bead",
      id:          "cloister-test01",
    };
    const a = beadCanonicalBytesV1(fixtureBead());
    const b = beadCanonicalBytesV1(reordered);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("normalizes label order — labels are a set, not a list", () => {
    const a = beadCanonicalBytesV1(fixtureBead({ labels: ["x", "y", "z"] }));
    const b = beadCanonicalBytesV1(fixtureBead({ labels: ["z", "y", "x"] }));
    const c = beadCanonicalBytesV1(fixtureBead({ labels: ["y", "x", "z"] }));
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(a)).toEqual(Array.from(c));
  });

  it("normalizes optional fields (undefined -> null)", () => {
    // created_by undefined and created_by null should yield identical bytes.
    const undef = beadCanonicalBytesV1(fixtureBead());  // created_by absent
    const nul   = beadCanonicalBytesV1(fixtureBead({ created_by: undefined }));
    expect(Array.from(undef)).toEqual(Array.from(nul));
    // notes likewise.
    const notesUndef = beadCanonicalBytesV1(fixtureBead());  // notes absent
    const notesNull  = beadCanonicalBytesV1(fixtureBead({ notes: undefined }));
    expect(Array.from(notesUndef)).toEqual(Array.from(notesNull));
  });

  it("changes when ANY field changes (no field is silently dropped)", () => {
    const base = beadCanonicalBytesV1(fixtureBead());
    const baseStr = new TextDecoder().decode(base);

    const variants: Array<[string, () => Uint8Array]> = [
      ["id",          () => beadCanonicalBytesV1(fixtureBead({ id: "cloister-test02" }))],
      ["title",       () => beadCanonicalBytesV1(fixtureBead({ title: "different" }))],
      ["description", () => beadCanonicalBytesV1(fixtureBead({ description: "different" }))],
      ["state",       () => beadCanonicalBytesV1(fixtureBead({ state: "in_progress" }))],
      ["priority",    () => beadCanonicalBytesV1(fixtureBead({ priority: 4 }))],
      ["labels",      () => beadCanonicalBytesV1(fixtureBead({ labels: ["x", "y"] }))],
      ["created_at",  () => beadCanonicalBytesV1(fixtureBead({ created_at: "2026-05-10T00:00:00Z" }))],
      ["updated_at",  () => beadCanonicalBytesV1(fixtureBead({ updated_at: "2026-05-10T00:00:00Z" }))],
      ["created_by",  () => beadCanonicalBytesV1(fixtureBead({ created_by: "alice" }))],
      ["repo",        () => beadCanonicalBytesV1(fixtureBead({ repo: "rosary" }))],
      ["notes",       () => beadCanonicalBytesV1(fixtureBead({ notes: '{"k":1}' }))],
    ];
    for (const [field, fn] of variants) {
      const variant = new TextDecoder().decode(fn());
      expect(variant, `field=${field} should change the digest`).not.toBe(baseStr);
    }
  });

  it("includes updated_at — digest commits to state at write time, not just identity", () => {
    // Two writes of the same bead with different updated_at must produce
    // different digests. ADR-0012 wants attestations to bind the witnessed
    // state, so re-writes are captured as new content.
    const t1 = beadCanonicalBytesV1(fixtureBead({ updated_at: "2026-05-09T20:00:00Z" }));
    const t2 = beadCanonicalBytesV1(fixtureBead({ updated_at: "2026-05-09T20:00:01Z" }));
    expect(Array.from(t1)).not.toEqual(Array.from(t2));
  });
});

describe("beadCanonicalDigestV1", () => {
  it("returns a 64-char lowercase hex digest", async () => {
    const d = await beadCanonicalDigestV1(fixtureBead());
    expect(d).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic: same struct -> same digest, every run", async () => {
    const a = await beadCanonicalDigestV1(fixtureBead());
    const b = await beadCanonicalDigestV1(fixtureBead());
    expect(a).toBe(b);
  });

  it("digest of canonical bytes matches direct sha256 (the contract)", async () => {
    const bytes = beadCanonicalBytesV1(fixtureBead());
    const digest = await beadCanonicalDigestV1(fixtureBead());

    const hashBuf = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
    const hex = Array.from(new Uint8Array(hashBuf))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
    expect(digest).toBe(hex);
  });
});
