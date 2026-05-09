// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 cloister contributors
// Origin: agentic-research/ley-line (Apache-2.0); see ../../../NOTICE.

use der::Decode;
use ed25519_dalek::SigningKey;
use x509_cert::Certificate;

use crate::error::SignError;
use crate::oid::ID_ED25519;

/// Parse a DER-encoded X.509 certificate.
pub fn parse_cert(der_bytes: &[u8]) -> Result<Certificate, SignError> {
    Certificate::from_der(der_bytes).map_err(|e| SignError::DerError(e.to_string()))
}

/// Extract the issuer name and serial number DER bytes from a certificate.
/// Returns (issuer_der, serial_bytes) for building SignerIdentifier.
pub fn signer_identifier(cert: &Certificate) -> Result<(Vec<u8>, Vec<u8>), SignError> {
    use der::Encode;
    let issuer_der = cert
        .tbs_certificate
        .issuer
        .to_der()
        .map_err(|e| SignError::DerError(e.to_string()))?;
    let serial_bytes = cert.tbs_certificate.serial_number.as_bytes().to_vec();
    Ok((issuer_der, serial_bytes))
}

/// Verify that the certificate's public key matches the signing key.
/// Compares the SPKI-embedded Ed25519 public key against the signing key's public half.
pub fn verify_key_match(cert: &Certificate, signing_key: &SigningKey) -> Result<(), SignError> {
    let spki = &cert.tbs_certificate.subject_public_key_info;

    // Verify it's an Ed25519 key
    if spki.algorithm.oid != ID_ED25519 {
        return Err(SignError::InvalidCert);
    }

    // Extract raw public key bits
    let cert_pubkey = spki.subject_public_key.raw_bytes();
    let our_pubkey = signing_key.verifying_key().to_bytes();

    if cert_pubkey != our_pubkey {
        return Err(SignError::KeyMismatch);
    }

    Ok(())
}
