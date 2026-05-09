// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 cloister contributors
// Origin: agentic-research/notme (Apache-2.0); see ../NOTICE.

// Request handler for the credential vault Worker.
//
// Routes:
//   GET  /:service?...   — proxy request to upstream (identity required)
//   PUT  /:service        — store credential (admin only)
//   DELETE /:service      — delete credential (admin only)
//   GET  /admin/services  — list services without credentials (admin only)
//
// Identity resolution and storage are injected — no DO/CF coupling here.

import {
  type VaultStorage,
  getCredential,
  storeCredential,
  deleteCredential,
  listServices,
  checkAccess,
  validateServiceName,
  validateUpstreamUrl,
  buildProxyRequest,
  buildErrorResponse,
} from "./vault";

export interface HandleRequestInput {
  request: Request;
  storage: VaultStorage;
  resolveIdentity: (req: Request) => Promise<string | null>;
  adminSub: string;
  /**
   * Proxy via the DO — decrypts credentials and fetches upstream INSIDE the DO.
   * Plaintext headers never leave the DO boundary.
   * If not provided (tests), falls back to building proxy request in the handler.
   */
  proxyViaVault?: (service: string, request: Request) => Promise<Response>;
}

export async function handleRequest(input: HandleRequestInput): Promise<Response> {
  const { request, storage, resolveIdentity, adminSub, proxyViaVault } = input;
  const url = new URL(request.url);
  const pathname = url.pathname;

  // ── Admin: list services ──────────────────────────────────────────────
  if (pathname === "/admin/services" && request.method === "GET") {
    const sub = await resolveIdentity(request);
    if (!sub) return json({ error: "identity required" }, 401);
    if (sub !== adminSub) return json({ error: "admin only" }, 403);

    const names = await listServices(storage);
    const services: Array<{ name: string; upstream: string; allowedSubs: string[] }> = [];
    for (const name of names) {
      const cred = await getCredential(storage, name);
      if (cred) {
        // Expose metadata, NOT credential headers
        services.push({ name, upstream: cred.upstream, allowedSubs: cred.allowedSubs });
      }
    }
    return json({ services }, 200);
  }

  // ── Extract service name from path ────────────────────────────────────
  const service = pathname.split("/")[1] || "";
  if (!service || !validateServiceName(service)) {
    return json({ error: "invalid service name" }, 400);
  }

  // ── Resolve identity ──────────────────────────────────────────────────
  const sub = await resolveIdentity(request);
  if (!sub) return json({ error: "identity required" }, 401);

  // ── Admin: store credential ───────────────────────────────────────────
  if (request.method === "PUT") {
    if (sub !== adminSub) return json({ error: "admin only" }, 403);

    let body: { upstream?: string; headers?: Record<string, string>; allowedSubs?: string[] };
    try {
      body = await request.json() as typeof body;
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }

    if (!body.upstream || !validateUpstreamUrl(body.upstream)) {
      return json({ error: "invalid or missing upstream URL" }, 400);
    }

    await storeCredential(storage, service, {
      upstream: body.upstream,
      headers: body.headers ?? {},
      allowedSubs: body.allowedSubs ?? [],
    });

    console.log(JSON.stringify(buildAuditEntry({
      event: "credential_stored",
      sub,
      service,
      method: "PUT",
      status: 200,
    })));

    return json({ ok: true, service }, 200);
  }

  // ── Admin: delete credential ──────────────────────────────────────────
  if (request.method === "DELETE") {
    if (sub !== adminSub) return json({ error: "admin only" }, 403);

    const deleted = await deleteCredential(storage, service);
    if (!deleted) return json({ error: "not found" }, 404);

    console.log(JSON.stringify(buildAuditEntry({
      event: "credential_deleted",
      sub,
      service,
      method: "DELETE",
      status: 200,
    })));

    return json({ ok: true, service }, 200);
  }

  // ── Proxy: GET/POST/etc → upstream ────────────────────────────────────
  // Check credential exists and caller has access (metadata only — no decrypted headers)
  const cred = await getCredential(storage, service);
  if (!cred) return json(buildErrorResponse("not_found", sub, service, null), 404);

  if (!checkAccess(cred.allowedSubs, sub)) {
    return json(buildErrorResponse("forbidden", sub, service, cred), 403);
  }

  console.log(JSON.stringify(buildAuditEntry({
    event: "proxy",
    sub,
    service,
    method: request.method,
    status: 0,
  })));

  // Production: proxy via DO — credentials decrypted and used INSIDE the DO.
  // Plaintext headers never cross the RPC boundary.
  if (proxyViaVault) {
    return proxyViaVault(service, request);
  }

  // Test fallback: build proxy request with the (empty) headers from metadata.
  // Tests validate routing, access control, and audit — not the actual fetch.
  const proxyReq = buildProxyRequest(request, cred);
  return new Response(JSON.stringify({
    _proxy: true,
    url: proxyReq.url,
    method: proxyReq.method,
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ── Audit entry builder ─────────────────────────────────────────────────────

export function buildAuditEntry(input: {
  event: string;
  sub: string;
  service: string;
  method: string;
  status: number;
}): { event: string; sub: string; service: string; method: string; status: number; ts: number } {
  return {
    event: input.event,
    sub: input.sub,
    service: input.service,
    method: input.method,
    status: input.status,
    ts: Date.now(),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}
