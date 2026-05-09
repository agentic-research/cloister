// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Disclosure-endpoint cursor signing + constant-time error helpers.
//
// Substrate for cloister-c7a184 / threat-model §9.2 + §9.4. The
// disclosure endpoint (cloister-bdef0c, not yet implemented) needs:
//
//   1. Cursors that aren't oracles. An attacker who can request
//      `?from_seq=N` and learn whether seq N exists for a peer (§9.4)
//      uses cloister as an existence-disclosure side-channel. Mitigation:
//      cursors are HMAC-signed tokens over (peer_fp, from_seq, ts);
//      cloister rejects unsigned cursors.
//
//   2. Constant-time error responses. An attacker who probes
//      `/interlace/peers/{fp}` for many fingerprints (§9.2) and
//      distinguishes "no peer" from "peer exists but rejected" learns
//      relationship state. Mitigation: error responses pad to a
//      constant size + use a fixed message regardless of failure class.
//
// Both helpers are pure / substrate-y and ship now so the disclosure
// endpoint (when it lands) doesn't have to roll its own. The HMAC key
// comes from `INTERLACE_DISCLOSURE_HMAC_KEY` (env binding, base64-std,
// 32+ bytes recommended).

const CURSOR_VERSION = 1;

/** Decoded cursor payload — what the caller asked for. */
export interface CursorPayload {
  /** Peer fingerprint the cursor scopes to. */
  peerFp: string;
  /** Starting seq within the peer's chain. */
  fromSeq: number;
  /** Unix-ms timestamp the cursor was minted at (for replay-window enforcement). */
  ts: number;
}

/**
 * Sign a cursor — returns an opaque base64url string the client can
 * round-trip without parsing. Format:
 *
 *   v1.<base64url-payload-json>.<base64url-hmac-sha256>
 *
 * The dot-separator + version prefix matches JWT shape so log-grep is
 * easy. Payload is canonical JSON (sorted keys); HMAC is over the dot-
 * concatenated `v1.<payload>` portion.
 */
export async function signCursor(
  payload: CursorPayload,
  hmacKey: CryptoKey,
): Promise<string> {
  const body = canonicalJSON(payload as unknown as Record<string, unknown>);
  const bodyBytes = new TextEncoder().encode(body);
  const bodyB64 = b64uEncode(bodyBytes);
  const headerAndBody = `v${CURSOR_VERSION}.${bodyB64}`;
  const sig = new Uint8Array(
    (await crypto.subtle.sign(
      { name: "HMAC" },
      hmacKey,
      new TextEncoder().encode(headerAndBody) as BufferSource,
    )) as ArrayBuffer,
  );
  return `${headerAndBody}.${b64uEncode(sig)}`;
}

/**
 * Verify a cursor — returns the payload on success or `null` on any
 * failure (malformed, wrong version, bad HMAC, missing fields). The
 * `null` return is intentional: callers should treat any failure as
 * "untrusted input" and fall back to the start of the chain.
 *
 * Constant-time HMAC comparison is enforced by Web Crypto's
 * `crypto.subtle.verify` — don't substitute a manual byte compare.
 */
export async function verifyCursor(
  cursor: string,
  hmacKey: CryptoKey,
): Promise<CursorPayload | null> {
  try {
    const parts = cursor.split(".");
    if (parts.length !== 3) return null;
    if (parts[0] !== `v${CURSOR_VERSION}`) return null;

    const bodyB64 = parts[1]!;
    const sigB64  = parts[2]!;
    const sig = b64uDecode(sigB64);
    const headerAndBody = `${parts[0]}.${bodyB64}`;

    const ok = await crypto.subtle.verify(
      { name: "HMAC" },
      hmacKey,
      sig as BufferSource,
      new TextEncoder().encode(headerAndBody) as BufferSource,
    );
    if (!ok) return null;

    const body = JSON.parse(new TextDecoder().decode(b64uDecode(bodyB64))) as Record<string, unknown>;
    if (typeof body["peerFp"]  !== "string") return null;
    if (typeof body["fromSeq"] !== "number") return null;
    if (typeof body["ts"]      !== "number") return null;
    return {
      peerFp:  body["peerFp"]  as string,
      fromSeq: body["fromSeq"] as number,
      ts:      body["ts"]      as number,
    };
  } catch {
    return null;
  }
}

/**
 * Import a raw HMAC key suitable for `signCursor` / `verifyCursor`.
 * Accepts the env-bound `INTERLACE_DISCLOSURE_HMAC_KEY` (base64-std or
 * base64url, no padding-required). Caller is responsible for keeping
 * the key the same across all replicas of the cluster.
 */
export async function importHmacKey(rawKeyB64: string): Promise<CryptoKey> {
  const norm = rawKeyB64.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (norm.length % 4)) % 4;
  const binary = atob(norm + "=".repeat(pad));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return crypto.subtle.importKey(
    "raw",
    bytes as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

// ── Constant-time error response (cloister-c7a184 / threat-model §9.2) ──

/** Fixed body length for disclosure-endpoint error responses. */
export const CONSTANT_TIME_ERROR_BODY_LEN = 256;

/**
 * Build a Response with a fixed-size body so an attacker probing for
 * peer existence can't distinguish failure classes by response size.
 * The status code is always 404 — "not found" is the only externally
 * observable failure shape. The internal `kind` is logged separately
 * (caller's responsibility) but does NOT bleed into the response.
 *
 * We pad to a fixed length using ASCII '0' so the body is valid UTF-8.
 */
export function constantTimeErrorResponse(_kind: "not_found" | "denied" | "bad_cursor"): Response {
  const body = "0".repeat(CONSTANT_TIME_ERROR_BODY_LEN);
  return new Response(body, {
    status: 404,
    headers: {
      "content-type":   "application/octet-stream",
      "cache-control":  "no-store",
      "content-length": String(CONSTANT_TIME_ERROR_BODY_LEN),
    },
  });
}

// ── helpers ──────────────────────────────────────────────────────────────

function b64uEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64uDecode(s: string): Uint8Array {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (norm.length % 4)) % 4;
  const binary = atob(norm + "=".repeat(pad));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Canonical JSON — sorted keys, no whitespace. Stable input for the
 * HMAC so a client re-encoding the payload (e.g. with different
 * whitespace) doesn't accidentally invalidate the signature.
 */
function canonicalJSON(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    parts.push(JSON.stringify(k) + ":" + JSON.stringify(obj[k]));
  }
  return "{" + parts.join(",") + "}";
}
