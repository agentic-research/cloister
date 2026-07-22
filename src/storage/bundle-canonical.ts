// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bundle canonical encoding + signature verification (cloister-c614ae).
//
// Lifted from notme/worker/src/revocation.ts (Apache-2.0 origin, re-licensed
// AGPL-3.0-or-later — the same crate-level license bump as ll-open's leyline-
// sign lift). Must stay byte-equal with notme's encoder so a bundle signed
// by signet's Go-side `pkg/revocation/checker.go` verifies correctly here.
//
// Wire format split per signet ADR-002 §2.3:
//   - Transport / KV / API:  JSON (CABundle struct as written by notme)
//   - Signing canonical:     CBOR canonical (this module)
//
// CABundle is NOT serialized as CBOR on the wire. CBOR is used only as the
// byte representation that goes into crypto.subtle.sign / verify.
//
// The threat-model finding §5 cloister-c614ae required this: cloister was
// caching whatever JSON it fetched without checking the signature, so a
// MITM that broke notme's TLS could swap in a malicious bundle. Now every
// bundle is verified against `INTERLACE_ROOT_PUBKEY` before caching.

import { Encoder } from "cbor-x";
import type { CABundle } from "./ca-bundle-cache.js";

/** Decode base64url-or-standard with optional padding. */
function b64Decode(s: string): Uint8Array {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (norm.length % 4)) % 4;
  const binary = atob(norm + "=".repeat(pad));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// CBOR encoder configured to match signet/Go's fxamacker/cbor canonical
// output byte-for-byte. Three settings matter:
//
//   - mapsAsObjects: false — preserve Map → CBOR map (needed for integer keys)
//   - useRecords: false — no cbor-x record extension; plain CBOR
//   - tagUint8Array: false — RFC 8949 plain bytes (major type 2), not the
//     RFC 8746 typed-array tag. signet's Go encoder writes plain bytes.
const cborEncoder = new Encoder({
  mapsAsObjects:  false,
  useRecords:     false,
  tagUint8Array:  false,
});

/**
 * Sort string-keyed entries by RFC 8949 §4.2 canonical order:
 * "bytewise lexicographic order of deterministic encodings." For UTF-8
 * text strings, equivalent to: shorter first; equal-length compared bytewise.
 */
function sortStringKeysCanonical(
  entries: Array<[string, Uint8Array]>,
): Array<[string, Uint8Array]> {
  const enc = new TextEncoder();
  return [...entries].sort((a, b) => {
    const ab = enc.encode(a[0]);
    const bb = enc.encode(b[0]);
    if (ab.length !== bb.length) return ab.length - bb.length;
    for (let i = 0; i < ab.length; i++) {
      if (ab[i] !== bb[i]) return ab[i] - bb[i];
    }
    return 0;
  });
}

/**
 * Produce canonical signing bytes for a CABundle. Must match
 * signet/pkg/revocation/checker.go:168-188 byte-for-byte:
 *
 *   message := map[int]interface{}{
 *     1: bundle.Epoch,     // uint64
 *     2: bundle.Seqno,     // uint64
 *     3: bundle.Keys,      // map[string][]byte
 *     4: bundle.KeyID,     // string
 *     5: bundle.PrevKeyID, // string
 *     6: bundle.IssuedAt,  // int64
 *   }
 *
 * Integer keys 1-6 are already in canonical bytewise order. The inner
 * `keys` map needs explicit RFC 8949 §4.2 ordering on its string keys.
 *
 * CABundle.keys is a Record<string, base64-string>; signet's Go-side has
 * map[string][]byte. To match Go bytes, base64-decode here so CBOR
 * encodes values as bytes (major type 2), not as text strings.
 */
export function bundleCanonical(bundle: CABundle): Uint8Array {
  const keysEntries = sortStringKeysCanonical(
    Object.entries(bundle.keys).map(([kid, b64]) => [kid, b64Decode(b64)]),
  );
  const keysMap = new Map<string, Uint8Array>(keysEntries);

  const message = new Map<number, unknown>([
    [1, bundle.epoch],
    [2, bundle.seqno],
    [3, keysMap],
    [4, bundle.keyId],
    [5, bundle.prevKeyId ?? ""],
    [6, bundle.issuedAt],
  ]);

  // cbor-x returns Buffer in Node, Uint8Array on Workers/V8. Normalize so
  // crypto.subtle and tests see a stable type cross-platform.
  const out = cborEncoder.encode(message);
  return out instanceof Uint8Array && out.constructor === Uint8Array
    ? out
    : new Uint8Array(out);
}

/**
 * Verify a CABundle's Ed25519 signature against the cluster root pubkey.
 *
 * @param bundle           — the bundle to verify (signature field is the
 *                          base64-encoded sig over `bundleCanonical(bundle)`)
 * @param rootPublicKeyB64 — base64-encoded raw Ed25519 root key (32 bytes;
 *                          accepts both base64-standard and base64url)
 *
 * Returns `true` iff the signature is valid. `false` on any failure
 * (parse error, length mismatch, sig mismatch). Failures are silent —
 * caller decides whether to log.
 */
export async function verifyBundleSignature(
  bundle: CABundle,
  rootPublicKeyB64: string,
): Promise<boolean> {
  try {
    const keyBytes = b64Decode(rootPublicKeyB64);
    if (keyBytes.length !== 32) return false;
    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes as BufferSource,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      b64Decode(bundle.signature) as BufferSource,
      bundleCanonical(bundle) as BufferSource,
    );
  } catch {
    // lint-allow-silent: verify predicate — false = signature does not verify (bad sig or malformed key)
    return false;
  }
}
