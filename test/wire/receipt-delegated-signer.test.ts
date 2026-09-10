/// <reference types="@cloudflare/vitest-pool-workers/types" />
//
// Delegated receipt signing against notme's `ReceiptSigner` RPC entrypoint
// (notme ADR-014 / cloister-35ccf7).
//
// The interesting cases are all about the EPOCH_MISMATCH retry, because that
// is where the delegated path stops being a thin passthrough:
//
//   - `epoch` is a field INSIDE the commitment, so it is inside the signed
//     bytes. Retrying means REBUILDING, not re-sending.
//   - the envelope must carry the commitment actually signed, not the one the
//     caller handed in — otherwise commitment and signature disagree and the
//     receipt fails verification everywhere, for a reason visible nowhere.
//   - the retry is bounded at ONE. Rotation can move again between the re-read
//     and the retry, and an unbounded loop aims a retry storm at the service
//     least able to absorb it.

import { describe, expect, it } from "vitest";
import {
  DelegatedReceiptSignError,
  DelegatedReceiptSigner,
  delegatedReceiptSignerFrom,
} from "../../src/wire/receipt-delegated-signer";
import { encodeCommitment, type ReceiptCommitment } from "../../src/wire/receipts";

const bytes = (n: number, fill: number) => new Uint8Array(n).fill(fill);

function commitment(epoch = 1, actorFill = 0xaa): ReceiptCommitment {
  return {
    nonce:       bytes(16, 0x01),
    requestHash: bytes(32, 0x02),
    status:      200,
    bodyHash:    bytes(32, 0x03),
    headersHash: bytes(32, 0x04),
    timestampMs: 1_700_000_000_000,
    actorFp:     bytes(32, actorFill),
    epoch,
  };
}

/** A scriptable stand-in for notme's entrypoint. */
function fakeRemote(opts: {
  facts: Array<{ actorFp: Uint8Array; epoch: number }>;
  replies: Array<{ ok: true } | { ok: false; code: string }>;
}) {
  const seen: Uint8Array[] = [];
  let factsCalls = 0;
  let signCalls = 0;
  return {
    seen,
    get factsCalls() { return factsCalls; },
    get signCalls() { return signCalls; },
    async receiptFacts() {
      const f = opts.facts[Math.min(factsCalls, opts.facts.length - 1)]!;
      factsCalls += 1;
      return f;
    },
    async signReceipt(c: Uint8Array) {
      seen.push(new Uint8Array(c));
      const r = opts.replies[Math.min(signCalls, opts.replies.length - 1)]!;
      signCalls += 1;
      if (r.ok) return { ok: true as const, signature: bytes(64, 0x7f), epoch: 9 };
      return { ok: false as const, code: r.code, message: `synthetic ${r.code}` };
    },
  };
}

describe("binding detection", () => {
  // These originally asserted a SHAPE check (`typeof b.signReceipt === "function"`).
  // That check was wrong and these tests passed anyway, because a plain object
  // literal really does lack the method. The integration suite caught it: a real
  // workerd service binding is an RPC PROXY, which synthesizes a callable for
  // any property name, so the check was a tautology against the only input that
  // mattered. Detection is now a capability PROBE — see below.
  it("only absence is detectable synchronously", () => {
    expect(delegatedReceiptSignerFrom(undefined)).toBeNull();
    expect(delegatedReceiptSignerFrom(null)).toBeNull();
  });

  it("any present binding yields a signer, pending the probe", () => {
    const remote = fakeRemote({ facts: [{ actorFp: bytes(32, 1), epoch: 1 }], replies: [{ ok: true }] });
    expect(delegatedReceiptSignerFrom(remote)).toBeInstanceOf(DelegatedReceiptSigner);
    // Including one that is definitely not a signer — that is the point. The
    // question cannot be answered without calling.
    expect(delegatedReceiptSignerFrom({ fetch: async () => new Response("") }))
      .toBeInstanceOf(DelegatedReceiptSigner);
  });
});

describe("the capability probe", () => {
  it("accepts a far side returning well-formed facts", async () => {
    const remote = fakeRemote({ facts: [{ actorFp: bytes(32, 0xaa), epoch: 3 }], replies: [{ ok: true }] });
    const facts = await new DelegatedReceiptSigner(remote).probe();
    expect(facts?.epoch).toBe(3);
    expect(facts?.actorFp).toEqual(bytes(32, 0xaa));
  });

  it("rejects a binding whose receiptFacts throws (wrong entrypoint / unreachable)", async () => {
    const signer = new DelegatedReceiptSigner({
      async receiptFacts(): Promise<{ actorFp: Uint8Array; epoch: number }> {
        throw new Error("no such method");
      },
      async signReceipt() { return { ok: true as const, signature: bytes(64, 1), epoch: 1 }; },
    });
    expect(await signer.probe()).toBeNull();
  });

  it("rejects a far side answering with the wrong SHAPE", async () => {
    // A fetch-only binding answers *something*. Requiring the shape only the
    // real entrypoint produces is what separates "answered" from "answered
    // correctly" — the distinction the old check could not make.
    const wrongType = new DelegatedReceiptSigner({
      async receiptFacts() { return { actorFp: "not-bytes", epoch: 1 } as never; },
      async signReceipt() { return { ok: true as const, signature: bytes(64, 1), epoch: 1 }; },
    });
    expect(await wrongType.probe()).toBeNull();

    const wrongLength = new DelegatedReceiptSigner({
      async receiptFacts() { return { actorFp: bytes(16, 1), epoch: 1 }; },
      async signReceipt() { return { ok: true as const, signature: bytes(64, 1), epoch: 1 }; },
    });
    expect(await wrongLength.probe()).toBeNull();

    const wrongEpoch = new DelegatedReceiptSigner({
      async receiptFacts() { return { actorFp: bytes(32, 1), epoch: 1.5 }; },
      async signReceipt() { return { ok: true as const, signature: bytes(64, 1), epoch: 1 }; },
    });
    expect(await wrongEpoch.probe()).toBeNull();
  });

  it("does not leave a failed probe cached", async () => {
    // A transient failure must not poison the isolate for its lifetime.
    let calls = 0;
    const signer = new DelegatedReceiptSigner({
      async receiptFacts() {
        calls += 1;
        if (calls === 1) throw new Error("transient");
        return { actorFp: bytes(32, 0xcc), epoch: 2 };
      },
      async signReceipt() { return { ok: true as const, signature: bytes(64, 1), epoch: 2 }; },
    });
    expect(await signer.probe()).toBeNull();
    expect((await signer.probe())?.epoch).toBe(2);
  });
});

describe("facts caching", () => {
  it("reads the authority once and caches", () => {
    const remote = fakeRemote({ facts: [{ actorFp: bytes(32, 1), epoch: 4 }], replies: [{ ok: true }] });
    const signer = new DelegatedReceiptSigner(remote);
    return (async () => {
      await signer.facts();
      await signer.facts();
      await signer.facts();
      // Cached rather than polled: rotation here is alarm-driven, so polling
      // adds constant load to detect an event that announces itself.
      expect(remote.factsCalls).toBe(1);
    })();
  });

  it("re-reads after an explicit invalidation", async () => {
    const remote = fakeRemote({ facts: [{ actorFp: bytes(32, 1), epoch: 4 }], replies: [{ ok: true }] });
    const signer = new DelegatedReceiptSigner(remote);
    await signer.facts();
    signer.invalidateFacts();
    await signer.facts();
    expect(remote.factsCalls).toBe(2);
  });
});

describe("signing", () => {
  it("sends the canonical encoding of the commitment", async () => {
    const remote = fakeRemote({ facts: [{ actorFp: bytes(32, 0xaa), epoch: 1 }], replies: [{ ok: true }] });
    const signer = new DelegatedReceiptSigner(remote);
    const c = commitment();
    const out = await signer.signCommitment(c);

    expect(out.signature).toEqual(bytes(64, 0x7f));
    // notme re-encodes and requires a byte-for-byte match, so anything other
    // than the canonical encoding is rejected as NOT_CANONICAL.
    expect(remote.seen[0]).toEqual(encodeCommitment(c));
    expect(remote.signCalls).toBe(1);
  });

  it("returns the same commitment it was given when no retry happened", async () => {
    const remote = fakeRemote({ facts: [{ actorFp: bytes(32, 0xaa), epoch: 1 }], replies: [{ ok: true }] });
    const c = commitment();
    const out = await new DelegatedReceiptSigner(remote).signCommitment(c);
    expect(out.commitment).toEqual(c);
  });

  it("throws with the code on a non-retryable rejection", async () => {
    const remote = fakeRemote({
      facts: [{ actorFp: bytes(32, 0xaa), epoch: 1 }],
      replies: [{ ok: false, code: "NOT_CANONICAL" }],
    });
    await expect(new DelegatedReceiptSigner(remote).signCommitment(commitment()))
      .rejects.toThrow(DelegatedReceiptSignError);
    // Exactly one attempt — nothing but EPOCH_MISMATCH is retryable, and
    // retrying a NOT_CANONICAL would send identical bytes to identical effect.
    expect(remote.signCalls).toBe(1);
  });

  it("surfaces the code on the error rather than only in the message", async () => {
    const remote = fakeRemote({
      facts: [{ actorFp: bytes(32, 0xaa), epoch: 1 }],
      replies: [{ ok: false, code: "TIMESTAMP_OUT_OF_RANGE" }],
    });
    await new DelegatedReceiptSigner(remote).signCommitment(commitment()).then(
      () => expect.unreachable("should have thrown"),
      (e: unknown) => {
        // Branchable: an RPC rejection that stringifies leaves a caller with
        // nothing but message text, which is why notme returns a union.
        expect((e as DelegatedReceiptSignError).code).toBe("TIMESTAMP_OUT_OF_RANGE");
      },
    );
  });
});

describe("the EPOCH_MISMATCH retry", () => {
  it("re-reads facts and REBUILDS the commitment, rather than re-sending", async () => {
    const remote = fakeRemote({
      facts: [
        { actorFp: bytes(32, 0xaa), epoch: 1 },
        { actorFp: bytes(32, 0xbb), epoch: 7 },  // rotation moved underneath
      ],
      replies: [{ ok: false, code: "EPOCH_MISMATCH" }, { ok: true }],
    });
    const signer = new DelegatedReceiptSigner(remote);
    await signer.facts();                       // prime the cache with epoch 1
    await signer.signCommitment(commitment(1));

    expect(remote.signCalls).toBe(2);
    // THE POINT: the second send is different bytes, not the same bytes again.
    // A bare re-send would be rejected identically, because the stale epoch is
    // inside the signed payload.
    expect(remote.seen[1]).not.toEqual(remote.seen[0]);

    // Asserted as exact bytes rather than by decoding: this pins the encoding
    // too, so a rebuild that used the right epoch but re-encoded differently
    // still fails here rather than at notme's NOT_CANONICAL check.
    expect(remote.seen[1]).toEqual(
      encodeCommitment({ ...commitment(1), actorFp: bytes(32, 0xbb), epoch: 7 }),
    );
  });

  it("returns the commitment ACTUALLY signed, not the caller's original", async () => {
    // If this regressed, the envelope would pair the caller's stale commitment
    // with a signature computed over the rebuilt one — a receipt that fails
    // verification everywhere and explains itself nowhere.
    const remote = fakeRemote({
      facts: [
        { actorFp: bytes(32, 0xaa), epoch: 1 },
        { actorFp: bytes(32, 0xbb), epoch: 7 },
      ],
      replies: [{ ok: false, code: "EPOCH_MISMATCH" }, { ok: true }],
    });
    const signer = new DelegatedReceiptSigner(remote);
    await signer.facts();
    const out = await signer.signCommitment(commitment(1));

    expect(out.commitment.epoch).toBe(7);
    expect(out.commitment.actorFp).toEqual(bytes(32, 0xbb));
    // And the bytes signed are the encoding of exactly what came back.
    expect(remote.seen[1]).toEqual(encodeCommitment(out.commitment));
  });

  it("is bounded at ONE retry", async () => {
    const remote = fakeRemote({
      facts: [
        { actorFp: bytes(32, 0xaa), epoch: 1 },
        { actorFp: bytes(32, 0xbb), epoch: 7 },
        { actorFp: bytes(32, 0xcc), epoch: 8 },
      ],
      // Rotation moves again between the re-read and the retry.
      replies: [{ ok: false, code: "EPOCH_MISMATCH" }, { ok: false, code: "EPOCH_MISMATCH" }],
    });
    const signer = new DelegatedReceiptSigner(remote);
    await signer.facts();
    await expect(signer.signCommitment(commitment(1)))
      .rejects.toThrow(DelegatedReceiptSignError);

    // Two attempts total, then stop. Looping against a rotating authority is a
    // retry storm aimed at the one service that can least afford it.
    expect(remote.signCalls).toBe(2);
  });

  it("leaves the refreshed facts cached for the next request", async () => {
    // The retry already paid for the re-read; a subsequent request should not
    // pay again, or a single rotation would cost two round-trips per request
    // for the rest of the isolate's life.
    const remote = fakeRemote({
      facts: [
        { actorFp: bytes(32, 0xaa), epoch: 1 },
        { actorFp: bytes(32, 0xbb), epoch: 7 },
      ],
      replies: [{ ok: false, code: "EPOCH_MISMATCH" }, { ok: true }],
    });
    const signer = new DelegatedReceiptSigner(remote);
    await signer.facts();
    await signer.signCommitment(commitment(1));
    const after = await signer.facts();

    expect(after.epoch).toBe(7);
    expect(remote.factsCalls).toBe(2);  // initial + the retry's re-read; no third
  });
});
