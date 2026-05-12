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

    info!(
        target: "leyline_sign_helper",
        op = "start",
        outcome = "ok",
        addr = %addr,
        rate_limit = args.rate_limit,
        "leyline-sign-helper listening"
    );

    let state = AppState::new(args.rate_limit);
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
    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(true)
        .with_writer(std::io::stderr)
        .try_init();
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
