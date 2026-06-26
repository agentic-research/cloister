// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 cloister contributors

// Pluggable KEK (key-encryption-key) source for the credential vault.
//
// Background: the vault DO derives an AES-GCM KEK from a secret string
// at construction time. Historically that secret came from
// `env.VAULT_KEK_SECRET` — a plaintext workerd binding. That's a footgun
// for "I'm running my own cloister on macOS" because the secret has to
// live somewhere on disk (config.capnp, wrangler.toml, dotenv, etc.).
//
// This module introduces a URL-driven indirection so the same DO can
// resolve the secret from:
//
//   env://NAME              — plaintext from env binding NAME (legacy default)
//   file:///path/to/file    — bytes from a workerd disk-service binding
//   http(s)://helper/...    — a generic HTTP service binding (sidecar)
//   keychain://service-name — sugar for the leyline-sign-helper macOS Keychain backend
//                              (via /usr/bin/security)
//   secret-tool://attr/value — sugar for the leyline-sign-helper Linux
//                              libsecret backend (via libsecret-tool)
//   op://VAULT/ITEM         — sugar for the 1Password CLI backend
//   apple-password://NAME   — sugar for the macOS Keychain Services API
//                              (distinct from keychain:// which uses the
//                              `security` CLI; this one uses the lower-
//                              level Security framework via the helper)
//   keyring://NAME          — sugar for the cross-platform keyring backend
//                              (Linux/Win)
//
// Workerd is a sandboxed V8 isolate — no fs, no child_process. So all
// the keystore-backed schemes are implemented by the leyline-sign-helper
// Rust binary (rs/crates/sign/, ADR-0019) that cloister talks to over
// a service binding (KEK_HELPER). The helper exposes a single
// `GET /resolve?url=<encoded spec>` endpoint that dispatches on the
// scheme internally. Adding a new scheme is a 2-line change here +
// implementation in the helper. See ADR-0014 for the design rationale.

/**
 * The minimal env shape this module reads.
 *
 * Treated structurally — we don't import `Env` from src/types.ts to keep
 * this module reusable from the pure vault library + unit tests. The
 * cast at the call site (in `src/vault-store.ts`) handles the Cloudflare
 * `Env` → `KekSourceEnv` widening.
 *
 * The `unknown` value type accommodates the fact that the cloudflare
 * `Env` interface doesn't have a string index signature; the resolver
 * narrows to `string`/`Fetcher` at access time and throws on type
 * mismatch.
 */
export type KekSourceEnv = {
  readonly [name: string]: unknown;
};

/**
 * Public contract: resolve a URL spec to the raw KEK secret bytes.
 *
 * The return is a UTF-8 string — `deriveKEK` consumes a string today
 * (HKDF importKey "raw" on the UTF-8 bytes). If a future backend wants
 * to surface binary key material, widen this to `Uint8Array` and adapt
 * `deriveKEK`; both paths are equivalent crypto-wise as long as the
 * exact same bytes go into HKDF on every boot.
 */
export interface KekSource {
  resolve(): Promise<string>;
}

/**
 * URL-scheme prefixes routed through `KEK_HELPER` (the leyline-sign-helper
 * sidecar). All keystore-backed schemes go through the helper because
 * workerd is a sandboxed isolate without process or filesystem access —
 * actually fetching the secret requires shelling out, which only the
 * helper can do. Adding a new scheme here is a 1-line change; the
 * matching dispatch in the helper is required for it to actually
 * resolve. Per ADR-0019.
 *
 * `http(s)://` is also helper-routed deliberately: we require KEK_HELPER
 * binding even for plain HTTP to avoid accidentally minting traffic to
 * the public internet for a secret. The helper can layer auth /
 * scoping / TLS-pin on top.
 */
export const HELPER_SCHEMES = [
  "keychain://",
  "secret-tool://",
  "op://",
  "apple-password://",
  "keyring://",
  "http://",
  "https://",
] as const;

/** Construct a `KekSource` for the given URL spec, bound to the given env. */
export function buildKekSource(spec: string, env: KekSourceEnv): KekSource {
  if (!spec || typeof spec !== "string") {
    throw new Error("kek-source: spec must be a non-empty URL string");
  }

  // env://NAME — read the named env binding as a UTF-8 string.
  if (spec.startsWith("env://")) {
    const name = spec.slice("env://".length);
    return new EnvKekSource(env, name);
  }

  // file:///path — read bytes from a workerd disk service via KEK_DISK.
  if (spec.startsWith("file://")) {
    return new FileKekSource(env, spec);
  }

  // All keystore-backed + HTTP schemes route through KEK_HELPER. The
  // helper does the actual scheme-specific work (shells to `security`
  // / `secret-tool` / `op` / etc.) and returns the secret bytes over
  // HTTP.
  if (HELPER_SCHEMES.some((prefix) => spec.startsWith(prefix))) {
    return new HelperKekSource(env, spec);
  }

  throw new Error(
    `kek-source: unsupported URL scheme in spec ${JSON.stringify(spec)} ` +
      `(supported: env://, file://, ${HELPER_SCHEMES.join(", ")})`,
  );
}

// ── env:// ──────────────────────────────────────────────────────────────────

class EnvKekSource implements KekSource {
  constructor(
    private readonly env: KekSourceEnv,
    private readonly varName: string,
  ) {
    if (!varName || /[^A-Z0-9_]/i.test(varName)) {
      throw new Error(
        `kek-source: env:// var name ${JSON.stringify(varName)} must be ` +
          "alphanumeric + underscore only",
      );
    }
  }

  async resolve(): Promise<string> {
    const raw = this.env[this.varName];
    if (typeof raw !== "string" || raw.length === 0) {
      throw new Error(
        `kek-source: env://${this.varName} is unset or empty — vault cannot derive its key`,
      );
    }
    return raw;
  }
}

// ── file:// ─────────────────────────────────────────────────────────────────

class FileKekSource implements KekSource {
  private readonly path: string;

  constructor(
    private readonly env: KekSourceEnv,
    spec: string,
  ) {
    // file:///foo/bar → path /foo/bar. file://host/path is rejected;
    // workerd's disk service is bound to a single directory so the
    // host portion of file URLs has no meaning here.
    let u: URL;
    try {
      u = new URL(spec);
    } catch {
      throw new Error(`kek-source: file:// URL is malformed: ${JSON.stringify(spec)}`);
    }
    if (u.hostname && u.hostname !== "") {
      throw new Error(
        "kek-source: file:// host must be empty (use file:///path, not file://host/path)",
      );
    }
    if (!u.pathname || u.pathname === "/") {
      throw new Error(
        "kek-source: file:// path must be non-empty (use file:///kek.bin)",
      );
    }
    this.path = u.pathname;
  }

  async resolve(): Promise<string> {
    const disk = this.env.KEK_DISK as Fetcher | undefined;
    if (!disk) {
      throw new Error(
        "kek-source: file:// requires the KEK_DISK service binding (a workerd disk service)",
      );
    }
    // workerd disk service speaks HTTP: GET against the path within the
    // bound directory. The Host header doesn't matter (workerd routes
    // by binding, not by Host).
    const res = await disk.fetch(new Request(`http://kek-disk${this.path}`));
    if (!res.ok) {
      throw new Error(
        `kek-source: KEK_DISK GET ${this.path} failed (status ${res.status})`,
      );
    }
    // Disk responses are raw file bytes. Read as text + trim trailing
    // newlines, which is the natural shape of `echo -n hex > file` or
    // a hand-edited keyfile.
    const text = await res.text();
    const trimmed = stripTrailingNewlines(text);
    if (trimmed.length === 0) {
      throw new Error(
        `kek-source: file://${this.path} resolved to empty bytes — vault cannot derive its key`,
      );
    }
    return trimmed;
  }
}

// ── keychain:// + http(s):// via KEK_HELPER ─────────────────────────────────

class HelperKekSource implements KekSource {
  constructor(
    private readonly env: KekSourceEnv,
    private readonly spec: string,
  ) {}

  async resolve(): Promise<string> {
    const helper = this.env.KEK_HELPER as Fetcher | undefined;
    if (!helper) {
      throw new Error(
        `kek-source: ${schemeOf(this.spec)} requires the KEK_HELPER service binding ` +
          "(start leyline-sign-helper and bind it as KEK_HELPER — see ADR-0019)",
      );
    }

    // The helper exposes GET /resolve?url=<encoded spec>. It returns
    // the raw secret bytes in the response body on 200, or a JSON
    // error body on non-2xx. We never include the spec in error
    // messages that escape this module — the spec may be a path or
    // service name the operator considers sensitive.
    //
    // Bounded retry with jitter for transient helper flake (cloister-2176e4
    // / dos-friend pilot finding F3). Retry network errors and 5xx; do
    // NOT retry 4xx (permanent — bad spec, missing keystore entry).
    // Paired with the vault DO `#getKEK` rejection clearing so a final
    // failure here doesn't poison the DO's KEK slot for its instance
    // lifetime.
    const url = `http://kek-helper/resolve?url=${encodeURIComponent(this.spec)}`;
    const ATTEMPTS = 3;
    const BACKOFF_MS = [100, 250]; // index = attempt number after the first
    let lastErr: string | null = null;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      let res: Response;
      try {
        res = await helper.fetch(new Request(url));
      } catch (err) {
        lastErr = `fetch: ${err instanceof Error ? err.message : String(err)}`;
        if (attempt < ATTEMPTS - 1) {
          const jitter = Math.floor(Math.random() * 50);
          await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]! + jitter));
          continue;
        }
        break;
      }

      if (res.ok) {
        const text = stripTrailingNewlines(await res.text());
        if (text.length === 0) {
          throw new Error(
            `kek-source: KEK_HELPER ${schemeOf(this.spec)} returned empty body`,
          );
        }
        return text;
      }

      // 4xx is permanent — don't retry.
      if (res.status >= 400 && res.status < 500) {
        throw new Error(
          `kek-source: KEK_HELPER ${schemeOf(this.spec)} lookup returned ${res.status}`,
        );
      }

      // 5xx — retry if attempts remain.
      lastErr = `status ${res.status}`;
      if (attempt < ATTEMPTS - 1) {
        const jitter = Math.floor(Math.random() * 50);
        await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]! + jitter));
      }
    }

    throw new Error(
      `kek-source: KEK_HELPER ${schemeOf(this.spec)} failed after ${ATTEMPTS} attempts (last: ${lastErr ?? "unknown"})`,
    );
  }
}

function schemeOf(spec: string): string {
  const idx = spec.indexOf("://");
  return idx > 0 ? `${spec.slice(0, idx)}://` : spec;
}

/**
 * Strip trailing `\r` / `\n` from `s`. Equivalent to running a `\r?\n`
 * trim in a loop — handles single newlines (`abc\n`), double newlines
 * (`abc\n\n`), and mixed CRLF/LF (`abc\r\n\n`) uniformly.
 */
function stripTrailingNewlines(s: string): string {
  let end = s.length;
  while (end > 0) {
    const c = s.charCodeAt(end - 1);
    if (c === 0x0a /* \n */ || c === 0x0d /* \r */) {
      end--;
    } else {
      break;
    }
  }
  return end === s.length ? s : s.slice(0, end);
}
