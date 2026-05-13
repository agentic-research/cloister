// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 cloister contributors
//
// URL-spec → bytes keystore resolver (ADR-0014 + ADR-0019).
//
// Supported schemes:
//
//   - `keychain://<service>`     — macOS Keychain via `nono::keystore`
//                                  (`keyring` backend). KEYCHAIN_ACCOUNT env
//                                  var (default "cloister") selects the
//                                  account name.
//   - `secret-tool://<service>`  — Linux libsecret via `nono::keystore`
//                                  (`keyring` backend). Same account
//                                  selection as `keychain://`.
//   - `keyring://<svc>/<acct>`   — explicit-form keyring URI (both service
//                                  and account in the URI). Pass-through to
//                                  `nono::keystore::load_secret_by_ref`.
//   - `op://<vault>/<item>/<field>` — 1Password via the `op` CLI (handled
//                                  by `nono`). Requires `op` on PATH.
//   - `apple-password://<server>/<account>` — Apple Passwords via the macOS
//                                  `security` CLI (handled by `nono`).
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
// `/resolve` semantic (golden-vector parity with `scripts/kek-helper.mjs`):
// the macOS keychain helper trims trailing CR/LF from the resolved bytes.
// We reproduce that exactly in `read_keystore_string_with_trim` — this is
// the cloister-993bef Phase B migration gate.

use std::path::{Path, PathBuf};

use crate::host::error::HelperError;

const DEFAULT_KEYCHAIN_ACCOUNT: &str = "cloister";

/// Service name passed to `nono::keystore::load_secret_by_ref` when the
/// credential reference is a bare account (no scheme). Cloister's URIs
/// always carry a scheme, so this is only used as the fallback `service`
/// argument and is never reached as the dispatch target.
const NONO_SERVICE_FALLBACK: &str = "cloister";

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
    /// `keychain://<service>` — macOS-flavored alias for the unified keyring
    /// backend. Translated to a `keyring://<service>/<account>` URI before
    /// dispatch.
    Keychain,
    /// `secret-tool://<service>` — Linux-flavored alias for the unified
    /// keyring backend. Same translation as `Keychain`.
    SecretTool,
    /// `keyring://<service>/<account>` — explicit-form keyring URI; passed
    /// through to nono verbatim.
    Keyring,
    /// `op://<vault>/<item>/<field>` — 1Password via `op` CLI.
    Op,
    /// `apple-password://<server>/<account>` — Apple Passwords via the
    /// macOS `security` CLI.
    ApplePassword,
    /// `file:///<absolute path>` — raw-bytes file read. Handled by cloister,
    /// not nono. See the module preamble for the two invariants this
    /// preserves.
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
/// unknown schemes or empty remainder.
pub fn parse_spec(spec: &str) -> Result<ParsedSpec, HelperError> {
    // Order matters: longer prefixes first so `apple-password://` is
    // checked before any potential overlap (none today, but cheap to be
    // explicit).
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

/// Resolve the URL spec to raw key bytes. The bytes are returned with the
/// same trim-trailing-newlines discipline as `scripts/kek-helper.mjs` —
/// see `read_keystore_string_with_trim`.
pub fn resolve_bytes(spec: &str) -> Result<Vec<u8>, HelperError> {
    let parsed = parse_spec(spec)?;
    match parsed.scheme {
        Scheme::Keychain | Scheme::SecretTool => {
            // Both legacy aliases route to nono's keyring backend with the
            // configured KEYCHAIN_ACCOUNT supplying the account slot.
            let account = keychain_account();
            let nono_uri = format!("keyring://{}/{}", parsed.remainder, account);
            read_keystore_string_with_trim(&nono_uri)
        }
        Scheme::Keyring => {
            // Explicit form — caller already encoded service + account.
            let nono_uri = format!("keyring://{}", parsed.remainder);
            read_keystore_string_with_trim(&nono_uri)
        }
        Scheme::Op => {
            let nono_uri = format!("op://{}", parsed.remainder);
            read_keystore_string_with_trim(&nono_uri)
        }
        Scheme::ApplePassword => {
            let nono_uri = format!("apple-password://{}", parsed.remainder);
            read_keystore_string_with_trim(&nono_uri)
        }
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

/// Dispatch a nono URI (keyring://, op://, apple-password://) to nono's
/// keystore and apply cloister's trim-trailing-newlines discipline to the
/// returned UTF-8 string. The trim is a superset of nono's internal trim
/// (nono strips at most one `\r\n` or `\n`; cloister strips runs of CRLF
/// to match `scripts/kek-helper.mjs`'s `/\r?\n+$/`).
fn read_keystore_string_with_trim(nono_uri: &str) -> Result<Vec<u8>, HelperError> {
    let loaded = nono::keystore::load_secret_by_ref(NONO_SERVICE_FALLBACK, nono_uri)
        .map_err(map_nono_err)?;
    Ok(trim_trailing_newlines(loaded.as_bytes()))
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

/// Map `nono::NonoError` variants to `HelperError`. The constant-time 404
/// invariant requires `NotFound` and `Internal` to produce byte-identical
/// responses (covered by `error::HelperError::const_time_404_and_500_byte_identical`);
/// `KeystoreLocked` is a distinct 503 path used when the OS keystore is
/// reachable but cannot fulfill the request (locked / permission denied).
fn map_nono_err(e: nono::NonoError) -> HelperError {
    match e {
        nono::NonoError::SecretNotFound(_) => HelperError::NotFound,
        nono::NonoError::KeystoreAccess(_) => HelperError::KeystoreLocked,
        nono::NonoError::ConfigParse(_) => HelperError::BadRequest("keystore uri rejected"),
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
    fn file_scheme_rejects_traversal_and_relative_paths() {
        assert!(matches!(read_file_bytes("/etc/../etc/hosts"), Err(HelperError::BadRequest(_))));
        assert!(matches!(read_file_bytes("relative/path"), Err(HelperError::BadRequest(_))));
    }
}
