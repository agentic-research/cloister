/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect } from "vitest";
import {
  encodeToolResult,
  decodeToolResult,
  type ToolResult,
  type Content,
} from "../../src/wire/tool-result.js";

const enc = (s: string) => new TextEncoder().encode(s);
const eq  = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

const text     = (s: string): Content => ({ kind: "text", text: s });
const resource = (b: Uint8Array): Content => ({ kind: "resource", resource: b });
const binary   = (data: Uint8Array, mimeType: string): Content =>
  ({ kind: "binary", binary: { data, mimeType } });

function rt(tr: ToolResult): ToolResult {
  return decodeToolResult(encodeToolResult(tr));
}

// ── Empty + Bool ──────────────────────────────────────────────────────────

describe("ToolResult — empty content + isError", () => {
  it("round-trips empty content with isError=false", () => {
    const r = rt({ content: [], isError: false });
    expect(r.content).toEqual([]);
    expect(r.isError).toBe(false);
  });

  it("round-trips empty content with isError=true", () => {
    const r = rt({ content: [], isError: true });
    expect(r.content).toEqual([]);
    expect(r.isError).toBe(true);
  });

  it("encodes isError as a single bit (byte 0 of data section)", () => {
    // Layout: header(8) + root_ptr(8) + data(8) + list_ptr(8) + tag(8) = 40 bytes for empty list.
    // Data section is at byte 16; isError is bit 0 of byte 16.
    const bytes = encodeToolResult({ content: [], isError: true });
    expect(bytes[16] & 1).toBe(1);
    const bytesF = encodeToolResult({ content: [], isError: false });
    expect(bytesF[16] & 1).toBe(0);
  });
});

// ── Single-variant elements ───────────────────────────────────────────────

describe("ToolResult — text variant", () => {
  it("round-trips a single text content", () => {
    const tr: ToolResult = { content: [text("hello world")], isError: false };
    const r = rt(tr);
    expect(r.content).toHaveLength(1);
    expect(r.content[0]).toEqual(text("hello world"));
  });

  it("round-trips empty text", () => {
    expect(rt({ content: [text("")], isError: false }).content[0]).toEqual(text(""));
  });

  it("preserves multi-byte UTF-8 in text", () => {
    expect(rt({ content: [text("café 漢字 😀")], isError: false }).content[0]).toEqual(
      text("café 漢字 😀"),
    );
  });
});

describe("ToolResult — resource variant", () => {
  it("round-trips a single resource content", () => {
    const bytes = enc('{"uri":"file:///x","text":"opaque"}');
    const r = rt({ content: [resource(bytes)], isError: false });
    expect(r.content[0].kind).toBe("resource");
    if (r.content[0].kind === "resource") {
      expect(eq(r.content[0].resource, bytes)).toBe(true);
    }
  });

  it("round-trips empty resource (zero-byte payload)", () => {
    const r = rt({ content: [resource(new Uint8Array(0))], isError: false });
    if (r.content[0].kind === "resource") {
      expect(r.content[0].resource.length).toBe(0);
    }
  });
});

describe("ToolResult — binary variant", () => {
  it("round-trips data + mimeType", () => {
    const data = new Uint8Array([0x89, 0x50, 0x4E, 0x47]); // PNG signature
    const r = rt({ content: [binary(data, "image/png")], isError: false });
    expect(r.content[0].kind).toBe("binary");
    if (r.content[0].kind === "binary") {
      expect(eq(r.content[0].binary.data, data)).toBe(true);
      expect(r.content[0].binary.mimeType).toBe("image/png");
    }
  });

  it("round-trips arbitrary binary (all 256 byte values)", () => {
    const data = new Uint8Array(256);
    for (let i = 0; i < 256; i++) data[i] = i;
    const r = rt({ content: [binary(data, "application/octet-stream")], isError: false });
    if (r.content[0].kind === "binary") {
      expect(eq(r.content[0].binary.data, data)).toBe(true);
    }
  });
});

// ── Multiple elements + ordering ──────────────────────────────────────────

describe("ToolResult — mixed and multiple elements", () => {
  it("preserves order across mixed-variant content", () => {
    const tr: ToolResult = {
      content: [
        text("first"),
        binary(new Uint8Array([1, 2, 3]), "application/octet-stream"),
        resource(enc("opaque")),
        text("last"),
      ],
      isError: false,
    };
    const r = rt(tr);
    expect(r.content).toHaveLength(4);
    expect(r.content[0]).toEqual(text("first"));
    expect(r.content[1].kind).toBe("binary");
    expect(r.content[2].kind).toBe("resource");
    expect(r.content[3]).toEqual(text("last"));
  });

  it("preserves isError alongside content", () => {
    const r = rt({ content: [text("err detail")], isError: true });
    expect(r.isError).toBe(true);
    expect(r.content[0]).toEqual(text("err detail"));
  });

  it("handles many elements (10x) without losing any", () => {
    const items: Content[] = [];
    for (let i = 0; i < 10; i++) items.push(text(`item-${i}`));
    const r = rt({ content: items, isError: false });
    expect(r.content).toHaveLength(10);
    for (let i = 0; i < 10; i++) {
      expect(r.content[i]).toEqual(text(`item-${i}`));
    }
  });
});

// ── Wire-format invariants ────────────────────────────────────────────────

describe("ToolResult — format", () => {
  it("output is 8-byte aligned", () => {
    expect(encodeToolResult({ content: [text("x")], isError: false }).length % 8).toBe(0);
  });

  it("empty list still writes a tag word (composite-list invariant)", () => {
    // Header(8) + root(8) + data(8) + list_ptr(8) + tag(8) = 40 bytes.
    const bytes = encodeToolResult({ content: [], isError: false });
    expect(bytes.length).toBe(40);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // Segment header: 4 bytes count-1 + 4 bytes segWords
    expect(dv.getUint32(0, true)).toBe(0);
    expect(dv.getUint32(4, true)).toBe(4);  // root + data + listPtr + tag = 4 words
  });
});

// ── Decode robustness ────────────────────────────────────────────────────

describe("ToolResult — decode robustness", () => {
  it("rejects unknown discriminant", () => {
    // Encode a valid Content[text], then corrupt the discriminant to 99.
    const bytes = encodeToolResult({ content: [text("hi")], isError: false });
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // Layout: header(8) + root(8) + data(8) + listPtr(8) + tag(8) + elemData(8) + elemPtr(8) + textPayload
    // elemDataOff is at byte 40 (header 8 + 4 words = 40).
    dv.setUint16(40, 99, true);
    expect(() => decodeToolResult(bytes)).toThrow(/unknown discriminant/);
  });

  it("rejects non-composite list pointer", () => {
    // Build a corrupted message: replace list_ptr's elementSize with 2 (byte) instead of 7.
    const bytes = encodeToolResult({ content: [], isError: false });
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // listPtrAt is at byte 24 (header 8 + root 8 + data 8 = 24).
    // Replace bytes 24..31. Keep kind=1 (list), offset=0, but elemSize=2.
    dv.setUint32(24, 1, true);              // kind=list, offset=0
    dv.setUint32(28, 2 | (0 << 3), true);   // elemSize=2, count=0
    expect(() => decodeToolResult(bytes)).toThrow(/expected composite/);
  });
});
