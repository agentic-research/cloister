/// <reference types="@cloudflare/vitest-pool-workers/types" />
//
// Conformance for credential-isolation/v1's reserved-response-header vector
// (cloister-d97415), driven by the vendored cases.
//
// The vector pins two things a second implementation gets wrong in opposite
// directions: passing upstream's `Server: nginx/1.23` through (leaking which
// upstream answered), or failing to stamp the proxy's own identity at all.
//
// ── Scope: `Server` here, `Interlace-Receipt` NOT here ───────────────────────
//
// The vector names two reserved headers. Only one is implementable today.
//
// `Interlace-Receipt` is a signed CBOR envelope — src/wire/receipts.ts signs
// the commitment with cloister's MASTER Ed25519 key. The vault-proxy handler
// has no access to that key, and wiring one in is the trust-root question
// currently open across cloister-0c8173 and ley-line-open's --trust-root work.
// Note it is also distinct from the `ProxyCallReceipt` this route already
// emits: that one goes to an audit sink, this one rides the response.
//
// So `vaultProxyHandler`'s doc comment ("with a signed Interlace-Receipt header
// attached") describes an unimplemented behaviour. The vector's own expected
// value is the placeholder `<receipt-base64url-set-by-proxy>`, so it pins the
// header's PRESENCE and not its bytes — but presence still needs the key.
// Asserted below as an explicit known-gap so the omission is visible rather
// than looking like nobody read the vector.

import { describe, expect, it } from "vitest";
import reservedVectors from "../fixtures/llo-credential-isolation-v1/test-vectors/reserved-response-headers.json";
import {
  collapseWireShape,
  PROXY_SERVER_HEADER_VALUE,
  RESERVED_RESPONSE_HEADERS,
} from "../../src/routes/vault-proxy";

const [reservedSet, passThrough] = reservedVectors.vectors;

describe("LLO reserved-response-headers vectors", () => {
  it("vendors the cases this suite claims to drive", () => {
    expect(reservedVectors.vectors.length).toBe(2);
    expect(reservedVectors.version).toBe("cloister/credential-isolation/v1");
  });

  it(`${reservedSet.name}: the reserved set matches, case-insensitively`, () => {
    // The vector lists them lower-cased as "the canonical comparison form",
    // so the constant is compared in that form rather than by wire spelling.
    expect([...RESERVED_RESPONSE_HEADERS].map((h) => h.toLowerCase()).sort())
      .toEqual([...(reservedSet.expected_reserved_response_headers_lowercase ?? [])].sort());
  });

  it(`${reservedSet.name}: the Server value matches`, () => {
    expect(PROXY_SERVER_HEADER_VALUE).toBe(reservedSet.expected_server_header_value);
  });

  it(`${passThrough.name}: upstream headers survive, Server is overwritten`, async () => {
    const upstream = new Response("{}", {
      status: 200,
      headers: passThrough.inputs.upstream_response_headers as Record<string, string>,
    });

    const out = await collapseWireShape(upstream);
    const expected = passThrough.expected_proxy_response_headers as Record<string, string>;

    for (const [name, want] of Object.entries(expected)) {
      if (name.toLowerCase() === "interlace-receipt") continue; // see header note
      expect(out.headers.get(name), `${name} must be ${want}`).toBe(want);
    }
  });
});

describe("the load-bearing pass-through headers", () => {
  // The vector calls out why these four matter: "body framing breaks if any of
  // these get mutated". Asserted individually so a failure names the header.
  it.each([
    ["Content-Type", "application/json"],
    ["Content-Length", "348"],
    ["Transfer-Encoding", "chunked"],
    ["Set-Cookie", "session=opaque-FAKE; Path=/; HttpOnly"],
  ])("passes %s through unchanged", async (name, value) => {
    const out = await collapseWireShape(
      new Response("{}", { status: 200, headers: { [name]: value } }),
    );
    expect(out.headers.get(name)).toBe(value);
  });
});

describe("Server is the proxy's identity, not the upstream's", () => {
  it("overwrites an upstream Server header", async () => {
    const out = await collapseWireShape(
      new Response("{}", { status: 200, headers: { Server: "envoy" } }),
    );
    expect(out.headers.get("server")).toBe(PROXY_SERVER_HEADER_VALUE);
  });

  it("sets Server even when upstream sent none", async () => {
    const out = await collapseWireShape(new Response("{}", { status: 200 }));
    expect(out.headers.get("server")).toBe(PROXY_SERVER_HEADER_VALUE);
  });

  it("stamps Server on error responses too", async () => {
    // The vector's cases are success-shaped, but `Server` identifies the
    // proxy on *every* response it emits. A fixed value cannot leak anything
    // through the constant-time error path, and omitting it there would make
    // the header a success-only signal.
    const out = await collapseWireShape(new Response("upstream detail", { status: 502 }));
    expect(out.headers.get("server")).toBe(PROXY_SERVER_HEADER_VALUE);
  });
});

describe("known gap — Interlace-Receipt", () => {
  it("is not yet emitted, and this test is the record of that", async () => {
    const out = await collapseWireShape(new Response("{}", { status: 200 }));
    // Deliberately asserting the CURRENT state. When the signing key is wired
    // (cloister-0c8173 / trust-root thread), this flips to `not.toBeNull()`
    // and the header note above comes out.
    expect(out.headers.get("interlace-receipt")).toBeNull();
  });
});
