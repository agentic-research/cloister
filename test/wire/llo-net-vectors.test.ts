/// <reference types="@cloudflare/vitest-pool-workers/types" />
//
// ley-line-open's leyline-net/v1 test vectors, run against cloister's codecs.
//
// LLO owns this wire and pins every vector in two byte forms. Its
// `wire/frames.md`: "Decoders MUST accept both — they are value-equal".
// cloister's own cross-check loaded only the reference form, and three of its
// decoders refused canonical bytes (a Manifest with sequence 0, a ToolCall
// with no arguments, every ToolResult rosary sent) until this ran.
//
// The vectors are vendored from the release cloister pins by
// gen/vendor-llo-net-vectors.mjs, run by gen/vendor-llo-spec.mjs with every
// other LLO spec fixture, and `task llo:bump` re-vendors them.

import { describe, it, expect } from "vitest";

import vendored from "./fixtures/llo-net-vectors.json";
import { decodeManifest, encodeManifest } from "../../src/wire/manifest.js";
import { decodeToolCall, encodeToolCall } from "../../src/wire/tool-call.js";
import { decodeToolResult, encodeToolResult } from "../../src/wire/tool-result.js";

type Form = { sha256: string; base64: string };
const VECTORS = vendored.vectors as Record<string, { reference: Form; canonical: Form }>;

const bytes = (f: Form) => Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/** The codec for a vector, by its name's prefix. */
function codecFor(name: string): { decode: (b: Uint8Array) => unknown; encode: (v: never) => Uint8Array } {
  if (name.startsWith("manifest")) return { decode: decodeManifest, encode: encodeManifest as never };
  if (name.startsWith("tool-call")) return { decode: decodeToolCall, encode: encodeToolCall as never };
  if (name.startsWith("tool-result")) return { decode: decodeToolResult, encode: encodeToolResult as never };
  throw new Error(`no codec for vector "${name}"`);
}

describe("leyline-net/v1 vectors (ley-line-open)", () => {
  const names = Object.keys(VECTORS);

  it("are the full set, from the pinned release", () => {
    expect(names.length).toBeGreaterThanOrEqual(12);
    expect(vendored.version).toMatch(/^v\d+\.\d+\.\d+$/);
    for (const prefix of ["manifest", "tool-call", "tool-result"]) {
      expect(names.some((n) => n.startsWith(prefix)), prefix).toBe(true);
    }
  });

  it("match the digests LLO pins for them", async () => {
    for (const name of names) {
      for (const form of ["reference", "canonical"] as const) {
        const f = VECTORS[name][form];
        expect(hex(await crypto.subtle.digest("SHA-256", bytes(f))), `${form}/${name}`).toBe(f.sha256);
      }
    }
  });

  for (const name of Object.keys(VECTORS)) {
    describe(name, () => {
      const { decode, encode } = codecFor(name);
      const reference = bytes(VECTORS[name].reference);
      const canonical = bytes(VECTORS[name].canonical);

      it("decodes in both forms to the same value", () => {
        expect(decode(canonical)).toEqual(decode(reference));
      });

      it("re-encodes to the reference bytes", () => {
        // cloister's encoders write the reference form: sections at their
        // declared sizes. So encoding what was decoded gives the bytes back.
        expect([...encode(decode(reference) as never)]).toEqual([...reference]);
      });
    });
  }
});
