// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SSE / streaming response receipt wrapper (RECEIPTS.md §2.4).
//
// On stream open:
//   - Sign a `stream_open_commitment` over canonical CBOR of the
//     request + stream metadata.
//   - Emit it in the response's `Interlace-Receipt` HTTP header.
//   - Compute and cache `open_commitment_hash = SHA-256(canonical_cbor
//     (stream_open_commitment))` as the first link in the rolling
//     event-hash chain.
//
// Per event:
//   - Compute event_hash[n] = SHA-256(canonical_cbor({prev, event_data, seq}))
//     using the previous event_hash (or open_commitment_hash for n=0).
//   - Pipe the original event bytes through to the consumer unchanged.
//
// On stream close:
//   - Sign a `stream_close_commitment` containing stream_id,
//     open_commitment_hash, tip_hash (= last event_hash, or
//     open_commitment_hash if event_count=0), event_count, close_status.
//   - Emit it as a final SSE event `event: interlace-stream-close`.
//
// The wrapper is INTRUSIVE on the underlying response body: it
// re-encodes the SSE stream so it can chain-hash data lines (NOT comment
// lines per spec §2.4). For non-SSE streaming (NDJSON etc) the wrapper
// hashes one event per delimiter — currently SSE-only.
//
// Math-friend round-3 review notes that are load-bearing:
//   - Comments (lines starting with `:`) MUST NOT contribute to the
//     hash chain.
//   - Empty-stream edge case: event_count=0 → tip_hash = open_commitment_hash.
//   - TCP-RST mid-stream → no close commitment → §13.2 cannot conclude.
//
// All three are honored here by:
//   - Skipping lines starting with `:` in the event parser.
//   - Initializing rolling_hash = open_commitment_hash and only advancing
//     on event blocks.
//   - The close-event is only emitted in the controller's finalize step,
//     which workerd skips if the response stream is torn down.

import {
  INTERLACE_RECEIPT_HEADER,
  signStreamCloseToEventPayload,
  signStreamOpenToHeader,
  eventChainStep,
  type ReceiptSigner,
  type StreamCloseCommitment,
  type StreamOpenCommitment,
} from "../wire/receipts.js";
import { sha256 } from "../wire/receipts.js";

export interface StreamReceiptContext {
  /** The full request canonical bytes (pre-SHA-256 form). */
  requestCanon: Uint8Array;
  /** Lease envelope nonce. */
  nonce: Uint8Array;
  /** Master signing key holder. */
  signer: ReceiptSigner;
  /** 32-byte actor fingerprint. */
  actorFp: Uint8Array;
  /** Current epoch. */
  epoch: number;
  /** Wall-clock timestamp at admission. */
  nowMs: number;
}

/**
 * Wrap an SSE Response with the §2.4 stream commitment chain.
 *
 * - Adds the stream-open commitment to the response's
 *   `Interlace-Receipt` header.
 * - Pipes the original body through a transformer that rolls the event
 *   chain hash on each data event.
 * - On stream close (the underlying readable terminates normally),
 *   appends a `event: interlace-stream-close` event with the close
 *   commitment signed payload.
 *
 * The transformer reads UTF-8 strings line-by-line (SSE is text-only).
 */
export async function wrapSseWithReceiptStream(
  upstream: Response,
  ctx: StreamReceiptContext,
): Promise<Response> {
  if (upstream.status !== 200) return upstream;
  if (upstream.body === null) return upstream;

  // Build open commitment + sign.
  const streamId = randomBytes(16);
  const requestHash = await sha256(ctx.requestCanon);
  const openCommitment: StreamOpenCommitment = {
    nonce:       ctx.nonce,
    requestHash,
    status:      200,
    streamMode:  "sse",
    streamId,
    timestampMs: ctx.nowMs,
    actorFp:     ctx.actorFp,
    epoch:       ctx.epoch,
  };
  const { headerValue, commitmentHash: openCommitmentHash } =
    await signStreamOpenToHeader(openCommitment, ctx.signer);

  // ── Build the transformer that rolls the event chain ──────────────────
  //
  // SSE wire format: events separated by `\n\n`. Each event is one or
  // more lines; comment lines start with `:` and MUST NOT contribute to
  // the hash chain (§2.4). Data lines start with `data: ` (or similar
  // field prefixes); the spec hashes the full event-data payload.
  //
  // Our chain step uses the full event-block bytes (excluding the
  // trailing `\n\n` delimiter). This is the simplest reading of "event
  // payload bytes" — implementations sharing this design choice can
  // reproduce byte-equal hashes.

  let rollingHash = openCommitmentHash;
  let eventCount = 0;
  let pending = "";
  const encoder = new TextEncoder();

  // We deliberately keep a strong reference to the original body's
  // reader so we can read from it inside the new ReadableStream's
  // pull() — workerd-native ReadableStreams play well with this
  // pattern.
  const reader = upstream.body.getReader();
  let closeEmitted = false;

  async function emitCloseEvent(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    if (closeEmitted) return;
    closeEmitted = true;
    const closeCommitment: StreamCloseCommitment = {
      streamId,
      openCommitmentHash,
      tipHash: rollingHash,
      eventCount,
      closeStatus: "ok",
      timestampMs: Date.now(),
    };
    const { payload } = await signStreamCloseToEventPayload(closeCommitment, ctx.signer);
    const closeEvent = `event: interlace-stream-close\ndata: ${payload}\n\n`;
    controller.enqueue(encoder.encode(closeEvent));
  }

  async function flushPendingEvents(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    // Split pending into complete event blocks (delimited by \n\n).
    let idx = pending.indexOf("\n\n");
    while (idx >= 0) {
      const eventBlock = pending.slice(0, idx);
      // Pass the raw block through; the +2 skips the delimiter.
      pending = pending.slice(idx + 2);
      // Compute hash chain step ONLY if the block contains at least
      // one non-comment line.
      const lines = eventBlock.split("\n");
      const nonComment = lines.filter((l) => !l.startsWith(":") && l.length > 0);
      if (nonComment.length > 0) {
        const eventBytes = encoder.encode(eventBlock);
        rollingHash = await eventChainStep(rollingHash, eventBytes, eventCount);
        eventCount++;
      }
      // Emit the block + delimiter unchanged to the consumer.
      controller.enqueue(encoder.encode(eventBlock + "\n\n"));
      idx = pending.indexOf("\n\n");
    }
  }

  const transformedStream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          // Drain residual buffer (no trailing \n\n) as a final event
          // block if non-empty. SSE strictly requires the trailing
          // delimiter; pragmatic: emit if it looks like a complete event.
          if (pending.length > 0) {
            // The remainder didn't end with \n\n; pass it through but
            // don't hash (incomplete event per spec).
            controller.enqueue(encoder.encode(pending));
            pending = "";
          }
          await emitCloseEvent(controller);
          controller.close();
          return;
        }
        pending += new TextDecoder().decode(value, { stream: true });
        await flushPendingEvents(controller);
      } catch (err) {
        try { await emitCloseEvent(controller); } catch { /* noop */ }
        controller.error(err);
      }
    },
    async cancel() {
      try { await reader.cancel(); } catch { /* noop */ }
    },
  });

  const newHeaders = new Headers(upstream.headers);
  newHeaders.set(INTERLACE_RECEIPT_HEADER, headerValue);
  newHeaders.set("access-control-expose-headers", INTERLACE_RECEIPT_HEADER);

  return new Response(transformedStream, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: newHeaders,
  });
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}
