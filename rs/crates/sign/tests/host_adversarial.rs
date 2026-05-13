// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 cloister contributors
//
// host_adversarial.rs — threat-model invariants for the leyline-sign-helper
// (cloister-99165e, ADR-0019). Each test asserts an invariant from
// docs/security/threat-model.md §15. Failures indicate the substrate does
// not enforce what the spec promises.
//
// Origin: adversarial-cycle 2026-05-12 (trust-root-friend pre-merge
// review). These tests RED today; that is the point — they are the spec
// of correct behavior. The merge stays blocked until they go green.
//
// File-mapping to threat-model §15:
//   §15.1 → resolve_must_reject_signing_key_urls
//   §15.2 → sign_must_require_authentication
//   §15.3 → rate_limit_must_be_per_caller
//   §15.5 → sign_must_reject_csrf_content_types
//   §15.6 → sign_must_enforce_body_size_cap
// (§15.4 and §15.7 are not unit-testable at this layer — see file foot.)

#![cfg(all(feature = "host", not(target_arch = "wasm32")))]

use std::net::SocketAddr;
use std::time::Duration;

use base64ct::{Base64UrlUnpadded, Encoding};
use leyline_sign::host::auth::AuthConfig;
use leyline_sign::host::server::{AppState, build_router};
use serde_json::Value;
use tempfile::TempDir;
use tokio::net::TcpListener;

const TEST_PAYLOAD: &[u8] = b"adversarial-probe";

/// Bearer tokens the AdvHelper accepts. The threat-model §15 tests exercise
/// production posture (auth REQUIRED), so each test either presents one of
/// these tokens (authenticated paths) or omits the Authorization header
/// entirely (the 401-asserting tests).
const ROUTER_TOKEN: &str = "test-token-router";
const NOTME_TOKEN: &str = "test-token-notme";

/// Minimal helper boot for adversarial tests. Boots in PRODUCTION posture
/// (auth required, /resolve allow-list empty by default). This is what
/// makes adversarial tests assert the §15 invariants on the production
/// wire, NOT the integration-test back-compat shape.
struct AdvHelper {
    addr: SocketAddr,
    _tmp: TempDir,
    seed_path: String,
    _server_task: tokio::task::JoinHandle<()>,
}

impl AdvHelper {
    async fn start() -> Self {
        Self::start_with(1000, default_auth(), Vec::new()).await
    }

    async fn start_with_rate(rate: u32) -> Self {
        Self::start_with(rate, default_auth(), Vec::new()).await
    }

    async fn start_with(
        rate: u32,
        auth: AuthConfig,
        resolve_allow: Vec<String>,
    ) -> Self {
        let tmp = TempDir::new().unwrap();
        let seed_path = tmp.path().join("seed");
        std::fs::write(&seed_path, [0xAAu8; 32]).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&seed_path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let state = AppState::with_config(rate, auth, resolve_allow);
        let app = build_router(state);
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        Self {
            addr,
            _tmp: tmp,
            seed_path: seed_path.to_string_lossy().into_owned(),
            _server_task: task,
        }
    }

    fn seed_url(&self) -> String {
        format!("file://{}", self.seed_path)
    }

    fn url(&self, path: &str) -> String {
        format!("http://{}{}", self.addr, path)
    }
}

fn default_auth() -> AuthConfig {
    AuthConfig::required([
        ("router".to_owned(), ROUTER_TOKEN.to_owned()),
        ("notme-bundle".to_owned(), NOTME_TOKEN.to_owned()),
    ])
}

fn client() -> reqwest::Client {
    reqwest::Client::builder().build().unwrap()
}

fn sign_body(url: &str, payload: &[u8]) -> Value {
    serde_json::json!({
        "url": url,
        "alg": "ed25519",
        "payload_b64": Base64UrlUnpadded::encode_string(payload),
        "return_pubkey": false,
    })
}

fn urlencode(s: &str) -> String {
    s.replace(':', "%3A").replace('/', "%2F")
}

// ── §15.1 — GET /resolve MUST NOT return signing-key bytes ──────────────────
//
// Bead `cloister-7aaab1`. ADR-0019 normative req. 13: signing-key consumers
// MUST use POST /sign. The helper today carries `/resolve` over from
// `scripts/kek-helper.mjs` with no allow-list — `curl
// /resolve?url=keychain://...master-sk` returns the raw 32-byte seed.
//
// Closing playbook: delete /resolve, or allow-list to non-signing-key URLs,
// or partition the keystore namespace.
#[tokio::test]
async fn resolve_must_reject_signing_key_urls() {
    // AdvHelper defaults to EMPTY /resolve allow-list (deny-all).
    // First confirm /sign DOES work for the seed URL (precondition).
    let h = AdvHelper::start().await;
    let body = sign_body(&h.seed_url(), TEST_PAYLOAD);
    let sign_resp = client()
        .post(h.url("/sign"))
        .bearer_auth(ROUTER_TOKEN)
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(sign_resp.status(), 200, "precondition: /sign reaches the seed");

    // Same URL via /resolve must be rejected — allow-list is empty.
    let resolve_resp = client()
        .get(h.url(&format!("/resolve?url={}", urlencode(&h.seed_url()))))
        .bearer_auth(ROUTER_TOKEN)
        .send()
        .await
        .unwrap();

    assert!(
        resolve_resp.status().is_client_error() || resolve_resp.status() == 410,
        "/resolve returned {} for a URL that /sign signs over — bytes exfiltrated. \
         Threat-model §15.1 / bead cloister-7aaab1.",
        resolve_resp.status(),
    );
}

// ── §15.2 — POST /sign MUST require caller authentication ──────────────────
//
// Bead `cloister-7afedc`. Loopback TCP is not UID-scoped; any local UID
// or local CSRF reaches /sign without auth. The helper's own
// `ratelimit.rs:13-23` comment asserts OS process scoping; no such
// mechanism applies.
//
// Closing playbook: UDS+peer-cred OR bearer-token OR mTLS. Test asserts
// that an unauthenticated /sign returns 401 / 403, not 200 with sig.
#[tokio::test]
async fn sign_must_require_authentication() {
    let h = AdvHelper::start().await;
    let body = sign_body(&h.seed_url(), TEST_PAYLOAD);

    // No Authorization header, no caller-cred header, just the JSON body.
    // This is exactly the wire the adversary in §15.2 sends.
    let resp = client()
        .post(h.url("/sign"))
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .unwrap();

    assert!(
        resp.status() == 401 || resp.status() == 403,
        "/sign returned {} for an unauthenticated request — any local TCP \
         caller can sign with master_sk. Threat-model §15.2 / bead cloister-7afedc.",
        resp.status(),
    );
}

// ── §15.3 — Rate-limit MUST be per-caller (not global) ─────────────────────
//
// Bead `cloister-7b5b9d`. ADR-0019 normative req. 10 promises per-source
// UID rate-limit. The helper keys the limiter HashMap on the helper's
// OWN getuid() — one global bucket. A single hostile caller saturates
// it and DoSes legitimate signing for everyone.
//
// Closing playbook: per-caller identity (lands with §15.2's auth fix) +
// limiter keying. Test asserts: two distinct callers each fire RATE+1
// requests; if rate-limit is per-caller, both succeed independently up
// to their own RATE; if rate-limit is global, the second caller is
// already throttled when it starts.
#[tokio::test]
async fn rate_limit_must_be_per_caller() {
    // Two distinct bearer tokens → two distinct caller_names → independent
    // rate-limit buckets. Low rate so the test runs fast.
    const RATE: u32 = 4;
    let h = AdvHelper::start_with_rate(RATE).await;
    let body = sign_body(&h.seed_url(), TEST_PAYLOAD);

    for _ in 0..RATE {
        let r = client()
            .post(h.url("/sign"))
            .bearer_auth(ROUTER_TOKEN)
            .json(&body)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200, "caller A's pre-exhaustion requests should pass");
    }
    let r_a_throttled = client()
        .post(h.url("/sign"))
        .bearer_auth(ROUTER_TOKEN)
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(
        r_a_throttled.status(),
        429,
        "caller A's post-RATE request should be rate-limited",
    );

    // Caller B (different bearer token → different caller_name) must NOT
    // be affected by caller A's exhaustion.
    let r_b = client()
        .post(h.url("/sign"))
        .bearer_auth(NOTME_TOKEN)
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(
        r_b.status(),
        200,
        "caller B got {} — rate-limit is global, not per-caller. \
         Threat-model §15.3 / bead cloister-7b5b9d.",
        r_b.status(),
    );
}

// ── §15.5 — POST /sign MUST reject non-application/json Content-Types ──────
//
// Bead `cloister-7c2179`. text/plain is CORS-safelisted → no preflight →
// cross-origin fetch from a malicious page POSTs JSON; helper parses
// regardless of declared content-type; master_sk signs attacker-chosen
// payload. Attacker doesn't need to read the response — the signature is
// the side effect.
//
// Closing playbook: strict Content-Type check (415 on mismatch) OR a
// custom-header preflight requirement.
#[tokio::test]
async fn sign_must_reject_csrf_content_types() {
    let h = AdvHelper::start().await;
    let body = sign_body(&h.seed_url(), TEST_PAYLOAD);

    // Even with a valid bearer token, text/plain Content-Type must be
    // rejected. The CSRF defense: cross-origin browser fetch sending JSON
    // with text/plain would normally skip CORS preflight; rejecting the
    // request shape itself closes that bypass.
    let resp = client()
        .post(h.url("/sign"))
        .bearer_auth(ROUTER_TOKEN)
        .header("content-type", "text/plain;charset=UTF-8")
        .body(serde_json::to_string(&body).unwrap())
        .send()
        .await
        .unwrap();

    assert_eq!(
        resp.status(),
        415,
        "/sign accepted Content-Type: text/plain (status {}) — CSRF via simple-POST \
         can sign arbitrary payloads. Threat-model §15.5 / bead cloister-7c2179.",
        resp.status(),
    );
}

// ── §15.6 — Body-size cap MUST hold without a Content-Length header ────────
//
// Bead `cloister-7c737a`. The `content_length_guard` enforces 64 KiB when
// Content-Length is present, but the fallthrough on missing CL lets the
// request through to axum's 2 MiB default. Helper's own source comment
// admits the gap and points at the unhandled fix.
//
// Closing playbook: install `tower_http::limit::RequestBodyLimitLayer::new(64 * 1024)`.
#[tokio::test]
async fn sign_must_enforce_body_size_cap() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let h = AdvHelper::start().await;
    // 128 KiB body — exceeds spec'd 64 KiB ceiling. Sent via a raw TCP
    // socket with Transfer-Encoding: chunked (NO Content-Length header),
    // which is exactly the bypass shape the helper's
    // `content_length_guard` falls through on. reqwest's high-level API
    // doesn't easily produce no-CL bodies, so we do this by hand — same
    // bytes the adversary would put on the wire.
    let big = vec![b'A'; 128 * 1024];
    let chunk_size_hex = format!("{:x}", big.len());

    let mut stream = tokio::net::TcpStream::connect(h.addr).await.unwrap();
    let head = format!(
        "POST /sign HTTP/1.1\r\n\
         Host: {}\r\n\
         Authorization: Bearer {}\r\n\
         Content-Type: application/json\r\n\
         Transfer-Encoding: chunked\r\n\
         Connection: close\r\n\
         \r\n\
         {}\r\n",
        h.addr, ROUTER_TOKEN, chunk_size_hex,
    );
    stream.write_all(head.as_bytes()).await.unwrap();
    stream.write_all(&big).await.unwrap();
    stream.write_all(b"\r\n0\r\n\r\n").await.unwrap();

    let mut response = String::new();
    let _ = tokio::time::timeout(
        Duration::from_secs(5),
        stream.read_to_string(&mut response),
    )
    .await;

    // Parse status from the first line: "HTTP/1.1 NNN ..."
    let status: u16 = response
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    assert_eq!(
        status, 413,
        "/sign accepted a {} KiB chunked body without Content-Length (status {}) — \
         body-size cap bypassable. Threat-model §15.6 / bead cloister-7c737a.",
        128, status,
    );
}

// ── Not covered by unit tests here (documented gaps) ───────────────────────
//
// §15.4 — Supervisor binary integrity. Deploy-time property; verified by
//          launchd plist / systemd unit assertions, not by the helper
//          itself at runtime. Tracked by `cloister-7bb456`. Add a
//          deploy-layer test (supervisor smoke) when the binary-attestation
//          phase-D design lands.
//
// §15.7 — ed25519-dalek pin drift. Build-time property (Cargo.lock contents
//          vs ADR declaration). Tracked by `cloister-7cd202`. Add a CI
//          lint that parses Cargo.lock and asserts the version against
//          a pinned constant; not a runtime test.
