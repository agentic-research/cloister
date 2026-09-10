// SPDX-License-Identifier: AGPL-3.0-or-later
//
// run-id — run-identity derivation for `cloister/execution/v1` (cloister-c1bd9e).
//
// A run's name is derived from the authority that admitted it, never chosen by
// the caller. That is what makes it useful to a second implementation: a
// consumer holding the same three inputs can compute the name locally and
// address a run WITHOUT waiting for `start` to return. Cloister is such a
// consumer — it calls LLO's execution surface over the `LSP_MCP` binding — so
// it needs this derivation on its own side, not just a field it reads back.
//
// The sibling of confinement-digest.ts: same substrate hash (cas-hash →
// leyline-cas-ffi), same obligation to reproduce LLO's pinned vector
// byte-for-byte. Conformance lives in test/wire/run-id.test.ts, driven by the
// vendored `test-vectors/run-id.json`.
//
// ── Why the preimage is framed, not concatenated ─────────────────────────────
//
// Each field is length-prefixed with a little-endian u64. LLO's vector states
// the reason and pins two cases that hold it apart: a bare concatenation makes
// (grantId "ab", replayKey "c") and (grantId "a", replayKey "bc") produce the
// same bytes, and therefore one run identity for two distinct runs. Those two
// cases are not decoration — an implementation that forgets the framing passes
// the canonical case and fails only there.
//
// The leading domain separator scopes the digest to this derivation so it can
// never collide with another BLAKE3 preimage in the substrate (arena roots,
// blob identity, confinement digests all share the same hash function).
//
// ── What this file is allowed to say ─────────────────────────────────────────
//
// The three constants below restate values cloister does not own. That is the
// thing `lint:schema-claim` exists to prevent, and the exemption is deliberate:
// a runtime derivation cannot read its own domain string out of a test fixture.
// The obligation is discharged in the test, which reads `derivation.domain`,
// `.prefix` and `.hash` FROM the vector and asserts these constants equal them.
// If LLO re-scopes the domain, cloister fails its own suite rather than
// computing confident, wrong names.

import { blake3Hex } from "./cas-hash.js";

/** Domain separator (`derivation.domain`); asserted against the vector. */
export const RUN_ID_DOMAIN = "cloister/execution/v1/run-id";

/** Rendered-identifier prefix (`derivation.prefix`); asserted against the vector. */
export const RUN_ID_PREFIX = "run-";

/** Digest algorithm (`derivation.hash`); asserted against the vector. */
export const RUN_ID_HASH = "blake3-256";

/**
 * The three inputs, in the order the preimage encodes them. Order is part of
 * the wire contract — see `buildRunIdPreimage`.
 */
export interface RunIdInputs {
  /**
   * ASCII `blake3-256:<hex>` digest of the RunSpec's Cap'n Proto CANONICAL
   * form. Per LLO: NOT of the received wire bytes — segment layout and padding
   * are an encoder's choice, not content, so two encoders that disagree on
   * framing must still derive one name for one spec.
   */
  canonicalSpecDigest: string;
  grantId: string;
  replayKey: string;
}

const encoder = new TextEncoder();

/**
 * Little-endian u64 length prefix. Written through a DataView rather than by
 * hand so the byte order is the platform-independent one the spec names, and
 * as a BigInt because a length is a u64 on the wire even when JS would happily
 * hold it in a double.
 */
function u64le(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value), true);
  return out;
}

/**
 * Exact preimage bytes:
 *
 *   domain || 0x00 || for each field in (canonicalSpecDigest, grantId, replayKey):
 *     u64le(byteLength(field)) || utf8(field)
 *
 * Exported separately from `deriveRunId` because LLO pins `preimageHex` per
 * case as well as the final `runId`. Checking both independently is what
 * distinguishes "my framing is wrong" from "my hash is wrong" — with only the
 * digest compared, either defect presents identically.
 *
 * Note the length is the UTF-8 BYTE length, not the JS string length; they
 * differ for any non-ASCII input, and the fields are not constrained to ASCII.
 */
export function buildRunIdPreimage(inputs: RunIdInputs): Uint8Array {
  const parts: Uint8Array[] = [encoder.encode(RUN_ID_DOMAIN), Uint8Array.of(0x00)];

  for (const field of [inputs.canonicalSpecDigest, inputs.grantId, inputs.replayKey]) {
    const bytes = encoder.encode(field);
    parts.push(u64le(bytes.length), bytes);
  }

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const preimage = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    preimage.set(part, offset);
    offset += part.length;
  }
  return preimage;
}

/**
 * Derive the run identifier: `run-<lowercase-hex BLAKE3-256 of the preimage>`.
 *
 * Uses the substrate hash (leyline-cas-ffi via wasm32), so the digest matches
 * LLO's `blake3` crate byte-for-byte rather than matching a TS BLAKE3 that
 * could semver-drift — the same argument cas-hash.ts makes for replacing
 * `@noble/hashes`.
 */
export function deriveRunId(inputs: RunIdInputs): string {
  return RUN_ID_PREFIX + blake3Hex(buildRunIdPreimage(inputs));
}
