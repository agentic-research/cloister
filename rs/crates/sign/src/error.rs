// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 cloister contributors
// Origin: agentic-research/ley-line (Apache-2.0); see ../../../NOTICE.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum SignError {
    #[error("invalid certificate DER")]
    InvalidCert,
    #[error("invalid private key")]
    InvalidKey,
    #[error("certificate public key does not match signing key")]
    KeyMismatch,
    #[error("Ed25519 signing failed")]
    SigningFailed,
    #[error("DER encoding error: {0}")]
    DerError(String),
}

#[derive(Debug, Error)]
pub enum VerifyError {
    #[error("invalid CMS signature structure")]
    InvalidSignature,
    #[error("no signers in SignedData")]
    NoSigners,
    #[error("message digest mismatch")]
    DigestMismatch,
    #[error("Ed25519 signature verification failed")]
    SignatureInvalid,
    #[error("signer certificate not found in SignedData")]
    CertNotFound,
    #[error("weak digest algorithm rejected (MD5/SHA-1)")]
    WeakAlgorithm,
    #[error("DER decoding error: {0}")]
    DerError(String),
}
