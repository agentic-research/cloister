// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 cloister contributors
//
// mint-dev-cert — generate a fresh ephemeral dev master + Interlace lease cert
// for `task harness:dev` (ADR-0042). Prints a JSON object to stdout with the
// material a local dev run needs:
//
//   - masterPubB64Std        → the static dev CA bundle `keys{active}` (+ the
//                              cert-chain verify anchor). base64-STANDARD, the
//                              encoding the CA-bundle cache decodes.
//   - certDerB64Url          → the shim's CertSource cert (Authorization: Signet)
//   - ephemeralPrivSeedB64Url→ the shim's Ed25519 signing seed (JWK `d`)
//   - ephemeralPubB64Url     → the shim's Ed25519 pubkey (JWK `x`)
//   - peerFp / epoch         → the vault seed key + the defaultAllowedSubs overlay
//   - notBefore / notAfter   → the cert validity window
//
// UNLIKE gen-fixture (fixed seed → stable test fixtures), this uses OsRng +
// wall-clock validity so every dev run gets its own throwaway identity. It is
// dev-only: the material is ephemeral, never committed, and the run is gated by
// CLOISTER_MODE=dev (ADR-0042 safety rail). Production mints via notme
// (cloister-c3c7b9) behind the same CertSource seam.
//
// Run: cargo run -q --example mint-dev-cert   (invoked by `task harness:dev`)

use ed25519_dalek::SigningKey;
use leyline_sign::cert_chain::tests_helpers::mint_test_cert;
use rand::rngs::OsRng;
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

fn b64url(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn b64std(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

// Minimal JSON string quoting. Values here are base64 / hex / ints, but escape
// defensively so the output is always valid JSON.
fn jstr(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

fn main() {
    let mut rng = OsRng;
    let master = SigningKey::generate(&mut rng);
    let ephemeral = SigningKey::generate(&mut rng);

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before unix epoch")
        .as_secs() as i64;
    let not_before = now - 300; // 5-min back-date to absorb clock skew
    let not_after = now + 24 * 60 * 60; // 1-day dev cert

    // The static dev CA bundle carries this same epoch; isCertEpochCurrent
    // requires bundle.epoch == cert.epoch.
    let epoch: u32 = 1;

    // peer_fp — stable per master, canonical shape. The vault seed keys the dev
    // credential under this fp, and the dev defaultAllowedSubs overlay opts it
    // in. First 12 bytes of SHA-256(master pubkey), hex.
    let mut hasher = Sha256::new();
    hasher.update(master.verifying_key().as_bytes());
    let digest = hasher.finalize();
    let fp_hex: String = digest.iter().take(12).map(|b| format!("{b:02x}")).collect();
    let peer_fp = format!("sha256:{fp_hex}");

    // Admin scope. The vault proxy derives requested scope `unknown:vaultProxy`
    // (its route isn't JSON-RPC-shaped), which only `*` grants until per-service
    // scope lands (cloister-c3d5ec).
    let scope = "*";

    let cert = mint_test_cert(
        &master,
        &ephemeral,
        not_before,
        not_after,
        Some(epoch),
        Some(&peer_fp),
        Some(scope),
    );

    println!("{{");
    println!("  \"masterPubB64Std\": {},", jstr(&b64std(master.verifying_key().as_bytes())));
    println!("  \"certDerB64Url\": {},", jstr(&b64url(&cert)));
    println!("  \"ephemeralPrivSeedB64Url\": {},", jstr(&b64url(&ephemeral.to_bytes())));
    println!("  \"ephemeralPubB64Url\": {},", jstr(&b64url(ephemeral.verifying_key().as_bytes())));
    println!("  \"peerFp\": {},", jstr(&peer_fp));
    println!("  \"scope\": {},", jstr(scope));
    println!("  \"epoch\": {epoch},");
    println!("  \"notBefore\": {not_before},");
    println!("  \"notAfter\": {not_after}");
    println!("}}");
}
