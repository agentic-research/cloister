// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 cloister contributors
//
// Sign-only trust-anchor-helper host implementation (ADR-0019,
// cloister-99165e).
//
// This module is the heart of `leyline-sign-helper` — a loopback-only HTTP
// daemon that mediates OS-keystore-backed Ed25519 signing. Key bytes never
// leave this process; callers (workerd, scripts, anything on the host)
// submit a payload and receive a signature.
//
// Module layout (all `pub(crate)` — only `helper.rs` consumes them):
//
//   - `error`     — typed errors + HTTP code mapping
//   - `keystore`  — URL-spec → bytes (keychain://, file://, secret-tool://)
//   - `sign`      — Ed25519 signing pipeline (cached SigningKey, byte-hash
//                   invalidation per ADR-0019 §"Keystore-byte caching policy")
//   - `cache`     — the byte-hash-indexed parsed-key cache
//   - `ratelimit` — token-bucket per source UID (default 1000 sigs/sec)
//   - `server`    — axum routes + middleware
//   - `health`    — GET /healthz handler
//
// All modules are gated on `feature = "host"` + `not(target_arch = "wasm32")`
// at the crate root in `lib.rs`; nothing inside this directory compiles on
// the wasm verifier path (Taskfile `rs:sign:wasm`).

pub mod auth;
pub mod cache;
pub mod error;
pub mod health;
pub mod keystore;
pub mod ratelimit;
pub mod server;
pub mod sign;
