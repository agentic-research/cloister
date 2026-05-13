// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 cloister contributors
//
// URL-spec → bytes keystore resolver (ADR-0014 + ADR-0019).
//
// Supported schemes:
//
//   - `keychain://<service>`     — macOS Keychain via the `keyring` crate
//                                  (direct dep, no nono mediation).
//                                  `KEYCHAIN_ACCOUNT` env var (default
//                                  "cloister") selects the account name.
//   - `secret-tool://<service>`  — Linux libsecret via the `keyring` crate.
//                                  Same account selection as `keychain://`.
//   - `keyring://<svc>/<acct>`   — explicit-form keyring URI (both service
//                                  and account in the URI). Routed directly
//                                  to `keyring::Entry::new`.
//   - `op://<vault>/<item>/<field>` — 1Password via the `op` CLI. **REQUIRES
//                                  THE `host-extras` FEATURE.** Default
//                                  `host` builds refuse this scheme with
//                                  BadRequest("scheme requires host-extras
//                                  feature"). Under host-extras, the URI
//                                  is validated via `nono::keystore::validate_op_uri`
//                                  and the subprocess runs via cloister's
//                                  own shim (NOT nono's `Command::new`) using
//                                  `LEYLINE_SIGN_OP_BIN` for absolute path
//                                  pinning.
//   - `apple-password://<server>/<account>` — Apple Passwords via the macOS
//                                  `security` CLI. **REQUIRES `host-extras`.**
//                                  Same discipline as `op://`. macOS only.
//   - `file:///<absolute path>`  — read raw bytes from path. Refuses to
//                                  follow symlinks, refuses paths containing
//                                  `..`, warns if perms are looser than 0600.
//
// **Feature-gating rationale (2026-05-13 cycle row 17.1):** the `nono`
// crate that mediates `op://` + `apple-password://` URI validation pulls
// sigstore-verify, sigstore-trust-root, aws-lc-rs (+ aws-lc-sys),
// landlock, x509-cert, and ~80 other transitive crates into the helper's
// trust closure. Default `host` deploys avoid this closure by routing
// only the schemes that don't need nono (keychain/secret-tool/keyring/file).
// Operators who need 1Password / Apple Passwords integration opt in via
// `--features host,host-extras`.
//
// All schemes reject query strings (`?...`) and fragments (`#...`) at
// parse time (cf. trust-root F5 / replay F1 from the 2026-05-13 cycle).
//
// `/resolve` semantic (golden-vector parity with `scripts/kek-helper.mjs`):
// the macOS keychain helper trims trailing CR/LF from the resolved bytes.
// We reproduce that exactly in `trim_trailing_newlines` — cloister-993bef
// Phase B migration gate.
//
// Async surface: `resolve_bytes(spec).await` wraps the dispatch in
// `tokio::task::spawn_blocking` so the (potentially-slow) keystore I/O
// — `keyring` crate IPC, `op` subprocess, `security` subprocess, even
// `std::fs::read` — runs on the dedicated blocking pool, not on the
// tokio worker threads. Closes dos-friend F1 / silence-friend Gap 2.

#[cfg(feature = "host-extras")]
use std::ffi::OsString;
#[cfg(feature = "host-extras")]
use std::io::Read;
use std::path::{Path, PathBuf};
#[cfg(feature = "host-extras")]
use std::process::{Command, Stdio};
#[cfg(feature = "host-extras")]
use std::time::Instant;

use crate::host::error::HelperError;

const DEFAULT_KEYCHAIN_ACCOUNT: &str = "cloister";

/// Per-subprocess wall-clock cap for `op` and `security` CLI invocations
/// (host-extras only). Tighter than nono's internal 30s — the helper's
/// outer `SIGN_TIMEOUT` is 5s and the subprocess timer MUST fire first
/// so the helper kills the child and frees the worker. 4500ms gives the
/// subprocess time to run (op + 1Password authn is ~1-2s warm; FaceID
/// is ~3s) while still leaving budget for the rest of the sign pipeline
/// before SIGN_TIMEOUT.
#[cfg(feature = "host-extras")]
const SUBPROCESS_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(4_500);

/// All supported URL schemes (shown verbatim in `GET /healthz`).
///
/// Op + apple-password are included only when `host-extras` is enabled
/// — operators discover via `/healthz` whether their build includes
/// those backends.
#[cfg(not(feature = "host-extras"))]
pub const SUPPORTED_SCHEMES: &[&str] = &[
    "keychain://",
    "secret-tool://",
    "keyring://",
    "file://",
];
#[cfg(feature = "host-extras")]
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
/// Note: parsing recognizes `op://` and `apple-password://` regardless
/// of the `host-extras` feature; the dispatch step (`resolve_bytes_blocking`)
/// is what enforces feature gating. This keeps URL-shape error
/// messages consistent across builds.
pub fn parse_spec(spec: &str) -> Result<ParsedSpec, HelperError> {
    if spec.contains('?') {
        return Err(HelperError::BadRequest("query strings are not permitted"));
    }
    if spec.contains('#') {
        return Err(HelperError::BadRequest("fragments are not permitted"));
    }
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

/// Synchronous dispatch used inside `spawn_blocking`.
pub fn resolve_bytes_blocking(spec: &str) -> Result<Vec<u8>, HelperError> {
    let parsed = parse_spec(spec)?;
    match parsed.scheme {
        Scheme::Keychain | Scheme::SecretTool => {
            let account = keychain_account();
            read_via_keyring(&parsed.remainder, &account)
        }
        Scheme::Keyring => {
            let (svc, acct) = parse_keyring_remainder(&parsed.remainder)?;
            read_via_keyring(&svc, &acct)
        }
        Scheme::File => read_file_bytes(&parsed.remainder),
        #[cfg(feature = "host-extras")]
        Scheme::Op => read_op_bytes(&parsed.remainder),
        #[cfg(feature = "host-extras")]
        Scheme::ApplePassword => read_apple_password_bytes(&parsed.remainder),
        #[cfg(not(feature = "host-extras"))]
        Scheme::Op | Scheme::ApplePassword => {
            tracing::warn!(
                target: "leyline_sign_helper",
                op = "resolve",
                scheme = parsed.scheme.label(),
                outcome = "scheme_requires_host_extras",
                "scheme is recognized but the binary was built without the host-extras feature; \
                 rebuild with `--features host,host-extras` to enable 1Password / Apple Passwords"
            );
            Err(HelperError::BadRequest("scheme requires the host-extras feature"))
        }
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

// ── Keyring backend (direct, no nono) ──────────────────────────────────────

/// Parse `keyring://<svc>/<acct>` remainder into `(service, account)`.
fn parse_keyring_remainder(remainder: &str) -> Result<(String, String), HelperError> {
    let (svc, acct) = remainder
        .split_once('/')
        .ok_or(HelperError::BadRequest("keyring URI missing account segment"))?;
    if svc.is_empty() {
        return Err(HelperError::BadRequest("keyring URI has empty service"));
    }
    if acct.is_empty() {
        return Err(HelperError::BadRequest("keyring URI has empty account"));
    }
    if acct.contains('/') {
        return Err(HelperError::BadRequest("keyring URI account must not contain '/'"));
    }
    Ok((svc.to_owned(), acct.to_owned()))
}

/// Read the stored credential via the `keyring` crate. All error
/// variants collapse to `HelperError::NotFound` for wire-shape
/// consistency (oracle-friend F1 from the 2026-05-13 cycle); operator
/// signal lives in the structured warn log.
///
/// The log line carries only the scheme + outcome label + error
/// variant name — never the keyring error's `Display` (which embeds
/// service/account-shaped strings). Closes the silence-Gap-3 follow-up
/// from the cycle: ADR-0019 req 11 ("log only operation + scheme +
/// outcome") is upheld at granularity of *scheme*, not service.
fn read_via_keyring(service: &str, account: &str) -> Result<Vec<u8>, HelperError> {
    let entry = match keyring::Entry::new(service, account) {
        Ok(e) => e,
        Err(e) => {
            tracing::warn!(
                target: "leyline_sign_helper",
                op = "resolve",
                backend = "keyring",
                outcome = "entry_init_failed",
                variant = keyring_error_variant(&e),
            );
            return Err(HelperError::NotFound);
        }
    };
    match entry.get_password() {
        Ok(s) => Ok(trim_trailing_newlines(s.as_bytes())),
        Err(e) => {
            tracing::warn!(
                target: "leyline_sign_helper",
                op = "resolve",
                backend = "keyring",
                outcome = keyring_outcome_label(&e),
                variant = keyring_error_variant(&e),
            );
            Err(HelperError::NotFound)
        }
    }
}

/// Stable outcome label for keyring errors. Operators read this label
/// to triage; it never embeds caller-supplied strings.
fn keyring_outcome_label(e: &keyring::Error) -> &'static str {
    match e {
        keyring::Error::NoEntry => "not_found",
        keyring::Error::Ambiguous(_) => "ambiguous",
        keyring::Error::PlatformFailure(_) => "platform_failure",
        keyring::Error::NoStorageAccess(_) => "no_storage_access",
        _ => "other",
    }
}

/// Stable variant-name label for engineering-side debugging.
fn keyring_error_variant(e: &keyring::Error) -> &'static str {
    match e {
        keyring::Error::NoEntry => "NoEntry",
        keyring::Error::Ambiguous(_) => "Ambiguous",
        keyring::Error::PlatformFailure(_) => "PlatformFailure",
        keyring::Error::NoStorageAccess(_) => "NoStorageAccess",
        keyring::Error::BadEncoding(_) => "BadEncoding",
        keyring::Error::TooLong(_, _) => "TooLong",
        keyring::Error::Invalid(_, _) => "Invalid",
        _ => "Other",
    }
}

// ── op:// + apple-password:// subprocess shims (host-extras only) ──────────

/// Local `op://` subprocess shim. Bypasses nono's `Command::new("op")`
/// bare-name lookup; uses an operator-pinned absolute path via
/// `LEYLINE_SIGN_OP_BIN`. Refuses (NotFound) if the env var is unset or
/// the path doesn't exist. Closes trust-root-friend F3 (PATH hijack) +
/// isolation-friend F-iso-3 (subprocess env wholesale inheritance) from
/// the 2026-05-13 cycle.
///
/// URI validation goes through `nono::keystore::validate_op_uri` (the
/// reason `host-extras` pulls nono in).
#[cfg(feature = "host-extras")]
fn read_op_bytes(remainder: &str) -> Result<Vec<u8>, HelperError> {
    let uri = format!("op://{}", remainder);
    if let Err(e) = nono::keystore::validate_op_uri(&uri) {
        return Err(map_nono_validation_err(e, "op_validate"));
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

/// Local `apple-password://` subprocess shim. macOS-only.
#[cfg(feature = "host-extras")]
fn read_apple_password_bytes(remainder: &str) -> Result<Vec<u8>, HelperError> {
    let uri = format!("apple-password://{}", remainder);
    if let Err(e) = nono::keystore::validate_apple_password_uri(&uri) {
        return Err(map_nono_validation_err(e, "apple_validate"));
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

/// Map nono URI-validation errors. Used only on the validation path
/// (the value-loading path is bypassed — we run the subprocess directly).
/// The log line emits a stable label, NOT nono's `Display` (which would
/// embed the URI string).
#[cfg(feature = "host-extras")]
fn map_nono_validation_err(e: nono::NonoError, backend: &'static str) -> HelperError {
    let variant = match &e {
        nono::NonoError::SecretNotFound(_) => "SecretNotFound",
        nono::NonoError::KeystoreAccess(_) => "KeystoreAccess",
        nono::NonoError::ConfigParse(_) => "ConfigParse",
        _ => "Other",
    };
    tracing::warn!(
        target: "leyline_sign_helper",
        op = "resolve",
        backend = backend,
        outcome = "uri_validation_failed",
        variant = variant,
    );
    HelperError::NotFound
}

#[cfg(feature = "host-extras")]
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
/// absolute, and (c) points to an extant regular file.
#[cfg(feature = "host-extras")]
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

#[cfg(feature = "host-extras")]
fn op_env_allowlist() -> Vec<&'static str> {
    vec![
        "HOME",
        "OP_SERVICE_ACCOUNT_TOKEN",
        "OP_SESSION_my",
        "OP_ACCOUNT",
        "OP_DEVICE",
    ]
}

#[cfg(feature = "host-extras")]
fn apple_password_env_allowlist() -> Vec<&'static str> {
    vec!["HOME"]
}

/// Spawn the subprocess with `env_clear` + an allow-list, capture stdout,
/// kill on timeout, return trimmed bytes.
#[cfg(feature = "host-extras")]
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
                io_kind = ?e.kind(),
            );
            return Err(HelperError::NotFound);
        }
    };
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
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(e) => {
                tracing::warn!(
                    target: "leyline_sign_helper",
                    op = "resolve",
                    backend = backend,
                    outcome = "subprocess_wait_failed",
                    io_kind = ?e.kind(),
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
                io_kind = ?e.kind(),
            );
            return Err(HelperError::Internal);
        }
    }
    if !exit_status.success() {
        tracing::warn!(
            target: "leyline_sign_helper",
            op = "resolve",
            backend = backend,
            outcome = "subprocess_nonzero_exit",
            exit_code = exit_status.code().unwrap_or(-1),
        );
        return Err(HelperError::NotFound);
    }
    Ok(trim_trailing_newlines(&stdout))
}

// ── file:// ────────────────────────────────────────────────────────────────

fn read_file_bytes(remainder: &str) -> Result<Vec<u8>, HelperError> {
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
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => Err(HelperError::NotFound),
        Err(_) => Err(HelperError::Internal),
    }
}

fn is_symlink(p: &Path) -> std::io::Result<bool> {
    Ok(std::fs::symlink_metadata(p)?.file_type().is_symlink())
}

/// Strip trailing CR/LF runs. Matches the JS sidecar's
/// `String#replace(/\r?\n+$/, "")` for golden-vector byte parity.
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
        let r = parse_spec("keyring://svc/acct?decode=go-keyring");
        assert!(matches!(r, Err(HelperError::BadRequest(_))), "got {:?}", r);
        assert!(matches!(parse_spec("op://v/i/f?extra=1"), Err(HelperError::BadRequest(_))));
        assert!(matches!(parse_spec("keychain://svc?account=other"), Err(HelperError::BadRequest(_))));
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
    fn keyring_remainder_parse() {
        let (s, a) = parse_keyring_remainder("svc/acct").unwrap();
        assert_eq!(s, "svc");
        assert_eq!(a, "acct");
        assert!(parse_keyring_remainder("noaccount").is_err());
        assert!(parse_keyring_remainder("/account").is_err());
        assert!(parse_keyring_remainder("svc/").is_err());
        assert!(parse_keyring_remainder("svc/acct/extra").is_err());
    }

    #[test]
    fn supported_schemes_minimal_in_default_host() {
        // Default `host` (no host-extras) MUST NOT advertise op:// or
        // apple-password:// since those backends are not compiled in.
        // Operators inspecting `/healthz.supported_schemes` see the
        // exact set their build supports.
        #[cfg(not(feature = "host-extras"))]
        {
            assert_eq!(SUPPORTED_SCHEMES.len(), 4);
            assert!(!SUPPORTED_SCHEMES.contains(&"op://"));
            assert!(!SUPPORTED_SCHEMES.contains(&"apple-password://"));
        }
        #[cfg(feature = "host-extras")]
        {
            assert_eq!(SUPPORTED_SCHEMES.len(), 6);
            assert!(SUPPORTED_SCHEMES.contains(&"op://"));
            assert!(SUPPORTED_SCHEMES.contains(&"apple-password://"));
        }
    }

    #[cfg(not(feature = "host-extras"))]
    #[test]
    fn op_scheme_refused_without_host_extras() {
        let r = resolve_bytes_blocking("op://vault/item/field");
        assert!(matches!(r, Err(HelperError::BadRequest(s)) if s.contains("host-extras")), "got {:?}", r);
    }

    #[cfg(not(feature = "host-extras"))]
    #[test]
    fn apple_password_scheme_refused_without_host_extras() {
        let r = resolve_bytes_blocking("apple-password://server/account");
        assert!(matches!(r, Err(HelperError::BadRequest(s)) if s.contains("host-extras")), "got {:?}", r);
    }

    #[cfg(feature = "host-extras")]
    #[test]
    fn op_refuses_without_pinned_bin() {
        unsafe {
            std::env::remove_var("LEYLINE_SIGN_OP_BIN");
        }
        let r = read_op_bytes("vault/item/field");
        assert!(matches!(r, Err(HelperError::NotFound)), "got {:?}", r);
    }

    #[cfg(feature = "host-extras")]
    #[test]
    fn apple_password_refuses_without_pinned_bin() {
        unsafe {
            std::env::remove_var("LEYLINE_SIGN_SECURITY_BIN");
        }
        let r = read_apple_password_bytes("server/account");
        assert!(matches!(r, Err(HelperError::NotFound)), "got {:?}", r);
    }

    #[cfg(feature = "host-extras")]
    #[test]
    fn pinned_path_rejects_relative() {
        unsafe {
            std::env::set_var("LEYLINE_SIGN_OP_BIN", "relative/op");
        }
        assert!(pinned_subprocess_path("LEYLINE_SIGN_OP_BIN").is_none());
        unsafe {
            std::env::remove_var("LEYLINE_SIGN_OP_BIN");
        }
    }

    #[cfg(feature = "host-extras")]
    #[test]
    fn pinned_path_rejects_missing_file() {
        unsafe {
            std::env::set_var("LEYLINE_SIGN_OP_BIN", "/this/path/does/not/exist/op");
        }
        assert!(pinned_subprocess_path("LEYLINE_SIGN_OP_BIN").is_none());
        unsafe {
            std::env::remove_var("LEYLINE_SIGN_OP_BIN");
        }
    }

    #[cfg(feature = "host-extras")]
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
}
