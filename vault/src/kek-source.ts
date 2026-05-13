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
//   http://helper/...       — a generic HTTP service binding (sidecar)
//   keychain://service-name — sugar for the kek-helper macOS Keychain backend
//   secret-tool://...       — sugar for the kek-helper Linux libsecret backend (future)
//
// Workerd is a sandboxed V8 isolate — no fs, no child_process. So
// `keychain://` is implemented by a separate `kek-helper` Node sidecar
// (scripts/kek-helper.mjs) that cloister talks to over a service
// binding (KEK_HELPER). See ADR-0014 for the design rationale.

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

  // keychain://service-name — sugar for kek-helper /resolve?url=keychain://...
  // The helper is the only thing that can actually shell to /usr/bin/security.
  if (spec.startsWith("keychain://")) {
    return new HelperKekSource(env, spec);
  }

  // http(s)://host/... — generic HTTP backend. Goes through KEK_HELPER
  // if bound (so the helper can do auth, scoping, etc.); otherwise the
  // caller can do `fetch()` directly. We require KEK_HELPER to avoid
  // accidentally minting traffic to the public internet for a secret.
  if (spec.startsWith("http://") || spec.startsWith("https://")) {
    return new HelperKekSource(env, spec);
  }

  throw new Error(
    `kek-source: unsupported URL scheme in spec ${JSON.stringify(spec)} ` +
      "(supported: env://, file://, keychain://, http(s)://)",
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
          "(start scripts/kek-helper.mjs and bind it as KEK_HELPER)",
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
