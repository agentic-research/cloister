// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 cloister contributors
//
// URL-spec → bytes keystore resolver (ADR-0014 + ADR-0019).
//
// Supported schemes:
//
//   - `keychain://<service>`     — macOS Keychain (`keyring` crate, generic
//                                  password). The KEYCHAIN_ACCOUNT env var
//                                  (default "cloister") selects the account.
//   - `secret-tool://<service>`  — Linux libsecret (`keyring` crate).
//   - `file:///<absolute path>`  — read raw bytes from path. Refuses to
//                                  follow symlinks, refuses paths containing
//                                  `..`, warns if perms are looser than 0600.
//
// `/resolve` semantic (golden-vector parity with `scripts/kek-helper.mjs`):
// the macOS keychain helper trims trailing CR/LF from the resolved bytes.
// We reproduce that exactly in `read_keychain_bytes_with_trim` — this is
// the cloister-993bef Phase B migration gate.

use std::path::{Path, PathBuf};

use crate::host::error::HelperError;

const DEFAULT_KEYCHAIN_ACCOUNT: &str = "cloister";

/// All supported URL schemes (shown verbatim in `GET /healthz`).
pub const SUPPORTED_SCHEMES: &[&str] = &["keychain://", "secret-tool://", "file://"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scheme {
    Keychain,
    SecretTool,
    File,
}

impl Scheme {
    pub fn label(self) -> &'static str {
        match self {
            Scheme::Keychain => "keychain://",
            Scheme::SecretTool => "secret-tool://",
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
/// unknown schemes or empty remainder.
pub fn parse_spec(spec: &str) -> Result<ParsedSpec, HelperError> {
    for (label, scheme) in [
        ("keychain://", Scheme::Keychain),
        ("secret-tool://", Scheme::SecretTool),
        ("file://", Scheme::File),
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

/// Resolve the URL spec to raw key bytes. The bytes are returned with the
/// same trim-trailing-newlines discipline as `scripts/kek-helper.mjs` —
/// see `read_keychain_bytes_with_trim`.
pub fn resolve_bytes(spec: &str) -> Result<Vec<u8>, HelperError> {
    let parsed = parse_spec(spec)?;
    match parsed.scheme {
        Scheme::Keychain => read_keychain_bytes_with_trim(&parsed.remainder),
        Scheme::SecretTool => read_secret_tool_bytes_with_trim(&parsed.remainder),
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

/// macOS Keychain via `keyring` crate. The bytes are stored as a string
/// password (matching `security add-generic-password -w <hex>` from the
/// kek-helper.mjs golden vectors); we trim trailing CR/LF for byte-exact
/// parity.
fn read_keychain_bytes_with_trim(service: &str) -> Result<Vec<u8>, HelperError> {
    if service.is_empty() {
        return Err(HelperError::BadRequest("empty service"));
    }
    let account = keychain_account();
    let entry = keyring::Entry::new(service, &account).map_err(map_keyring_err)?;
    match entry.get_password() {
        Ok(s) => Ok(trim_trailing_newlines(s.as_bytes())),
        Err(e) => Err(map_keyring_err(e)),
    }
}

/// Linux libsecret via `keyring` crate. Same trim discipline as keychain.
fn read_secret_tool_bytes_with_trim(service: &str) -> Result<Vec<u8>, HelperError> {
    if service.is_empty() {
        return Err(HelperError::BadRequest("empty service"));
    }
    let account = keychain_account();
    let entry = keyring::Entry::new(service, &account).map_err(map_keyring_err)?;
    match entry.get_password() {
        Ok(s) => Ok(trim_trailing_newlines(s.as_bytes())),
        Err(e) => Err(map_keyring_err(e)),
    }
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
            Err(HelperError::KeystoreLocked)
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

/// Map `keyring::Error` to `HelperError`. The `keyring` crate's `NoEntry`
/// variant is the canonical "entry not found" — collapses to constant-time
/// 404. Everything else is `Internal` (which also collapses to the same
/// shape per `error::HelperError::Internal`).
fn map_keyring_err(e: keyring::Error) -> HelperError {
    match e {
        keyring::Error::NoEntry => HelperError::NotFound,
        keyring::Error::PlatformFailure(_) => HelperError::KeystoreLocked,
        keyring::Error::NoStorageAccess(_) => HelperError::KeystoreLocked,
        _ => HelperError::Internal,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_matches_kek_helper_mjs_regex() {
        // The JS helper applies /\r?\n+$/ — strip a run of CRLFs at end.
        assert_eq!(trim_trailing_newlines(b"abc\n"), b"abc");
        assert_eq!(trim_trailing_newlines(b"abc\n\n"), b"abc");
        assert_eq!(trim_trailing_newlines(b"abc\r\n"), b"abc");
        assert_eq!(trim_trailing_newlines(b"abc\r\n\r\n"), b"abc");
        assert_eq!(trim_trailing_newlines(b"abc"), b"abc");
        assert_eq!(trim_trailing_newlines(b""), b"");
        // Leading newlines NOT trimmed.
        assert_eq!(trim_trailing_newlines(b"\nabc"), b"\nabc");
    }

    #[test]
    fn parse_spec_known_schemes() {
        assert_eq!(parse_spec("keychain://svc").unwrap().scheme, Scheme::Keychain);
        assert_eq!(parse_spec("secret-tool://svc").unwrap().scheme, Scheme::SecretTool);
        assert_eq!(parse_spec("file:///etc/x").unwrap().scheme, Scheme::File);
    }

    #[test]
    fn parse_spec_unknown_scheme() {
        assert!(parse_spec("http://x").is_err());
        assert!(parse_spec("just-a-string").is_err());
        assert!(parse_spec("keychain://").is_err());
    }

    #[test]
    fn file_scheme_rejects_traversal_and_relative_paths() {
        assert!(matches!(read_file_bytes("/etc/../etc/hosts"), Err(HelperError::BadRequest(_))));
        assert!(matches!(read_file_bytes("relative/path"), Err(HelperError::BadRequest(_))));
    }
}
