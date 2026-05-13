// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 cloister contributors
// Origin: agentic-research/ley-line (Apache-2.0); see ../../../NOTICE.

pub mod cert;
pub mod cert_chain;
pub mod cms;
pub mod error;
pub mod ffi;
pub mod oid;

// Host-only sign-only helper (ADR-0019, cloister-99165e). Gated on both the
// `host` Cargo feature AND `not(target_arch = "wasm32")` so the wasm verifier
// path (`task rs:sign:wasm`) is unaffected.
#[cfg(all(feature = "host", not(target_arch = "wasm32")))]
pub mod host;
