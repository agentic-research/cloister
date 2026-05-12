// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Archival CA bundle endpoint (RECEIPTS.md §2.3 / §2.2.2).
//
//   GET /interlace/ca-bundle              — list all known epochs
//   GET /interlace/ca-bundle/<epoch>      — fetch the bundle entry for <epoch>
//
// Per §2.2.2 step 2 (audit form), V uses this to resolve historical
// pubkeys when replaying receipts against retired epochs. Per §2.3,
// retired entries MUST remain resolvable until the operator's
// `ca_decommission_after` elapses.
//
// Constant-time 404 (per §9.4) — unknown epoch returns the same shape
// as a known-but-empty bundle entry to avoid epoch-enumeration oracles.
//
// Auth gating: the bundle entries themselves are PUBLIC by design
// (V can be anyone, including untrusted observers, per the spec's
// open-audit model). No lease gate on this endpoint.

import type { EdgeRoute } from "../router.js";
import type { Env } from "../types.js";
import type { ActorCaBundleEntry } from "../storage/actor-ca-bundle.js";

const PATTERN_LIST   = "/interlace/ca-bundle";
const PATTERN_LOOKUP = new URLPattern({ pathname: "/interlace/ca-bundle/:epoch" });

interface CaBundleListEntry {
  epoch:                   number;
  status:                  "active" | "retired";
  issued_at_ms:            number;
  retired_at_ms:           number | null;
  signing_key_pubkey:      string;      // base64url no-pad
  external_anchor_uri:     string | null;
  has_compromise_notice:   boolean;
}

interface CaBundleListBody {
  version: "v1";
  epochs: CaBundleListEntry[];
}

interface CaBundleEntryBody {
  version:                "v1";
  epoch:                  number;
  status:                 "active" | "retired";
  signing_key_pubkey:     string;
  cert_der?:              string;
  issued_at_ms:           number;
  retired_at_ms:          number | null;
  external_anchor_uri:    string | null;
  compromise_notice?:     string;
}

interface TrustStoreRpc {
  listCaBundleEpochs(): Promise<ActorCaBundleEntry[]>;
  getCaBundle(epoch: number): Promise<ActorCaBundleEntry | null>;
}

export class CaBundleRoute implements EdgeRoute {
  match(request: Request): boolean {
    if (request.method !== "GET") return false;
    const path = new URL(request.url).pathname;
    if (path === PATTERN_LIST) return true;
    return PATTERN_LOOKUP.test(request.url);
  }

  async handle(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const trust = trustStoreStub(env) as DurableObjectStub & TrustStoreRpc;

    if (url.pathname === PATTERN_LIST) {
      const entries = await trust.listCaBundleEpochs();
      const body: CaBundleListBody = {
        version: "v1",
        epochs: entries.map((e) => ({
          epoch:                 e.epoch,
          status:                e.status,
          issued_at_ms:          e.issued_at_ms,
          retired_at_ms:         e.retired_at_ms,
          signing_key_pubkey:    e.signing_key_pubkey_b64u,
          external_anchor_uri:   e.external_anchor_uri,
          has_compromise_notice: e.compromise_notice_b64u !== null,
        })),
      };
      return jsonResponse(body, 200);
    }

    const m = PATTERN_LOOKUP.exec(request.url);
    const epochRaw = m?.pathname.groups.epoch;
    if (!epochRaw) return notFound();
    const epoch = Number.parseInt(epochRaw, 10);
    if (!Number.isFinite(epoch) || epoch < 0 || String(epoch) !== epochRaw) {
      return notFound();
    }

    const entry = await trust.getCaBundle(epoch);
    if (entry === null) return notFound();

    const body: CaBundleEntryBody = {
      version:             "v1",
      epoch:               entry.epoch,
      status:              entry.status,
      signing_key_pubkey:  entry.signing_key_pubkey_b64u,
      issued_at_ms:        entry.issued_at_ms,
      retired_at_ms:       entry.retired_at_ms,
      external_anchor_uri: entry.external_anchor_uri,
    };
    if (entry.cert_der_b64u !== null)          body.cert_der          = entry.cert_der_b64u;
    if (entry.compromise_notice_b64u !== null) body.compromise_notice = entry.compromise_notice_b64u;
    return jsonResponse(body, 200);
  }
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type":  "application/json; charset=utf-8",
      "cache-control": "public, max-age=60",
    },
  });
}

function notFound(): Response {
  return new Response(
    JSON.stringify({ version: "v1", error: "not_found" }),
    {
      status: 404,
      headers: {
        "content-type":  "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

function trustStoreStub(env: Env): DurableObjectStub {
  return env.TRUST_STORE.get(env.TRUST_STORE.idFromName("cluster"));
}
