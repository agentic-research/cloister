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

use const_oid::ObjectIdentifier;
use ed25519_dalek::{Signer, SigningKey};
use leyline_sign::cert_chain::tests_helpers::*;

fn b64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn b64_std(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
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
    // Validity window: Nov 14 2023 → Dec 31 2049 (the end of UTCTime's
    // representable range). Wide enough that wall-clock Date.now() in
    // any test session passes the validity-window check; SELF.fetch
    // tests can use real Date.now() via signedMcpRequest without
    // tripping the cert.not_after gate. Closes cloister-2197d8.
    let not_before: i64 = 1_700_000_000;
    let not_after:  i64 = 2_524_607_999;  // 2049-12-31T23:59:59Z

    // Cert with all Interlace extensions populated.
    let cert_full = mint_test_cert(
        &master, &ephemeral,
        not_before, not_after,
        Some(7),
        Some("sha256:abc123def456"),
        Some("bead_create:/repos/foo"),
    );

    // Admin-scope cert for live proof harnesses that need to exercise
    // generic JSON-RPC surfaces such as tools/list and dynamic MCP tools.
    let cert_admin = mint_test_cert(
        &master, &ephemeral,
        not_before, not_after,
        Some(7),
        Some("sha256:abc123def456"),
        Some("*"),
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
    println!("/** Cert with admin wildcard scope, used only by local proof harnesses. */");
    println!("export const CERT_ADMIN_B64 = \"{}\";",        b64(&cert_admin));
    println!();
    println!("/** Cert without Interlace extensions (legacy / minimum-viable cert). */");
    println!("export const CERT_MINIMAL_B64 = \"{}\";",      b64(&cert_minimal));
    println!();
    println!("/** Cert minted by a different master — should reject under MASTER_PUBKEY_B64. */");
    println!("export const CERT_WRONG_MASTER_B64 = \"{}\";", b64(&cert_wrong_master));

    // ── Sample signed request, for orchestrator integration tests ────────
    //
    // The lease middleware verifies a request signature: the caller signs
    // canonical-bytes(method, url, ts, nonce_b64, body) with the cert's
    // ephemeral private key. We mint a complete sample here so TS tests
    // don't have to derive a CryptoKey from the seed at runtime.

    let sample_method  = "POST";
    let sample_url     = "http://x/mcp";
    let sample_ts: i64 = 1_700_000_100_000;  // ms; inside [not_before, not_after] in seconds
    let sample_nonce: [u8; 16] = [
        0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8,
        0xa9, 0xaa, 0xab, 0xac, 0xad, 0xae, 0xaf, 0xb0,
    ];
    let sample_nonce_b64 = b64(&sample_nonce);
    let sample_body = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"bead_create","arguments":{"repo":"/repos/foo"}}}"#;

    // Reproduce src/routes/lease-middleware.ts canonicalRequestBytes:
    //   <method>\n<url>\n<ts>\n<nonce-b64-no-pad>\n<body>
    let canonical = format!(
        "{}\n{}\n{}\n{}\n{}",
        sample_method, sample_url, sample_ts, sample_nonce_b64, sample_body
    );
    let sig = ephemeral.sign(canonical.as_bytes());

    println!();
    println!("/**");
    println!(" * Sample signed request for verifyAndUpsertLease integration tests.");
    println!(" * The signature is over canonicalRequestBytes(method, url, ts, nonce, body)");
    println!(" * using the ephemeral private key whose public key is embedded in CERT_FULL_B64.");
    println!(" */");
    println!("export const SAMPLE_METHOD    = \"{}\";", sample_method);
    println!("export const SAMPLE_URL       = \"{}\";", sample_url);
    println!("export const SAMPLE_TS_MS     = {};",     sample_ts);
    println!("export const SAMPLE_NONCE_B64 = \"{}\";", sample_nonce_b64);
    println!("export const SAMPLE_BODY_JSON = {};",     serde_json_str(sample_body));
    println!("export const SAMPLE_SIG_B64   = \"{}\";", b64(&sig.to_bytes()));
    println!();
    println!("/** Master pubkey re-encoded as base64-STANDARD for CA-bundle insertion. */");
    println!("export const MASTER_PUBKEY_B64_STD = \"{}\";", b64_std(master.verifying_key().as_bytes()));

    println!();
    println!("/**");
    println!(" * Ephemeral key SEED (base64url, no padding) — the 32-byte raw seed");
    println!(" * matching EPHEMERAL_PUBKEY_B64. Tests import this as a JWK Ed25519");
    println!(" * private key (`{{ kty:\"OKP\", crv:\"Ed25519\", d:<seed>, x:<pub> }}`)");
    println!(" * and sign canonical request bytes per-test, so each test uses a");
    println!(" * unique nonce and timestamp without colliding with the");
    println!(" * (cert_fp, nonce) replay-defense ledger.");
    println!(" *");
    println!(" * Test-fixture only — not a real key.");
    println!(" */");
    println!("export const EPHEMERAL_PRIV_SEED_B64 = \"{}\";", b64(&ephemeral_seed));

    // ── Edge-of-validity envelopes for validity-window tests ─────────────
    //
    // The primary SAMPLE_TS sits in the middle of the cert validity window,
    // which means a `nowMs` outside the validity window is also outside
    // the clock-skew window (60s) and gets caught by the clock-skew gate
    // first (cloister-c7e3e3). To exercise the validity-window check in
    // isolation, we mint envelopes signed AT THE EDGE of the cert window
    // — that way `nowMs` can step a few seconds outside the validity
    // window while staying within ±60s of the envelope's ts.

    let near_nb_ts: i64 = (not_before + 5) * 1000;  // 5s past not_before, in ms
    let near_nb_nonce: [u8; 16] = [
        0xb1, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8,
        0xb9, 0xba, 0xbb, 0xbc, 0xbd, 0xbe, 0xbf, 0xc0,
    ];
    let near_nb_nonce_b64 = b64(&near_nb_nonce);
    let near_nb_canonical = format!(
        "{}\n{}\n{}\n{}\n{}",
        sample_method, sample_url, near_nb_ts, near_nb_nonce_b64, sample_body
    );
    let near_nb_sig = ephemeral.sign(near_nb_canonical.as_bytes());

    let near_na_ts: i64 = (not_after - 5) * 1000;  // 5s before not_after, in ms
    let near_na_nonce: [u8; 16] = [
        0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8,
        0xc9, 0xca, 0xcb, 0xcc, 0xcd, 0xce, 0xcf, 0xd0,
    ];
    let near_na_nonce_b64 = b64(&near_na_nonce);
    let near_na_canonical = format!(
        "{}\n{}\n{}\n{}\n{}",
        sample_method, sample_url, near_na_ts, near_na_nonce_b64, sample_body
    );
    let near_na_sig = ephemeral.sign(near_na_canonical.as_bytes());

    println!();
    println!("/**");
    println!(" * Sample envelope signed AT THE EDGE of the cert validity window.");
    println!(" * Used to test `cert.not_before` / `cert.not_after` rejections without");
    println!(" * tripping the clock-skew gate first (cloister-c7e3e3).");
    println!(" *");
    println!(" * `NEAR_NB`: ts = (not_before + 5s); nowMs slightly before not_before");
    println!(" *           stays within clock-skew (~5s) and triggers validity-window.");
    println!(" * `NEAR_NA`: ts = (not_after - 5s); nowMs slightly past not_after");
    println!(" *           stays within clock-skew (~5s) and triggers validity-window.");
    println!(" */");
    println!("export const SAMPLE_NEAR_NB_TS_MS     = {};",     near_nb_ts);
    println!("export const SAMPLE_NEAR_NB_NONCE_B64 = \"{}\";", near_nb_nonce_b64);
    println!("export const SAMPLE_NEAR_NB_SIG_B64   = \"{}\";", b64(&near_nb_sig.to_bytes()));
    println!();
    println!("export const SAMPLE_NEAR_NA_TS_MS     = {};",     near_na_ts);
    println!("export const SAMPLE_NEAR_NA_NONCE_B64 = \"{}\";", near_na_nonce_b64);
    println!("export const SAMPLE_NEAR_NA_SIG_B64   = \"{}\";", b64(&near_na_sig.to_bytes()));

    // ── Cert with a critical unknown extension (cloister-c71977) ─────────
    //
    // RFC 5280 §4.2: a verifier MUST reject any cert it does not recognize
    // when the extension is critical-flagged. We mint a cert with a
    // critical extension at a private OID outside cloister's known arc;
    // the TS-side wasm verifier should reject it.

    let unknown_oid = ObjectIdentifier::new_unwrap("1.3.6.1.4.1.99999.42.1");
    let cert_critical_unknown = mint_test_cert_with_extra_ext(
        &master, &ephemeral, not_before, not_after,
        unknown_oid,
        true,                              // critical
        vec![0x04, 0x01, 0x01],            // arbitrary DER bytes
    );
    let cert_noncritical_unknown = mint_test_cert_with_extra_ext(
        &master, &ephemeral, not_before, not_after,
        unknown_oid,
        false,                             // non-critical
        vec![0x04, 0x01, 0x01],
    );

    println!();
    println!("/** Cert with a CRITICAL unknown extension (OID 1.3.6.1.4.1.99999.42.1).");
    println!(" * Per RFC 5280 §4.2 / cloister-c71977, the verifier MUST reject. */");
    println!("export const CERT_CRITICAL_UNKNOWN_EXT_B64 = \"{}\";", b64(&cert_critical_unknown));
    println!();
    println!("/** Cert with a NON-CRITICAL unknown extension at the same OID.");
    println!(" * RFC 5280 says non-critical unknowns MAY be ignored — verifier accepts. */");
    println!("export const CERT_NONCRITICAL_UNKNOWN_EXT_B64 = \"{}\";", b64(&cert_noncritical_unknown));
}

/// Hand-encode a JSON string literal — avoids pulling serde_json in for one
/// usage. Escapes `"` and `\\` and the control characters that would
/// otherwise produce invalid TS source.
fn serde_json_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"'  => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
