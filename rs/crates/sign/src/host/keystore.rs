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

/// Upper bound on bytes we'll read from a keystore subprocess's stdout.
///
/// Legitimate keystore outputs are tiny — Ed25519 raw key bytes are 32B,
/// base64 PEM blocks ~100B, x509 certs a few KB. 64 KiB is ~3 orders of
/// magnitude above any real ceiling and prevents an op/security CLI bug
/// or a hijacked binary from streaming until OOM. On overflow we drop
/// the bytes and surface `HelperError::Internal` (cloister-d9da67).
#[cfg(feature = "host-extras")]
const MAX_SUBPROCESS_STDOUT_BYTES: usize = 64 * 1024;

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

/// Resolve the URL spec to raw key bytes, off the tokio worker thread,
/// with **request coalescing** AND a **per-scheme TTL cache**:
///
///   - Concurrent callers for the same `spec` share one keystore round-
///     trip via per-spec singleflight (closes the dogfood-observed
///     concurrent-keychain hang).
///   - For subprocess-spawning schemes (`op://`, `apple-password://`),
///     successful read results are cached for `LEYLINE_SIGN_RESOLVE_TTL_MS`
///     ms (default 60_000). Within the TTL window, subsequent callers
///     get the cached bytes without re-spawning the CLI subprocess /
///     re-prompting FaceID. Rotation latency is TTL-bounded.
///   - For all other schemes (`keychain://`, `secret-tool://`,
///     `keyring://`, `file://`), TTL defaults to 0 — every call re-reads
///     the keystore (preserves ADR-0019 req 9 rotation detection).
///   - Operators can override the default for ALL schemes via
///     `LEYLINE_SIGN_RESOLVE_TTL_MS=<ms>`; set to 0 to opt out of TTL
///     caching for subprocess schemes too.
///
/// Closes 2026-05-13 cycle dos-friend F2 / `cloister-8d4dd7`
/// (singleflight) + dos-friend F3 / `cloister-8d675a` (TTL cache).
pub async fn resolve_bytes(spec: &str) -> Result<Vec<u8>, HelperError> {
    RESOLVE_CACHE
        .get_or_init(ResolveCache::new)
        .resolve(spec)
        .await
}

// ── Resolve-time cache (singleflight + TTL) ────────────────────────────────
//
// Per-spec singleflight built on `tokio::sync::watch::channel(None)`:
//   - Leader inserts the receiver into the map, drives the work, sends
//     `Some(CachedValue)` once it completes.
//   - Followers grab the receiver from the map, `await rx.changed()`,
//     then read `borrow()`. If the leader's future is dropped (outer
//     `SIGN_TIMEOUT` fires mid-`spawn_blocking`, runtime cancellation),
//     the sender drops, followers' `changed()` returns `Err`, and they
//     bail with `HelperError::Internal` — no panic, no stale state.
//     The next caller starts a fresh resolve.
//   - The map is bounded by `MAX_CACHE_ENTRIES` via FIFO eviction. An
//     attacker (or legitimate diverse-URL operator) flooding the cache
//     with unique specs cannot grow the map unboundedly.
//
// Cached Err is intentional: all coalesced callers see the same outcome,
// so a transient keystore failure doesn't silently retry for some
// callers (which would muddle the operator log + the §17.10 constant-
// time wire semantic). Err entries respect TTL too — a fresh read is
// only attempted after TTL elapses.
//
// **Rewrite rationale (cloister-d95f0d, cloister-d9a3c6):** the prior
// implementation used `tokio::sync::OnceCell::get_or_init` with an
// `unreachable!()` in the follower path. That panic IS reachable when
// the leader's future is cancelled mid-init (tokio 1.x: "if the
// provided operation is cancelled or panics, one of the waiting tasks
// will start another attempt at initializing the value"). The follower
// would then run the `unreachable!()`. Also: the prior cache was
// unbounded under TTL>0. Both fixed in one rewrite.

type CachedValue = (Result<Vec<u8>, HelperError>, std::time::Instant);

/// Maximum cells held in the resolve cache. FIFO eviction enforces.
/// Operator can override via `LEYLINE_SIGN_RESOLVE_CACHE_MAX` env. The
/// default is generous enough for realistic deploys (thousands of
/// distinct VAULT_KEK_SOURCE specs is absurd; 1024 is well above the
/// usual single-digit count) and small enough to bound memory.
const DEFAULT_MAX_CACHE_ENTRIES: usize = 1024;

fn max_cache_entries() -> usize {
    std::env::var("LEYLINE_SIGN_RESOLVE_CACHE_MAX")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(DEFAULT_MAX_CACHE_ENTRIES)
}

struct Inflight {
    /// Latest-value receiver. `None` while in-flight; `Some(value)`
    /// after the leader publishes. Cloned for each follower.
    rx: tokio::sync::watch::Receiver<Option<CachedValue>>,
}

struct ResolveCacheInner {
    cells: std::collections::HashMap<String, Inflight>,
    /// FIFO eviction order. Front = oldest insertion. On overflow,
    /// pop_front + cells.remove. Linear-time `retain` on eviction; the
    /// map is bounded so worst-case is O(MAX_CACHE_ENTRIES).
    order: std::collections::VecDeque<String>,
}

struct ResolveCache {
    inner: std::sync::Mutex<ResolveCacheInner>,
}

impl ResolveCache {
    fn new() -> Self {
        Self {
            inner: std::sync::Mutex::new(ResolveCacheInner {
                cells: std::collections::HashMap::new(),
                order: std::collections::VecDeque::new(),
            }),
        }
    }

    /// Production entry — dispatches via `resolve_bytes_blocking` on a
    /// `spawn_blocking` thread.
    async fn resolve(&self, spec: &str) -> Result<Vec<u8>, HelperError> {
        self.resolve_with(spec, |spec_owned| async move {
            tokio::task::spawn_blocking(move || resolve_bytes_blocking(&spec_owned))
                .await
                .unwrap_or_else(|join_err| {
                    tracing::error!(
                        target: "leyline_sign_helper",
                        op = "resolve_blocking",
                        outcome = "join_error",
                        err = %join_err,
                    );
                    Err(HelperError::Internal)
                })
        })
        .await
    }

    /// Test-friendly entry — accepts the work closure. Production
    /// `resolve` wraps this with `resolve_bytes_blocking` inside
    /// `spawn_blocking`. Adversarial tests call this directly with a
    /// counter-tracking closure to assert the singleflight invariant
    /// (concurrent callers for the same spec → exactly ONE work call).
    async fn resolve_with<F, Fut>(&self, spec: &str, work: F) -> Result<Vec<u8>, HelperError>
    where
        F: FnOnce(String) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = Result<Vec<u8>, HelperError>> + Send + 'static,
    {
        let scheme = scheme_label(spec);
        let ttl = ttl_for_scheme(scheme);

        // Phase 1: under the map lock, decide the role.
        let role = {
            let mut inner = self.inner.lock().expect("resolve cache mutex poisoned");
            // Inspect existing entry.
            let existing_role = inner.cells.get(spec).map(|inflight| {
                let snap = inflight.rx.borrow();
                match &*snap {
                    Some((result, fetched_at)) if fetched_at.elapsed() < ttl => {
                        CacheLookup::CacheHit(result.clone())
                    }
                    Some(_) => CacheLookup::Stale,
                    None => CacheLookup::Follower(inflight.rx.clone()),
                }
            });
            match existing_role {
                Some(CacheLookup::CacheHit(result)) => Role::CacheHit(result),
                Some(CacheLookup::Follower(rx)) => Role::Follower(rx),
                Some(CacheLookup::Stale) => {
                    // Evict the stale entry and become leader.
                    inner.cells.remove(spec);
                    inner.order.retain(|s| s != spec);
                    Role::Leader(insert_leader(&mut inner, spec))
                }
                None => Role::Leader(insert_leader(&mut inner, spec)),
            }
        };

        match role {
            Role::CacheHit(result) => result,
            Role::Follower(mut rx) => {
                // Wait for the leader to publish or drop. Re-check the
                // borrow on each wake because `watch` collapses
                // multiple sends — the value we want might already be
                // present when `changed()` returns Ok.
                loop {
                    {
                        let snap = rx.borrow();
                        if let Some((result, _)) = &*snap {
                            return result.clone();
                        }
                    }
                    if rx.changed().await.is_err() {
                        // Leader cancelled mid-flight (sender dropped).
                        // Bail; next caller will start fresh. No
                        // unreachable!() — the cancellation is a
                        // documented failure mode handled cleanly.
                        tracing::warn!(
                            target: "leyline_sign_helper",
                            op = "resolve",
                            outcome = "leader_cancelled",
                            "leader future dropped before publishing — bailing follower"
                        );
                        return Err(HelperError::Internal);
                    }
                }
            }
            Role::Leader(tx) => {
                let spec_owned = spec.to_owned();
                let result = work(spec_owned).await;
                let value = (result.clone(), std::time::Instant::now());
                // `send` returns Err if no receivers — that's fine, we
                // still have our own result. The leader's own receiver
                // (kept in the map for TTL>0) keeps the send Ok-shaped.
                let _ = tx.send(Some(value));
                if ttl.is_zero() {
                    let mut inner = self.inner.lock().expect("resolve cache mutex poisoned");
                    inner.cells.remove(spec);
                    inner.order.retain(|s| s != spec);
                }
                result
            }
        }
    }

    /// Test helper — current cache size. Used by adversarial tests
    /// asserting bounded growth.
    #[cfg(test)]
    fn len(&self) -> usize {
        self.inner.lock().unwrap().cells.len()
    }
}

/// Outcome of inspecting an existing cell under the map lock.
enum CacheLookup {
    CacheHit(Result<Vec<u8>, HelperError>),
    Follower(tokio::sync::watch::Receiver<Option<CachedValue>>),
    Stale,
}

/// The post-Phase-1 role the caller plays.
enum Role {
    CacheHit(Result<Vec<u8>, HelperError>),
    Follower(tokio::sync::watch::Receiver<Option<CachedValue>>),
    Leader(tokio::sync::watch::Sender<Option<CachedValue>>),
}

/// Insert a fresh in-flight cell for `spec`, enforcing the bounded-
/// capacity cap via FIFO eviction. Caller holds the inner mutex.
fn insert_leader(
    inner: &mut ResolveCacheInner,
    spec: &str,
) -> tokio::sync::watch::Sender<Option<CachedValue>> {
    let (tx, rx) = tokio::sync::watch::channel(None);
    inner.cells.insert(spec.to_string(), Inflight { rx });
    inner.order.push_back(spec.to_string());
    let cap = max_cache_entries();
    while inner.order.len() > cap {
        if let Some(evicted) = inner.order.pop_front() {
            inner.cells.remove(&evicted);
        } else {
            break;
        }
    }
    tx
}

/// Per-scheme TTL for cached keystore reads.
///
/// Default: 60s for `op://` + `apple-password://` (subprocess-shelling
/// schemes — FaceID prompts and `op` CLI spawns are too expensive to pay
/// per-request). 0s for everything else (preserves ADR-0019 req 9
/// "re-read every call" rotation semantics for the cheap-read schemes).
///
/// Override via `LEYLINE_SIGN_RESOLVE_TTL_MS=<u64 ms>`: the env value
/// applies to ALL schemes uniformly. Operators wanting per-scheme tuning
/// have to rebuild with custom logic — by design (one knob is easier to
/// audit than five). Set to 0 to opt OUT of subprocess caching entirely.
fn ttl_for_scheme(scheme: &str) -> std::time::Duration {
    if let Ok(s) = std::env::var("LEYLINE_SIGN_RESOLVE_TTL_MS") {
        if let Ok(ms) = s.parse::<u64>() {
            return std::time::Duration::from_millis(ms);
        }
    }
    if matches!(scheme, "op://" | "apple-password://") {
        std::time::Duration::from_millis(60_000)
    } else {
        std::time::Duration::ZERO
    }
}

static RESOLVE_CACHE: std::sync::OnceLock<ResolveCache> = std::sync::OnceLock::new();

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

/// Outcome of a bounded stdout read.
///
/// `Overflow` distinguishes "subprocess produced more than `cap` bytes"
/// from a real I/O error so callers can emit a specific log line. Both
/// collapse to `HelperError::Internal` at the boundary — the variant
/// only exists for observability + future test seams.
#[cfg(feature = "host-extras")]
#[derive(Debug)]
enum StdoutReadError {
    Io(std::io::Error),
    Overflow,
}

/// Read at most `cap` bytes from `reader`. If the reader yields more
/// than `cap` bytes, returns `Overflow` (we deliberately let the OS
/// kernel buffer the rest so it gets dropped when the subprocess pipe
/// closes — we don't need to consume them). Per cloister-d9da67.
#[cfg(feature = "host-extras")]
fn read_stdout_capped<R: std::io::Read>(
    reader: &mut R,
    cap: usize,
) -> Result<Vec<u8>, StdoutReadError> {
    // Take cap+1 so we can DISTINGUISH "exactly at cap" (legitimate)
    // from "above cap" (overflow). Without the +1 the two collapse.
    let mut buf = Vec::with_capacity(cap.min(4096));
    let n = reader
        .take((cap as u64) + 1)
        .read_to_end(&mut buf)
        .map_err(StdoutReadError::Io)?;
    if n > cap {
        return Err(StdoutReadError::Overflow);
    }
    Ok(buf)
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
        match read_stdout_capped(&mut s, MAX_SUBPROCESS_STDOUT_BYTES) {
            Ok(bytes) => stdout = bytes,
            Err(StdoutReadError::Io(e)) => {
                tracing::warn!(
                    target: "leyline_sign_helper",
                    op = "resolve",
                    backend = backend,
                    outcome = "subprocess_stdout_read_failed",
                    io_kind = ?e.kind(),
                );
                return Err(HelperError::Internal);
            }
            Err(StdoutReadError::Overflow) => {
                tracing::warn!(
                    target: "leyline_sign_helper",
                    op = "resolve",
                    backend = backend,
                    outcome = "subprocess_stdout_overflow",
                    cap_bytes = MAX_SUBPROCESS_STDOUT_BYTES,
                );
                return Err(HelperError::Internal);
            }
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
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    // ── ResolveCache: real singleflight + TTL + bounded-eviction tests ───────
    //
    // These tests exercise `ResolveCache::resolve_with` directly, bypassing
    // the production `resolve_bytes_blocking` dispatch. The test work
    // closure tracks call count via `AtomicUsize`, so the singleflight
    // invariant is asserted precisely (concurrent same-spec callers →
    // exactly ONE underlying call) — not inferred from wall-clock
    // timing slack the way the pre-rewrite test did.

    #[tokio::test]
    async fn resolve_with_coalesces_concurrent_same_spec_to_one_work_call() {
        let cache = Arc::new(ResolveCache::new());
        let counter = Arc::new(AtomicUsize::new(0));

        let mut handles = Vec::with_capacity(16);
        for _ in 0..16 {
            let cache = cache.clone();
            let counter = counter.clone();
            handles.push(tokio::spawn(async move {
                cache
                    .resolve_with("file:///fake-test-spec", move |_| {
                        let c = counter.clone();
                        async move {
                            c.fetch_add(1, Ordering::SeqCst);
                            // Yield so other callers definitely arrive
                            // before the leader publishes.
                            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                            Ok(vec![0xCDu8; 32])
                        }
                    })
                    .await
            }));
        }
        for h in handles {
            let result = h.await.unwrap().unwrap();
            assert_eq!(result, vec![0xCDu8; 32], "coalesced caller got wrong bytes");
        }
        assert_eq!(
            counter.load(Ordering::SeqCst),
            1,
            "singleflight broken — work closure ran {} times, expected 1 (cloister-d95f0d / cloister-da87da)",
            counter.load(Ordering::SeqCst),
        );
    }

    #[tokio::test]
    async fn resolve_with_leader_cancellation_bails_followers_without_panic() {
        // When the leader's future is dropped before it publishes, the
        // sender drops, all follower receivers see channel-closed, and
        // they bail with `HelperError::Internal`. Critically: no
        // `unreachable!()` panic. The pre-rewrite code panicked here.
        let cache = Arc::new(ResolveCache::new());
        // Two callers race to the same spec. The first becomes leader;
        // we then drop its handle (simulating outer SIGN_TIMEOUT
        // cancellation). The second should bail cleanly, not panic.
        let cache_a = cache.clone();
        let leader = tokio::spawn(async move {
            cache_a
                .resolve_with("file:///cancellation-test", |_| async move {
                    // Take long enough that the cancel below fires first.
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    Ok(vec![0xFFu8; 32])
                })
                .await
        });
        // Let the leader register the cell.
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;

        // Spawn a follower that will wait on the leader's cell.
        let cache_b = cache.clone();
        let follower = tokio::spawn(async move {
            cache_b
                .resolve_with("file:///cancellation-test", |_| async move {
                    // Follower's closure should never run — it joins
                    // the leader's in-flight cell.
                    Ok(vec![0xAAu8; 32])
                })
                .await
        });
        // Let the follower register as a watcher.
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;

        // Cancel the leader.
        leader.abort();
        let _ = leader.await;

        // Follower should return Internal (the contract on leader-drop).
        let result = follower.await.unwrap();
        assert!(
            matches!(result, Err(HelperError::Internal)),
            "follower didn't bail cleanly on leader-cancellation (got {:?}); pre-rewrite would have panicked here",
            result,
        );
    }

    #[tokio::test]
    async fn resolve_cache_bounded_under_unique_spec_flood() {
        // An attacker (or legitimate diverse-URL operator) hits the
        // helper with N >> MAX_CACHE_ENTRIES distinct specs. Cache
        // size MUST NOT grow unboundedly.
        //
        // We use the production cap (default 1024) by setting the env
        // var to a small value so the test completes quickly.
        // SAFETY: this test runs serially-ok because it asserts a
        // bound, not a specific number — concurrent tests that read
        // the env see at most the test's value (32), which is still a
        // valid bounded behavior.
        unsafe {
            std::env::set_var("LEYLINE_SIGN_RESOLVE_CACHE_MAX", "32");
        }
        let cache = Arc::new(ResolveCache::new());
        // Use a long TTL so entries stick (TTL=0 would evict on
        // leader-complete; we want to test the capacity cap path).
        unsafe {
            std::env::set_var("LEYLINE_SIGN_RESOLVE_TTL_MS", "60000");
        }
        for i in 0..200u32 {
            let spec = format!("file:///bounded-test-{}", i);
            let _ = cache
                .resolve_with(&spec, |_| async move { Ok(vec![0xAAu8; 32]) })
                .await;
        }
        let size = cache.len();
        assert!(
            size <= 32,
            "cache grew unboundedly: {} entries after 200 unique specs (cap was 32); cloister-d9a3c6 regressed",
            size,
        );
        unsafe {
            std::env::remove_var("LEYLINE_SIGN_RESOLVE_CACHE_MAX");
            std::env::remove_var("LEYLINE_SIGN_RESOLVE_TTL_MS");
        }
    }

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

    // ── read_stdout_capped: bounds subprocess stdout (cloister-d9da67) ───────

    #[cfg(feature = "host-extras")]
    #[test]
    fn read_stdout_capped_returns_full_buffer_under_cap() {
        let payload = vec![0xAAu8; 100];
        let mut cur = std::io::Cursor::new(payload.clone());
        let got = read_stdout_capped(&mut cur, MAX_SUBPROCESS_STDOUT_BYTES).unwrap();
        assert_eq!(got, payload);
    }

    #[cfg(feature = "host-extras")]
    #[test]
    fn read_stdout_capped_returns_full_buffer_at_exactly_cap() {
        // Boundary: a payload whose length equals the cap is legitimate
        // and must succeed (the +1 take buffer is for distinguishing
        // overflow, not for trimming at the boundary).
        let cap = 256;
        let payload = vec![0xBBu8; cap];
        let mut cur = std::io::Cursor::new(payload.clone());
        let got = read_stdout_capped(&mut cur, cap).unwrap();
        assert_eq!(got.len(), cap);
        assert_eq!(got, payload);
    }

    #[cfg(feature = "host-extras")]
    #[test]
    fn read_stdout_capped_overflows_one_byte_past_cap() {
        let cap = 256;
        let payload = vec![0xCCu8; cap + 1];
        let mut cur = std::io::Cursor::new(payload);
        let err = read_stdout_capped(&mut cur, cap).unwrap_err();
        assert!(matches!(err, StdoutReadError::Overflow));
    }

    #[cfg(feature = "host-extras")]
    #[test]
    fn read_stdout_capped_overflows_far_past_cap() {
        // The MAX bound itself — feed twice the production cap to confirm
        // the dispatch path classifies this as Overflow, not Io.
        let payload = vec![0xDDu8; MAX_SUBPROCESS_STDOUT_BYTES * 2];
        let mut cur = std::io::Cursor::new(payload);
        let err = read_stdout_capped(&mut cur, MAX_SUBPROCESS_STDOUT_BYTES).unwrap_err();
        assert!(matches!(err, StdoutReadError::Overflow));
    }

    #[cfg(feature = "host-extras")]
    #[test]
    fn read_stdout_capped_empty_reader_yields_empty_vec() {
        let payload: Vec<u8> = Vec::new();
        let mut cur = std::io::Cursor::new(payload);
        let got = read_stdout_capped(&mut cur, MAX_SUBPROCESS_STDOUT_BYTES).unwrap();
        assert!(got.is_empty());
    }

    #[cfg(feature = "host-extras")]
    #[test]
    fn read_stdout_capped_propagates_io_error_as_io_variant() {
        // A reader that always fails — confirms the Io variant is
        // distinguishable from Overflow at the boundary.
        struct AlwaysErr;
        impl std::io::Read for AlwaysErr {
            fn read(&mut self, _buf: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::new(std::io::ErrorKind::Other, "boom"))
            }
        }
        let mut r = AlwaysErr;
        let err = read_stdout_capped(&mut r, MAX_SUBPROCESS_STDOUT_BYTES).unwrap_err();
        assert!(matches!(err, StdoutReadError::Io(_)));
    }
}
