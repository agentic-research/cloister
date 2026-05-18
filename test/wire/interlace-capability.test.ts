// Tests for src/wire/interlace-capability.ts (cloister-c18eb3 Phase 1).
//
// Pure-function unit tests; no DO, no fetch, no MCP server.

import { describe, expect, it } from "vitest";
import {
  RECEIPT_HEADER_NAME,
  detectInterlaceCapability,
  extractReceiptHeader,
} from "../../src/wire/interlace-capability.js";

describe("detectInterlaceCapability", () => {
  it("returns null when input is not an object", () => {
    expect(detectInterlaceCapability(null)).toBeNull();
    expect(detectInterlaceCapability(undefined)).toBeNull();
    expect(detectInterlaceCapability("hello")).toBeNull();
    expect(detectInterlaceCapability(42)).toBeNull();
  });

  it("returns null when capabilities is missing or not an object", () => {
    expect(detectInterlaceCapability({})).toBeNull();
    expect(detectInterlaceCapability({ capabilities: null })).toBeNull();
    expect(detectInterlaceCapability({ capabilities: "no" })).toBeNull();
  });

  it("returns null when interlace block is missing", () => {
    expect(detectInterlaceCapability({ capabilities: {} })).toBeNull();
    expect(detectInterlaceCapability({ capabilities: { other: {} } })).toBeNull();
  });

  it("returns the parsed block when all required fields are present (no prev_epoch)", () => {
    const got = detectInterlaceCapability({
      capabilities: {
        interlace: {
          version:       "0.2.0",
          actor_fp:      "fp-b64u-abc",
          current_epoch: 3,
        },
      },
    });
    expect(got).toEqual({
      version:       "0.2.0",
      actor_fp:      "fp-b64u-abc",
      current_epoch: 3,
    });
  });

  it("returns the parsed block with prev_epoch when present", () => {
    const got = detectInterlaceCapability({
      capabilities: {
        interlace: {
          version:       "0.2.0",
          actor_fp:      "fp-b64u-abc",
          current_epoch: 3,
          prev_epoch:    2,
        },
      },
    });
    expect(got?.prev_epoch).toBe(2);
  });

  it("omits prev_epoch when null is supplied (matches well-known 'omit-when-null' convention)", () => {
    const got = detectInterlaceCapability({
      capabilities: {
        interlace: {
          version:       "0.2.0",
          actor_fp:      "fp-b64u-abc",
          current_epoch: 3,
          prev_epoch:    null,
        },
      },
    });
    expect(got).not.toHaveProperty("prev_epoch");
    expect(got?.current_epoch).toBe(3);
  });

  it("degrades to no-prev_epoch when prev_epoch is malformed", () => {
    const got = detectInterlaceCapability({
      capabilities: {
        interlace: {
          version:       "0.2.0",
          actor_fp:      "fp-b64u-abc",
          current_epoch: 3,
          prev_epoch:    "not-a-number",
        },
      },
    });
    expect(got).not.toHaveProperty("prev_epoch");
  });

  it("returns null when version is missing or non-string", () => {
    expect(detectInterlaceCapability({
      capabilities: { interlace: { actor_fp: "fp", current_epoch: 1 } },
    })).toBeNull();
    expect(detectInterlaceCapability({
      capabilities: { interlace: { version: 0.2, actor_fp: "fp", current_epoch: 1 } },
    })).toBeNull();
    expect(detectInterlaceCapability({
      capabilities: { interlace: { version: "", actor_fp: "fp", current_epoch: 1 } },
    })).toBeNull();
  });

  it("returns null when actor_fp is missing, non-string, or empty", () => {
    expect(detectInterlaceCapability({
      capabilities: { interlace: { version: "0.2.0", current_epoch: 1 } },
    })).toBeNull();
    expect(detectInterlaceCapability({
      capabilities: { interlace: { version: "0.2.0", actor_fp: 42, current_epoch: 1 } },
    })).toBeNull();
    expect(detectInterlaceCapability({
      capabilities: { interlace: { version: "0.2.0", actor_fp: "", current_epoch: 1 } },
    })).toBeNull();
  });

  it("returns null when current_epoch is missing, non-integer, or negative", () => {
    expect(detectInterlaceCapability({
      capabilities: { interlace: { version: "0.2.0", actor_fp: "fp" } },
    })).toBeNull();
    expect(detectInterlaceCapability({
      capabilities: { interlace: { version: "0.2.0", actor_fp: "fp", current_epoch: 1.5 } },
    })).toBeNull();
    expect(detectInterlaceCapability({
      capabilities: { interlace: { version: "0.2.0", actor_fp: "fp", current_epoch: -1 } },
    })).toBeNull();
    expect(detectInterlaceCapability({
      capabilities: { interlace: { version: "0.2.0", actor_fp: "fp", current_epoch: "1" } },
    })).toBeNull();
  });

  it("ignores unknown extra fields in the interlace block (forward-compat)", () => {
    const got = detectInterlaceCapability({
      capabilities: {
        interlace: {
          version:       "0.2.0",
          actor_fp:      "fp",
          current_epoch: 1,
          future_field:  { whatever: true },
        },
      },
    });
    expect(got?.current_epoch).toBe(1);
  });
});

describe("extractReceiptHeader", () => {
  it("returns null when header is absent", () => {
    const h = new Headers({ "content-type": "application/json" });
    expect(extractReceiptHeader(h)).toBeNull();
  });

  it("returns the value when header is present (canonical lowercase)", () => {
    const h = new Headers({ "interlace-receipt": "envelope-b64u-bytes" });
    expect(extractReceiptHeader(h)).toBe("envelope-b64u-bytes");
  });

  it("is case-insensitive on the header name (Headers API contract)", () => {
    const h = new Headers({ "Interlace-Receipt": "envelope-b64u-bytes" });
    expect(extractReceiptHeader(h)).toBe("envelope-b64u-bytes");
    const h2 = new Headers({ "INTERLACE-RECEIPT": "envelope-b64u-bytes" });
    expect(extractReceiptHeader(h2)).toBe("envelope-b64u-bytes");
  });

  it("trims surrounding whitespace", () => {
    const h = new Headers({ "interlace-receipt": "  envelope-b64u-bytes  " });
    expect(extractReceiptHeader(h)).toBe("envelope-b64u-bytes");
  });

  it("returns null when header value is empty or whitespace-only", () => {
    const h1 = new Headers({ "interlace-receipt": "" });
    expect(extractReceiptHeader(h1)).toBeNull();
    const h2 = new Headers({ "interlace-receipt": "   " });
    expect(extractReceiptHeader(h2)).toBeNull();
  });

  it("RECEIPT_HEADER_NAME is the canonical lowercase name", () => {
    expect(RECEIPT_HEADER_NAME).toBe("interlace-receipt");
  });
});
