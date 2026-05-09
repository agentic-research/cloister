// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 cloister contributors
//
// Mint a test cert + master keypair and print as a TypeScript fixture
// module to stdout. Used by `task rs:sign:fixtures` to produce
// test/wire/fixtures/cert-chain.ts so the TS-side wasm wrapper can
// run real round-trip tests.
//
// Output format: a TS module with base64-encoded master_pubkey + cert
// DER + ephemeral pubkey + claims fields. Stable across runs given the
// same RNG seed (deterministic with --deterministic, random otherwise).
//
// Run via: cargo run --example gen-fixture > test/wire/fixtures/cert-chain.ts

use ed25519_dalek::SigningKey;
use leyline_sign::cert_chain::tests_helpers::*;

fn b64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn main() {
    // Use a fixed seed for determinism — fixtures should be stable across
    // task runs so test output diff is signal, not noise.
    let master_seed: [u8; 32] = [
        0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
        0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
        0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18,
        0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20,
    ];
    let ephemeral_seed: [u8; 32] = [
        0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
        0x88, 0x89, 0x8a, 0x8b, 0x8c, 0x8d, 0x8e, 0x8f,
        0x90, 0x91, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97,
        0x98, 0x99, 0x9a, 0x9b, 0x9c, 0x9d, 0x9e, 0x9f,
    ];

    let master    = SigningKey::from_bytes(&master_seed);
    let ephemeral = SigningKey::from_bytes(&ephemeral_seed);

    // Fixed-time validity so the fixture doesn't drift.
    let not_before: i64 = 1_700_000_000;
    let not_after:  i64 = 1_700_000_300;

    // Cert with all Interlace extensions populated.
    let cert_full = mint_test_cert(
        &master, &ephemeral,
        not_before, not_after,
        Some(7),
        Some("sha256:abc123def456"),
        Some("bead_create:/repos/foo"),
    );

    // Cert without Interlace extensions (legacy mintBridgeCertPair shape).
    let cert_minimal = mint_test_cert(
        &master, &ephemeral,
        not_before, not_after,
        None, None, None,
    );

    // Wrong-master cert: minted by a different master, used to test
    // BadSignature rejection.
    let other_seed: [u8; 32] = [0xff; 32];
    let other_master = SigningKey::from_bytes(&other_seed);
    let cert_wrong_master = mint_test_cert(
        &other_master, &ephemeral,
        not_before, not_after,
        Some(7),
        Some("sha256:abc123def456"),
        Some("bead_create:/repos/foo"),
    );

    println!("// SPDX-License-Identifier: AGPL-3.0-or-later");
    println!("//");
    println!("// AUTO-GENERATED — do not edit. Regenerate with `task rs:sign:fixtures`.");
    println!("// Source: rs/crates/sign/examples/gen-fixture.rs");
    println!("//");
    println!("// Test fixtures for cloister-bd5241 / cloister-9d49eb cert-chain");
    println!("// verify wrapper. Generated from a fixed RNG seed so the bytes are");
    println!("// stable across regenerations.");
    println!();
    println!("export const MASTER_PUBKEY_B64 = \"{}\";",     b64(master.verifying_key().as_bytes()));
    println!("export const EPHEMERAL_PUBKEY_B64 = \"{}\";",  b64(ephemeral.verifying_key().as_bytes()));
    println!("export const NOT_BEFORE = {};",                not_before);
    println!("export const NOT_AFTER  = {};",                not_after);
    println!();
    println!("/** Cert with all Interlace extensions (epoch + peer_fp + scope). */");
    println!("export const CERT_FULL_B64 = \"{}\";",         b64(&cert_full));
    println!();
    println!("/** Cert without Interlace extensions (legacy / minimum-viable cert). */");
    println!("export const CERT_MINIMAL_B64 = \"{}\";",      b64(&cert_minimal));
    println!();
    println!("/** Cert minted by a different master — should reject under MASTER_PUBKEY_B64. */");
    println!("export const CERT_WRONG_MASTER_B64 = \"{}\";", b64(&cert_wrong_master));
}
