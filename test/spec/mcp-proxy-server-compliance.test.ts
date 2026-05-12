/// <reference types="@cloudflare/vitest-pool-workers/types" />
//
// mcp-proxy-server-compliance.test.ts — the Phase 1/2/3 acceptance contract
// for cloister-as-MCP-Proxy-Server (ADR-0015; bead cloister-a2b76f).
//
// ── Why every test in this file is `.skip` ─────────────────────────────────
//
// These tests intentionally exercise spec obligations that the CURRENT
// implementation of McpProxyToolBackend does NOT satisfy. They are the
// contract Phase 1 (current-spec compliance) and Phase 2 (sessionless
// protocol per SEP-2575/2567) must satisfy when those phases land.
//
// They are skipped today because:
//   1. The lint gate (`task lint`) must stay green at 743 tests for the
//      foundation work to land without churning the inner loop.
//   2. Each failure here is BY DESIGN — it encodes the bug the phase work
//      will fix. Running them today would just confirm what we already
//      know: the implementation skips `notifications/initialized`, does
//      no version negotiation, declares an empty capabilities block, etc.
//
// Phase 1 lands: flip `.skip` → unskipped on tests 1, 2, 3, 4, 5, 8.
// Phase 2 lands: flip `.skip` → unskipped on tests 6, 7. Re-run the
//                "current" tests in `mode: "next"` configuration.
//
// ── How the fixture is wired ───────────────────────────────────────────────
//
// `FixtureMcpServer` exposes a `fetcher: typeof fetch` and a stable URL
// (`https://fixture.test/mcp`). The system-under-test is an McpProxyToolBackend
// configured with `urlBinding: "FIXTURE_URL"` (env-injected to that URL) and
// constructed with `fixture.fetcher` as its fetch implementation. The fixture
// records every inbound request and every spec violation.
//
// After driving the SUT, the test asserts on `fixture.violations` and on
// `fixture.requests`. A passing test = "the SUT met the spec obligation."
//
// ── Cross-references ───────────────────────────────────────────────────────
//
// - ADR-0015 (docs/adr/0015-mcp-spec-alignment.md) — phase plan.
// - SEP-XXXX (docs/mcp-seps/SEP-XXXX-mcp-proxy-server-formalization.md) —
//   the normative obligations these tests assert.
// - test/spec/fixture-mcp-server.ts — the fixture this file uses.
// - src/manifest/backends/mcp-proxy.ts — the current implementation.

import { afterEach, describe, expect, it } from "vitest";
import { McpProxyToolBackend } from "../../src/manifest/backends/mcp-proxy.js";
import type { Env } from "../../src/types.js";
import type { HttpForwardBackend } from "../../src/manifest/types.js";
import { FixtureMcpServer } from "./fixture-mcp-server.js";
import {
  ANONYMOUS_PEER,
  resetRootsStateForTests,
  setRoots,
} from "../../src/routes/roots-state.js";

const FIXTURE_BINDING = "FIXTURE_URL";

function envFor(fixtureUrl: string, extra: Record<string, string> = {}): Env {
  return { [FIXTURE_BINDING]: fixtureUrl, ...extra } as unknown as Env;
}

function specFor(overrides: Partial<HttpForwardBackend> = {}): HttpForwardBackend {
  return {
    urlBinding:      FIXTURE_BINDING,
    tools:           [],
    dynamicTools:    true,
    stripPrefix:     "fixture_",
    requiresSession: true,
    ...overrides,
  };
}

describe("MCP Proxy Server compliance (ADR-0015 Phase 1/2/3 contract)", () => {
  afterEach(() => {
    // Module-level roots cache leaks across tests otherwise. Reset
    // after every case so we get clean isolation.
    resetRootsStateForTests();
  });

  // ── 1. Current-protocol lifecycle: notifications/initialized ────────────
  //
  // MCP Lifecycle §3.1 step 3: after the initialize response, the client
  // MUST send `notifications/initialized` before any other RPC.
  //
  // Current cloister implementation (mcp-proxy.ts:doInitialize) does
  // NOT send this notification. The test fails today; Phase 1 work fixes it.
  it("[Phase 1] sends notifications/initialized after initialize (currently FAILS)", async () => {
    const fixture = new FixtureMcpServer({
      mode:  "current",
      tools: [{ name: "ping", description: "ping", inputSchema: { type: "object" } }],
    });
    await fixture.start();
    try {
      const backend = new McpProxyToolBackend(specFor(), "fixture_", fixture.fetcher);
      await backend.refreshTools(envFor(fixture.url));
      // Wait long enough that the initialized-window timer fires if the
      // notification never arrives.
      await new Promise(r => setTimeout(r, 100));
      const missing = fixture.violations.filter(v => v.kind === "missingNotificationsInitialized");
      expect(missing, "client must send notifications/initialized per Lifecycle §3.1").toEqual([]);
    } finally {
      await fixture.stop();
    }
  });

  // ── 2. Version negotiation ──────────────────────────────────────────────
  //
  // SEP §3 Obligation 2: if an upstream returns an incompatible
  // protocolVersion, the proxy MUST mark that upstream as unreachable
  // rather than silently fall back.
  //
  // Current implementation does no version check at all — it accepts
  // whatever the upstream returns and proceeds. Phase 1 work adds the
  // negotiation.
  it("[Phase 1] marks upstream unreachable on incompatible protocolVersion", async () => {
    const fixture = new FixtureMcpServer({
      mode:                 "current",
      tools:                [{ name: "ping" }],
      forceProtocolVersion: "1999-01-01", // deliberately ancient
    });
    await fixture.start();
    try {
      const backend = new McpProxyToolBackend(specFor(), "fixture_", fixture.fetcher);
      await backend.refreshTools(envFor(fixture.url));
      // After version mismatch, the backend should not have populated
      // any derived tools (the upstream is effectively unreachable from
      // the proxy's perspective).
      expect(backend.tools()).toEqual([]);
    } finally {
      await fixture.stop();
    }
  });

  // ── 3. Capability declaration on the client side ────────────────────────
  //
  // MCP Lifecycle §3.1 + §4: the client MUST declare its capabilities in
  // the initialize request. Current implementation sends `capabilities: {}`
  // — an empty object that declares nothing.
  //
  // Phase 1 work surfaces what cloister-as-client supports (at minimum, a
  // non-empty marker for "I am a proxy aggregating upstreams").
  it("[Phase 1] initialize request declares non-empty client capabilities", async () => {
    const fixture = new FixtureMcpServer({ mode: "current", tools: [] });
    await fixture.start();
    try {
      const backend = new McpProxyToolBackend(specFor(), "fixture_", fixture.fetcher);
      await backend.refreshTools(envFor(fixture.url));
      const empty = fixture.violations.filter(v => v.kind === "emptyCapabilities");
      expect(empty, "initialize must declare non-empty capabilities").toEqual([]);
    } finally {
      await fixture.stop();
    }
  });

  // ── 4. Session ID lifecycle: echo + re-init on expiry ───────────────────
  //
  // Two sub-obligations.
  //
  // (a) After initialize, every subsequent request MUST carry the
  //     `Mcp-Session-Id` header echoed back by the upstream. Current code
  //     does echo (requestHeaders() in mcp-proxy.ts). This assertion is
  //     here to lock that property under the new fixture.
  //
  // (b) If the upstream returns a 4xx "session expired" response, the
  //     proxy MUST re-initialize (full lifecycle, including
  //     notifications/initialized) — not just retry the call with the
  //     old session ID. Current code resets sessionId and retries but
  //     skips notifications/initialized on the re-init. Phase 1 fix.
  it("[Phase 1] echoes Mcp-Session-Id on every call AND re-inits on session expiry", async () => {
    const fixture = new FixtureMcpServer({
      mode:                    "current",
      tools:                   [{ name: "ping" }],
      expireSessionOnNextCall: false,
    });
    await fixture.start();
    try {
      const backend = new McpProxyToolBackend(specFor(), "fixture_", fixture.fetcher);
      await backend.refreshTools(envFor(fixture.url));

      // First refresh completed; now force the next call to see
      // "session expired" and require re-initialize.
      // (Setter is internal to the fixture; tests of the real Phase 1
      // impl will reach into the fixture to flip it. For Phase 0 we
      // document the obligation; the assertion below is what Phase 1
      // satisfies.)

      // After ANY non-initialize request, fixture should not have
      // recorded a missingMcpSessionId violation.
      const missingSid = fixture.violations.filter(v => v.kind === "missingMcpSessionId");
      expect(missingSid, "Mcp-Session-Id must be echoed on every post-init call").toEqual([]);

      // The fixture-violation table should also be clear of missing-init
      // entries — every initialize cycle (the first AND any re-init)
      // completed lifecycle including notifications/initialized.
      const missingInit = fixture.violations.filter(
        v => v.kind === "missingInitialize" || v.kind === "missingNotificationsInitialized",
      );
      expect(missingInit, "every initialize must be followed by notifications/initialized").toEqual([]);
    } finally {
      await fixture.stop();
    }
  });

  // ── 5. Token-passthrough prohibition ────────────────────────────────────
  //
  // SEP §3 Obligation 3 / Security Best Practices token-passthrough
  // prohibition: the proxy MUST NOT forward client-issued credentials to
  // upstreams. The proxy is its own audience; it obtains its own
  // credentials for each upstream.
  //
  // Today cloister doesn't forward Authorization (the McpEdgeRoute call
  // path strips it), but there is no test asserting this property at the
  // upstream boundary. Phase 1 work adds the explicit check + assertion.
  it("[Phase 1] does not forward client-issued Authorization tokens to upstream", async () => {
    const marker = "CLIENT-TOKEN-MUST-NEVER-LEAK-9e3a";
    const fixture = new FixtureMcpServer({
      mode:              "current",
      tools:             [{ name: "ping" }],
      passthroughMarker: marker,
    });
    await fixture.start();
    try {
      // Simulate: a client called cloister with `Authorization: Bearer <marker>`.
      // The backend, fetching upstream tools/list, MUST NOT forward that.
      // (In production code path the env wouldn't carry the client's bearer
      // token, but the fixture asserts the outbound shape regardless of source.)
      const backend = new McpProxyToolBackend(specFor(), "fixture_", fixture.fetcher);
      await backend.refreshTools(envFor(fixture.url));
      const leaks = fixture.violations.filter(v => v.kind === "tokenPassthrough");
      expect(leaks, "client-issued token must not reach upstream").toEqual([]);
    } finally {
      await fixture.stop();
    }
  });

  // ── 6. Sessionless protocol: per-request MCP-Protocol-Version header ────
  //
  // SEP-2575 (Accepted) removed `initialize` and replaced it with a
  // per-request `MCP-Protocol-Version` header plus `_meta` clientInfo /
  // clientCapabilities / protocolVersion inline.
  //
  // Phase 2 implements the sessionless path for upstreams advertising
  // SEP-2575 support. Current implementation knows nothing about this.
  it("[Phase 2] sessionless mode: every request carries MCP-Protocol-Version header", async () => {
    const fixture = new FixtureMcpServer({
      mode:  "next",
      tools: [{ name: "ping" }],
    });
    await fixture.start();
    try {
      const backend = new McpProxyToolBackend(
        // Phase 2 (cloister-a35fdb): `protocolMode: "next"` flips the
        // backend into the sessionless code path (SEP-2575 + SEP-2567).
        specFor({ requiresSession: false, protocolMode: "next" }),
        "fixture_",
        fixture.fetcher,
      );
      await backend.refreshTools(envFor(fixture.url));
      const missingHeader = fixture.violations.filter(v => v.kind === "missingProtocolVersionHeader");
      const missingMeta   = fixture.violations.filter(v => v.kind === "missingMetaClientInfo");
      expect(missingHeader, "MCP-Protocol-Version header required per request (SEP-2575)").toEqual([]);
      expect(missingMeta,   "_meta clientInfo/clientCapabilities/protocolVersion required (SEP-2575)").toEqual([]);
    } finally {
      await fixture.stop();
    }
  });

  // ── 7. Sessionless protocol: `server/discover` ──────────────────────────
  //
  // SEP-2575 introduces `server/discover` as the introspection RPC that
  // replaces capability negotiation via `initialize`. A Phase 2-compliant
  // proxy uses it to populate the upstream's serverInfo + capabilities for
  // `proxy/upstreams`.
  it("[Phase 2] sessionless mode: calls server/discover instead of initialize", async () => {
    const fixture = new FixtureMcpServer({
      mode:  "next",
      tools: [{ name: "ping" }],
    });
    await fixture.start();
    try {
      const backend = new McpProxyToolBackend(
        specFor({ requiresSession: false, protocolMode: "next" }),
        "fixture_",
        fixture.fetcher,
      );
      await backend.refreshTools(envFor(fixture.url));
      const initCalls = fixture.requests.filter(
        r => (r.body as { method?: string } | null)?.method === "initialize",
      );
      const discoverCalls = fixture.requests.filter(
        r => (r.body as { method?: string } | null)?.method === "server/discover",
      );
      expect(initCalls, "next-protocol mode must not call initialize").toEqual([]);
      expect(discoverCalls.length, "next-protocol mode must call server/discover").toBeGreaterThan(0);
    } finally {
      await fixture.stop();
    }
  });

  // ── 8. Tool aggregation with namespacing ────────────────────────────────
  //
  // Per SEP §1 (`namespacing: "prefix"`) and §5 (tools/list aggregation),
  // a proxy aggregating N upstream tools advertises them with prefix
  // applied. Cloister already does this (handlesPrefix); the test locks
  // the behavior under the new fixture so the Phase 1 rename doesn't
  // regress it.
  it("[Phase 1] aggregates upstream tools/list under the configured prefix", async () => {
    const fixture = new FixtureMcpServer({
      mode:  "current",
      tools: [
        { name: "alpha" },
        { name: "beta" },
        { name: "gamma" },
      ],
    });
    await fixture.start();
    try {
      const backend = new McpProxyToolBackend(specFor(), "fixture_", fixture.fetcher);
      await backend.refreshTools(envFor(fixture.url));
      const names = backend.tools().map(t => t.name).sort();
      expect(names).toEqual(["fixture_alpha", "fixture_beta", "fixture_gamma"]);
    } finally {
      await fixture.stop();
    }
  });

  // ── 9. Roots primitive: capability forwarded to upstream ────────────────
  //
  // MCP 2025-06-18 §Client Features → Roots: a proxy that exposes roots
  // to its upstreams MUST declare `capabilities.roots = { listChanged: true }`
  // on its outgoing `initialize`. Cloister announces this because it
  // intermediates the external client's roots view and can fan
  // list-changed notifications onward.
  it("[Phase 1+] forwards roots capability on upstream initialize", async () => {
    const fixture = new FixtureMcpServer({
      mode:  "current",
      tools: [{ name: "ping" }],
    });
    await fixture.start();
    try {
      const backend = new McpProxyToolBackend(specFor(), "fixture_", fixture.fetcher);
      await backend.refreshTools(envFor(fixture.url));
      const initReq = fixture.requests.find(
        r => (r.body as { method?: string } | null)?.method === "initialize",
      );
      expect(initReq, "fixture should have seen an initialize request").toBeDefined();
      const params = (initReq!.body as { params?: { capabilities?: { roots?: { listChanged?: boolean } } } }).params;
      expect(params?.capabilities?.roots).toEqual({ listChanged: true });
    } finally {
      await fixture.stop();
    }
  });

  // ── 10. Roots primitive: upstream roots/list answered from peer cache ───
  //
  // The upstream emits a `roots/list` request mid-`tools/call`. Cloister
  // reads the SSE multi-message stream, dispatches the reverse-RPC to its
  // per-peer `RootsState` cache, and POSTs a response back to the upstream
  // matching the request id. Then it picks the actual `tools/call`
  // response off the stream and returns the tool result.
  it("[Phase 1+] answers upstream roots/list with captured peer state", async () => {
    setRoots(ANONYMOUS_PEER, [
      { uri: "file:///workspace/project-a", name: "Project A" },
      { uri: "file:///workspace/project-b", name: "Project B" },
    ]);
    const fixture = new FixtureMcpServer({
      mode:                 "current",
      tools:                [{ name: "ping" }],
      emitRootsListMidCall: true,
    });
    await fixture.start();
    try {
      const backend = new McpProxyToolBackend(specFor(), "fixture_", fixture.fetcher);
      await backend.refreshTools(envFor(fixture.url));
      // tools/call now triggers the SSE mid-call roots/list emission.
      // The peerFp passed in is the anonymous sentinel because tests
      // don't run the lease pipeline.
      const out = await backend.invoke("fixture_ping", {}, envFor(fixture.url), ANONYMOUS_PEER);
      expect(out).toEqual({ ok: true, tool: "ping" });

      expect(
        fixture.reverseRpcResponses.length,
        "SUT must POST exactly one reverse-RPC response to roots/list",
      ).toBe(1);
      const reply = fixture.reverseRpcResponses[0]!;
      expect(reply.error, "roots/list must answer with result, not error").toBeUndefined();
      expect(reply.result).toEqual({
        roots: [
          { uri: "file:///workspace/project-a", name: "Project A" },
          { uri: "file:///workspace/project-b", name: "Project B" },
        ],
      });
    } finally {
      await fixture.stop();
    }
  });

  // ── 11. Roots primitive: empty list when peer has no state ──────────────
  //
  // Same flow as the previous test, but the peer never declared any
  // roots. The reverse-RPC response must still arrive (the upstream is
  // waiting on it), with an empty `roots: []` payload.
  it("[Phase 1+] answers upstream roots/list with empty array when peer has none", async () => {
    const fixture = new FixtureMcpServer({
      mode:                 "current",
      tools:                [{ name: "ping" }],
      emitRootsListMidCall: true,
    });
    await fixture.start();
    try {
      const backend = new McpProxyToolBackend(specFor(), "fixture_", fixture.fetcher);
      await backend.refreshTools(envFor(fixture.url));
      const out = await backend.invoke("fixture_ping", {}, envFor(fixture.url), ANONYMOUS_PEER);
      expect(out).toEqual({ ok: true, tool: "ping" });

      expect(fixture.reverseRpcResponses.length).toBe(1);
      expect(fixture.reverseRpcResponses[0]!.result).toEqual({ roots: [] });
    } finally {
      await fixture.stop();
    }
  });

  // ── 12. Roots primitive: list_changed notification fan-out ──────────────
  //
  // `notifyRootsChanged` POSTs `notifications/roots/list_changed` to the
  // upstream. Notifications carry no `id` and expect no response; the
  // assertion is purely on the outbound wire: the upstream saw the
  // notification arrive on its endpoint.
  it("[Phase 1+] fans notifications/roots/list_changed to upstream", async () => {
    const fixture = new FixtureMcpServer({
      mode:  "current",
      tools: [{ name: "ping" }],
    });
    await fixture.start();
    try {
      const backend = new McpProxyToolBackend(specFor(), "fixture_", fixture.fetcher);
      // Prime the session so the notification can ride the upstream's
      // initialized session table (legacy mode requires it).
      await backend.refreshTools(envFor(fixture.url));
      await backend.notifyRootsChanged(envFor(fixture.url));
      const notify = fixture.requests.find(
        r => (r.body as { method?: string } | null)?.method === "notifications/roots/list_changed",
      );
      expect(notify, "fixture must see notifications/roots/list_changed").toBeDefined();
      // Notifications MUST NOT carry an `id` field per JSON-RPC §4.1.5.
      expect((notify!.body as { id?: unknown }).id).toBeUndefined();
    } finally {
      await fixture.stop();
    }
  });
});
