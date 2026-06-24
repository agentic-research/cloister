/// <reference types="@cloudflare/vitest-pool-workers/types" />
//
// Integration test: full bead-create orchestrator with BEAD_STORAGE_BACKEND="rsry".
//
// Closes the test-coverage gap left by sub-bead 2 (cloister-decf0d):
// the unit tests in `test/routes/bead-create-orchestrator-backend.test.ts`
// pin the rsry-wire and resolver in isolation, but the full orchestrator
// pipeline (BlobStore.put → rsry → TrustStore.applyAttestation with
// bead_id link) was untested end-to-end.
//
// This file pins the LOAD-BEARING property of the c8b907 migration:
// the §13.4 audit chain reconstitutes through the rsry mode. Specifically:
//
//   1. Step 1 (BlobStore.put) runs against the real BlobStore DO.
//   2. Step 2 (rsry-mode) calls rsry's MCP `rsry_bead_create` via a stub
//      ROSARY_BUNDLE Fetcher; the stub returns a synthetic bead row.
//   3. Step 3 (TrustStore.applyAttestation) lands an attestation row
//      with bead_id = the synthetic id from rsry's response.
//   4. Query the TrustStore via attestationsForBead(bead_id) and verify
//      the row exists with the expected content_hash.
//
// Without this test, sub-bead 2 (decf0d) could silently regress at the
// integration layer (e.g. orchestrator forgetting to thread beadId
// through to applyAttestation in the rsry branch) without any signal.

import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  runBeadCreateOrchestrator,
  __resetBeadStoreDoWarnedForTest,
} from "../../src/routes/bead-create-orchestrator.js";
import { attestationsForBead } from "../../src/storage/peer-attestations.js";
import type { Env } from "../../src/types.js";

// ── Stub ROSARY_BUNDLE Fetcher (returns a fake rsry_bead_create result) ─

function makeRsryStub(syntheticId: string): {
  fetcher: Fetcher;
  callCount: () => number;
} {
  let calls = 0;
  const fetcher: Fetcher = {
    async fetch(req: RequestInfo | URL): Promise<Response> {
      calls++;
      // Sanity-check the inbound shape — should be MCP tools/call to
      // rsry_bead_create. Failing here surfaces an orchestrator regression
      // as a test failure rather than a silent wrong call.
      const r = req instanceof Request ? req : new Request(req);
      const body = JSON.parse(await r.text()) as {
        method: string;
        params: { name: string; arguments: Record<string, unknown> };
      };
      if (body.method !== "tools/call") {
        return new Response(`expected tools/call, got ${body.method}`, { status: 400 });
      }
      if (body.params.name !== "rsry_bead_create") {
        return new Response(`expected rsry_bead_create, got ${body.params.name}`, { status: 400 });
      }
      // Return synthetic MCP-shaped success.
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 0,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  id: syntheticId,
                  title: body.params.arguments.title ?? "stub-title",
                  state: "open",
                }),
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  } as unknown as Fetcher;
  return { fetcher, callCount: () => calls };
}

// ── Context fixture (a verified lease's shape) ──────────────────────────

const CERT = new Uint8Array([0xCA, 0xFE]);
const SIG  = new Uint8Array([0xBA, 0xBE]);

function ctx(peerFp: string): {
  peerFp:  string;
  scope:   string;
  certDer: Uint8Array;
  sig:     Uint8Array;
} {
  return {
    peerFp,
    scope:   "bead_create:/r/test",
    certDer: CERT,
    sig:     SIG,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("orchestrator rsry-mode integration (cloister-decf0d + dea77c)", () => {
  // The deprecation-warning one-shot flag is module-level; reset between
  // tests so the do-mode case observes a fresh fire.
  afterEach(() => {
    __resetBeadStoreDoWarnedForTest();
  });

  it("rsry-mode: full chain lands a TrustStore attestation with bead_id linking to rsry's synthetic id", async () => {
    const peerFp = `sha256:rsry-mode-${Math.random()}`;
    const syntheticBeadId = `cloister-rsry-${Math.random().toString(36).slice(2, 10)}`;
    const { fetcher, callCount } = makeRsryStub(syntheticBeadId);

    // Custom env spread: real DOs + stub ROSARY_BUNDLE + flag set.
    const customEnv = {
      ...env,
      BEAD_STORAGE_BACKEND: "rsry",
      ROSARY_BUNDLE: fetcher,
    } as unknown as Env;

    const result = await runBeadCreateOrchestrator({
      toolArgs: { repo: "/tmp/rsry-test", title: "integration test bead" },
      env: customEnv,
      context: ctx(peerFp),
      nowMs: 1_000_000,
    });

    // rsry was called.
    expect(callCount()).toBe(1);
    // The orchestrator returns rsry's synthetic id, not a fresh one.
    expect(result.id).toBe(syntheticBeadId);

    // The §13.4 audit chain landed: query TrustStore by bead_id and find
    // the attestation with content_hash matching the BlobStore digest.
    const trustStub = env.TRUST_STORE.get(env.TRUST_STORE.idFromName("cluster"));
    await runInDurableObject(trustStub, async (_, state) => {
      const rows = attestationsForBead(state.storage.sql, syntheticBeadId);
      expect(rows.length).toBe(1);
      expect(rows[0]!.bead_id).toBe(syntheticBeadId);
      expect(rows[0]!.content_hash).toBe(result.content_hash);
      expect(rows[0]!.peer_fingerprint).toBe(peerFp);
    });
  });

  it("do-mode (default): full chain ALSO lands a TrustStore attestation with bead_id (sub-bead 1 wired the legacy path too)", async () => {
    // Symmetry test: the bead_id column gets populated on the LEGACY path
    // too — sub-bead 1's orchestrator thread runs regardless of which
    // backend produced the bead row. Pin this so a future refactor that
    // forgets to thread bead_id through the "do" branch surfaces here.
    const peerFp = `sha256:do-mode-${Math.random()}`;
    // No BEAD_STORAGE_BACKEND set → defaults to "do". No ROSARY_BUNDLE
    // stub needed — the legacy path goes to BeadStore DO.
    const customEnv = env as unknown as Env;

    const result = await runBeadCreateOrchestrator({
      toolArgs: { repo: "/tmp/do-test", title: "legacy path bead" },
      env: customEnv,
      context: ctx(peerFp),
      nowMs: 2_000_000,
    });

    const trustStub = env.TRUST_STORE.get(env.TRUST_STORE.idFromName("cluster"));
    await runInDurableObject(trustStub, async (_, state) => {
      const rows = attestationsForBead(state.storage.sql, result.id);
      expect(rows.length).toBe(1);
      expect(rows[0]!.bead_id).toBe(result.id);
      expect(rows[0]!.content_hash).toBe(result.content_hash);
      expect(rows[0]!.peer_fingerprint).toBe(peerFp);
    });
  });

  it("rsry-mode honors §13.4 short-circuit: when rsry returns an error, NO TrustStore write happens", async () => {
    const peerFp = `sha256:rsry-short-circuit-${Math.random()}`;
    // Stub returns a JSON-RPC error — orchestrator should throw + skip Step 3.
    const broken: Fetcher = {
      async fetch(): Promise<Response> {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 0,
            error: { code: -32602, message: "rsry refused" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    } as unknown as Fetcher;
    const customEnv = {
      ...env,
      BEAD_STORAGE_BACKEND: "rsry",
      ROSARY_BUNDLE: broken,
    } as unknown as Env;

    await expect(
      runBeadCreateOrchestrator({
        toolArgs: { repo: "/tmp", title: "x" },
        env: customEnv,
        context: ctx(peerFp),
        nowMs: 3_000_000,
      }),
    ).rejects.toThrow(/rsry refused/);

    // Verify the peer has NO attestation chain entry — Step 3 was skipped.
    const trustStub = env.TRUST_STORE.get(env.TRUST_STORE.idFromName("cluster"));
    await runInDurableObject(trustStub, async (_, state) => {
      const rows = state.storage.sql.exec(
        "SELECT * FROM peer_attestations WHERE peer_fingerprint = ?",
        peerFp,
      ).toArray();
      expect(rows.length).toBe(0);
    });
  });

  // ── cloister-f34f7b: deprecation-warning fire on legacy do-mode ────────

  it("do-mode emits exactly ONE structured deprecation warning across multiple bead_create calls (c8b907 sub-bead 3 prep)", async () => {
    // Capture console.warn. Three back-to-back do-mode calls should
    // produce exactly ONE deprecation warning (module-level one-shot).
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = ((arg: unknown) => {
      if (typeof arg === "string") warnings.push(arg);
    }) as typeof console.warn;
    try {
      const customEnv = env as unknown as Env;
      for (let i = 0; i < 3; i++) {
        await runBeadCreateOrchestrator({
          toolArgs: { repo: `/tmp/depwarn-${i}`, title: `bead ${i}` },
          env: customEnv,
          context: ctx(`sha256:depwarn-${Math.random()}-${i}`),
          nowMs: 4_000_000 + i,
        });
      }
    } finally {
      console.warn = orig;
    }

    // Filter to deprecation events only (other unrelated warnings may
    // appear in the workerd pool — rate-limit emits etc.).
    const deprecationEmits = warnings.filter((w) => {
      try {
        return JSON.parse(w).event === "bead_create.legacy_backend";
      } catch {
        return false;
      }
    });
    expect(deprecationEmits.length).toBe(1);

    // Structured payload pinned: operators alerting on this event need
    // the fields to remain stable.
    const emit = JSON.parse(deprecationEmits[0]!);
    expect(emit.event).toBe("bead_create.legacy_backend");
    expect(emit.backend).toBe("do");
    expect(emit.parent_epic).toBe("cloister-c8b907");
    expect(emit.deprecation).toMatch(/cloister-f34f7b/);
    expect(emit.actionable).toMatch(/BEAD_STORAGE_BACKEND="rsry"/);
    expect(emit.related_adr).toMatch(/ADR-0033/);
  });

  it("rsry-mode does NOT emit the deprecation warning (only do-mode triggers it)", async () => {
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = ((arg: unknown) => {
      if (typeof arg === "string") warnings.push(arg);
    }) as typeof console.warn;
    try {
      const peerFp = `sha256:rsry-nowarn-${Math.random()}`;
      const syntheticId = `cloister-${Math.random().toString(36).slice(2, 10)}`;
      const { fetcher } = makeRsryStub(syntheticId);
      const customEnv = {
        ...env,
        BEAD_STORAGE_BACKEND: "rsry",
        ROSARY_BUNDLE: fetcher,
      } as unknown as Env;
      await runBeadCreateOrchestrator({
        toolArgs: { repo: "/tmp/rsry-nowarn", title: "should-not-warn" },
        env: customEnv,
        context: ctx(peerFp),
        nowMs: 5_000_000,
      });
    } finally {
      console.warn = orig;
    }

    const deprecationEmits = warnings.filter((w) => {
      try {
        return JSON.parse(w).event === "bead_create.legacy_backend";
      } catch {
        return false;
      }
    });
    expect(deprecationEmits.length).toBe(0);
  });
});
