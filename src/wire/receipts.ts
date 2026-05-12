// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Interlace 0.2.0 signed-receipt envelopes (RECEIPTS.md §2.1 + §2.4).
//
// Receipts close the §13.2 non-repudiation gap by binding A's 2xx
// response bytes to A's master Ed25519 signing key. Two envelope
// classes:
//
//   - per-request receipt: commits to a single request+response pair.
//     Emitted in the `Interlace-Receipt` HTTP response header on every
//     authenticated 2xx (§2.1, §2.6).
//
//   - streaming-receipt chain: covers SSE / NDJSON responses with an
//     open commitment + per-event hash chain + close commitment. The
//     open commitment is a Interlace-Receipt header on the initial
//     response; the close commitment is emitted as a terminal
//     `event: interlace-stream-close` SSE event (§2.4).
//
// This module owns the canonical-byte construction + signing + verifying
// primitives. Receipt-emit wiring (response wrappers around route
// handlers) lives in `src/routes/receipt-emitter.ts`. P-side client
// verification (cloister-as-consumer of upstream Interlace responses)
// lives in `src/wire/receipt-verify.ts`.
//
// ## Key surface
//
// Signing requires Cloister's MASTER private key. Two paths:
//
//   1. `RECEIPT_SIGNING_KEY` env binding — base64-standard 64-byte
//      Ed25519 keypair (seed || pub). When set, Cloister signs locally
//      via Web Crypto. Default deployment path until notme grows a
//      `/internal/sign-receipt` endpoint.
//
//   2. Notme service-binding delegation — when (1) is unset and the
//      env.NOTME service binding is configured, sign forwards to notme
//      as POST /internal/sign-receipt with the canonical commitment
//      bytes. Returns the Ed25519 signature. (Followup bead to add the
//      notme-side endpoint.)
//
// Verification (always cloister-local) uses the master pubkey from the
// CA bundle's epoch index. See §2.2 of RECEIPTS.md.

import { canonicalCbor, decodeCanonicalCbor, type ReceiptCborMap, type ReceiptCborValue } from "./receipts-cbor.js";

// ── Spec constants ────────────────────────────────────────────────────────

/**
 * HTTP response header carrying the receipt envelope. RFC 6648
 * non-`X-` form per RECEIPTS.md §3.2.
 */
export const INTERLACE_RECEIPT_HEADER = "Interlace-Receipt";

/**
 * Allowlist of response headers committed by the receipt's
 * `headers_hash` per RECEIPTS.md §2.1. Sorted bytewise-lex.
 *
 * Adding a header here is a SPEC change — extensions require a SEP
 * amendment, not a deploy-time edit. The list is intentionally
 * defined-by-the-spec to keep canonical receipt bytes stable across the
 * ecosystem.
 */
export const HEADER_ALLOWLIST: readonly string[] = Object.freeze([
  "access-control-allow-credentials",
  "access-control-allow-origin",
  "access-control-expose-headers",
  "cache-control",
  "content-encoding",
  "content-language",
  "content-length",
  "content-type",
  "docker-content-digest",
  "docker-distribution-api-version",
  "etag",
  "last-modified",
  "link",
  "location",
  "mcp-protocol-version",
  "mcp-session-id",
  "retry-after",
  "www-authenticate",
]);

/**
 * Tolerance window for `timestamp_ms` clock-skew per §2.2.1 step 12.
 * Matches the 0.1.0 lease-envelope MAX_CLOCK_SKEW_MS (60s) extended to
 * RECEIPTS.md's stated ±300s (the receipt construction lives later in
 * the response pipeline, so a wider tolerance covers asymmetric
 * forward latency).
 */
export const RECEIPT_CLOCK_SKEW_MS = 300_000;

// ── Schema types ──────────────────────────────────────────────────────────

/**
 * Per-request receipt commitment fields (RECEIPTS.md §2.1).
 */
export interface ReceiptCommitment {
  /** Request nonce from P's lease envelope; ≥16 bytes. */
  nonce:        Uint8Array;
  /** SHA-256(request_canon) per URL-CANONICALIZATION.md §3.2. */
  requestHash:  Uint8Array;
  /** HTTP status code, 200..299. */
  status:       number;
  /** SHA-256(response_body_bytes); SHA-256("") if empty. */
  bodyHash:     Uint8Array;
  /** SHA-256(canonical_cbor(allowlisted headers map)). */
  headersHash:  Uint8Array;
  /** Unix milliseconds at admission. */
  timestampMs:  number;
  /** SHA-256(A.master_pubkey). */
  actorFp:      Uint8Array;
  /** A's current key epoch. */
  epoch:        number;
}

/** Per-request receipt envelope. */
export interface ReceiptEnvelope {
  commitment: ReceiptCommitment;
  /** Ed25519(master_sk, canonical_cbor(commitment)). */
  signature:  Uint8Array;
}

/**
 * Stream-open commitment (RECEIPTS.md §2.4). Sent in the
 * `Interlace-Receipt` header at stream open.
 */
export interface StreamOpenCommitment {
  nonce:        Uint8Array;
  requestHash:  Uint8Array;
  /** Always 200 for opened streams. */
  status:       number;
  streamMode:   "sse" | "ndjson";
  /** 16-byte per-stream random identifier. */
  streamId:     Uint8Array;
  timestampMs:  number;
  actorFp:      Uint8Array;
  epoch:        number;
}

/** Wrapped stream-open envelope (kind="stream-open"). */
export interface StreamOpenEnvelope {
  kind:       "stream-open";
  commitment: StreamOpenCommitment;
  signature:  Uint8Array;
}

/**
 * Stream-close commitment (RECEIPTS.md §2.4). Signed at stream close
 * and emitted as the terminal `interlace-stream-close` SSE event.
 */
export interface StreamCloseCommitment {
  streamId:           Uint8Array;
  /** SHA-256(canonical_cbor(stream_open_commitment)). */
  openCommitmentHash: Uint8Array;
  /** event_hash[last], or openCommitmentHash if event_count=0. */
  tipHash:            Uint8Array;
  /** Number of events emitted (excluding the close event itself). */
  eventCount:         number;
  closeStatus:        "ok" | "client-disconnect" | "server-shutdown";
  timestampMs:        number;
}

export interface StreamCloseEnvelope {
  commitment: StreamCloseCommitment;
  signature:  Uint8Array;
}

// ── canonical-bytes mapping ───────────────────────────────────────────────

/**
 * Build the canonical-CBOR map for a `ReceiptCommitment` per §2.1.
 * Map keys are the exact text labels named in the spec.
 */
export function commitmentCborMap(c: ReceiptCommitment): ReceiptCborMap {
  return {
    actor_fp:     c.actorFp,
    body_hash:    c.bodyHash,
    epoch:        c.epoch,
    headers_hash: c.headersHash,
    nonce:        c.nonce,
    request_hash: c.requestHash,
    status:       c.status,
    timestamp_ms: c.timestampMs,
  };
}

/** Build the canonical-CBOR map for a `StreamOpenCommitment` per §2.4. */
export function streamOpenCborMap(c: StreamOpenCommitment): ReceiptCborMap {
  return {
    actor_fp:     c.actorFp,
    epoch:        c.epoch,
    nonce:        c.nonce,
    request_hash: c.requestHash,
    status:       c.status,
    stream_id:    c.streamId,
    stream_mode:  c.streamMode,
    timestamp_ms: c.timestampMs,
  };
}

/** Build the canonical-CBOR map for a `StreamCloseCommitment` per §2.4. */
export function streamCloseCborMap(c: StreamCloseCommitment): ReceiptCborMap {
  return {
    close_status:           c.closeStatus,
    event_count:            c.eventCount,
    open_commitment_hash:   c.openCommitmentHash,
    stream_id:              c.streamId,
    timestamp_ms:           c.timestampMs,
    tip_hash:               c.tipHash,
  };
}

/** Canonical CBOR bytes for a per-request commitment. */
export function encodeCommitment(c: ReceiptCommitment): Uint8Array {
  return canonicalCbor(commitmentCborMap(c));
}

export function encodeStreamOpenCommitment(c: StreamOpenCommitment): Uint8Array {
  return canonicalCbor(streamOpenCborMap(c));
}

export function encodeStreamCloseCommitment(c: StreamCloseCommitment): Uint8Array {
  return canonicalCbor(streamCloseCborMap(c));
}

// ── Receipt envelope encoding (transport bytes) ───────────────────────────

/**
 * Encode a per-request receipt envelope for header emission.
 * Per §2.1: `canonical_cbor({"commitment": commitment_cbor, "signature": sig})`.
 *
 * Important: the OUTER envelope's "commitment" field stores the CBOR
 * MAP value (decodable as canonical structure), not the encoded-byte
 * blob. Per §2.4 the open_commitment_hash is computed over the
 * commitment-only canonical bytes, NOT over the envelope.
 */
export function encodeReceiptEnvelope(env: ReceiptEnvelope): Uint8Array {
  return canonicalCbor({
    commitment: commitmentCborMap(env.commitment),
    signature:  env.signature,
  });
}

export function encodeStreamOpenEnvelope(env: StreamOpenEnvelope): Uint8Array {
  return canonicalCbor({
    commitment: streamOpenCborMap(env.commitment),
    kind:       env.kind,
    signature:  env.signature,
  });
}

export function encodeStreamCloseEnvelope(env: StreamCloseEnvelope): Uint8Array {
  return canonicalCbor({
    commitment: streamCloseCborMap(env.commitment),
    signature:  env.signature,
  });
}

// ── Decoding ──────────────────────────────────────────────────────────────

/**
 * Decode a base64url-encoded `Interlace-Receipt` header value into the
 * typed envelope. Strict — rejects non-canonical CBOR + structural
 * mismatches per §2.2.1 step 2.
 *
 * Returns `{ ok: false, reason }` on any structural failure. Successful
 * decode does NOT verify the signature; caller does that against the
 * resolved master pubkey.
 */
export function decodeReceiptHeader(headerValue: string): DecodeResult<ReceiptEnvelope> {
  let bytes: Uint8Array;
  try {
    bytes = b64urlDecode(headerValue);
  } catch (err) {
    return { ok: false, reason: `base64url decode failed: ${(err as Error).message}` };
  }
  return decodeReceiptBytes(bytes);
}

/**
 * Decode a per-request receipt from canonical-CBOR bytes (lower-level
 * sibling of `decodeReceiptHeader` for callers that already have raw
 * bytes — e.g. archival store reads).
 */
export function decodeReceiptBytes(bytes: Uint8Array): DecodeResult<ReceiptEnvelope> {
  let outer: ReceiptCborValue;
  try {
    outer = decodeCanonicalCbor(bytes);
  } catch (err) {
    return { ok: false, reason: `canonical CBOR decode failed: ${(err as Error).message}` };
  }
  if (!isPlainMap(outer)) return { ok: false, reason: "receipt envelope is not a map" };

  const keys = Object.keys(outer).sort();
  if (keys.length !== 2 || keys[0] !== "commitment" || keys[1] !== "signature") {
    return { ok: false, reason: `receipt envelope has unexpected keys: ${JSON.stringify(keys)}` };
  }

  const commitment = outer["commitment"];
  const signature  = outer["signature"];
  if (!isPlainMap(commitment)) return { ok: false, reason: "commitment is not a map" };
  if (!(signature instanceof Uint8Array)) return { ok: false, reason: "signature is not bytes" };
  if (signature.length !== 64)            return { ok: false, reason: `signature wrong length (${signature.length})` };

  const c = parseCommitmentMap(commitment);
  if (!c.ok) return c;
  return { ok: true, value: { commitment: c.value, signature } };
}

/** Decode a stream-open envelope from canonical-CBOR bytes. */
export function decodeStreamOpenEnvelopeBytes(bytes: Uint8Array): DecodeResult<StreamOpenEnvelope> {
  let outer: ReceiptCborValue;
  try {
    outer = decodeCanonicalCbor(bytes);
  } catch (err) {
    return { ok: false, reason: `canonical CBOR decode failed: ${(err as Error).message}` };
  }
  if (!isPlainMap(outer)) return { ok: false, reason: "stream-open envelope is not a map" };

  const keys = Object.keys(outer).sort();
  if (keys.length !== 3 || keys[0] !== "commitment" || keys[1] !== "kind" || keys[2] !== "signature") {
    return { ok: false, reason: `stream-open envelope unexpected keys: ${JSON.stringify(keys)}` };
  }
  const kind = outer["kind"];
  if (kind !== "stream-open") return { ok: false, reason: `kind mismatch: ${kind as string}` };

  const commitment = outer["commitment"];
  const signature  = outer["signature"];
  if (!isPlainMap(commitment))            return { ok: false, reason: "commitment is not a map" };
  if (!(signature instanceof Uint8Array)) return { ok: false, reason: "signature is not bytes" };
  if (signature.length !== 64)            return { ok: false, reason: `signature wrong length` };

  const c = parseStreamOpenMap(commitment);
  if (!c.ok) return c;
  return { ok: true, value: { kind: "stream-open", commitment: c.value, signature } };
}

/** Decode a stream-close envelope. Same shape as receipt envelope. */
export function decodeStreamCloseEnvelopeBytes(bytes: Uint8Array): DecodeResult<StreamCloseEnvelope> {
  let outer: ReceiptCborValue;
  try {
    outer = decodeCanonicalCbor(bytes);
  } catch (err) {
    return { ok: false, reason: `canonical CBOR decode failed: ${(err as Error).message}` };
  }
  if (!isPlainMap(outer)) return { ok: false, reason: "stream-close envelope is not a map" };

  const keys = Object.keys(outer).sort();
  if (keys.length !== 2 || keys[0] !== "commitment" || keys[1] !== "signature") {
    return { ok: false, reason: `stream-close envelope unexpected keys` };
  }
  const commitment = outer["commitment"];
  const signature  = outer["signature"];
  if (!isPlainMap(commitment))            return { ok: false, reason: "commitment is not a map" };
  if (!(signature instanceof Uint8Array)) return { ok: false, reason: "signature is not bytes" };
  if (signature.length !== 64)            return { ok: false, reason: `signature wrong length` };

  const c = parseStreamCloseMap(commitment);
  if (!c.ok) return c;
  return { ok: true, value: { commitment: c.value, signature } };
}

// ── Map → typed-struct parsers ────────────────────────────────────────────

type DecodeResult<T> = { ok: true; value: T } | { ok: false; reason: string };

function parseCommitmentMap(m: ReceiptCborMap): DecodeResult<ReceiptCommitment> {
  const required = ["actor_fp", "body_hash", "epoch", "headers_hash", "nonce", "request_hash", "status", "timestamp_ms"];
  for (const r of required) {
    if (!(r in m)) return { ok: false, reason: `commitment missing required key '${r}'` };
  }
  const extraKeys = Object.keys(m).filter((k) => !required.includes(k));
  if (extraKeys.length > 0) {
    return { ok: false, reason: `commitment has unexpected keys: ${JSON.stringify(extraKeys)}` };
  }
  if (!(m["actor_fp"]     instanceof Uint8Array) || m["actor_fp"].length !== 32)     return { ok: false, reason: "actor_fp" };
  if (!(m["body_hash"]    instanceof Uint8Array) || m["body_hash"].length !== 32)    return { ok: false, reason: "body_hash" };
  if (typeof m["epoch"]   !== "number")                                              return { ok: false, reason: "epoch" };
  if (!(m["headers_hash"] instanceof Uint8Array) || m["headers_hash"].length !== 32) return { ok: false, reason: "headers_hash" };
  if (!(m["nonce"]        instanceof Uint8Array) || m["nonce"].length < 16)          return { ok: false, reason: "nonce" };
  if (!(m["request_hash"] instanceof Uint8Array) || m["request_hash"].length !== 32) return { ok: false, reason: "request_hash" };
  if (typeof m["status"]  !== "number")                                              return { ok: false, reason: "status" };
  const ts = m["timestamp_ms"];
  if (typeof ts !== "number" && typeof ts !== "bigint")                              return { ok: false, reason: "timestamp_ms" };

  return {
    ok: true,
    value: {
      actorFp:     m["actor_fp"]     as Uint8Array,
      bodyHash:    m["body_hash"]    as Uint8Array,
      epoch:       m["epoch"]        as number,
      headersHash: m["headers_hash"] as Uint8Array,
      nonce:       m["nonce"]        as Uint8Array,
      requestHash: m["request_hash"] as Uint8Array,
      status:      m["status"]       as number,
      timestampMs: typeof ts === "bigint" ? Number(ts) : ts,
    },
  };
}

function parseStreamOpenMap(m: ReceiptCborMap): DecodeResult<StreamOpenCommitment> {
  const required = ["actor_fp", "epoch", "nonce", "request_hash", "status", "stream_id", "stream_mode", "timestamp_ms"];
  for (const r of required) if (!(r in m)) return { ok: false, reason: `stream-open missing '${r}'` };
  const extras = Object.keys(m).filter((k) => !required.includes(k));
  if (extras.length > 0) return { ok: false, reason: `stream-open unexpected: ${JSON.stringify(extras)}` };

  if (!(m["actor_fp"]     instanceof Uint8Array) || m["actor_fp"].length !== 32)     return { ok: false, reason: "actor_fp" };
  if (typeof m["epoch"]   !== "number")                                              return { ok: false, reason: "epoch" };
  if (!(m["nonce"]        instanceof Uint8Array) || m["nonce"].length < 16)          return { ok: false, reason: "nonce" };
  if (!(m["request_hash"] instanceof Uint8Array) || m["request_hash"].length !== 32) return { ok: false, reason: "request_hash" };
  if (typeof m["status"]  !== "number")                                              return { ok: false, reason: "status" };
  if (!(m["stream_id"]    instanceof Uint8Array) || m["stream_id"].length !== 16)    return { ok: false, reason: "stream_id" };
  const mode = m["stream_mode"];
  if (mode !== "sse" && mode !== "ndjson")                                           return { ok: false, reason: "stream_mode" };
  const ts = m["timestamp_ms"];
  if (typeof ts !== "number" && typeof ts !== "bigint")                              return { ok: false, reason: "timestamp_ms" };

  return {
    ok: true,
    value: {
      actorFp:     m["actor_fp"]     as Uint8Array,
      epoch:       m["epoch"]        as number,
      nonce:       m["nonce"]        as Uint8Array,
      requestHash: m["request_hash"] as Uint8Array,
      status:      m["status"]       as number,
      streamId:    m["stream_id"]    as Uint8Array,
      streamMode:  mode,
      timestampMs: typeof ts === "bigint" ? Number(ts) : ts,
    },
  };
}

function parseStreamCloseMap(m: ReceiptCborMap): DecodeResult<StreamCloseCommitment> {
  const required = ["close_status", "event_count", "open_commitment_hash", "stream_id", "timestamp_ms", "tip_hash"];
  for (const r of required) if (!(r in m)) return { ok: false, reason: `stream-close missing '${r}'` };
  const extras = Object.keys(m).filter((k) => !required.includes(k));
  if (extras.length > 0) return { ok: false, reason: `stream-close unexpected: ${JSON.stringify(extras)}` };

  const cs = m["close_status"];
  if (cs !== "ok" && cs !== "client-disconnect" && cs !== "server-shutdown") {
    return { ok: false, reason: "close_status" };
  }
  if (typeof m["event_count"] !== "number")                                            return { ok: false, reason: "event_count" };
  if (!(m["open_commitment_hash"] instanceof Uint8Array) || m["open_commitment_hash"].length !== 32) return { ok: false, reason: "open_commitment_hash" };
  if (!(m["stream_id"]            instanceof Uint8Array) || m["stream_id"].length !== 16)            return { ok: false, reason: "stream_id" };
  const ts = m["timestamp_ms"];
  if (typeof ts !== "number" && typeof ts !== "bigint")                                              return { ok: false, reason: "timestamp_ms" };
  if (!(m["tip_hash"]             instanceof Uint8Array) || m["tip_hash"].length !== 32)             return { ok: false, reason: "tip_hash" };

  return {
    ok: true,
    value: {
      closeStatus:        cs,
      eventCount:         m["event_count"]          as number,
      openCommitmentHash: m["open_commitment_hash"] as Uint8Array,
      streamId:           m["stream_id"]            as Uint8Array,
      timestampMs:        typeof ts === "bigint" ? Number(ts) : ts,
      tipHash:            m["tip_hash"]             as Uint8Array,
    },
  };
}

function isPlainMap(v: unknown): v is ReceiptCborMap {
  return typeof v === "object" && v !== null && !(v instanceof Uint8Array) && !Array.isArray(v);
}

// ── Signing primitives ────────────────────────────────────────────────────

/**
 * Ed25519 keypair holder for receipt signing. The keypair is the 64-byte
 * concatenation: seed (32 bytes) || pubkey (32 bytes). Web Crypto's
 * pkcs8 form is different; we wrap it for ergonomics here.
 *
 * `pubkey` is the 32-byte raw Ed25519 public key. Test fixtures and
 * `RECEIPT_SIGNING_KEY` env binding parse to this shape.
 */
export interface ReceiptSigner {
  /**
   * Sign canonical commitment bytes with the master Ed25519 private key.
   * Returns the 64-byte signature.
   */
  sign(canonical: Uint8Array): Promise<Uint8Array>;
  /** The 32-byte raw Ed25519 public key paired with this signer. */
  pubkey: Uint8Array;
}

/**
 * Build a `ReceiptSigner` from a raw seed (32 bytes) — the same source
 * format notme stores and Signet uses for ephemeral key material. The
 * matching public key is derived locally (Web Crypto can't do
 * Ed25519 seed→pub directly, so we use the pkcs8 raw-import path).
 *
 * Use case: tests + local dev where the master keypair is provided as a
 * 64-byte (seed||pub) blob in the `RECEIPT_SIGNING_KEY` env binding.
 */
export async function makeReceiptSignerFromKeypair(keypair64: Uint8Array): Promise<ReceiptSigner> {
  if (keypair64.length !== 64) {
    throw new Error(`receipt signing keypair must be 64 bytes (seed||pub); got ${keypair64.length}`);
  }
  const seed = keypair64.slice(0, 32);
  const pubkey = keypair64.slice(32, 64);

  // Wrap the raw 32-byte seed in a minimal PKCS#8 OneAsymmetricKey
  // structure so Web Crypto's importKey accepts it.
  // PKCS#8 PrivateKeyInfo for Ed25519:
  //   30 2e               SEQUENCE (46 bytes)
  //     02 01 00          INTEGER 0 (version)
  //     30 05             SEQUENCE (5 bytes)
  //       06 03 2b 65 70  OID 1.3.101.112 (Ed25519)
  //     04 22             OCTET STRING (34 bytes)
  //       04 20           OCTET STRING (32 bytes)
  //         <seed bytes>
  const pkcs8 = new Uint8Array([
    0x30, 0x2e,
    0x02, 0x01, 0x00,
    0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
    0x04, 0x22, 0x04, 0x20,
    ...seed,
  ]);

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8 as BufferSource,
    { name: "Ed25519" },
    false,
    ["sign"],
  );

  return {
    pubkey,
    async sign(canonical: Uint8Array): Promise<Uint8Array> {
      const sig = await crypto.subtle.sign("Ed25519", cryptoKey, canonical as BufferSource);
      return new Uint8Array(sig);
    },
  };
}

/**
 * Verify Ed25519(`pubkey`, `signature`, `canonical`).
 * Returns true iff the signature is valid. Errors collapse to false.
 */
export async function verifyEd25519(
  pubkey: Uint8Array,
  signature: Uint8Array,
  canonical: Uint8Array,
): Promise<boolean> {
  if (pubkey.length !== 32 || signature.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      pubkey as BufferSource,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify("Ed25519", key, signature as BufferSource, canonical as BufferSource);
  } catch {
    return false;
  }
}

/** Compute SHA-256 over the bytes. */
export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return new Uint8Array(digest);
}

// ── headers_hash construction ─────────────────────────────────────────────

/**
 * Build the canonical CBOR bytes for the `headers_hash` input per §2.1.
 * Restricts to `HEADER_ALLOWLIST`; values are CBOR byte strings (major
 * type 2). Header names are lower-cased before lookup.
 *
 * Map keys are the lowercase header names; values are the byte content
 * of each header as encoded UTF-8 of the header value (HTTP RFC 9110
 * §5.5 says header values are byte sequences, but Headers.get() returns
 * the value as a JS string; we encode UTF-8 of that string as the
 * byte representation — sufficient for ASCII headers, and the spec
 * doesn't require non-UTF-8 header bytes today).
 */
export function buildHeadersCommittedBytes(headers: Headers): Uint8Array {
  const map: Record<string, Uint8Array> = {};
  const enc = new TextEncoder();
  for (const name of HEADER_ALLOWLIST) {
    const v = headers.get(name);
    if (v !== null) {
      map[name] = enc.encode(v);
    }
  }
  return canonicalCbor(map);
}

// ── High-level sign + assemble ────────────────────────────────────────────

/**
 * Sign a per-request commitment and assemble the base64url-encoded
 * `Interlace-Receipt` header value. Pure utility wrapping the canonical
 * encode + sign + envelope-encode + base64url steps.
 */
export async function signCommitmentToHeader(
  c: ReceiptCommitment,
  signer: ReceiptSigner,
): Promise<{ headerValue: string; envelopeBytes: Uint8Array; signature: Uint8Array }> {
  const canon = encodeCommitment(c);
  const signature = await signer.sign(canon);
  const envelopeBytes = encodeReceiptEnvelope({ commitment: c, signature });
  return {
    headerValue: b64urlEncode(envelopeBytes),
    envelopeBytes,
    signature,
  };
}

/** Sign a stream-open commitment + return the base64url header value. */
export async function signStreamOpenToHeader(
  c: StreamOpenCommitment,
  signer: ReceiptSigner,
): Promise<{ headerValue: string; envelopeBytes: Uint8Array; signature: Uint8Array; commitmentHash: Uint8Array }> {
  const canon = encodeStreamOpenCommitment(c);
  const signature = await signer.sign(canon);
  const envelopeBytes = encodeStreamOpenEnvelope({ kind: "stream-open", commitment: c, signature });
  const commitmentHash = await sha256(canon);
  return { headerValue: b64urlEncode(envelopeBytes), envelopeBytes, signature, commitmentHash };
}

/** Sign a stream-close commitment + return the base64url payload string for the close-event. */
export async function signStreamCloseToEventPayload(
  c: StreamCloseCommitment,
  signer: ReceiptSigner,
): Promise<{ payload: string; envelopeBytes: Uint8Array; signature: Uint8Array }> {
  const canon = encodeStreamCloseCommitment(c);
  const signature = await signer.sign(canon);
  const envelopeBytes = encodeStreamCloseEnvelope({ commitment: c, signature });
  return {
    payload: b64urlEncode(envelopeBytes),
    envelopeBytes,
    signature,
  };
}

// ── Event chain helpers (RECEIPTS.md §2.4) ────────────────────────────────

/**
 * Compute the chain step for the n-th SSE event per §2.4:
 *   event_hash[n] = SHA-256(canonical_cbor({
 *     "prev": event_hash[n-1] | open_commitment_hash,
 *     "event_data": <bytes>,
 *     "seq": n,
 *   }))
 *
 * Inputs are positional to avoid an object-allocation cost at the inner
 * loop of streaming.
 */
export async function eventChainStep(
  prev:     Uint8Array,
  eventData: Uint8Array,
  seq:       number,
): Promise<Uint8Array> {
  const canon = canonicalCbor({
    event_data: eventData,
    prev,
    seq,
  });
  return sha256(canon);
}

// ── base64url helpers ─────────────────────────────────────────────────────

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/")
    + "===".slice((s.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Decode base64-STANDARD (with `+`/`/` and `=` padding). */
export function b64stdDecode(s: string): Uint8Array {
  if (s === "") return new Uint8Array(0);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
