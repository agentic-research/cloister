// SPDX-License-Identifier: AGPL-3.0-or-later
//
// harness-shim — the lease-aware local proxy that lets a STOCK agent harness
// (Claude Code, Codex) reach cloister's credential vault.
//
// The harness points its provider base URL at this shim; the shim attaches a
// valid Interlace lease to each request (via `lease-signer.ts`) and forwards
// to cloister's `/vault/proxy/<name>` route, streaming the response back. The
// harness holds a localhost URL only — not the LLM key (vaulted in cloister)
// and not the signing key (held here). Per cloister-caab2d / ADR-0040.
//
//   Codex:        OPENAI_BASE_URL=http://127.0.0.1:8799/vault/proxy/openai
//   Claude Code:  ANTHROPIC_BASE_URL=http://127.0.0.1:8799/vault/proxy/anthropic
//
// This is a HOST-SIDE Node program (workerd can't spawn processes — ADR-0033),
// deliberately outside the workers tsconfig. Run with Node 20+ (global fetch +
// Web Crypto Ed25519). Config comes from env; see README.md.
//
// v1 cert source is a loaded dev cert (env). Live notme minting is a drop-in
// `CertSource` (see `envCertSource` / the mint TODO). v1 holds the ephemeral
// key in-process; the ADR-0019 sign-only-helper hardening (never hold the raw
// key) is the documented next step.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { signLeaseHeaders, type EphemeralIdentity } from "./lease-signer.js";

interface ShimConfig {
  /** Local listen port. */
  port: number;
  /** Cloister origin, e.g. "https://cloister.example". No trailing slash. */
  cloisterBaseUrl: string;
  /** Where the ephemeral lease identity comes from. */
  identity: EphemeralIdentity;
  /**
   * Audit mode (ADR-0040 amendment). When true, the caller's own
   * `Authorization` header is **preserved** (not stripped) so an
   * OAuth-subscription harness (Claude Code Max) can forward its credential
   * through to cloister's passthrough proxy. Off (custody mode) strips it —
   * cloister injects the vaulted key instead.
   */
  preserveAuth: boolean;
}

/**
 * A `CertSource` yields the current ephemeral identity. v1 ships `envCertSource`
 * (a dev cert loaded from env). The deployable follow-up is a notme-minting
 * source that refreshes a short-lived cert before it expires — same interface,
 * so `index.ts` doesn't change.
 */
export type CertSource = () => EphemeralIdentity;

/** Load a dev cert + ephemeral keypair from env (base64url, as on the wire). */
export function envCertSource(getEnv: (k: string) => string | undefined): EphemeralIdentity {
  const certB64     = required(getEnv, "HARNESS_SHIM_CERT_B64");
  const privSeedB64 = required(getEnv, "HARNESS_SHIM_PRIV_SEED_B64");
  const pubKeyB64   = required(getEnv, "HARNESS_SHIM_PUBKEY_B64");
  return { certB64, privSeedB64, pubKeyB64 };
}

function required(getEnv: (k: string) => string | undefined, key: string): string {
  const v = getEnv(key);
  if (!v) throw new Error(`harness-shim: missing required env ${key}`);
  return v;
}

/** Hop-by-hop + identity headers the shim must not forward verbatim. */
// Always stripped (hop-by-hop / recomputed). `authorization` is stripped too
// in custody mode (harness sends none; cloister injects the vaulted key), but
// PRESERVED in audit mode (`preserveAuth`) so a Max/OAuth harness's own
// credential reaches cloister's passthrough proxy. Per ADR-0040 amendment.
const STRIP_ALWAYS = new Set(["host", "connection", "content-length"]);

/**
 * Handle one inbound harness request: sign over the CLOISTER url (what the
 * server verifies), forward, stream the response back untouched (SSE fidelity).
 */
async function handleRequest(
  cfg: ShimConfig,
  identity: EphemeralIdentity,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = req.method ?? "GET";
  const cloisterUrl = cfg.cloisterBaseUrl + (req.url ?? "/");

  const body = method === "GET" || method === "HEAD"
    ? ""
    : await readBody(req);

  const signet = await signLeaseHeaders({ method, url: cloisterUrl, body, identity });

  const outHeaders = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (v === undefined || STRIP_ALWAYS.has(lk)) continue;
    const val = Array.isArray(v) ? v.join(", ") : v;
    if (lk === "authorization") {
      // The lease occupies `Authorization: Signet` on this hop. In audit mode,
      // side-channel the harness's own Authorization (e.g. Max OAuth) so
      // cloister can restore it upstream; in custody mode, drop it (cloister
      // injects the vaulted key). Per ADR-0040 amendment.
      if (cfg.preserveAuth) outHeaders.set("x-harness-authorization", val);
      continue;
    }
    outHeaders.set(k, val);
  }
  // Lease headers set LAST so `Authorization: Signet` wins on this hop.
  for (const [k, v] of Object.entries(signet)) outHeaders.set(k, v);

  const upstream = await fetch(cloisterUrl, {
    method,
    headers: outHeaders,
    body: body === "" ? undefined : body,
  });

  res.statusCode = upstream.status;
  upstream.headers.forEach((value, key) => {
    // fetch decodes the body, so a stale content-encoding/length would lie.
    if (key === "content-encoding" || key === "content-length") return;
    res.setHeader(key, value);
  });

  if (upstream.body) {
    // Stream, do not buffer — preserves token-by-token SSE latency.
    Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
  } else {
    res.end();
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Build (but don't listen on) the shim server — handy for tests. */
export function createShimServer(cfg: ShimConfig, source: CertSource) {
  return createServer((req, res) => {
    handleRequest(cfg, source(), req, res).catch((err) => {
      // Shim-side failure (signing, config, upstream dial): 502, never leak
      // internals to the harness.
      res.statusCode = 502;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "shim_failure" }));
      // eslint-disable-next-line no-console -- operator-facing diagnostic
      console.error("harness-shim request failed:", err instanceof Error ? err.message : err);
    });
  });
}

function loadConfig(getEnv: (k: string) => string | undefined): ShimConfig {
  const port = Number.parseInt(getEnv("HARNESS_SHIM_PORT") ?? "8799", 10);
  const cloisterBaseUrl = required(getEnv, "CLOISTER_BASE_URL").replace(/\/+$/, "");
  const preserveAuth = (getEnv("HARNESS_SHIM_PRESERVE_AUTH") ?? "") !== "";
  return { port, cloisterBaseUrl, identity: envCertSource(getEnv), preserveAuth };
}

// Entrypoint — only runs when invoked directly (`node index.js` or via tsx as
// `index.ts`), not on import.
if (process.argv[1] !== undefined && /index\.(ts|js)$/.test(process.argv[1])) {
  const getEnv = (k: string) => process.env[k];
  const cfg = loadConfig(getEnv);
  createShimServer(cfg, () => cfg.identity).listen(cfg.port, "127.0.0.1", () => {
    // eslint-disable-next-line no-console -- operator-facing startup line
    console.log(`harness-shim listening on http://127.0.0.1:${cfg.port} → ${cfg.cloisterBaseUrl}`);
  });
}
