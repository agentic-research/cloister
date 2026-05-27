// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 cloister contributors
// Origin: agentic-research/ley-line (Apache-2.0); see ../../../NOTICE.
//
// VENDORED FORK — converge under cloister-bd8c41.
//
// This crate is a vendored copy of leyline-sign from the private
// ley-line repo, lifted 2026-05-09. The same code exists in three
// places: signet (as `signet-sign`, the original 2026-03-23),
// ley-line-open (as `leyline-sign` 0.4.5), and here. All three are
// diverging forks of the same CMS/PKCS#7 + Ed25519 implementation.
//
// This copy is the only one that works on wasm32 today (signingTime
// removed, lsign_alloc/free, cert_chain.rs, leyline-sign-helper).
// The four cloister-only additions need to be PR'd upstream to LLO
// so cloister can consume leyline-sign as a git dep (same pattern as
// leyline-cas-ffi in cloister-713b4e) and delete this vendored copy.
// See NOTICE for the full diff and license provenance.

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
