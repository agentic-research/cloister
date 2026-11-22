// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Identity discovery bridge (cloister-c9922f).
//
// First non-MCP tenant of the cloister edge router (ADR-0002). Publishes
// the cluster's Interlace identity under two more standard formats:
//
//   GET  /.well-known/webfinger              JRD (RFC 7033) keyed off
//                                            ?resource=acct:cluster@host
//   GET  /.well-known/nostr.json             NIP-05 names+relays mapping
//
// Both paths share one EdgeRoute because they project the same identity:
// `manifest.actor.fingerprint` and the master public key at
// `env[actor.pubkeyBinding]`.
//
// ## Cloister issues no tokens (ADR-0086)
//
// This route also served `POST /oauth/token`, a client_credentials grant
// whose JWT notme signed on a delegated key, with
// `/.well-known/openid-configuration` and `/.well-known/jwks.json` to
// describe and verify it. All three are gone. notme is the token authority:
// its `POST /token` issues sender-constrained tokens to a caller that has
// proved who it is, and it is deliberately not an OpenID provider. A second
// issuer here would be a weaker copy of that, and notme's ADR-020 asks the
// stack to compose its credentials rather than mint new ones.
//
// ## What this is NOT
//
//   - No ActivityPub inbox/outbox. WebFinger only handles identity
//     discovery, not message delivery.
//   - No relay implementation. NIP-05 is just identity mapping.
//   - No placeholder identity. The fingerprint and pubkey derive from the
//     manifest's real `actor` block + the master pubkey bytes pinned at
//     deploy time. If `actor.fingerprint` is empty (Interlace discovery
//     disabled), the bridge returns 404 for both formats — symmetric with
//     WellKnownInterlaceRoute.

import type { EdgeRoute } from "../router.js";
import type { Env } from "../types.js";
import type { Gateway } from "../manifest/types.js";
import { resolveActorFingerprint } from "./actor-fingerprint.js";

// ── Path constants ────────────────────────────────────────────────────────

export const PATH_WEBFINGER      = "/.well-known/webfinger";
export const PATH_NOSTR_NIP05    = "/.well-known/nostr.json";

const ALL_PATHS = new Set<string>([PATH_WEBFINGER, PATH_NOSTR_NIP05]);

// ── Route ────────────────────────────────────────────────────────────────

export class WellKnownIdentityBridgeRoute implements EdgeRoute {
  constructor(private readonly manifest: Gateway) {}

  match(request: Request): boolean {
    const url = new URL(request.url);
    if (!ALL_PATHS.has(url.pathname)) return false;
    // Both are GET (RFC 7033, NIP-05). Other methods 404 at the router, so
    // the response is indistinguishable from "no such route."
    return request.method === "GET";
  }

  async handle(request: Request, env: Env): Promise<Response> {
    // Identity bridge is opt-in via the same lever as the native
    // One resolver, shared with the discovery doc: manifest value, else the
    // INTERLACE_ACTOR_FP binding, else genuinely disabled. Before this, an
    // operator with a live identity who had not restated its digest in the
    // manifest got the same bare 404 as one who had opted out.
    const fingerprint = resolveActorFingerprint(this.manifest.actor.fingerprint, env);
    if (!fingerprint) {
      return new Response("identity bridge disabled", { status: 404 });
    }

    const url = new URL(request.url);
    switch (url.pathname) {
      case PATH_WEBFINGER:   return this.handleWebFinger(request, env);
      case PATH_NOSTR_NIP05: return this.handleNostrNip05(request, env);
    }
    // Unreachable — match() filters to the two paths above.
    return new Response("not found", { status: 404 });
  }

  // ── /.well-known/webfinger ─────────────────────────────────────────────

  private handleWebFinger(request: Request, _env: Env): Response {
    const url = new URL(request.url);
    const resource = url.searchParams.get("resource");
    if (!resource) {
      // RFC 7033 §4.2 — server MUST return 400 if `resource` is missing.
      return new Response("webfinger: missing resource parameter", { status: 400 });
    }
    // The cluster's WebFinger account is `acct:cluster@<host>`. We
    // accept any host matching the request — the cluster doesn't
    // mediate identity for other hosts, and refusing to lookup other
    // identities is the safe default per RFC 7033 §4.4.
    const expected = `acct:cluster@${url.host}`;
    if (resource !== expected) {
      // RFC 7033 §4.4 — 404 for an unknown account.
      return new Response("webfinger: unknown account", { status: 404 });
    }
    const base = baseUrl(request);
    const jrd = {
      subject: expected,
      links: [
        {
          // Self-link per RFC 7033 §8.4.
          rel:  "self",
          type: "application/jrd+json",
          href: `${base}${PATH_WEBFINGER}?resource=${encodeURIComponent(expected)}`,
        },
      ],
    };
    // RFC 7033 §4.2 — content-type MUST be `application/jrd+json`.
    return new Response(JSON.stringify(jrd, null, 2), {
      status: 200,
      headers: {
        "content-type":                "application/jrd+json; charset=utf-8",
        // RFC 7033 §5 — cross-origin access. WebFinger queries from
        // browsers (e.g. Mastodon's federation UI) require CORS.
        "access-control-allow-origin": "*",
        "cache-control":               "public, max-age=300, must-revalidate",
      },
    });
  }

  // ── /.well-known/nostr.json ────────────────────────────────────────────

  private handleNostrNip05(request: Request, env: Env): Response {
    // NIP-05 takes an optional `?name=<local>` query. The spec allows a
    // server to ignore unknown names; clients query for a specific name
    // before treating the response as a binding. We expose a single
    // identity — `cluster` — keyed off the same actor surface as the
    // other formats.
    const url = new URL(request.url);
    const requestedName = url.searchParams.get("name");
    const masterB64 = readEnvString(env, this.manifest.actor.pubkeyBinding);
    if (!masterB64) {
      return new Response("nostr: master pubkey binding unset", { status: 503 });
    }
    // NIP-05 maps `name → pubkey-hex` (raw 32-byte Ed25519/secp256k1 key
    // encoded as 64 lowercase hex chars). The published surface here
    // uses the Ed25519 master pubkey — Nostr canonically uses
    // secp256k1, but the spec doesn't constrain the curve, only the
    // encoding. Consumers that strictly require secp256k1 will reject
    // this entry; that's fine — they fall back to other discovery.
    const pubHex = base64StdToHex(masterB64);
    const names = requestedName === null || requestedName === "cluster"
      ? { cluster: pubHex }
      : {};  // unknown name → empty mapping (NIP-05 §"Showing just the public key")
    const body = { names, relays: {} as Record<string, string[]> };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        // NIP-05 §"Allowing access from JavaScript apps" — wildcard
        // CORS is REQUIRED so browser-based clients can discover the
        // mapping.
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=300, must-revalidate",
      },
    });
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function baseUrl(request: Request): string {
  // The deployment's public origin, from the inbound Request — workerd /
  // Cloudflare Workers populate request.url with the public-facing origin.
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

function readEnvString(env: Env, binding: string): string | undefined {
  if (!binding) return undefined;
  const v = (env as unknown as Record<string, unknown>)[binding];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** base64-standard → lowercase hex. */
function base64StdToHex(s: string): string {
  const bin = atob(s);
  let out = "";
  for (let i = 0; i < bin.length; i++) {
    out += bin.charCodeAt(i).toString(16).padStart(2, "0");
  }
  return out;
}

