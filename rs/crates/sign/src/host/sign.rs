// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 cloister contributors
//
// Ed25519 signing pipeline + algorithm-substitution defense (ADR-0019
// normative reqs 1, 5, 6, 7, 8, 9).
//
// Pipeline:
//   1. Re-read keystore bytes from OS (delegated to keystore::resolve_bytes)
//   2. Validate caller-asserted `alg` against keystore byte length
//      (ed25519 → exactly 32 bytes; everything else → HTTP 415).
//      THIS IS NORMATIVE REQ. 6 — the largest gap closed per
//      math-friend #1.
//   3. Cache lookup by SHA-256(keystore bytes); reuse parsed SigningKey
//      if hash matches.
//   4. Sign with ed25519-dalek 2.x (RFC 8032 §5.1 pure Ed25519).
//   5. Compute kid = base64url(first 8 bytes of SHA-256(pubkey)).
//   6. Return { signature_b64, kid [, pubkey_b64 if return_pubkey] }.

use std::sync::Arc;

use base64ct::{Base64UrlUnpadded, Encoding};
use ed25519_dalek::{Signer, SigningKey};
use sha2::{Digest, Sha256};

use crate::host::cache::KeyCache;
use crate::host::error::HelperError;
use crate::host::keystore;

/// Wire-supported algorithms. Currently just ed25519. ml-dsa-44 etc. will
/// land as new variants per ADR-0019 §"Why Ed25519-first".
pub const SUPPORTED_ALGS: &[&str] = &["ed25519"];

const ED25519_SEED_BYTES: usize = 32;

#[derive(Debug, Clone)]
pub struct SignResult {
    pub signature_b64: String,
    pub kid: String,
    pub pubkey_b64: Option<String>,
}

/// Run the signing pipeline for `(spec, alg, payload)`. Returns wire-shape
/// result.
///
/// This is the synchronous-after-keystore part — keystore I/O happens
/// inside this function. The outer server layer wraps it in `tokio::time::
/// timeout(5s)` per ADR-0019 normative req. 4.
pub async fn sign(
    cache: &KeyCache,
    spec: &str,
    alg: &str,
    payload: &[u8],
    return_pubkey: bool,
) -> Result<SignResult, HelperError> {
    if alg != "ed25519" {
        return Err(HelperError::UnsupportedAlg("only ed25519 supported"));
    }
    let keystore_bytes = keystore::resolve_bytes(spec)?;
    // ADR-0019 normative req. 6: validate keystore byte length BEFORE
    // any sign operation. Wrong length → 415, no signing attempted.
    if keystore_bytes.len() != ED25519_SEED_BYTES {
        return Err(HelperError::UnsupportedAlg(
            "keystore byte length mismatch for ed25519 (expect 32)",
        ));
    }
    let sk = cache
        .get_or_load(spec, &keystore_bytes, parse_ed25519)
        .await
        .map_err(|_| HelperError::UnsupportedAlg("invalid ed25519 seed"))?;
    Ok(sign_with(&sk, payload, return_pubkey))
}

/// Pure signing routine — separated for unit-test convenience.
pub fn sign_with(sk: &SigningKey, payload: &[u8], return_pubkey: bool) -> SignResult {
    let signature = sk.sign(payload);
    let signature_bytes = signature.to_bytes();
    let signature_b64 = Base64UrlUnpadded::encode_string(&signature_bytes);
    let pubkey_bytes: [u8; 32] = sk.verifying_key().to_bytes();
    let kid = compute_kid(&pubkey_bytes);
    let pubkey_b64 = if return_pubkey {
        Some(Base64UrlUnpadded::encode_string(&pubkey_bytes))
    } else {
        None
    };
    SignResult { signature_b64, kid, pubkey_b64 }
}

/// `kid = base64url(first 8 bytes of SHA-256(pubkey))` per ADR-0019
/// normative req. 9.
pub fn compute_kid(pubkey: &[u8; 32]) -> String {
    let mut h = Sha256::new();
    h.update(pubkey);
    let digest = h.finalize();
    Base64UrlUnpadded::encode_string(&digest[..8])
}

pub fn parse_ed25519(bytes: &[u8]) -> Result<SigningKey, ()> {
    if bytes.len() != ED25519_SEED_BYTES {
        return Err(());
    }
    let arr: [u8; 32] = bytes.try_into().map_err(|_| ())?;
    Ok(SigningKey::from_bytes(&arr))
}

/// Helper for tests + the `kid` deterministic-output guarantee.
#[allow(dead_code)]
pub fn _signing_key_from_seed(seed: &[u8; 32]) -> Arc<SigningKey> {
    Arc::new(SigningKey::from_bytes(seed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::Verifier;

    #[test]
    fn sign_returns_valid_ed25519_signature() {
        let sk = SigningKey::from_bytes(&[1u8; 32]);
        let r = sign_with(&sk, b"hello", true);
        let sig_bytes = Base64UrlUnpadded::decode_vec(&r.signature_b64).unwrap();
        let pk_bytes = Base64UrlUnpadded::decode_vec(r.pubkey_b64.as_deref().unwrap()).unwrap();
        let pk_arr: [u8; 32] = pk_bytes.try_into().unwrap();
        let sig_arr: [u8; 64] = sig_bytes.try_into().unwrap();
        let vk = ed25519_dalek::VerifyingKey::from_bytes(&pk_arr).unwrap();
        let sig = ed25519_dalek::Signature::from_bytes(&sig_arr);
        vk.verify(b"hello", &sig).expect("signature must verify");
    }

    #[test]
    fn kid_deterministic_for_same_pubkey() {
        let pk = [0xABu8; 32];
        let a = compute_kid(&pk);
        let b = compute_kid(&pk);
        assert_eq!(a, b);
    }

    #[test]
    fn kid_format_is_base64url_no_pad() {
        let pk = [0xABu8; 32];
        let kid = compute_kid(&pk);
        assert!(!kid.contains('+'));
        assert!(!kid.contains('/'));
        assert!(!kid.contains('='));
        assert!(kid.len() == 11 || kid.len() == 12);
    }

    #[test]
    fn return_pubkey_false_omits_pubkey() {
        let sk = SigningKey::from_bytes(&[2u8; 32]);
        let r = sign_with(&sk, b"x", false);
        assert!(r.pubkey_b64.is_none());
    }

    #[test]
    fn return_pubkey_true_includes_pubkey() {
        let sk = SigningKey::from_bytes(&[2u8; 32]);
        let r = sign_with(&sk, b"x", true);
        assert!(r.pubkey_b64.is_some());
    }

    #[test]
    fn parse_ed25519_rejects_wrong_length() {
        assert!(parse_ed25519(&[0u8; 16]).is_err());
        assert!(parse_ed25519(&[0u8; 64]).is_err());
        assert!(parse_ed25519(&[0u8; 32]).is_ok());
    }
}
