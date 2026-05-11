#!/usr/bin/env node
/**
 * kek-helper — local-host sidecar that resolves vault KEK URLs to raw
 * secret bytes via the OS keystore.
 *
 * Why this exists:
 *
 *   The cloister vault Durable Object runs inside workerd, a sandboxed
 *   V8 isolate with no filesystem, no `child_process`, no native bindings.
 *   It cannot shell out to `/usr/bin/security` or link libsecret. But it
 *   CAN make HTTP requests over a workerd service binding (per ADR-0013,
 *   "service-binding-as-syscall"). So we run this helper as a separate
 *   Node process on the cloister host, bind it as `KEK_HELPER` in
 *   workerd config, and let the vault DO ask it to resolve URLs like
 *   `keychain://com.cloister/kek` to actual key bytes.
 *
 *   This is the self-host story: "I want to run my own cloister and
 *   store my KEK in the macOS Keychain, not in a plaintext env var."
 *
 * Supported URL schemes:
 *
 *   keychain://<service>          — macOS Keychain.
 *                                    Shells to `security find-generic-password`.
 *                                    The KEYCHAIN_ACCOUNT env var (default
 *                                    "cloister") controls the -a argument.
 *   secret-tool://<service>       — Linux libsecret. NOT IMPLEMENTED YET —
 *                                    returns 501. A follow-up bead should
 *                                    wire `secret-tool lookup service <name>`.
 *
 * Wire contract:
 *
 *   GET /resolve?url=<encoded URL>
 *
 *     200  body = raw secret bytes (no trailing newline)
 *     400  { error: "bad request", reason: "..." }
 *     404  { error: "not_found" }
 *     500  { error: "internal" }
 *     501  { error: "unsupported", scheme: "..." }
 *
 *   GET /healthz
 *     200  { ok: true, platform: "darwin", schemes: [...] }
 *
 * Usage:
 *
 *   # Stash a KEK in macOS Keychain
 *   security add-generic-password \
 *     -a cloister -s com.cloister/kek \
 *     -w "$(openssl rand -hex 32)"
 *
 *   # Start the helper
 *   node scripts/kek-helper.mjs --bind 127.0.0.1:8786
 *
 *   # Point cloister at it
 *   export VAULT_KEK_SOURCE="keychain://com.cloister/kek"
 *   #   (and wire the helper as KEK_HELPER in config.capnp / wrangler.toml)
 *
 *   task dev
 *
 * Security notes:
 *
 *   - The helper has NO authentication. Bind it to 127.0.0.1 only.
 *     Anything that can reach 127.0.0.1:<port> can read your KEK. The
 *     workerd↔helper binding goes over the same host-local loopback
 *     interface, so the trust boundary is "everything running on this
 *     host as your UID". That matches the macOS Keychain ACL model.
 *   - Body bytes are returned raw to the caller. No logging of the
 *     secret. Errors deliberately do not echo the requested URL back
 *     in plaintext.
 *   - Do not expose this helper to a remote host. Do not bind to
 *     0.0.0.0. Do not run it under a different user than cloister.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import http from "node:http";
import { spawnSync } from "node:child_process";
import { argv, env, platform, exit } from "node:process";

// ── Args ───────────────────────────────────────────────────────────────────

function parseArgs(args) {
  const out = { bind: "127.0.0.1:8786", verbose: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--bind") {
      out.bind = args[++i];
    } else if (a === "--verbose" || a === "-v") {
      out.verbose = true;
    } else if (a === "--help" || a === "-h") {
      out.help = true;
    } else {
      console.error(`kek-helper: unknown arg ${JSON.stringify(a)}`);
      exit(2);
    }
  }
  return out;
}

const ARGS = parseArgs(argv.slice(2));
if (ARGS.help) {
  console.log("Usage: kek-helper.mjs [--bind 127.0.0.1:8786] [--verbose]");
  exit(0);
}
const [BIND_HOST, BIND_PORT_STR] = ARGS.bind.split(":");
const BIND_PORT = Number.parseInt(BIND_PORT_STR, 10);
if (!BIND_HOST || !Number.isFinite(BIND_PORT)) {
  console.error(`kek-helper: bad --bind value ${JSON.stringify(ARGS.bind)} (want host:port)`);
  exit(2);
}
if (BIND_HOST !== "127.0.0.1" && BIND_HOST !== "::1" && BIND_HOST !== "localhost") {
  console.error(
    `kek-helper: refusing to bind to ${BIND_HOST} — only loopback is safe ` +
      "(this process has no auth; anything that can reach it can read your KEK)",
  );
  exit(2);
}

const KEYCHAIN_ACCOUNT = env.KEYCHAIN_ACCOUNT || "cloister";

// ── Supported schemes ──────────────────────────────────────────────────────

const SCHEMES = new Set([
  "keychain://", // macOS — implemented
  "secret-tool://", // Linux — NOT YET (returns 501)
]);

// ── Resolvers ──────────────────────────────────────────────────────────────

/** Resolve a `keychain://<service>` URL to raw secret bytes (string). */
function resolveKeychain(service) {
  if (platform !== "darwin") {
    const e = new Error("keychain:// is only supported on macOS (darwin)");
    e.code = "unsupported";
    throw e;
  }
  // `security find-generic-password -a <account> -s <service> -w` prints
  // the password to stdout with a trailing newline. -w means "password
  // only, no metadata". Service name is passed as a positional argument
  // — we do NOT interpolate into a shell, so no quoting hazard.
  const r = spawnSync(
    "/usr/bin/security",
    ["find-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", service, "-w"],
    { encoding: "utf8" },
  );
  if (r.error) {
    const e = new Error(`spawn security: ${r.error.message}`);
    e.code = "internal";
    throw e;
  }
  if (r.status !== 0) {
    // exit 44 = item not found
    if (r.status === 44 || /could not be found/i.test(r.stderr)) {
      const e = new Error("keychain entry not found");
      e.code = "not_found";
      throw e;
    }
    const e = new Error(`security exit ${r.status}: ${r.stderr.trim()}`);
    e.code = "internal";
    throw e;
  }
  return (r.stdout || "").replace(/\r?\n+$/, "");
}

// ── HTTP server ────────────────────────────────────────────────────────────

function send(res, status, body, contentType = "application/json") {
  res.statusCode = status;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj));
}

function logLine(...parts) {
  if (ARGS.verbose) {
    console.error("[kek-helper]", ...parts);
  }
}

const server = http.createServer((req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (u.pathname === "/healthz") {
      sendJson(res, 200, {
        ok: true,
        platform,
        schemes: Array.from(SCHEMES),
        keychainAccount: KEYCHAIN_ACCOUNT,
      });
      return;
    }

    if (u.pathname !== "/resolve") {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }

    const spec = u.searchParams.get("url");
    if (!spec) {
      sendJson(res, 400, { error: "bad_request", reason: "missing url param" });
      return;
    }

    let scheme = "";
    for (const s of SCHEMES) {
      if (spec.startsWith(s)) {
        scheme = s;
        break;
      }
    }
    if (!scheme) {
      sendJson(res, 400, { error: "bad_request", reason: "unsupported scheme" });
      return;
    }

    if (scheme === "secret-tool://") {
      // TODO(follow-up bead): wire `secret-tool lookup service <name>`.
      sendJson(res, 501, { error: "unsupported", scheme });
      return;
    }

    if (scheme === "keychain://") {
      const service = spec.slice("keychain://".length);
      if (!service) {
        sendJson(res, 400, { error: "bad_request", reason: "empty service" });
        return;
      }
      try {
        const secret = resolveKeychain(service);
        if (!secret) {
          sendJson(res, 500, { error: "internal" });
          return;
        }
        logLine("resolved keychain entry", JSON.stringify(service));
        // Raw body — caller is the vault DO, which feeds bytes straight
        // into deriveKEK. No JSON envelope.
        send(res, 200, secret, "application/octet-stream");
        return;
      } catch (err) {
        const code = err && err.code;
        if (code === "not_found") {
          sendJson(res, 404, { error: "not_found" });
        } else if (code === "unsupported") {
          sendJson(res, 501, { error: "unsupported", scheme });
        } else {
          // Do NOT echo the spec or internal error message back.
          // Log it locally if --verbose; the wire response is generic.
          logLine("internal error:", err && err.message);
          sendJson(res, 500, { error: "internal" });
        }
        return;
      }
    }

    sendJson(res, 500, { error: "internal" });
  } catch (err) {
    logLine("uncaught:", err && err.message);
    sendJson(res, 500, { error: "internal" });
  }
});

server.listen(BIND_PORT, BIND_HOST, () => {
  console.error(
    `[kek-helper] listening on http://${BIND_HOST}:${BIND_PORT} ` +
      `(platform=${platform}, keychainAccount=${KEYCHAIN_ACCOUNT}, ` +
      `schemes=${Array.from(SCHEMES).join(",")})`,
  );
});

// Clean shutdown on common signals so `kill %1` doesn't leave a zombie.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    console.error(`[kek-helper] ${sig} — shutting down`);
    server.close(() => exit(0));
  });
}
