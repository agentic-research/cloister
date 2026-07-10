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
// This uses OsRng + wall-clock validity so every dev run gets its own throwaway
// identity. It is dev-only: the material is ephemeral, never committed, and the
// run is gated by CLOISTER_MODE=dev (ADR-0042 safety rail). Production mints via
// notme (cloister-c3c7b9) behind the same CertSource seam.
//
// Home: this example lived in `rs/crates/sign/examples/` while cloister carried
// a leyline-sign fork. PR #119 (cloister-8f4d3f) dropped the fork and made
// cloister depend on LLO's canonical leyline-sign — but the minter was collateral
// and left `task harness:dev` broken. It is re-homed here in `cloister-cas`, the
// surviving crate that already pins LLO's leyline-sign, and builds against
// `leyline_sign::cert_chain::tests_helpers` (an intentionally-public module).
//
// Run: cargo run -q --example mint-dev-cert -p cloister-cas  (invoked by `task harness:dev`)

use ed25519_dalek::SigningKey;
use leyline_sign::cert_chain::tests_helpers::mint_test_cert;
use rand::RngCore;
use rand::rngs::OsRng;
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

// ed25519-dalek 3.x removed `SigningKey::generate` — it now requires a
// `rand_core 0.10`-compatible `CryptoRng`, while `rand = "0.8"` (rand_core 0.6)
// is the pin LLO's leyline-sign keeps (bead ley-line-open-3b2f55). Mirror LLO's
// own `random_signing_key` test helper: seed a `[u8; 32]` from rand 0.8's OsRng
// and hand the raw bytes to `SigningKey::from_bytes`, infallible in 3.x. This
// keeps the SigningKey type identical to the one `mint_test_cert` expects.
fn random_signing_key() -> SigningKey {
    let mut seed = [0u8; 32];
    OsRng.fill_bytes(&mut seed);
    SigningKey::from_bytes(&seed)
}

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
    let master = random_signing_key();
    let ephemeral = random_signing_key();

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
