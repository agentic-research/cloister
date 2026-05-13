// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 cloister contributors
//
// URL-spec → bytes keystore resolver (ADR-0014 + ADR-0019).
//
// Supported schemes:
//
//   - `keychain://<service>`     — macOS Keychain via `nono::keystore`
//                                  (`keyring` backend). `KEYCHAIN_ACCOUNT`
//                                  env var (default "cloister") selects the
//                                  account name.
//   - `secret-tool://<service>`  — Linux libsecret via `nono::keystore`
//                                  (`keyring` backend). Same account
//                                  selection as `keychain://`.
//   - `keyring://<svc>/<acct>`   — explicit-form keyring URI (both service
//                                  and account in the URI). Pass-through to
//                                  `nono::keystore::load_secret_by_ref`.
//   - `op://<vault>/<item>/<field>` — 1Password via the `op` CLI. Routed
//                                  through cloister's own subprocess shim
//                                  (NOT nono's `Command::new("op")`) so the
//                                  CLI binary is pinned by absolute path via
//                                  `LEYLINE_SIGN_OP_BIN`. Refuses if unset.
//                                  Cf. trust-root-friend F3 + isolation-friend
//                                  F-iso-3 from the 2026-05-13 adversarial
//                                  cycle.
//   - `apple-password://<server>/<account>` — Apple Passwords via macOS
//                                  `security` CLI. Same local-shim discipline
//                                  as `op://`; pinned by
//                                  `LEYLINE_SIGN_SECURITY_BIN`. macOS only.
//   - `file:///<absolute path>`  — read raw bytes from path. Refuses to
//                                  follow symlinks, refuses paths containing
//                                  `..`, warns if perms are looser than 0600.
//                                  Read **directly by cloister** (NOT through
//                                  nono) so we keep two invariants:
//                                    (1) bytes are binary-safe (nono's
//                                        `read_to_string` rejects non-UTF-8);
//                                    (2) trim-trailing-newlines uses the
//                                        kek-helper.mjs regex (`/\r?\n+$/`),
//                                        which strips runs of CRLF; nono's
//                                        own trim only strips one CRLF.
//                                  Per cloister-993bef Phase B + cloister-2a0faa.
//
// All schemes reject query strings (`?...`) and fragments (`#...`) at
// parse time. nono's `keyring://` accepts `?decode=go-keyring`; cloister
// rejects it to keep the kid-determinism invariant and to avoid
// reaching into nono's trust module (which links sigstore-verify). See
// trust-root-friend F5 + replay-friend F1 from the 2026-05-13 cycle.
//
// `/resolve` semantic (golden-vector parity with `scripts/kek-helper.mjs`):
// the macOS keychain helper trims trailing CR/LF from the resolved bytes.
// We reproduce that exactly in `trim_trailing_newlines` — this is the
// cloister-993bef Phase B migration gate.
//
// Async surface: `resolve_bytes(spec).await` wraps the dispatch in
// `tokio::task::spawn_blocking` so the (potentially-slow) keystore I/O
// — `keyring` crate IPC, `op` subprocess, `security` subprocess, even
// `std::fs::read` — runs on the dedicated blocking pool, not on the
// tokio worker threads. Closes dos-friend F1 / silence-friend Gap 2
// from the 2026-05-13 cycle.

use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::host::error::HelperError;

const DEFAULT_KEYCHAIN_ACCOUNT: &str = "cloister";

/// Service name passed to `nono::keystore::load_secret_by_ref` when the
/// credential reference is a bare account (no scheme). Cloister's URIs
/// always carry a scheme, so this is only used as the fallback `service`
/// argument and is never reached as the dispatch target.
const NONO_SERVICE_FALLBACK: &str = "cloister";

/// Per-subprocess wall-clock cap for `op` and `security` CLI invocations.
/// Tighter than nono's internal 30s — the helper's outer `SIGN_TIMEOUT`
/// is 5s and the subprocess timer MUST fire first so the helper kills
/// the child and frees the worker. 4500 ms gives the subprocess time to
/// run (op + 1Password authn is ~1-2s warm; FaceID is ~3s) while still
/// leaving budget for the rest of the sign pipeline before SIGN_TIMEOUT.
const SUBPROCESS_TIMEOUT: Duration = Duration::from_millis(4_500);

/// All supported URL schemes (shown verbatim in `GET /healthz`).
pub const SUPPORTED_SCHEMES: &[&str] = &[
    "keychain://",
    "secret-tool://",
    "keyring://",
    "op://",
    "apple-password://",
    "file://",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scheme {
    Keychain,
    SecretTool,
    Keyring,
    Op,
    ApplePassword,
    File,
}

impl Scheme {
    pub fn label(self) -> &'static str {
        match self {
            Scheme::Keychain => "keychain://",
            Scheme::SecretTool => "secret-tool://",
            Scheme::Keyring => "keyring://",
            Scheme::Op => "op://",
            Scheme::ApplePassword => "apple-password://",
            Scheme::File => "file://",
        }
    }
}

#[derive(Debug)]
pub struct ParsedSpec {
    pub scheme: Scheme,
    pub remainder: String,
}

/// Parse a URL spec into `(scheme, remainder)`. Returns `BadRequest` for
/// unknown schemes, empty remainder, or any spec containing a query
/// string / fragment (`?` or `#`).
///
/// Query-string rejection closes trust-root-friend F5 + replay-friend F1
/// from the 2026-05-13 cycle: nono's `keyring://` URI grammar accepts
/// `?decode=go-keyring` and reaches into nono's trust module (which links
/// sigstore-verify et al.). Cloister's signing path doesn't need that
/// transform, and the kid-determinism invariant (ADR-0019 req 7) is
/// cleaner if the URL grammar is fixed at the cloister side.
pub fn parse_spec(spec: &str) -> Result<ParsedSpec, HelperError> {
    if spec.contains('?') {
        return Err(HelperError::BadRequest("query strings are not permitted"));
    }
    if spec.contains('#') {
        return Err(HelperError::BadRequest("fragments are not permitted"));
    }
    // Order matters: `apple-password://` before any potential prefix overlap.
    for (label, scheme) in [
        ("apple-password://", Scheme::ApplePassword),
        ("secret-tool://", Scheme::SecretTool),
        ("keychain://", Scheme::Keychain),
        ("keyring://", Scheme::Keyring),
        ("file://", Scheme::File),
        ("op://", Scheme::Op),
    ] {
        if let Some(rest) = spec.strip_prefix(label) {
            if rest.is_empty() {
                return Err(HelperError::BadRequest("empty url remainder"));
            }
            return Ok(ParsedSpec { scheme, remainder: rest.to_string() });
        }
    }
    Err(HelperError::BadRequest("unsupported scheme"))
}

/// Resolve the URL spec to raw key bytes, off the tokio worker thread.
///
/// Wraps `resolve_bytes_blocking` in `tokio::task::spawn_blocking` so the
/// keystore I/O — `keyring` crate IPC, `op` subprocess, `security`
/// subprocess, `std::fs::read` — does not pin a tokio worker. The caller
/// is still responsible for wrapping the future in `tokio::time::timeout`
/// to bound wall-clock; the spawn_blocking pool (default 512 threads)
/// absorbs the load.
pub async fn resolve_bytes(spec: &str) -> Result<Vec<u8>, HelperError> {
    let spec_owned = spec.to_owned();
    tokio::task::spawn_blocking(move || resolve_bytes_blocking(&spec_owned))
        .await
        .map_err(|join_err| {
            tracing::error!(
                target: "leyline_sign_helper",
                op = "resolve_blocking",
                outcome = "join_error",
                err = %join_err,
            );
            HelperError::Internal
        })?
}

/// Synchronous dispatch used inside `spawn_blocking`. Exposed for unit
/// tests that don't want a tokio runtime; production callers should use
/// the async `resolve_bytes` wrapper.
pub fn resolve_bytes_blocking(spec: &str) -> Result<Vec<u8>, HelperError> {
    let parsed = parse_spec(spec)?;
    match parsed.scheme {
        Scheme::Keychain | Scheme::SecretTool => {
            let account = keychain_account();
            let nono_uri = format!("keyring://{}/{}", parsed.remainder, account);
            read_via_nono(&nono_uri)
        }
        Scheme::Keyring => {
            let nono_uri = format!("keyring://{}", parsed.remainder);
            read_via_nono(&nono_uri)
        }
        Scheme::Op => read_op_bytes(&parsed.remainder),
        Scheme::ApplePassword => read_apple_password_bytes(&parsed.remainder),
        Scheme::File => read_file_bytes(&parsed.remainder),
    }
}

/// Resolve and return just the scheme label, for log lines (per ADR-0019
/// normative req. 11 — only scheme, never the remainder).
pub fn scheme_label(spec: &str) -> &'static str {
    if let Ok(parsed) = parse_spec(spec) {
        parsed.scheme.label()
    } else {
        "<invalid>"
    }
}

fn keychain_account() -> String {
    std::env::var("KEYCHAIN_ACCOUNT").unwrap_or_else(|_| DEFAULT_KEYCHAIN_ACCOUNT.to_string())
}

/// Dispatch a `keyring://` URI to nono and apply cloister's
/// trim-trailing-newlines discipline. Reaches only nono's `keyring`-crate
/// backend (no subprocess); the trust-module link reached via
/// `?decode=go-keyring` is blocked at `parse_spec` so this call is the
/// minimal-surface variant of nono.
fn read_via_nono(nono_uri: &str) -> Result<Vec<u8>, HelperError> {
    let result = nono::keystore::load_secret_by_ref(NONO_SERVICE_FALLBACK, nono_uri);
    match result {
        Ok(loaded) => Ok(trim_trailing_newlines(loaded.as_bytes())),
        Err(e) => Err(map_nono_err_logged(e, "nono_keyring")),
    }
}

/// Log the nono diagnostic (already URI-redacted by nono's `redact_*_uri`
/// functions, so this does not violate ADR-0019 req 11) at warn level
/// before collapsing to `HelperError`. Closes silence-friend Gap 3 from
/// the 2026-05-13 cycle.
fn map_nono_err_logged(e: nono::NonoError, backend: &'static str) -> HelperError {
    let (outcome, mapped) = classify_nono_err(&e);
    tracing::warn!(
        target: "leyline_sign_helper",
        op = "resolve",
        backend = backend,
        outcome = outcome,
        // nono's `Display` for these variants embeds only redacted URIs;
        // see `redact_keyring_uri`, `redact_op_uri`, `redact_apple_password_uri`,
        // `redact_file_uri` in upstream nono. The `%e` format is safe.
        nono_detail = %e,
    );
    mapped
}

/// Map nono errors to a stable (outcome-label, HelperError) pair.
///
/// **Wire collapse:** ALL keystore-side failures map to `HelperError::NotFound`
/// — byte-identical with the constant-time 404. Oracle-friend F1 + F2
/// from the 2026-05-13 cycle: `KeystoreLocked` (503) and `BadRequest`
/// (400) on different nono variants leaked "present-but-locked" vs
/// "shape-wrong" vs "absent". Collapsing to 404 preserves the §9.4
/// constant-time invariant the helper inherits via
/// `error.rs::const_time_404_and_500_byte_identical`.
fn classify_nono_err(e: &nono::NonoError) -> (&'static str, HelperError) {
    match e {
        nono::NonoError::SecretNotFound(_) => ("not_found", HelperError::NotFound),
        nono::NonoError::KeystoreAccess(_) => ("keystore_locked", HelperError::NotFound),
        nono::NonoError::ConfigParse(_) => ("bad_uri", HelperError::NotFound),
        _ => ("internal", HelperError::NotFound),
    }
}

/// Local `op://` subprocess shim. Bypasses nono's `Command::new("op")`
/// bare-name lookup; uses an operator-pinned absolute path via
/// `LEYLINE_SIGN_OP_BIN`. Refuses (NotFound) if the env var is unset or
/// the path doesn't exist. Closes trust-root-friend F3 (PATH hijack) +
/// isolation-friend F-iso-3 (subprocess env wholesale inheritance) from
/// the 2026-05-13 cycle.
fn read_op_bytes(remainder: &str) -> Result<Vec<u8>, HelperError> {
    let uri = format!("op://{}", remainder);
    // Validate via nono (no subprocess; pure URI parse + char allow-list).
    if let Err(e) = nono::keystore::validate_op_uri(&uri) {
        return Err(map_nono_err_logged(e, "op_validate"));
    }
    let op_bin = match pinned_subprocess_path("LEYLINE_SIGN_OP_BIN") {
        Some(p) => p,
        None => {
            tracing::warn!(
                target: "leyline_sign_helper",
                op = "resolve",
                backend = "op",
                outcome = "subprocess_unpinned",
                "LEYLINE_SIGN_OP_BIN unset or path missing; op:// is refused. \
                 Set it to the absolute path of the `op` binary (e.g. /opt/1Password/bin/op)."
            );
            return Err(HelperError::NotFound);
        }
    };
    run_subprocess_with_trim(
        "op",
        &op_bin,
        &[OsString::from("read"), OsString::from("--"), OsString::from(&uri)],
        &op_env_allowlist(),
    )
}

/// Local `apple-password://` subprocess shim. Same discipline as
/// `read_op_bytes`. macOS-only.
fn read_apple_password_bytes(remainder: &str) -> Result<Vec<u8>, HelperError> {
    let uri = format!("apple-password://{}", remainder);
    if let Err(e) = nono::keystore::validate_apple_password_uri(&uri) {
        return Err(map_nono_err_logged(e, "apple_validate"));
    }
    let (server, account) = parse_apple_password_remainder(remainder)?;
    let security_bin = match pinned_subprocess_path("LEYLINE_SIGN_SECURITY_BIN") {
        Some(p) => p,
        None => {
            tracing::warn!(
                target: "leyline_sign_helper",
                op = "resolve",
                backend = "apple_password",
                outcome = "subprocess_unpinned",
                "LEYLINE_SIGN_SECURITY_BIN unset or path missing; apple-password:// is refused. \
                 Set it to the absolute path of the macOS `security` binary (e.g. /usr/bin/security)."
            );
            return Err(HelperError::NotFound);
        }
    };
    run_subprocess_with_trim(
        "security",
        &security_bin,
        &[
            OsString::from("find-internet-password"),
            OsString::from("-s"),
            OsString::from(&server),
            OsString::from("-a"),
            OsString::from(&account),
            OsString::from("-w"),
        ],
        &apple_password_env_allowlist(),
    )
}

/// Parse `server/account` out of an apple-password URI remainder. nono's
/// `parse_apple_password_uri` isn't pub, so we re-parse here. Validation
/// already happened via `validate_apple_password_uri`.
fn parse_apple_password_remainder(remainder: &str) -> Result<(String, String), HelperError> {
    let (server, rest) = remainder
        .split_once('/')
        .ok_or(HelperError::BadRequest("apple-password URI missing account segment"))?;
    if server.is_empty() {
        return Err(HelperError::BadRequest("apple-password URI has empty server"));
    }
    if rest.is_empty() {
        return Err(HelperError::BadRequest("apple-password URI has empty account"));
    }
    if rest.contains('/') {
        return Err(HelperError::BadRequest("apple-password URI account must not contain '/'"));
    }
    Ok((server.to_owned(), rest.to_owned()))
}

/// Returns the env-var value as a PathBuf if it (a) is non-empty, (b) is
/// absolute, and (c) points to an extant regular file. Returns None on
/// any failure so the caller can refuse the scheme.
fn pinned_subprocess_path(env_var: &str) -> Option<PathBuf> {
    let raw = std::env::var(env_var).ok()?;
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return None;
    }
    let meta = std::fs::metadata(&path).ok()?;
    if !meta.is_file() {
        return None;
    }
    Some(path)
}

/// Env vars passed to the `op` subprocess. Everything else is stripped.
fn op_env_allowlist() -> Vec<&'static str> {
    vec![
        "HOME",                      // op writes ~/.op state
        "OP_SERVICE_ACCOUNT_TOKEN",  // non-interactive auth
        "OP_SESSION_my",             // interactive sessions follow OP_SESSION_<account>
        "OP_ACCOUNT",                // account selector
        "OP_DEVICE",                 // device id
    ]
}

/// Env vars passed to the `security` subprocess.
fn apple_password_env_allowlist() -> Vec<&'static str> {
    vec![
        "HOME", // security reads ~/Library/Keychains/* by default
    ]
}

/// Spawn the subprocess with `env_clear` + an allow-list, capture
/// stdout, kill on timeout, return trimmed bytes. Mirrors nono's
/// `load_from_op` / `load_from_apple_password` shape but with the
/// path + env hardening cloister needs.
fn run_subprocess_with_trim(
    backend: &'static str,
    bin: &Path,
    args: &[OsString],
    env_allowlist: &[&str],
) -> Result<Vec<u8>, HelperError> {
    let mut cmd = Command::new(bin);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_clear();
    // Set a minimal PATH so the child can find any sibling tools it
    // needs (e.g. 1Password's `op` may exec into a helper inside the
    // 1Password app bundle). Empty PATH breaks `op` on some installs.
    cmd.env("PATH", "/usr/bin:/bin:/usr/local/bin");
    for var in env_allowlist {
        if let Ok(val) = std::env::var(var) {
            cmd.env(var, val);
        }
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(
                target: "leyline_sign_helper",
                op = "resolve",
                backend = backend,
                outcome = "subprocess_spawn_failed",
                err = %e,
            );
            return Err(HelperError::NotFound);
        }
    };
    // Poll-and-kill with our own (tighter) timeout. nono's internal
    // 30s is too long for cloister's 5s outer cap; we kill the child
    // at SUBPROCESS_TIMEOUT and return NotFound on the wire so the
    // §9.4 constant-time invariant holds.
    let deadline = Instant::now() + SUBPROCESS_TIMEOUT;
    let exit_status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    tracing::warn!(
                        target: "leyline_sign_helper",
                        op = "resolve",
                        backend = backend,
                        outcome = "subprocess_timeout",
                    );
                    return Err(HelperError::NotFound);
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                tracing::warn!(
                    target: "leyline_sign_helper",
                    op = "resolve",
                    backend = backend,
                    outcome = "subprocess_wait_failed",
                    err = %e,
                );
                return Err(HelperError::Internal);
            }
        }
    };
    let mut stdout = Vec::new();
    if let Some(mut s) = child.stdout.take() {
        if let Err(e) = s.read_to_end(&mut stdout) {
            tracing::warn!(
                target: "leyline_sign_helper",
                op = "resolve",
                backend = backend,
                outcome = "subprocess_stdout_read_failed",
                err = %e,
            );
            return Err(HelperError::Internal);
        }
    }
    if !exit_status.success() {
        let mut stderr = Vec::new();
        if let Some(mut s) = child.stderr.take() {
            let _ = s.read_to_end(&mut stderr);
        }
        let stderr_lossy = String::from_utf8_lossy(&stderr);
        // Log a single-line classified summary; stderr is already
        // operator-locale, but the substring is the operator-actionable
        // signal (e.g. "not signed in" vs "session expired").
        tracing::warn!(
            target: "leyline_sign_helper",
            op = "resolve",
            backend = backend,
            outcome = "subprocess_nonzero_exit",
            exit_code = exit_status.code().unwrap_or(-1),
            stderr_summary = %stderr_lossy.lines().next().unwrap_or("<empty>"),
        );
        return Err(HelperError::NotFound);
    }
    Ok(trim_trailing_newlines(&stdout))
}

fn read_file_bytes(remainder: &str) -> Result<Vec<u8>, HelperError> {
    // Path-traversal defense.
    if remainder.contains("..") {
        return Err(HelperError::BadRequest("path contains .."));
    }
    let pathbuf = PathBuf::from(remainder);
    if !pathbuf.is_absolute() {
        return Err(HelperError::BadRequest("file:// path must be absolute"));
    }
    if is_symlink(&pathbuf).unwrap_or(false) {
        return Err(HelperError::BadRequest("file:// path is a symlink"));
    }
    // Permission check — warn but don't refuse if perms are looser.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&pathbuf) {
            let mode = meta.permissions().mode() & 0o777;
            if mode & 0o077 != 0 {
                tracing::warn!(target: "leyline_sign_helper",
                    "file:// keystore source has permissive mode {:#o}; recommend 0600",
                    mode
                );
            }
        }
    }
    match std::fs::read(&pathbuf) {
        Ok(bytes) => Ok(trim_trailing_newlines(&bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(HelperError::NotFound),
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
            // PermissionDenied on file:// is operator misconfiguration,
            // not an enumeration oracle (the URL is operator-pinned). Map
            // to NotFound for wire-shape consistency with the keystore
            // backends (oracle-friend F1 collapse).
            Err(HelperError::NotFound)
        }
        Err(_) => Err(HelperError::Internal),
    }
}

fn is_symlink(p: &Path) -> std::io::Result<bool> {
    Ok(std::fs::symlink_metadata(p)?.file_type().is_symlink())
}

/// Strip trailing CR/LF runs. Matches the JS sidecar's
/// `String#replace(/\r?\n+$/, "")` for golden-vector byte parity
/// (cloister-993bef Phase B gate).
pub fn trim_trailing_newlines(b: &[u8]) -> Vec<u8> {
    let mut end = b.len();
    while end > 0 && (b[end - 1] == b'\n' || b[end - 1] == b'\r') {
        end -= 1;
    }
    b[..end].to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_matches_kek_helper_mjs_regex() {
        assert_eq!(trim_trailing_newlines(b"abc\n"), b"abc");
        assert_eq!(trim_trailing_newlines(b"abc\n\n"), b"abc");
        assert_eq!(trim_trailing_newlines(b"abc\r\n"), b"abc");
        assert_eq!(trim_trailing_newlines(b"abc\r\n\r\n"), b"abc");
        assert_eq!(trim_trailing_newlines(b"abc"), b"abc");
        assert_eq!(trim_trailing_newlines(b""), b"");
        assert_eq!(trim_trailing_newlines(b"\nabc"), b"\nabc");
    }

    #[test]
    fn parse_spec_known_schemes() {
        assert_eq!(parse_spec("keychain://svc").unwrap().scheme, Scheme::Keychain);
        assert_eq!(parse_spec("secret-tool://svc").unwrap().scheme, Scheme::SecretTool);
        assert_eq!(parse_spec("keyring://svc/acct").unwrap().scheme, Scheme::Keyring);
        assert_eq!(parse_spec("op://v/i/f").unwrap().scheme, Scheme::Op);
        assert_eq!(parse_spec("apple-password://srv/acct").unwrap().scheme, Scheme::ApplePassword);
        assert_eq!(parse_spec("file:///etc/x").unwrap().scheme, Scheme::File);
    }

    #[test]
    fn parse_spec_unknown_scheme() {
        assert!(parse_spec("http://x").is_err());
        assert!(parse_spec("just-a-string").is_err());
        assert!(parse_spec("keychain://").is_err());
        assert!(parse_spec("op://").is_err());
        assert!(parse_spec("apple-password://").is_err());
    }

    #[test]
    fn parse_spec_rejects_query_strings() {
        // Closes trust-root-friend F5 + replay-friend F1 from the
        // 2026-05-13 cycle: nono's `?decode=go-keyring` reaches into
        // nono's trust module. Reject at parse time.
        let r = parse_spec("keyring://svc/acct?decode=go-keyring");
        assert!(matches!(r, Err(HelperError::BadRequest(_))), "got {:?}", r);
        assert!(matches!(
            parse_spec("op://v/i/f?extra=1"),
            Err(HelperError::BadRequest(_))
        ));
        assert!(matches!(
            parse_spec("keychain://svc?account=other"),
            Err(HelperError::BadRequest(_))
        ));
    }

    #[test]
    fn parse_spec_rejects_fragments() {
        assert!(matches!(parse_spec("keyring://svc/acct#frag"), Err(HelperError::BadRequest(_))));
        assert!(matches!(parse_spec("file:///etc/x#1"), Err(HelperError::BadRequest(_))));
    }

    #[test]
    fn file_scheme_rejects_traversal_and_relative_paths() {
        assert!(matches!(read_file_bytes("/etc/../etc/hosts"), Err(HelperError::BadRequest(_))));
        assert!(matches!(read_file_bytes("relative/path"), Err(HelperError::BadRequest(_))));
    }

    #[test]
    fn apple_password_remainder_parse() {
        let (s, a) = parse_apple_password_remainder("example.com/me@example").unwrap();
        assert_eq!(s, "example.com");
        assert_eq!(a, "me@example");
        assert!(parse_apple_password_remainder("noaccount").is_err());
        assert!(parse_apple_password_remainder("/account").is_err());
        assert!(parse_apple_password_remainder("server/").is_err());
        assert!(parse_apple_password_remainder("server/account/extra").is_err());
    }

    #[test]
    fn classify_nono_err_collapses_to_not_found() {
        // Oracle-friend F1 + F2: all nono errors map to NotFound on the
        // wire so the constant-time 404 shape holds. The first element
        // of the tuple is the log label (distinct) — that distinguishes
        // for operators in tracing, not for adversaries on the wire.
        for (e, expected_label) in [
            (nono::NonoError::SecretNotFound("x".into()), "not_found"),
            (nono::NonoError::KeystoreAccess("x".into()), "keystore_locked"),
            (nono::NonoError::ConfigParse("x".into()), "bad_uri"),
        ] {
            let (label, mapped) = classify_nono_err(&e);
            assert_eq!(label, expected_label);
            assert!(matches!(mapped, HelperError::NotFound));
        }
    }
}
