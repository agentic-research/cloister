/**
 * ToolCall wire codec — the request payload (encrypted within the wire frame).
 *
 * Schema source: `wire/cloister.capnp` struct ToolCall. ADR-0005 §"ToolCall".
 *
 * Three pointer fields, zero data words:
 *   - upstreamId    :Text  — companion's logical upstream id
 *   - toolName      :Text  — MCP tool name (e.g. "rsry_decompose")
 *   - argumentsJson :Data  — canonical JSON args, opaque to the wire
 *
 * Capnp `Text` is a NUL-terminated UTF-8 byte list — its on-wire count is
 * `utf8_byte_length + 1`. `Data` is plain List(UInt8) with no terminator.
 * This encoder writes them per spec; the decoder strips the NUL and
 * UTF-8-decodes (with `fatal: true` so invalid UTF-8 throws cleanly).
 *
 * Encoded length is variable (depends on string lengths). Layout:
 *
 *     bytes  0.. 7  : segment table (count-1=0, segWords variable)
 *     bytes  8..15  : root struct pointer (0d/3p, target offset 0)
 *     bytes 16..23  : pointer 0 — list ptr to upstreamId (Text)
 *     bytes 24..31  : pointer 1 — list ptr to toolName (Text)
 *     bytes 32..39  : pointer 2 — list ptr to argumentsJson (Data)
 *     bytes 40..    : payloads, each padded to 8-byte boundary
 */

import { ELEM_BYTE, WORD, WireBuilder, WireReader } from "./codec.js";

// Lazy globals — TextEncoder/TextDecoder allocations are cheap but keep them
// hoisted so we don't recreate per call.
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export interface ToolCall {
  /** Logical upstream id the companion routes by (e.g. "rosary"). */
  upstreamId:    string;
  /** MCP tool name (e.g. "rsry_decompose"). */
  toolName:      string;
  /** Canonical JSON-encoded args; opaque to the wire. */
  argumentsJson: Uint8Array;
}

// ── Encode ────────────────────────────────────────────────────────────────

export function encodeToolCall(tc: ToolCall): Uint8Array {
  const b = new WireBuilder();
  // Root pointer at byte 0; struct starts at byte 8 with 0 data + 3 ptrs.
  const rootPtr = b.reserveWords(1);   //  0
  const p0Off   = b.reserveWords(1);   //  8 — pointer section starts here
  const p1Off   = b.reserveWords(1);   // 16
  const p2Off   = b.reserveWords(1);   // 24

  // Struct pointer: target is the START of the struct's data section, which
  // for a 0-data-word struct is the same as the start of the pointer
  // section (p0Off). Offset from end-of-pointer (byte 8) to p0Off (byte 8) = 0.
  b.writeStructPointer(rootPtr, p0Off, /*data*/ 0, /*ptr*/ 3);

  // Text fields: UTF-8 bytes + 1 trailing NUL byte. Empty string → 1-byte payload.
  const idBytes   = encodeTextWithNul(tc.upstreamId);
  const nameBytes = encodeTextWithNul(tc.toolName);

  const idAt = b.appendBytesPadded(idBytes);
  b.writeListPointer(p0Off, idAt, ELEM_BYTE, idBytes.length);

  const nameAt = b.appendBytesPadded(nameBytes);
  b.writeListPointer(p1Off, nameAt, ELEM_BYTE, nameBytes.length);

  // Data field: no NUL terminator.
  const argsAt = b.appendBytesPadded(tc.argumentsJson);
  b.writeListPointer(p2Off, argsAt, ELEM_BYTE, tc.argumentsJson.length);

  return b.finalize();
}

function encodeTextWithNul(s: string): Uint8Array {
  const utf8 = TEXT_ENCODER.encode(s);
  const out = new Uint8Array(utf8.length + 1);
  out.set(utf8);
  // Last byte is already 0 (zero-initialized) — that's the NUL terminator.
  return out;
}

// ── Decode ────────────────────────────────────────────────────────────────

export function decodeToolCall(bytes: Uint8Array): ToolCall {
  const r = new WireReader(bytes);
  const segStart = r.readSegmentStart();
  const root = r.readStructPointer(segStart);

  if (root.ptrWords < 3) {
    throw new Error(`ToolCall struct too small: ptrWords=${root.ptrWords} (need ≥3)`);
  }

  // Pointer section follows the data section. dataWords may be > 0 if the
  // sender is a future version that added data fields — skip past them.
  const ptrSection = root.target + root.dataWords * WORD;

  // Capnp encodes default-valued pointer fields as null pointers (8 zero
  // bytes). For Text/Data fields, null = empty. Detect the null case
  // BEFORE strict-kind-checking the pointer.
  const idAt   = ptrSection + 0 * WORD;
  const nameAt = ptrSection + 1 * WORD;
  const argsAt = ptrSection + 2 * WORD;

  return {
    upstreamId:    r.isNullPointer(idAt)   ? "" : readText("upstreamId", r, idAt),
    toolName:      r.isNullPointer(nameAt) ? "" : readText("toolName",   r, nameAt),
    argumentsJson: r.isNullPointer(argsAt) ? new Uint8Array(0) : readData("argumentsJson", r, argsAt),
  };
}

function readText(field: string, r: WireReader, at: number): string {
  const ptr = r.readListPointer(at);
  if (ptr.elementSize !== ELEM_BYTE) {
    throw new Error(`ToolCall.${field}: elementSize=${ptr.elementSize}, expected ${ELEM_BYTE}`);
  }
  return decodeTextWithNul(field, r.readBytes(ptr.target, ptr.count));
}

function readData(field: string, r: WireReader, at: number): Uint8Array {
  const ptr = r.readListPointer(at);
  if (ptr.elementSize !== ELEM_BYTE) {
    throw new Error(`ToolCall.${field}: elementSize=${ptr.elementSize}, expected ${ELEM_BYTE}`);
  }
  return r.readBytes(ptr.target, ptr.count);
}

function decodeTextWithNul(field: string, bytes: Uint8Array): string {
  if (bytes.length === 0) {
    throw new Error(`ToolCall.${field}: Text payload empty (must contain at least the NUL terminator)`);
  }
  if (bytes[bytes.length - 1] !== 0) {
    throw new Error(`ToolCall.${field}: Text payload missing NUL terminator`);
  }
  // Strip trailing NUL, then UTF-8 decode (fatal mode: invalid UTF-8 throws).
  return TEXT_DECODER.decode(bytes.subarray(0, bytes.length - 1));
}
