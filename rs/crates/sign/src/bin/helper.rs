// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 cloister contributors
//
// `leyline-sign-helper` — sign-only trust-anchor-helper daemon (ADR-0019,
// cloister-99165e).
//
// HTTP server crate choice: **axum 0.7**.
//
// Rationale:
//   - tokio is required anyway for the keyring crate's blocking-fs ops
//     (we spawn_blocking around them) AND for the per-call 5s timeout
//     (tokio::time::timeout is the natural fit). Once tokio is in the
//     dep graph, axum costs nothing additional vs tiny_http.
//   - axum 0.7 + tower has a well-audited middleware story (RequestBodyLimitLayer,
//     TimeoutLayer, etc.) — even though we hand-roll the per-route limits
//     here to get the constant-time 413 behavior right.
//   - Future expansion: HTTP/2, UDS, structured tracing integration —
//     all are cheap on axum, expensive on tiny_http.
//   - Trade-off: larger dep graph than tiny_http (~25 transitive crates
//     vs ~3). ADR-0019 §"Two independent shifts in this ADR" is honest
//     about this: Rust ≠ smaller trust base. axum's surface IS larger
//     than tiny_http's. We accept it for the runtime + middleware
//     story.
//
// Binary lifecycle:
//   1. parse CLI args
//   2. setup tracing (logs go to stderr, structured per ADR-0019 req. 11)
//   3. headless-platform warning (if applicable)
//   4. bind loopback only at fixed 127.0.0.1:8786 (req. 2)
//      - on EADDRINUSE: log error + exit non-zero (NO port fallback)
//   5. serve axum app
//   6. on SIGTERM / SIGINT: drain in-flight up to 5s (matches
//      SIGN_TIMEOUT), exit cleanly. No SIGHUP handler (req. ops §2).

use std::net::SocketAddr;
use std::process::ExitCode;

use clap::Parser;
use leyline_sign::host::allowlist::{SignAllowList, validate_resolve_allow_prefixes};
use leyline_sign::host::auth::AuthConfig;
use leyline_sign::host::server::{AppState, SIGN_TIMEOUT, build_router};
use tokio::net::TcpListener;
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;

const DEFAULT_BIND: &str = "127.0.0.1:8786";
const DEFAULT_RATE: u32 = 1000;

#[derive(Parser, Debug)]
#[command(name = "leyline-sign-helper", version, about = "Sign-only trust-anchor-helper (ADR-0019)")]
struct Args {
    /// Bind address. MUST be loopback. Default 127.0.0.1:8786 per ADR-0019
    /// normative req. 2.
    #[arg(long, default_value = DEFAULT_BIND)]
    bind: String,

    /// Per-UID rate limit (sigs/sec) — ADR-0019 normative req. 10.
    #[arg(long, default_value_t = DEFAULT_RATE)]
    rate_limit: u32,

    /// Run in foreground (don't fork). Always implicit on launchd /
    /// systemd — kept for explicit invocation.
    #[arg(long, default_value_t = true)]
    foreground: bool,

    /// Require bearer-token auth at startup. The helper refuses to start
    /// if `LEYLINE_SIGN_CALLER_TOKENS` is unset or empty when this flag
    /// is true. Production supervisor units (launchd plist / systemd
    /// unit) MUST pass this flag — closes the NEW-1 finding from the
    /// 2026-05-12 adversarial cycle (cloister-7afedc follow-up).
    ///
    /// For local dev (interactive `task helper:start`), leave this off
    /// — the helper will warn loudly and accept unauthenticated calls.
    #[arg(long, default_value_t = false)]
    require_auth: bool,

    /// Require a non-empty `/sign` URL allow-list at startup. Closes
    /// trust-root-friend F2 + isolation-friend F-iso-1 from the 2026-05-13
    /// adversarial cycle: a bearer-token holder can otherwise ask the
    /// helper to sign with an attacker-supplied URL (e.g.,
    /// `op://attacker-vault/their-key/field`). The supervisor unit MUST
    /// set `LEYLINE_SIGN_SIGN_ALLOW=<caller>=<prefix>[;...]` and pass
    /// this flag.
    #[arg(long, default_value_t = false)]
    require_sign_allow: bool,
}

#[tokio::main]
async fn main() -> ExitCode {
    let args = Args::parse();
    init_tracing();

    // Loopback-only bind validation (ADR-0019 normative req. 2).
    let addr: SocketAddr = match args.bind.parse() {
        Ok(a) => a,
        Err(e) => {
            error!(target: "leyline_sign_helper", "invalid --bind {:?}: {}", args.bind, e);
            return ExitCode::from(2);
        }
    };
    if !is_loopback(&addr) {
        error!(
            target: "leyline_sign_helper",
            "refusing to bind to {} — only loopback (127.0.0.1 / ::1) is permitted (ADR-0019)",
            addr,
        );
        return ExitCode::from(2);
    }

    // Headless-platform diagnostics. Best-effort; doesn't gate startup.
    warn_if_headless();

    let listener = match TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            // ADR-0019 normative req. 2: on EADDRINUSE, log structured
            // error + exit non-zero. MUST NOT fall back to a different
            // port (workerd's binding wouldn't find it).
            error!(
                target: "leyline_sign_helper",
                op = "bind",
                outcome = "eaddrinuse",
                addr = %addr,
                "port already in use (another helper or unrelated process holds it); exiting"
            );
            return ExitCode::from(3);
        }
        Err(e) => {
            error!(target: "leyline_sign_helper", "bind failed: {}", e);
            return ExitCode::from(1);
        }
    };

    // Threat-model §15.2 (cloister-7afedc): production binary requires
    // bearer-token auth. LEYLINE_SIGN_CALLER_TOKENS env (`name=token,...`)
    // configures the auth map; unset/empty = warn loudly and run in
    // unauthenticated dev mode (intended for local task helper:start, NOT
    // production). For prod, the supervisor unit MUST set the env.
    let auth_env = std::env::var("LEYLINE_SIGN_CALLER_TOKENS").unwrap_or_default();
    let auth = match AuthConfig::parse(&auth_env) {
        Ok(a) => a,
        Err(e) => {
            error!(target: "leyline_sign_helper", "LEYLINE_SIGN_CALLER_TOKENS parse failed: {}", e);
            return ExitCode::from(2);
        }
    };
    let auth_mode = match &auth {
        AuthConfig::Disabled => {
            // `--require-auth` is the supervisor-unit-side close for
            // NEW-1 (threat-model §15.2 follow-up): the templates pass
            // the flag so an operator copy-pasting them and forgetting
            // to populate LEYLINE_SIGN_CALLER_TOKENS gets a hard FAIL
            // instead of silently dropping into dev mode.
            if args.require_auth {
                error!(
                    target: "leyline_sign_helper",
                    op = "start",
                    outcome = "auth_required_but_unset",
                    "--require-auth is set but LEYLINE_SIGN_CALLER_TOKENS is unset/empty. \
                     Refusing to start. Set the env to `caller1=token1,caller2=token2`. \
                     Threat-model §15.2 / cloister-7afedc."
                );
                return ExitCode::from(2);
            }
            warn!(
                target: "leyline_sign_helper",
                op = "start",
                outcome = "auth_disabled",
                "LEYLINE_SIGN_CALLER_TOKENS unset — running WITHOUT auth (dev mode). \
                 Production deployments MUST pass --require-auth AND set this env. \
                 Threat-model §15.2 / cloister-7afedc."
            );
            "disabled"
        }
        AuthConfig::Required(m) => {
            info!(target: "leyline_sign_helper", op = "start", caller_count = m.len(), "auth enabled");
            "required"
        }
    };

    // Threat-model §15.1 (cloister-7aaab1): /resolve allow-list is
    // empty-default = deny-all. Operators authorize specific URL prefixes
    // via LEYLINE_SIGN_RESOLVE_ALLOW=<prefix1>,<prefix2>. For the vault
    // KEK path: `LEYLINE_SIGN_RESOLVE_ALLOW=keychain://com.cloister/vault-kek-`
    // (or whatever scheme + prefix the deploy uses). Signing-key URLs
    // (e.g., `keychain://com.cloister/master-sk`) MUST NOT be on the list.
    let resolve_allow: Vec<String> = std::env::var("LEYLINE_SIGN_RESOLVE_ALLOW")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect();
    if resolve_allow.is_empty() {
        info!(
            target: "leyline_sign_helper",
            op = "start",
            outcome = "resolve_deny_all",
            "/resolve is DENY-ALL (LEYLINE_SIGN_RESOLVE_ALLOW unset)"
        );
    } else {
        // NEW-2 / cloister-9bee1f: validate prefixes don't accidentally
        // authorize signing-key URLs (via too-broad string-prefix match).
        // Hard-fail before binding the socket — fail-closed is the only
        // safe disposition for a misconfigured allow-list.
        if let Err(violations) = validate_resolve_allow_prefixes(&resolve_allow) {
            for v in &violations {
                error!(
                    target: "leyline_sign_helper",
                    op = "start",
                    outcome = "resolve_allow_unsafe",
                    prefix = %v.prefix,
                    matched = v.matched,
                    "{}",
                    v,
                );
            }
            return ExitCode::from(2);
        }
        info!(
            target: "leyline_sign_helper",
            op = "start",
            allow_count = resolve_allow.len(),
            "/resolve allow-list configured"
        );
    }

    // 2026-05-13 cycle Cross-cut A: per-caller `/sign` URL allow-list.
    // Grammar documented in `host::allowlist::SignAllowList::parse`.
    let sign_allow_env = std::env::var("LEYLINE_SIGN_SIGN_ALLOW").unwrap_or_default();
    let sign_allow = match SignAllowList::parse(&sign_allow_env) {
        Ok(a) => a,
        Err(e) => {
            error!(target: "leyline_sign_helper", "LEYLINE_SIGN_SIGN_ALLOW parse failed: {}", e);
            return ExitCode::from(2);
        }
    };
    if sign_allow.is_empty() {
        if args.require_sign_allow {
            error!(
                target: "leyline_sign_helper",
                op = "start",
                outcome = "sign_allow_required_but_unset",
                "--require-sign-allow is set but LEYLINE_SIGN_SIGN_ALLOW is unset/empty. \
                 Refusing to start. Set the env to `caller=prefix[,prefix...][;...]`. \
                 Closes 2026-05-13 cycle Cross-cut A (trust-root F2 + iso F-iso-1)."
            );
            return ExitCode::from(2);
        }
        warn!(
            target: "leyline_sign_helper",
            op = "start",
            outcome = "sign_allow_disabled",
            "LEYLINE_SIGN_SIGN_ALLOW unset — /sign accepts ANY URL the keystore can resolve. \
             Production deployments MUST pass --require-sign-allow AND set this env."
        );
    } else {
        info!(
            target: "leyline_sign_helper",
            op = "start",
            outcome = "sign_allow_enabled",
            caller_count = sign_allow.caller_count(),
            "/sign per-caller URL allow-list configured"
        );
    }

    // 2026-05-13 cycle silence-friend Gap 1: log presence of the pinned
    // `op` + `security` CLI paths at startup. Only meaningful under
    // `host-extras` (the schemes are otherwise not compiled in and the
    // probe would mislead operators into thinking they could enable
    // them by setting the env var).
    #[cfg(feature = "host-extras")]
    {
        log_subprocess_pin("LEYLINE_SIGN_OP_BIN", "op", "op://");
        log_subprocess_pin("LEYLINE_SIGN_SECURITY_BIN", "security", "apple-password://");
    }
    #[cfg(not(feature = "host-extras"))]
    info!(
        target: "leyline_sign_helper",
        op = "start",
        outcome = "host_extras_disabled",
        "binary built without host-extras feature; op:// and apple-password:// schemes are not enabled"
    );

    // 2026-05-13 cycle silence-friend bonus: log effective KEYCHAIN_ACCOUNT.
    // Helps an operator notice the `KEYCHAIN_ACCOUNTS` typo class of bug.
    let effective_account = std::env::var("KEYCHAIN_ACCOUNT").unwrap_or_else(|_| "cloister".into());
    info!(
        target: "leyline_sign_helper",
        op = "start",
        keychain_account = %effective_account,
        "keychain account resolved (KEYCHAIN_ACCOUNT env or default 'cloister')"
    );

    info!(
        target: "leyline_sign_helper",
        op = "start",
        outcome = "ok",
        addr = %addr,
        rate_limit = args.rate_limit,
        auth = auth_mode,
        resolve_allow_count = resolve_allow.len(),
        sign_allow_caller_count = sign_allow.caller_count(),
        "leyline-sign-helper listening"
    );

    let state =
        AppState::with_full_config(args.rate_limit, auth, resolve_allow, sign_allow);
    let app = build_router(state);

    // Graceful shutdown — SIGTERM / SIGINT drain up to SIGN_TIMEOUT
    // (5s) per ADR-0019 ops §2. No SIGHUP handler (rotation is
    // byte-hash driven; no operator signal needed).
    let shutdown = async {
        let mut sigterm = match tokio::signal::unix::signal(
            tokio::signal::unix::SignalKind::terminate(),
        ) {
            Ok(s) => s,
            Err(e) => {
                error!(target: "leyline_sign_helper", "SIGTERM listener setup failed: {}", e);
                return;
            }
        };
        let mut sigint = match tokio::signal::unix::signal(
            tokio::signal::unix::SignalKind::interrupt(),
        ) {
            Ok(s) => s,
            Err(e) => {
                error!(target: "leyline_sign_helper", "SIGINT listener setup failed: {}", e);
                return;
            }
        };
        tokio::select! {
            _ = sigterm.recv() => {
                info!(target: "leyline_sign_helper", op = "shutdown", trigger = "sigterm");
            }
            _ = sigint.recv() => {
                info!(target: "leyline_sign_helper", op = "shutdown", trigger = "sigint");
            }
        }
    };

    let serve_result = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown)
        .await;

    // After shutdown signal, hyper drains in-flight up to its default;
    // we additionally cap the wait to SIGN_TIMEOUT to match the per-call
    // ceiling.
    let _ = tokio::time::timeout(SIGN_TIMEOUT, async {}).await;

    match serve_result {
        Ok(()) => {
            info!(target: "leyline_sign_helper", op = "exit", outcome = "ok");
            ExitCode::SUCCESS
        }
        Err(e) => {
            error!(target: "leyline_sign_helper", op = "exit", outcome = "error", err = %e);
            ExitCode::from(1)
        }
    }
}

fn init_tracing() {
    // RUST_LOG > default. Default level info; per ADR-0019 req. 11, the
    // formatters never emit URL paths or payload bytes (we feed log
    // events only with `scheme` + `outcome` + numeric `payload_len`).
    //
    // 2026-05-13 cycle oracle-friend F4: clamp `nono::keystore` to INFO
    // unconditionally. nono's debug lines emit redacted-but-correlatable
    // URIs (service / vault / item names) that ADR-0019 req 11 wants
    // out of logs. Operators running `RUST_LOG=debug` to chase an
    // unrelated bug would otherwise inherit nono's leakage.
    let base = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let filter = base
        .add_directive("nono::keystore=info".parse().expect("static directive parses"))
        .add_directive("nono=info".parse().expect("static directive parses"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(true)
        .with_writer(std::io::stderr)
        .try_init();
}

/// 2026-05-13 cycle silence-friend Gap 1: surface whether the subprocess
/// shim has a usable pinned binary. Logs the resolved state at startup
/// instead of letting it silently surface as a 503 keystore_locked.
#[cfg(feature = "host-extras")]
fn log_subprocess_pin(env_var: &str, bin_name: &str, scheme: &str) {
    match std::env::var(env_var) {
        Err(_) => {
            info!(
                target: "leyline_sign_helper",
                op = "start",
                env_var = env_var,
                scheme = scheme,
                bin = bin_name,
                pinned = false,
                "subprocess CLI not pinned; this scheme will refuse with 404 if requested"
            );
        }
        Ok(path) => {
            let trimmed = path.trim();
            let exists = std::path::Path::new(trimmed).is_file()
                && std::path::Path::new(trimmed).is_absolute();
            if exists {
                info!(
                    target: "leyline_sign_helper",
                    op = "start",
                    env_var = env_var,
                    scheme = scheme,
                    bin = bin_name,
                    pinned = true,
                    path = %trimmed,
                    "subprocess CLI pinned to absolute path"
                );
            } else {
                warn!(
                    target: "leyline_sign_helper",
                    op = "start",
                    env_var = env_var,
                    scheme = scheme,
                    bin = bin_name,
                    pinned = false,
                    path = %trimmed,
                    "subprocess CLI path does not exist or is not absolute; this scheme will refuse with 404"
                );
            }
        }
    }
}

fn is_loopback(addr: &SocketAddr) -> bool {
    addr.ip().is_loopback()
}

/// Per ADR-0019 ops §5: warn (don't fail) on headless platforms where
/// keystore unlock prompts would otherwise block forever.
fn warn_if_headless() {
    if cfg!(target_os = "linux") {
        // libsecret requires an unlocked D-Bus session keyring. Heuristic:
        // headless if neither DISPLAY nor WAYLAND_DISPLAY is set AND
        // DBUS_SESSION_BUS_ADDRESS is not set.
        let has_display = std::env::var("DISPLAY").is_ok()
            || std::env::var("WAYLAND_DISPLAY").is_ok();
        let has_dbus = std::env::var("DBUS_SESSION_BUS_ADDRESS").is_ok();
        if !has_display && !has_dbus {
            warn!(
                target: "leyline_sign_helper",
                op = "startup",
                "headless Linux detected (no DISPLAY/WAYLAND_DISPLAY/DBUS_SESSION_BUS_ADDRESS); \
                 secret-tool:// calls will likely fail — prefer file:// per ADR-0019 ops §5"
            );
        }
    }
    if cfg!(target_os = "macos") {
        // macOS Keychain non-interactive access requires
        // `security set-generic-password-partition-list` (set up via
        // ADR-0019 ops §5). We can't probe this without a keychain
        // operation; left to operator setup.
    }
    if cfg!(target_os = "windows") {
        warn!(
            target: "leyline_sign_helper",
            op = "startup",
            "Windows headless support is deferred (ADR-0019 §Headless platform disposition); \
             best-effort, interactive sessions only"
        );
    }
}
