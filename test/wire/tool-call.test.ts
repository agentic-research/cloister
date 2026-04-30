/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect } from "vitest";
import { encodeToolCall, decodeToolCall, type ToolCall } from "../../src/wire/tool-call.js";

const enc = (s: string) => new TextEncoder().encode(s);
const eq  = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

const fixture = (overrides: Partial<ToolCall> = {}): ToolCall => ({
  upstreamId:    "rosary",
  toolName:      "rsry_decompose",
  argumentsJson: enc('{"path":"/tmp/x.md","commit":false}'),
  ...overrides,
});

// ── Round-trip ────────────────────────────────────────────────────────────

describe("ToolCall wire codec — round-trip", () => {
  it("encode → decode is lossless for the canonical fixture", () => {
    const tc = fixture();
    const r = decodeToolCall(encodeToolCall(tc));
    expect(r.upstreamId).toBe(tc.upstreamId);
    expect(r.toolName).toBe(tc.toolName);
    expect(eq(r.argumentsJson, tc.argumentsJson)).toBe(true);
  });

  it("preserves empty strings (Text count = 1, just NUL)", () => {
    const tc = fixture({ upstreamId: "", toolName: "" });
    const r = decodeToolCall(encodeToolCall(tc));
    expect(r.upstreamId).toBe("");
    expect(r.toolName).toBe("");
  });

  it("preserves empty argumentsJson (Data count = 0)", () => {
    const tc = fixture({ argumentsJson: new Uint8Array(0) });
    const r = decodeToolCall(encodeToolCall(tc));
    expect(r.argumentsJson.length).toBe(0);
  });

  it("preserves multi-byte UTF-8 (emoji, accents, CJK)", () => {
    const tc = fixture({
      upstreamId: "café",
      toolName:   "tool_😀_漢字",
    });
    const r = decodeToolCall(encodeToolCall(tc));
    expect(r.upstreamId).toBe("café");
    expect(r.toolName).toBe("tool_😀_漢字");
  });

  it("preserves long strings (multi-word payloads)", () => {
    const long = "x".repeat(1000);
    const tc = fixture({ toolName: long });
    expect(decodeToolCall(encodeToolCall(tc)).toolName).toBe(long);
  });

  it("preserves arbitrary binary in argumentsJson (not just JSON)", () => {
    const bin = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bin[i] = i;
    const r = decodeToolCall(encodeToolCall(fixture({ argumentsJson: bin })));
    expect(eq(r.argumentsJson, bin)).toBe(true);
  });
});

// ── Wire format ───────────────────────────────────────────────────────────

describe("ToolCall wire codec — format", () => {
  it("output is 8-byte aligned", () => {
    expect(encodeToolCall(fixture()).length % 8).toBe(0);
  });

  it("single-segment header (count-1=0, variable segWords)", () => {
    const bytes = encodeToolCall(fixture());
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(dv.getUint32(0, true)).toBe(0);            // count - 1
    const segWords = dv.getUint32(4, true);
    expect(8 + segWords * 8).toBe(bytes.length);      // header + segment
  });

  it("Text with empty string encodes 1-byte payload (NUL terminator)", () => {
    // Empty + empty + empty Data → minimal payload (segWords = 4 root header
    // + 1 word of NUL-padded Text "" + 0 words of Data = 5 segWords).
    const bytes = encodeToolCall(fixture({ upstreamId: "", toolName: "", argumentsJson: new Uint8Array(0) }));
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const segWords = dv.getUint32(4, true);
    // Layout: rootPtr(1) + p0(1) + p1(1) + p2(1) + Text""(1) + Text""(1) + Data(0) = 6
    // (Two 1-byte payloads round to 1 word each. Empty Data list = 0 words.)
    expect(segWords).toBe(6);
  });
});

// ── Decode robustness ─────────────────────────────────────────────────────

describe("ToolCall wire codec — decode robustness", () => {
  it("rejects messages shorter than segment header", () => {
    expect(() => decodeToolCall(new Uint8Array(4))).toThrow(/segment/);
  });

  it("rejects multi-segment messages", () => {
    const bytes = new Uint8Array(16);
    new DataView(bytes.buffer).setUint32(0, 1, true);
    expect(() => decodeToolCall(bytes)).toThrow(/single-segment/);
  });

  it("rejects struct with too few pointer words", () => {
    // Forge: segWords=1, root pointer with 0d/0p.
    const bytes = new Uint8Array(16);
    new DataView(bytes.buffer).setUint32(4, 1, true);
    // root pointer (bytes 8..15) all zero → kind=0, offset=0, 0d/0p
    expect(() => decodeToolCall(bytes)).toThrow(/ToolCall struct too small/);
  });

  it("rejects Text without NUL terminator", () => {
    // Build a malformed message manually: a ToolCall whose upstreamId Text
    // has count=3 but bytes are "abc" (no NUL).
    // Easier: encode a real ToolCall, then corrupt the last byte of the
    // upstreamId payload (which should be NUL).
    const bytes = encodeToolCall(fixture({ upstreamId: "abc", toolName: "x", argumentsJson: new Uint8Array(0) }));
    // Find the upstreamId payload byte. Layout:
    //   root_ptr (W0=8..15), p0=16..23, p1=24..31, p2=32..39
    //   then upstreamId at byte 40, padded; "abc\0" → bytes 40..43, padded to 48
    // Corrupt byte 43 (the NUL).
    const corrupted = new Uint8Array(bytes);
    corrupted[43] = 0xFF;
    expect(() => decodeToolCall(corrupted)).toThrow(/NUL terminator/);
  });

  it("rejects invalid UTF-8 in Text fields (fatal decode)", () => {
    // Payload like [0xC3, 0x28, 0x00] is invalid UTF-8 (incomplete sequence).
    // Build it: encode a valid ToolCall then overwrite the upstreamId payload.
    const bytes = encodeToolCall(fixture({ upstreamId: "abc", toolName: "x", argumentsJson: new Uint8Array(0) }));
    const corrupted = new Uint8Array(bytes);
    // upstreamId payload at byte 40, count was 4 ("abc\0"). Replace bytes 40..42.
    corrupted[40] = 0xC3; corrupted[41] = 0x28; corrupted[42] = 0x00;
    // count is still 4 → text is "0xC3 0x28 0x00" + final NUL at byte 43.
    expect(() => decodeToolCall(corrupted)).toThrow();
  });
});
