/**
 * ToolResult wire codec — the response payload (encrypted within the wire frame).
 *
 * Schema source: `wire/cloister.capnp` structs ToolResult, Content,
 * BinaryContent. ADR-0005 §"ToolResult".
 *
 *     struct ToolResult { content :List(Content);  isError :Bool; }
 *     struct Content    { body :union { text :Text; binary :BinaryContent; resource :Data; } }
 *     struct BinaryContent { data :Data;  mimeType :Text; }
 *
 * Layout choices:
 *
 *   - ToolResult is 1d/1p (Bool isError in data word, content list pointer).
 *   - Content is 1d/1p — discriminant in data section bits [0..16], the
 *     active variant's pointer/data overlapping pointer slot 0. (Capnp
 *     unions overlap variant storage; the discriminant tells you what to
 *     interpret the slot as.)
 *   - List(Content) uses element size code 7 (composite). The list payload
 *     starts with a TAG WORD describing element shape + count, followed by
 *     `count` × (1 data word + 1 pointer word) elements inline. Each
 *     element's pointer slot may target Data/Text/BinaryContent payloads
 *     appended after the entire list block.
 *   - BinaryContent is 0d/2p (data + mimeType pointers).
 *
 * Discriminant values (must match the ordinal numbers in the capnp schema):
 *
 *     text     @0 → discriminant 0
 *     binary   @1 → discriminant 1
 *     resource @2 → discriminant 2
 */

import { ELEM_BYTE, WORD, WireBuilder, WireReader } from "./codec.js";

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

const ELEM_COMPOSITE = 7;

const DISCRIM_TEXT     = 0;
const DISCRIM_BINARY   = 1;
const DISCRIM_RESOURCE = 2;

// Per-element shape for List(Content): 1 data + 1 ptr = 2 words.
const CONTENT_DATA_WORDS = 1;
const CONTENT_PTR_WORDS  = 1;
const CONTENT_ELEM_WORDS = CONTENT_DATA_WORDS + CONTENT_PTR_WORDS;

// ── Types ─────────────────────────────────────────────────────────────────

export interface BinaryContent {
  data:     Uint8Array;
  mimeType: string;
}

export type Content =
  | { kind: "text";     text: string }
  | { kind: "binary";   binary: BinaryContent }
  | { kind: "resource"; resource: Uint8Array };

export interface ToolResult {
  content: readonly Content[];
  isError: boolean;
}

// ── Encode ────────────────────────────────────────────────────────────────

export function encodeToolResult(tr: ToolResult): Uint8Array {
  const b = new WireBuilder();

  // Root pointer + 1 data word + 1 pointer word
  const rootPtr  = b.reserveWords(1);   //  0
  const dataOff  = b.reserveWords(1);   //  8 — isError bit at bit 0 of byte 0
  const listPtrAt = b.reserveWords(1);  // 16 — pointer to content list

  b.writeStructPointer(rootPtr, dataOff, /*data*/ 1, /*ptr*/ 1);
  b.writeBit(dataOff, 0, tr.isError ? 1 : 0);

  // Reserve composite list with N elements of shape (1d, 1p). Always
  // writes a tag word.
  const count = tr.content.length;
  const tagOff = b.reserveCompositeList(count, CONTENT_DATA_WORDS, CONTENT_PTR_WORDS);

  // The list pointer's count field is the WORD count of all elements
  // (excluding the tag word).
  const elemWordCount = count * CONTENT_ELEM_WORDS;
  b.writeListPointer(listPtrAt, tagOff, ELEM_COMPOSITE, elemWordCount);

  // Encode each element. Element body is at:
  //   tagOff + WORD + i * CONTENT_ELEM_WORDS * WORD
  for (let i = 0; i < count; i++) {
    const elemOff   = tagOff + WORD + i * CONTENT_ELEM_WORDS * WORD;
    const elemDataOff = elemOff;
    const elemPtrOff  = elemOff + CONTENT_DATA_WORDS * WORD;
    encodeContentElement(b, tr.content[i]!, elemDataOff, elemPtrOff);
  }

  return b.finalize();
}

function encodeContentElement(
  b: WireBuilder,
  c: Content,
  elemDataOff: number,
  elemPtrOff: number,
): void {
  switch (c.kind) {
    case "text": {
      b.writeU16(elemDataOff, DISCRIM_TEXT);
      const textBytes = encodeTextWithNul(c.text);
      const at = b.appendBytesPadded(textBytes);
      b.writeListPointer(elemPtrOff, at, ELEM_BYTE, textBytes.length);
      return;
    }
    case "binary": {
      b.writeU16(elemDataOff, DISCRIM_BINARY);
      // BinaryContent: 0d/2p struct.
      // Reserve its pointer section in the buffer; the struct pointer
      // targets the (empty) data section, which equals the start of the
      // pointer section since dataWords=0.
      const bcSection = b.reserveWords(2); // 2 pointer words
      b.writeStructPointer(elemPtrOff, bcSection, /*data*/ 0, /*ptr*/ 2);

      // BinaryContent.data (pointer 0): plain Data list
      const dataAt = b.appendBytesPadded(c.binary.data);
      b.writeListPointer(bcSection + 0 * WORD, dataAt, ELEM_BYTE, c.binary.data.length);

      // BinaryContent.mimeType (pointer 1): NUL-terminated Text
      const mtBytes = encodeTextWithNul(c.binary.mimeType);
      const mtAt = b.appendBytesPadded(mtBytes);
      b.writeListPointer(bcSection + 1 * WORD, mtAt, ELEM_BYTE, mtBytes.length);
      return;
    }
    case "resource": {
      b.writeU16(elemDataOff, DISCRIM_RESOURCE);
      const at = b.appendBytesPadded(c.resource);
      b.writeListPointer(elemPtrOff, at, ELEM_BYTE, c.resource.length);
      return;
    }
  }
}

function encodeTextWithNul(s: string): Uint8Array {
  const utf8 = TEXT_ENCODER.encode(s);
  const out = new Uint8Array(utf8.length + 1);
  out.set(utf8);
  return out; // last byte is 0 (NUL)
}

// ── Decode ────────────────────────────────────────────────────────────────

export function decodeToolResult(bytes: Uint8Array): ToolResult {
  const r = new WireReader(bytes);
  const segStart = r.readSegmentStart();
  const root = r.readStructPointer(segStart);

  if (root.dataWords < 1 || root.ptrWords < 1) {
    throw new Error(`ToolResult struct too small: ${root.dataWords}d/${root.ptrWords}p`);
  }
  const isError = r.readBit(root.target, 0) === 1;

  const ptrSection = root.target + root.dataWords * WORD;
  const listPtr = r.readListPointer(ptrSection);

  if (listPtr.elementSize !== ELEM_COMPOSITE) {
    throw new Error(
      `ToolResult.content list elementSize=${listPtr.elementSize}, expected composite (7)`,
    );
  }

  // listPtr.target points at the tag word.
  const tag = r.readCompositeListTag(listPtr.target);
  // Per spec: list pointer's count is total element words (no tag).
  const expectedWords = tag.count * (tag.dataWords + tag.ptrWords);
  if (listPtr.count !== expectedWords) {
    throw new Error(
      `ToolResult.content list pointer count=${listPtr.count} ≠ tag.count×elemSize=${expectedWords}`,
    );
  }

  const content: Content[] = [];
  for (let i = 0; i < tag.count; i++) {
    const elemOff = listPtr.target + WORD + i * (tag.dataWords + tag.ptrWords) * WORD;
    content.push(decodeContentElement(r, elemOff, tag.dataWords, tag.ptrWords));
  }

  return { content, isError };
}

function decodeContentElement(
  r: WireReader,
  elemOff: number,
  dataWords: number,
  ptrWords: number,
): Content {
  if (dataWords < 1 || ptrWords < 1) {
    throw new Error(`Content element too small: ${dataWords}d/${ptrWords}p (need ≥1d/1p)`);
  }
  const elemDataOff = elemOff;
  const elemPtrOff  = elemOff + dataWords * WORD;
  const discriminant = r.readU16(elemDataOff);

  // Don't read the pointer until we know the variant — text/resource use a
  // list pointer; binary uses a struct pointer. readListPointer would throw
  // on the binary case (kind=0).
  switch (discriminant) {
    case DISCRIM_TEXT: {
      const ptr = r.readListPointer(elemPtrOff);
      if (ptr.elementSize !== ELEM_BYTE) {
        throw new Error(`Content.text expects byte list; got elementSize=${ptr.elementSize}`);
      }
      return { kind: "text", text: decodeTextWithNul(r.readBytes(ptr.target, ptr.count)) };
    }
    case DISCRIM_RESOURCE: {
      const ptr = r.readListPointer(elemPtrOff);
      if (ptr.elementSize !== ELEM_BYTE) {
        throw new Error(`Content.resource expects byte list; got elementSize=${ptr.elementSize}`);
      }
      return { kind: "resource", resource: r.readBytes(ptr.target, ptr.count) };
    }
    case DISCRIM_BINARY: {
      const bc = r.readStructPointer(elemPtrOff);
      if (bc.ptrWords < 2) {
        throw new Error(`BinaryContent struct too small: ${bc.dataWords}d/${bc.ptrWords}p`);
      }
      const bcPtrSection = bc.target + bc.dataWords * WORD;
      const dataPtr = r.readListPointer(bcPtrSection + 0 * WORD);
      const mtPtr   = r.readListPointer(bcPtrSection + 1 * WORD);
      if (dataPtr.elementSize !== ELEM_BYTE) {
        throw new Error(`BinaryContent.data elementSize=${dataPtr.elementSize}`);
      }
      if (mtPtr.elementSize !== ELEM_BYTE) {
        throw new Error(`BinaryContent.mimeType elementSize=${mtPtr.elementSize}`);
      }
      return {
        kind: "binary",
        binary: {
          data:     r.readBytes(dataPtr.target, dataPtr.count),
          mimeType: decodeTextWithNul(r.readBytes(mtPtr.target, mtPtr.count)),
        },
      };
    }
    default:
      throw new Error(`Content: unknown discriminant ${discriminant}`);
  }
}

function decodeTextWithNul(bytes: Uint8Array): string {
  if (bytes.length === 0) {
    throw new Error("Text payload empty (must contain at least the NUL terminator)");
  }
  if (bytes[bytes.length - 1] !== 0) {
    throw new Error("Text payload missing NUL terminator");
  }
  return TEXT_DECODER.decode(bytes.subarray(0, bytes.length - 1));
}
