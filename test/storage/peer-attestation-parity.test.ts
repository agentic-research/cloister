/// <reference types="@cloudflare/vitest-pool-workers/types" />
//
// peer_attestations parity vs. Interlace 0.1.0 spec test vectors
// (cloister-fff647 / threat-model §7.7).
//
// The lease-counter chain is verified against the spec at
// `test-vectors/lease-counter.json` by the existing parity test in
// `test/trust-store.test.ts` (cloister-ee51b8). The peer-attestation
// chain needs the same rigor against `test-vectors/peer-attestation.json`
// — different chain, same byte-level contract.
//
// What the spec pins for peer_attestations (per the vector's
// `$comment` + `chain[]` rows):
//
//   1. PRIMARY KEY (peer_fingerprint, seq) — sequence is per-peer
//      monotonic. genesis_row.seq == 1; second_row.seq == 2; third_row.seq == 3.
//      Each row's seq is the prior row's seq + 1.
//
//   2. prev_self_ref invariant — row N's prev_self_ref MUST equal row
//      (N-1)'s content_hash exactly. genesis has prev_self_ref = null.
//
//   3. content_hash is opaque to the attestation step — the spec uses
//      placeholders (0x1111..., 0x2222..., 0x3333...) because the
//      digest comes from the upstream state-write encoder
//      (bead-canonical.ts in cloister), not from the chain step.
//      The attestation chain's job is to PRESERVE these bytes
//      faithfully across (peer, seq) rows.
//
//   4. per-peer scoping — prev_self_ref MUST chain over the same peer's
//      prior row only. A "globally chained" prev_self_ref across all
//      peers is an `implementation_bug` per the vector's
//      `rejection_cases[1]`.
//
// What the spec does NOT pin: the cert + sig bytes. Those are
// placeholder strings in the vector ("cert_full DER, base64-std" /
// "Ed25519 sig"). A full byte-exact vector for those would require an
// Ed25519 signing oracle (the spec defers that to the ref-impl). The
// chain-layout vectors are still load-bearing for the chain machinery
// itself; the signing-oracle vectors are a separate concern.

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyAttestation } from "../../src/storage/peer-attestations.js";
import peerAttestationSpec from "../../interlace-spec/0.1.0/test-vectors/peer-attestation.json";

interface SpecRow {
  peer_fingerprint: string;
  seq:              number;
  prev_self_ref:    string | null;
  prev_peer_ref:    string | null;
  content_hash:     string;
  content_type:     string;
  scope:            string;
  created_at:       number;
}

interface SpecChainStep {
  seq:         number;
  name:        string;
  description: string;
  row:         SpecRow;
}

const SPEC = peerAttestationSpec as {
  chain: SpecChainStep[];
};

// Spec stand-ins for the placeholder cert + sig bytes. The vector
// elides those because byte-exact cert/sig would require an Ed25519
// signing oracle; the chain-layout invariants are independent of
// those bytes. We use deterministic stand-ins so the cloister-side
// row reads back stable.
const CERT_STANDIN = new Uint8Array([0xCA, 0xFE, 0xBE, 0xEF]);
const SIG_STANDIN  = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);

let counter = 0;
function freshStub() {
  return env.TRUST_STORE.get(
    env.TRUST_STORE.idFromName(`peer-attestation-parity-${counter++}-${Math.random()}`),
  );
}

describe("peer-attestation parity vs interlace-spec/0.1.0/peer-attestation.json", () => {
  it("chain has the expected three steps (genesis -> middle -> late)", () => {
    // Sanity guard: if the spec file ever drops below 3 rows the
    // recursive case isn't exercised. Spec contract — fail loud.
    expect(SPEC.chain.length).toBeGreaterThanOrEqual(3);
    expect(SPEC.chain[0]!.row.seq).toBe(1);
    expect(SPEC.chain[0]!.row.prev_self_ref).toBeNull();
  });

  it("replays the spec chain through applyAttestation; rows are byte-identical to spec", async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_, state) => {
      const sql = state.storage.sql;
      // Walk the spec chain step-by-step. The cloister chain builder
      // is `applyAttestation`; we feed it the spec inputs verbatim and
      // assert the returned row matches the spec row field-by-field.
      const computedRows: Array<ReturnType<typeof applyAttestation>> = [];
      for (const step of SPEC.chain) {
        const result = applyAttestation(sql, {
          peerFingerprint: step.row.peer_fingerprint,
          contentHash:     step.row.content_hash,
          contentType:     step.row.content_type,
          scope:           step.row.scope,
          cert:            CERT_STANDIN,
          sig:             SIG_STANDIN,
          prevSelfRef:     step.row.prev_self_ref,
          prevPeerRef:     step.row.prev_peer_ref,
          nowMs:           step.row.created_at,
        });
        computedRows.push(result);
      }

      // Every step must have written cleanly — `ok: true` is the spec
      // expectation for in-order, prev-ref-correct insertions.
      for (let i = 0; i < computedRows.length; i++) {
        const r = computedRows[i]!;
        if (!r.ok) {
          throw new Error(
            `spec chain step ${i + 1} (${SPEC.chain[i]!.name}) failed unexpectedly: ` +
            `${r.error} — expected=${r.expected} got=${r.got}. ` +
            `The spec is the byte-level contract; do NOT auto-fix the spec — ` +
            `investigate whether cloister's prev_self_ref handling diverged.`,
          );
        }
      }

      // ── Per-row byte-identity assertions ──────────────────────────
      // The spec is the load-bearing artifact. Each row's seq,
      // prev_self_ref, prev_peer_ref, content_hash, content_type,
      // scope, and created_at MUST match byte-for-byte. If any of
      // these fail, do NOT change the spec — the spec is the
      // Interlace 0.1.0 protocol contract. Investigate which side
      // diverged, file a sub-bead, and stop.
      for (let i = 0; i < SPEC.chain.length; i++) {
        const spec = SPEC.chain[i]!.row;
        const got  = computedRows[i]!;
        if (!got.ok) throw new Error("unreachable — checked above");
        expect(got.row.peer_fingerprint).toBe(spec.peer_fingerprint);
        expect(got.row.seq             ).toBe(spec.seq);
        expect(got.row.prev_self_ref   ).toBe(spec.prev_self_ref);
        expect(got.row.prev_peer_ref   ).toBe(spec.prev_peer_ref);
        expect(got.row.content_hash    ).toBe(spec.content_hash);
        expect(got.row.content_type    ).toBe(spec.content_type);
        expect(got.row.scope           ).toBe(spec.scope);
        expect(got.row.created_at      ).toBe(spec.created_at);
      }

      // ── Recursive case: row 3's prev_self_ref MUST trace back
      //   through row 2 to row 1. This is the contract invariant
      //   that distinguishes per-peer chaining from a global hash
      //   chain (rejection_cases[1] in the spec, called out as an
      //   `implementation_bug`).
      const r3 = computedRows[2]!;
      if (!r3.ok) throw new Error("unreachable — checked above");
      expect(r3.row.prev_self_ref).toBe(SPEC.chain[1]!.row.content_hash);
      const r2 = computedRows[1]!;
      if (!r2.ok) throw new Error("unreachable — checked above");
      expect(r2.row.prev_self_ref).toBe(SPEC.chain[0]!.row.content_hash);
      expect(SPEC.chain[0]!.row.prev_self_ref).toBeNull();
    });
  });

  it("genesis row writes with prev_self_ref = null exactly (not undefined, not empty string)", async () => {
    // The spec is unambiguous: `prev_self_ref` is `null` at genesis.
    // An implementation that wrote empty-string or undefined would
    // diverge from the spec and break verifier round-trip. Pin it
    // explicitly here so future refactors can't silently flip it.
    const stub = freshStub();
    await runInDurableObject(stub, async (_, state) => {
      const sql = state.storage.sql;
      const genesis = SPEC.chain[0]!.row;
      const r = applyAttestation(sql, {
        peerFingerprint: genesis.peer_fingerprint,
        contentHash:     genesis.content_hash,
        contentType:     genesis.content_type,
        scope:           genesis.scope,
        cert:            CERT_STANDIN,
        sig:             SIG_STANDIN,
        prevSelfRef:     null,
        prevPeerRef:     null,
        nowMs:           genesis.created_at,
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.row.prev_self_ref).toBeNull();
        expect(r.row.seq          ).toBe(1);
      }
    });
  });

  it("wrong_prev_self_ref rejection_case: chain rejects fork attempt + writes nothing", async () => {
    // Spec rejection_cases[0]: caller submits seq=2 with
    // prev_self_ref=0xdead... when the chain head is genesis's
    // content_hash. Cloister MUST return `prev_self_ref_mismatch`
    // and write nothing.
    const stub = freshStub();
    await runInDurableObject(stub, async (_, state) => {
      const sql = state.storage.sql;
      const genesis = SPEC.chain[0]!.row;
      // Genesis lands cleanly.
      applyAttestation(sql, {
        peerFingerprint: genesis.peer_fingerprint,
        contentHash:     genesis.content_hash,
        contentType:     genesis.content_type,
        scope:           genesis.scope,
        cert:            CERT_STANDIN,
        sig:             SIG_STANDIN,
        prevSelfRef:     null,
        prevPeerRef:     null,
        nowMs:           genesis.created_at,
      });
      // Attempt seq=2 with wrong prev_self_ref.
      const bad = applyAttestation(sql, {
        peerFingerprint: genesis.peer_fingerprint,
        contentHash:     SPEC.chain[1]!.row.content_hash,
        contentType:     SPEC.chain[1]!.row.content_type,
        scope:           SPEC.chain[1]!.row.scope,
        cert:            CERT_STANDIN,
        sig:             SIG_STANDIN,
        prevSelfRef:     "d".repeat(64),                  // wrong
        prevPeerRef:     null,
        nowMs:           SPEC.chain[1]!.row.created_at,
      });
      expect(bad.ok).toBe(false);
      if (!bad.ok) {
        expect(bad.error).toBe("prev_self_ref_mismatch");
        expect(bad.expected).toBe(genesis.content_hash);
        expect(bad.got     ).toBe("d".repeat(64));
      }
      // Spec demands `reject_no_row_written` — assert the chain has
      // exactly one row (the genesis we just wrote), no forked row.
      const countRows = sql
        .exec(
          `SELECT COUNT(*) AS n FROM peer_attestations WHERE peer_fingerprint = ?`,
          genesis.peer_fingerprint,
        )
        .toArray()[0]!;
      expect(Number(countRows["n"])).toBe(1);
    });
  });
});
