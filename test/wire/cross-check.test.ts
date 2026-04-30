/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect } from "vitest";
import * as fixtures from "./fixtures/canonical.js";
import {
  decodeManifest,
  encodeManifest,
  MANIFEST_PUBKEY_BYTES,
  MANIFEST_SIG_BYTES,
  MANIFEST_HASH_BYTES,
} from "../../src/wire/manifest.js";
import { decodeToolCall, encodeToolCall } from "../../src/wire/tool-call.js";
import { decodeToolResult, encodeToolResult } from "../../src/wire/tool-result.js";

/**
 * Phase 2D-codec.D — substrate-equivalence proof, Direction 1
 * (capnp CLI produces, our decoder consumes).
 *
 * Each fixture is reference bytes from `capnp eval -b` against
 * wire/cross-check-fixtures.capnp. We decode them with our hand-rolled
 * decoder and assert the values match what the capnp source declared.
 *
 * If our decoder reads the reference encoder's output correctly, we have
 * evidence cloister-companion (Rust, future) using the official `capnp`
 * crate will produce bytes our cloister-side reader handles.
 *
 * Direction 2 (our encode → capnp decode) is a separate Taskfile entry —
 * see `task wire:verify-roundtrip`.
 */

const eq = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

const filled = (len: number, byte: number) => {
  const a = new Uint8Array(len);
  a.fill(byte);
  return a;
};

const enc = (s: string) => new TextEncoder().encode(s);
const hex = (s: string) => {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
};

// ── Manifest ──────────────────────────────────────────────────────────────

describe("substrate equivalence: Manifest (capnp → our decoder)", () => {
  it("decodes manifestCanonical correctly", () => {
    const m = decodeManifest(fixtures.manifestCanonical);
    expect(m.sequence).toBe(42n);
    expect(eq(m.publicKey,   filled(MANIFEST_PUBKEY_BYTES, 0x11))).toBe(true);
    expect(eq(m.signature,   filled(MANIFEST_SIG_BYTES,    0x22))).toBe(true);
    expect(eq(m.contentHash, filled(MANIFEST_HASH_BYTES,   0x33))).toBe(true);
  });

  it("decodes manifestZeroSequence correctly", () => {
    const m = decodeManifest(fixtures.manifestZeroSequence);
    expect(m.sequence).toBe(0n);
    expect(eq(m.publicKey,   filled(MANIFEST_PUBKEY_BYTES, 0x00))).toBe(true);
    expect(eq(m.signature,   filled(MANIFEST_SIG_BYTES,    0x00))).toBe(true);
    expect(eq(m.contentHash, hex("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"))).toBe(true);
  });

  it("our re-encoded Manifest decodes back to the same value (round-trip via reference)", () => {
    // Encoder-equivalence is weaker than byte-equivalence: capnp may lay out
    // payloads differently than us, but BOTH encodings must be valid capnp.
    // The semantic check: our encoder's output can be decoded back to the
    // logical value the capnp reference declared.
    const m = decodeManifest(fixtures.manifestCanonical);
    const reEncoded = encodeManifest(m);
    const reDecoded = decodeManifest(reEncoded);
    expect(reDecoded.sequence).toBe(m.sequence);
    expect(eq(reDecoded.publicKey,   m.publicKey)).toBe(true);
    expect(eq(reDecoded.signature,   m.signature)).toBe(true);
    expect(eq(reDecoded.contentHash, m.contentHash)).toBe(true);
  });
});

// ── ToolCall ──────────────────────────────────────────────────────────────

describe("substrate equivalence: ToolCall (capnp → our decoder)", () => {
  it("decodes toolCallBasic", () => {
    const tc = decodeToolCall(fixtures.toolCallBasic);
    expect(tc.upstreamId).toBe("rosary");
    expect(tc.toolName).toBe("rsry_status");
    expect(eq(tc.argumentsJson, enc("{}"))).toBe(true);
  });

  it("decodes toolCallEmpty (omitted argumentsJson defaults to empty Data)", () => {
    const tc = decodeToolCall(fixtures.toolCallEmpty);
    expect(tc.upstreamId).toBe("");
    expect(tc.toolName).toBe("");
    expect(tc.argumentsJson.length).toBe(0);
  });

  it("decodes toolCallWithArgs (real-world JSON-ish payload)", () => {
    const tc = decodeToolCall(fixtures.toolCallWithArgs);
    expect(tc.upstreamId).toBe("leyline");
    expect(tc.toolName).toBe("lsp_hover");
    // canonical JSON that capnp's hex literal encoded
    expect(new TextDecoder().decode(tc.argumentsJson)).toBe('{"col":5,"file":"/x/foo.rs","line":10}');
  });

  it("our re-encoded ToolCall round-trips through our codec", () => {
    const tc = decodeToolCall(fixtures.toolCallBasic);
    const tc2 = decodeToolCall(encodeToolCall(tc));
    expect(tc2.upstreamId).toBe(tc.upstreamId);
    expect(tc2.toolName).toBe(tc.toolName);
    expect(eq(tc2.argumentsJson, tc.argumentsJson)).toBe(true);
  });
});

// ── ToolResult ────────────────────────────────────────────────────────────

describe("substrate equivalence: ToolResult (capnp → our decoder)", () => {
  it("decodes toolResultEmpty (no content, no error)", () => {
    const tr = decodeToolResult(fixtures.toolResultEmpty);
    expect(tr.content).toEqual([]);
    expect(tr.isError).toBe(false);
  });

  it("decodes toolResultErrorEmpty (no content, isError=true)", () => {
    const tr = decodeToolResult(fixtures.toolResultErrorEmpty);
    expect(tr.content).toEqual([]);
    expect(tr.isError).toBe(true);
  });

  it("decodes toolResultText (single text element)", () => {
    const tr = decodeToolResult(fixtures.toolResultText);
    expect(tr.isError).toBe(false);
    expect(tr.content).toHaveLength(1);
    expect(tr.content[0]).toEqual({ kind: "text", text: "hello world" });
  });

  it("decodes toolResultResource (single resource element)", () => {
    const tr = decodeToolResult(fixtures.toolResultResource);
    expect(tr.content).toHaveLength(1);
    expect(tr.content[0].kind).toBe("resource");
    if (tr.content[0].kind === "resource") {
      expect(eq(tr.content[0].resource, enc("opaque"))).toBe(true);
    }
  });

  it("decodes toolResultBinary (PNG signature + image/png mimeType)", () => {
    const tr = decodeToolResult(fixtures.toolResultBinary);
    expect(tr.content).toHaveLength(1);
    expect(tr.content[0].kind).toBe("binary");
    if (tr.content[0].kind === "binary") {
      expect(eq(tr.content[0].binary.data, hex("89504e47"))).toBe(true);
      expect(tr.content[0].binary.mimeType).toBe("image/png");
    }
  });

  it("decodes toolResultMixed (4 elements, 3 distinct variants, ordering preserved)", () => {
    const tr = decodeToolResult(fixtures.toolResultMixed);
    expect(tr.content).toHaveLength(4);
    expect(tr.content[0]).toEqual({ kind: "text", text: "first" });
    expect(tr.content[1].kind).toBe("binary");
    if (tr.content[1].kind === "binary") {
      expect(eq(tr.content[1].binary.data, hex("010203"))).toBe(true);
      expect(tr.content[1].binary.mimeType).toBe("application/octet-stream");
    }
    expect(tr.content[2].kind).toBe("resource");
    if (tr.content[2].kind === "resource") {
      expect(new TextDecoder().decode(tr.content[2].resource)).toBe("opaque2");
    }
    expect(tr.content[3]).toEqual({ kind: "text", text: "last" });
  });

  it("decodes toolResultErrorWithText (text content + isError=true)", () => {
    const tr = decodeToolResult(fixtures.toolResultErrorWithText);
    expect(tr.isError).toBe(true);
    expect(tr.content).toHaveLength(1);
    expect(tr.content[0]).toEqual({ kind: "text", text: "tool failed: missing 'file' argument" });
  });

  it("our re-encoded ToolResult round-trips through our codec", () => {
    const tr = decodeToolResult(fixtures.toolResultMixed);
    const tr2 = decodeToolResult(encodeToolResult(tr));
    expect(tr2.isError).toBe(tr.isError);
    expect(tr2.content).toHaveLength(tr.content.length);
    for (let i = 0; i < tr.content.length; i++) {
      expect(tr2.content[i].kind).toBe(tr.content[i].kind);
    }
  });
});
