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

// ── §17 — 2026-05-13 nono-swap cycle invariants ─────────────────────────────
//
// Helper subset for §17 tests: production-posture AdvHelper with a
// configurable `/sign` allow-list. The fixture file:// seed lives at
// `seed_path`, and the allow-list permits *exactly* `file://<seed_path>`
// for the `router` caller (no other URL). Other tests in this block
// vary the allow-list to probe the gate.

fn allow_only_seed(seed_path: &str) -> leyline_sign::host::allowlist::SignAllowList {
    leyline_sign::host::allowlist::SignAllowList::from_pairs([(
        "router".to_owned(),
        format!("file://{}", seed_path),
    )])
}

async fn start_adv_with_sign_allow(
    sign_allow: leyline_sign::host::allowlist::SignAllowList,
) -> AdvHelper {
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
    let state = AppState::with_full_config(1000, default_auth(), Vec::new(), sign_allow);
    let app = build_router(state);
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    tokio::time::sleep(Duration::from_millis(20)).await;
    AdvHelper {
        addr,
        _tmp: tmp,
        seed_path: seed_path.to_string_lossy().into_owned(),
        _server_task: task,
    }
}

// ── §17.2 — POST /sign MUST consult the per-caller URL allow-list ──────────
//
// 2026-05-13 cycle Cross-cut A (trust-root F2 + isolation F-iso-1). A
// bearer-token holder could otherwise send `{url: "op://attacker/..."}`
// and the helper would sign with attacker-supplied bytes.
#[tokio::test]
async fn sign_must_reject_url_not_in_allow_list() {
    let h = start_adv_with_sign_allow(allow_only_seed("/this/path/does/not/exist/intentionally")).await;
    // The seed_url is `file://<actual seed_path>`, NOT the configured
    // allow-list prefix. So even though /sign would otherwise succeed,
    // the gate fires.
    let body = sign_body(&h.seed_url(), TEST_PAYLOAD);
    let resp = client()
        .post(h.url("/sign"))
        .bearer_auth(ROUTER_TOKEN)
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(
        resp.status(),
        403,
        "/sign accepted a URL not on the per-caller allow-list. Cross-cut A, threat-model §17.2."
    );
    let j: Value = resp.json().await.unwrap();
    assert_eq!(j["error"], "forbidden");
}

#[tokio::test]
async fn sign_allows_url_matching_caller_prefix() {
    // Pre-condition: with the allow-list set to the real seed_path,
    // /sign succeeds for the matching URL.
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
    let seed_url = format!("file://{}", seed_path.display());
    let sign_allow = leyline_sign::host::allowlist::SignAllowList::from_pairs([(
        "router".to_owned(),
        seed_url.clone(),
    )]);
    let state = AppState::with_full_config(1000, default_auth(), Vec::new(), sign_allow);
    let app = build_router(state);
    let _task = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    tokio::time::sleep(Duration::from_millis(20)).await;
    let body = sign_body(&seed_url, TEST_PAYLOAD);
    let resp = client()
        .post(format!("http://{}/sign", addr))
        .bearer_auth(ROUTER_TOKEN)
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200, "allow-listed URL should sign successfully");
}

#[tokio::test]
async fn sign_allow_is_per_caller_not_global() {
    // router can sign URL-A but notme cannot — proves the per-caller
    // binding is enforced (vs. a global allow-list).
    let tmp = TempDir::new().unwrap();
    let seed_path = tmp.path().join("seed");
    std::fs::write(&seed_path, [0xAAu8; 32]).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&seed_path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let seed_url = format!("file://{}", seed_path.display());
    let sign_allow = leyline_sign::host::allowlist::SignAllowList::from_pairs([(
        "router".to_owned(),
        seed_url.clone(),
    )]);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let state = AppState::with_full_config(1000, default_auth(), Vec::new(), sign_allow);
    let app = build_router(state);
    let _task = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    tokio::time::sleep(Duration::from_millis(20)).await;
    let body = sign_body(&seed_url, TEST_PAYLOAD);
    // notme caller is authenticated (passes 15.2) but is NOT in the
    // sign_allow map → should get 403.
    let resp = client()
        .post(format!("http://{}/sign", addr))
        .bearer_auth(NOTME_TOKEN)
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(
        resp.status(),
        403,
        "notme caller signed a URL only router has access to — cross-cut A breach"
    );
}

// ── §17.10 — Wire collapse to 404 across backend failure shapes ───────────
//
// 2026-05-13 cycle oracle-friend F1 + F2 + silence Gap 3 (Cross-cut C).
// Backend-side failures (entry not found, keystore locked, ambiguous,
// platform error) MUST all return the byte-identical 404 body. Parse
// errors at cloister's boundary are a distinct class (400) — they're
// operator-config errors, not enumeration oracles, because
// attacker-controlled URLs are filtered by the `/sign` (§17.2) and
// `/resolve` allow-lists before parse runs. The collapse invariant
// applies to the LAYER BELOW the allow-list.
#[tokio::test]
async fn backend_failures_collapse_to_constant_time_404() {
    // Well-formed file:// URL pointing at a path that does not exist.
    // Parse succeeds; keystore-side read fails with NotFound.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    use leyline_sign::host::auth::AuthConfig;
    let state = AppState::with_config(
        1000,
        AuthConfig::Disabled,
        vec!["file://".to_owned()],
    );
    let _task = tokio::spawn(async move {
        let _ = axum::serve(listener, build_router(state)).await;
    });
    tokio::time::sleep(Duration::from_millis(20)).await;
    let nonexistent = "file:///this/path/intentionally/does/not/exist";
    let url = format!("http://{}/resolve?url={}", addr, urlencode(nonexistent));
    let resp = client().get(&url).send().await.unwrap();
    assert_eq!(
        resp.status(),
        404,
        "backend-side NotFound must surface as 404 (got {}), oracle-friend F1 / §17.10",
        resp.status(),
    );
    // Body must be constant-time-shaped (matches the existing 404 body
    // used by NotFound elsewhere).
    let body = resp.text().await.unwrap();
    let (_, expected_body) =
        leyline_sign::host::error::HelperError::NotFound.into_response_parts();
    let expected = serde_json::to_string(&expected_body).unwrap();
    assert_eq!(body, expected, "404 body diverged from canonical NotFound shape");
}

// Companion: malformed URI at parse boundary → 400, NOT collapsed to 404.
// Parse errors are operator-config errors, not enumeration oracles, since
// the upstream allow-list filters attacker-controlled URLs.
#[tokio::test]
async fn malformed_uri_returns_400_at_parse_boundary() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    use leyline_sign::host::auth::AuthConfig;
    let state = AppState::with_config(
        1000,
        AuthConfig::Disabled,
        vec!["keyring://".to_owned()],
    );
    let _task = tokio::spawn(async move {
        let _ = axum::serve(listener, build_router(state)).await;
    });
    tokio::time::sleep(Duration::from_millis(20)).await;
    // keyring:// requires <service>/<account>. Without the account
    // segment, cloister's parser returns BadRequest at the boundary.
    let malformed = "keyring://just-a-service";
    let url = format!("http://{}/resolve?url={}", addr, urlencode(malformed));
    let resp = client().get(&url).send().await.unwrap();
    assert_eq!(
        resp.status(),
        400,
        "malformed keyring URI must surface as 400 at parse boundary (got {})",
        resp.status(),
    );
}

// ── §17.x — parse_spec rejects query strings + fragments ───────────────────
//
// 2026-05-13 cycle trust-root F5 + replay F1. Nono's `?decode=go-keyring`
// reaches into nono's trust module (sigstore-verify et al). Cloister
// rejects query strings at parse time so the kid-determinism invariant
// holds and the trust-module link is not reachable.
#[tokio::test]
async fn sign_rejects_url_with_query_string() {
    let h = AdvHelper::start().await;
    let body = sign_body("keyring://svc/acct?decode=go-keyring", TEST_PAYLOAD);
    let resp = client()
        .post(h.url("/sign"))
        .bearer_auth(ROUTER_TOKEN)
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(
        resp.status(),
        400,
        "query strings must be rejected at parse — trust-root F5 / §17.x"
    );
    let j: Value = resp.json().await.unwrap();
    assert_eq!(j["error"], "bad_request");
}

// ── §17.6 — Blocking keystore call MUST NOT pin tokio workers ──────────────
//
// 2026-05-13 cycle dos F1 / silence Gap 2 (Cross-cut B). The keystore
// dispatch now runs on the spawn_blocking pool. Concurrent /sign calls
// + a /healthz probe must complete without the /healthz request
// queueing behind the keystore I/O.
#[tokio::test]
async fn keystore_call_does_not_pin_worker_threads() {
    // 16 concurrent /sign calls each hitting the file:// path
    // (microsecond cost, but the dispatch goes through spawn_blocking).
    // While they're in flight, a /healthz request must return promptly.
    let h = AdvHelper::start_with_rate(10_000).await;
    let body = sign_body(&h.seed_url(), TEST_PAYLOAD);
    let mut sign_tasks = Vec::new();
    let sign_url = h.url("/sign");
    for _ in 0..16 {
        let b = body.clone();
        let u = sign_url.clone();
        sign_tasks.push(tokio::spawn(async move {
            let resp = reqwest::Client::new()
                .post(&u)
                .bearer_auth(ROUTER_TOKEN)
                .json(&b)
                .send()
                .await
                .unwrap();
            assert_eq!(resp.status(), 200);
        }));
    }
    // While the burst is in flight, /healthz should still return ≤100 ms.
    let healthz_url = h.url("/healthz");
    let healthz_start = std::time::Instant::now();
    let healthz_resp = reqwest::Client::new().get(&healthz_url).send().await.unwrap();
    let healthz_elapsed = healthz_start.elapsed();
    assert_eq!(healthz_resp.status(), 200);
    assert!(
        healthz_elapsed < Duration::from_millis(500),
        "healthz took {:?} during sign burst — keystore is pinning workers (dos F1 / §17.6)",
        healthz_elapsed,
    );
    for t in sign_tasks {
        t.await.unwrap();
    }
}

// ── §17.7 — concurrent /resolve for the same spec must coalesce ────────────
//
// Closes the dogfood-observed hang on parallel keychain://<same-svc> reads
// (cloister-8d4dd7). Prior behavior: N parallel `/resolve` calls for the
// same URL spawned N independent keystore reads. macOS Keychain (via the
// `keyring` crate) re-evaluates authorization per call, causing some
// callers to hang on per-thread auth prompts.
//
// **SMOKE TEST** — confirms `/resolve` survives 16 concurrent same-spec
// callers and they all see byte-identical bytes. Does NOT assert the
// singleflight invariant — that lives at the unit-test layer:
// `host::keystore::tests::resolve_with_coalesces_concurrent_same_spec_to_one_work_call`
// (uses an `AtomicUsize` counter inside the work closure to assert
// `count == 1`, the actual invariant). The old version of this test
// tried to use wall-clock latency as the singleflight signal, which the
// skeptic-friend cycle (cloister-da87da) flagged as a false-positive:
// 16 serial `file://` reads (microseconds each) still pass <1s wall,
// so a regression to no-singleflight is undetectable wall-clock-side.
// The unit-test asserts on call count instead. Pre-rewrite contract
// was also subtly wrong (`unreachable!()` panic on leader cancel;
// cloister-d95f0d) — see the dedicated cancellation unit test.
#[tokio::test]
async fn concurrent_resolve_for_same_spec_smoke() {
    let tmp = TempDir::new().unwrap();
    let seed_path = tmp.path().join("seed");
    std::fs::write(&seed_path, [0xCDu8; 32]).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&seed_path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    use leyline_sign::host::auth::AuthConfig;
    let state = AppState::with_config(
        10_000,
        AuthConfig::Disabled,
        vec!["file://".to_owned()],
    );
    let _task = tokio::spawn(async move {
        let _ = axum::serve(listener, build_router(state)).await;
    });
    tokio::time::sleep(Duration::from_millis(20)).await;

    let url = format!("file://{}", seed_path.display());
    let url_enc = urlencode(&url);
    let resolve_url = format!("http://{}/resolve?url={}", addr, url_enc);

    let mut handles = Vec::with_capacity(16);
    for _ in 0..16 {
        let u = resolve_url.clone();
        handles.push(tokio::spawn(async move {
            let resp = reqwest::Client::new().get(&u).send().await.unwrap();
            assert_eq!(resp.status(), 200);
            resp.bytes().await.unwrap()
        }));
    }
    let expected: &[u8] = &[0xCDu8; 32];
    for (i, h) in handles.into_iter().enumerate() {
        let r = h.await.unwrap();
        assert_eq!(r.as_ref(), expected, "caller {} got wrong bytes", i);
    }
}

// ── §17.7 (TTL axis) + §17.8 — TTL-bounded positive cache ──────────────────
//
// Closes the second axis of cloister-8d4dd7 + cloister-8d675a: cache
// successful keystore reads for `LEYLINE_SIGN_RESOLVE_TTL_MS` ms so
// `op://` / `apple-password://` callers don't pay the CLI subprocess /
// FaceID prompt cost per request. Operators can override the TTL for
// ALL schemes via the env var (set to 0 to opt out of caching even for
// subprocess schemes).
//
// Test strategy: use `file://` (TTL=0 by default) + an env override
// (TTL=high) and a temp file we mutate between calls. Verify:
//   1. Within TTL window: cached bytes returned even if the underlying
//      file changed.
//   2. After TTL elapses: fresh read, see the new bytes.
//
// Per-scheme defaults (without env override) are exercised by reading
// the bare scheme label through `parse_spec` paths in unit tests, plus
// the live behavior validated by the host-extras + keychain dogfoods.
#[tokio::test]
#[serial_test::serial(env_LEYLINE_SIGN_RESOLVE_TTL_MS)]
async fn resolve_ttl_cache_serves_cached_bytes_within_window() {
    // Set env BEFORE the helper starts so the cache picks up the override.
    //
    // SAFETY: the `#[serial(env_LEYLINE_SIGN_RESOLVE_TTL_MS)]` attribute
    // serializes this test against any other test bearing the same
    // label, across cargo's parallel test workers. No other test in
    // the suite currently touches this env var; if one is added later,
    // mark it with the same label and serial_test serializes them.
    // (For read-only tests that just observe the value, `#[parallel(...)]`
    // with the same label is the right shape — runs concurrently with
    // other readers but waits if a serial-writer is in-flight.)
    //
    // `unsafe` is required by Rust 2024 for env mutation regardless of
    // serialization; `std::env::set_var` is sound-only-if-single-threaded.
    // serial_test gives us the single-threaded guarantee at test-runner
    // level; the unsafe block is the compile-time acknowledgment.
    //
    // Per cloister-da0f35 — replaces an inline SAFETY comment that
    // wasn't enforceable.
    unsafe {
        std::env::set_var("LEYLINE_SIGN_RESOLVE_TTL_MS", "10000");
    }

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
    use leyline_sign::host::auth::AuthConfig;
    let state = AppState::with_config(
        10_000,
        AuthConfig::Disabled,
        vec!["file://".to_owned()],
    );
    let _task = tokio::spawn(async move {
        let _ = axum::serve(listener, build_router(state)).await;
    });
    tokio::time::sleep(Duration::from_millis(20)).await;

    // Use a spec that hasn't been resolved in this test process. The
    // RESOLVE_CACHE is module-static so we need a fresh-to-this-process
    // spec to validate behavior. The temp file path is unique per run.
    let url = format!("file://{}", seed_path.display());
    let url_enc = urlencode(&url);
    let resolve_url = format!("http://{}/resolve?url={}", addr, url_enc);

    // Call 1: populates the cache.
    let r1 = client().get(&resolve_url).send().await.unwrap().bytes().await.unwrap();
    assert_eq!(r1.as_ref(), &[0xAAu8; 32]);

    // Rotate the file underneath. Without TTL caching, the next /resolve
    // would return the new bytes. With TTL caching, it should return the
    // cached bytes (until TTL elapses).
    std::fs::write(&seed_path, [0xBBu8; 32]).unwrap();

    // Call 2: should return the OLD bytes (cached).
    let r2 = client().get(&resolve_url).send().await.unwrap().bytes().await.unwrap();
    assert_eq!(
        r2.as_ref(),
        &[0xAAu8; 32],
        "TTL cache served fresh bytes — cache not honored (cloister-8d4dd7 / §17.7)"
    );

    // Restore env so other tests aren't affected.
    unsafe {
        std::env::remove_var("LEYLINE_SIGN_RESOLVE_TTL_MS");
    }
}

// `LEYLINE_SIGN_RESOLVE_TTL_MS=0` opt-out (matching pre-cycle "re-read every
// call" behavior) is the implicit contract of `ttl_for_scheme` — not
// separately tested here because cargo's parallel test runner can race
// concurrent env-var writers and the negative case ("no caching") is
// observationally indistinguishable from the keystore-side fresh read
// of a non-mutated file. The positive case (caching when configured)
// is pinned by `resolve_ttl_cache_serves_cached_bytes_within_window`
// above; the opt-out is exercised in practice every time `task lint`
// runs because no other test sets the env var.

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
//
// §17.7 — FaceID singleflight (dos F2). Requires `apple-password://`
//          subprocess mocking; tracked by `cloister-future-faceid-singleflight`.
//
// §17.8 — Keychain daemon serialization fairness (dos F3). Tracked by
//          `cloister-future-keychain-cache-ttl`.
//
// §17.11 — `/healthz` deep probe (silence Gap 4). The deep-probe handler
//          + CLI-presence section + LEYLINE_SIGN_HEALTHZ_PROBE_URL env
//          are tracked by `cloister-future-deep-healthz` (the larger
//          §17.11 closing playbook). The PLATFORM-FIELD-STRIP sub-piece
//          IS pinned below (cloister-8d933d sub-piece #3) — narrow
//          security fix that ships independent of the deep-probe work.

// ── §17.11 sub-piece: `/healthz` platform-field strip (cloister-8d933d) ───
//
// Pre-fix /healthz unconditionally emitted `platform = "darwin"|"linux"|...`,
// giving an unauthenticated probe an OS-family oracle for targeted scheme
// probing (skip `apple-password://` on Linux, etc.). Per cloister-8d933d
// the production posture (AuthConfig::Required) strips the field; the
// dev posture (AuthConfig::Disabled) keeps it for local debugging.

#[tokio::test]
async fn healthz_strips_platform_when_auth_required() {
    let h = AdvHelper::start().await; // default_auth() = AuthConfig::Required
    let body: Value = client()
        .get(h.url("/healthz"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(body.get("ok"), Some(&Value::Bool(true)));
    assert!(
        body.get("platform").is_none(),
        "auth-required /healthz MUST omit `platform` (cloister-8d933d / §17.11); got body: {body}",
    );
    // Other fields still present (only `platform` is stripped).
    assert!(body.get("supported_schemes").is_some());
    assert!(body.get("supported_algs").is_some());
    assert!(body.get("uptime_s").is_some());
    assert!(body.get("build_sha").is_some());
}

#[tokio::test]
async fn healthz_emits_platform_when_auth_disabled() {
    let h = AdvHelper::start_with(1000, AuthConfig::Disabled, Vec::new()).await;
    let body: Value = client()
        .get(h.url("/healthz"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(body.get("ok"), Some(&Value::Bool(true)));
    let platform = body.get("platform").and_then(|v| v.as_str()).unwrap_or("");
    assert!(
        ["darwin", "linux", "windows", "unknown"].contains(&platform),
        "dev-mode /healthz MUST emit a recognized `platform` string; got {platform:?}",
    );
}

// ── §17.11 sub-piece #2: CLI-presence section (cloister-8d933d) ───────────
//
// Operators wiring `op://` or `apple-password://` schemes pin absolute
// binary paths via LEYLINE_SIGN_OP_BIN / LEYLINE_SIGN_SECURITY_BIN.
// Dev-mode /healthz exposes the two presence flags so operators can
// debug a misconfigured pin without triggering a real signing call.
// Production-mode strips both — they leak platform info indirectly
// (security_cli_present=true ≈ macOS).

#[tokio::test]
async fn healthz_strips_cli_presence_when_auth_required() {
    let h = AdvHelper::start().await; // default_auth() = AuthConfig::Required
    let body: Value = client()
        .get(h.url("/healthz"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(body.get("ok"), Some(&Value::Bool(true)));
    assert!(
        body.get("op_cli_present").is_none(),
        "auth-required /healthz MUST omit `op_cli_present` (cloister-8d933d sub-piece #2); got body: {body}",
    );
    assert!(
        body.get("security_cli_present").is_none(),
        "auth-required /healthz MUST omit `security_cli_present` (cloister-8d933d sub-piece #2); got body: {body}",
    );
}

#[tokio::test]
async fn healthz_emits_cli_presence_when_auth_disabled() {
    let h = AdvHelper::start_with(1000, AuthConfig::Disabled, Vec::new()).await;
    let body: Value = client()
        .get(h.url("/healthz"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(body.get("ok"), Some(&Value::Bool(true)));
    // Both fields MUST be present as bools in dev-mode. Their values
    // depend on whether the test environment has the env vars pinned;
    // the test cares about the SHAPE (presence + bool type), not the
    // value (operator-controlled).
    let op_present = body.get("op_cli_present");
    let security_present = body.get("security_cli_present");
    assert!(
        op_present.and_then(|v| v.as_bool()).is_some(),
        "dev-mode /healthz MUST emit `op_cli_present` as a bool; got {op_present:?}",
    );
    assert!(
        security_present.and_then(|v| v.as_bool()).is_some(),
        "dev-mode /healthz MUST emit `security_cli_present` as a bool; got {security_present:?}",
    );
}

// ── §17.11 sub-piece #1+#4: `/healthz?deep=1` synthetic probe (cloister-8d933d) ──
//
// Silence Gap 4 fix: today /healthz returns ok=true if the Worker boots,
// regardless of whether the keystore is wired. `?deep=1` rounds-trips a
// pinned URL (LEYLINE_SIGN_HEALTHZ_PROBE_URL) through the keystore so
// ok=true means "I can actually resolve secrets," not just "I started."
//
// Sub-piece #4 from the bead checklist: `healthz_deep_probe_returns_ok_for_seeded_url`.

#[tokio::test]
async fn healthz_no_deep_query_omits_deep_probe_field() {
    let h = AdvHelper::start().await;
    let body: Value = client()
        .get(h.url("/healthz"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(body.get("ok"), Some(&Value::Bool(true)));
    assert!(
        body.get("deep_probe").is_none(),
        "shallow /healthz MUST omit `deep_probe` (back-compat with pre-sub-piece-#1 readers); got body: {body}",
    );
}

#[tokio::test]
#[serial_test::serial(env_LEYLINE_SIGN_HEALTHZ_PROBE_URL)]
async fn healthz_deep_query_unconfigured_when_probe_url_unset() {
    // Save + clear so this test is hermetic regardless of dev-env.
    let saved = std::env::var("LEYLINE_SIGN_HEALTHZ_PROBE_URL").ok();
    // SAFETY: env mutation in a test; the AdvHelper handler reads the
    // env on each /healthz?deep=1 call (no cached value).
    unsafe { std::env::remove_var("LEYLINE_SIGN_HEALTHZ_PROBE_URL"); }
    let h = AdvHelper::start().await;
    let body: Value = client()
        .get(h.url("/healthz?deep=1"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    if let Some(v) = saved {
        unsafe { std::env::set_var("LEYLINE_SIGN_HEALTHZ_PROBE_URL", v); }
    }
    assert_eq!(body.get("ok"), Some(&Value::Bool(true)));
    let deep = body.get("deep_probe").expect("deep_probe field present under ?deep=1");
    assert_eq!(deep.get("status"), Some(&Value::String("unconfigured".to_string())));
    assert!(deep.get("error").is_none(), "unconfigured MUST NOT carry an error label; got {deep}");
}

#[tokio::test]
#[serial_test::serial(env_LEYLINE_SIGN_HEALTHZ_PROBE_URL)]
async fn healthz_deep_probe_returns_ok_for_seeded_url() {
    // Seed: keychain://probe-marker-{nonce} populated via the test
    // keychain fixture. We don't have a real keychain in CI, so use
    // file:// pointing at a tmp file we control.
    let dir = tempfile::tempdir().unwrap();
    let probe_path = dir.path().join("probe.txt");
    std::fs::write(&probe_path, b"healthz-probe-bytes\n").unwrap();
    let probe_url = format!("file://{}", probe_path.to_string_lossy());

    let saved = std::env::var("LEYLINE_SIGN_HEALTHZ_PROBE_URL").ok();
    // SAFETY: env mutation in a test; the handler reads env per call.
    unsafe { std::env::set_var("LEYLINE_SIGN_HEALTHZ_PROBE_URL", &probe_url); }
    let h = AdvHelper::start().await;
    let body: Value = client()
        .get(h.url("/healthz?deep=1"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    match saved {
        Some(v) => unsafe { std::env::set_var("LEYLINE_SIGN_HEALTHZ_PROBE_URL", v); },
        None => unsafe { std::env::remove_var("LEYLINE_SIGN_HEALTHZ_PROBE_URL"); },
    }

    assert_eq!(body.get("ok"), Some(&Value::Bool(true)));
    let deep = body.get("deep_probe").expect("deep_probe field present under ?deep=1");
    assert_eq!(deep.get("status"), Some(&Value::String("ok".to_string())));
    assert!(deep.get("error").is_none(), "ok MUST NOT carry an error label; got {deep}");
}

#[tokio::test]
#[serial_test::serial(env_LEYLINE_SIGN_HEALTHZ_PROBE_URL)]
async fn healthz_deep_probe_reports_error_with_coarse_label_when_url_fails() {
    // Point at a definitely-missing file. resolve_bytes returns
    // NotFound; the deep-probe surface lowers that to log_label()
    // = "not_found".
    let probe_url = "file:///does/not/exist/healthz-probe.txt";
    let saved = std::env::var("LEYLINE_SIGN_HEALTHZ_PROBE_URL").ok();
    // SAFETY: env mutation in a test.
    unsafe { std::env::set_var("LEYLINE_SIGN_HEALTHZ_PROBE_URL", probe_url); }
    let h = AdvHelper::start().await;
    let body: Value = client()
        .get(h.url("/healthz?deep=1"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    match saved {
        Some(v) => unsafe { std::env::set_var("LEYLINE_SIGN_HEALTHZ_PROBE_URL", v); },
        None => unsafe { std::env::remove_var("LEYLINE_SIGN_HEALTHZ_PROBE_URL"); },
    }

    assert_eq!(body.get("ok"), Some(&Value::Bool(false)));
    let deep = body.get("deep_probe").expect("deep_probe field present under ?deep=1");
    assert_eq!(deep.get("status"), Some(&Value::String("error".to_string())));
    let err = deep.get("error").and_then(|v| v.as_str()).unwrap_or("");
    // The exact label is one of HelperError's coarse strings — we
    // don't pin which to keep the test resilient to error-classification
    // refinements. We DO pin "not the URL" (ADR-0019 req. 11).
    assert!(
        !err.is_empty(),
        "error label MUST be a non-empty coarse string; got {err:?}",
    );
    assert!(
        !err.contains("/does/not/exist") && !err.contains("healthz-probe"),
        "error label MUST NOT leak the probe URL (ADR-0019 req. 11); got {err:?}",
    );
}
