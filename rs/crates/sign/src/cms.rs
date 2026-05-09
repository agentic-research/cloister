// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 cloister contributors
// Origin: agentic-research/ley-line (Apache-2.0); see ../../../NOTICE.

use ed25519_dalek::{Signer, SigningKey, Verifier, VerifyingKey};
use sha2::{Digest, Sha512};

use crate::cert;
use crate::error::{SignError, VerifyError};
use crate::oid;

/// Sign data using CMS/PKCS#7 with Ed25519 and signed attributes (RFC 5652 + RFC 8419).
///
/// Produces a detached CMS signature with contentType and messageDigest signed
/// attributes. The signature is over the DER-encoded SET OF attributes.
///
/// `signingTime` is **omitted by design**. RFC 5652 §5.3 lists signingTime as
/// a useful-but-unauthenticated attribute, so omission is spec-legal. The
/// reason: this crate compiles to wasm32 (cloister adoption — see cloister
/// ADR-0007 amendment 2026-05-08, originally tracked as ley-line-e25413
/// before cloister lifted leyline-sign in-tree). A wasm32 build needs a
/// time source that varies per host (`js_sys::Date` in V8, `wasi:clocks` in
/// WASI, `SystemTime::now()` native), and a fixed-time placeholder shipping
/// across hosts would silently collapse the temporal-binding property of any
/// verifier that trusts signingTime. Until a per-host time-source contract
/// lands, the safer choice is to leave it out and bind temporal context via
/// `cert.not_before` / `not_after` (which the master signs at mint time) and
/// the attestation row's server-timestamped `created_at`.
///
/// Returns DER-encoded ContentInfo wrapping SignedData.
pub fn sign_data(
    data: &[u8],
    cert_der: &[u8],
    private_key: &[u8; 64],
) -> Result<Vec<u8>, SignError> {
    let x509 = cert::parse_cert(cert_der)?;
    let signing_key =
        SigningKey::from_keypair_bytes(private_key).map_err(|_| SignError::InvalidKey)?;
    cert::verify_key_match(&x509, &signing_key)?;

    let (issuer_der, serial_bytes) = cert::signer_identifier(&x509)?;

    // SHA-512 digest of content
    let digest = Sha512::digest(data);

    // Build signed attributes (contentType, messageDigest — see fn doc for why
    // signingTime is omitted).
    let content_type_attr = build_attribute(&oid::ID_CONTENT_TYPE, &encode_oid(&oid::ID_DATA));
    let message_digest_attr =
        build_attribute(&oid::ID_MESSAGE_DIGEST, &encode_octet_string(&digest));

    let mut attrs = vec![content_type_attr, message_digest_attr];
    // DER canonical ordering: sort by encoded bytes
    attrs.sort();

    // Dual encoding: SET (0x31) for signing
    let set_bytes = encode_as_set(&attrs);

    // Sign the SET-encoded attributes
    let signature = signing_key.sign(&set_bytes);
    let sig_bytes = signature.to_bytes();

    // IMPLICIT [0] (0xA0) for storage in SignerInfo
    let implicit_bytes = encode_as_implicit0(&attrs);

    // Build SignerInfo
    let signer_info = build_signer_info(
        &issuer_der,
        &serial_bytes,
        &sig_bytes,
        Some(&implicit_bytes),
    );

    // Build SignedData
    let signed_data = build_signed_data(&signer_info, cert_der);

    // Wrap in ContentInfo
    Ok(build_content_info(&signed_data))
}

/// Sign data using CMS/PKCS#7 with Ed25519 PureEdDSA (no signed attributes, RFC 8419).
///
/// The signature is directly over the raw data. No intermediate digest or attributes.
///
/// Returns DER-encoded ContentInfo wrapping SignedData.
pub fn sign_data_without_attributes(
    data: &[u8],
    cert_der: &[u8],
    private_key: &[u8; 64],
) -> Result<Vec<u8>, SignError> {
    let x509 = cert::parse_cert(cert_der)?;
    let signing_key =
        SigningKey::from_keypair_bytes(private_key).map_err(|_| SignError::InvalidKey)?;
    cert::verify_key_match(&x509, &signing_key)?;

    let (issuer_der, serial_bytes) = cert::signer_identifier(&x509)?;

    // PureEdDSA: sign raw data directly
    let signature = signing_key.sign(data);
    let sig_bytes = signature.to_bytes();

    // Build SignerInfo without attributes
    let signer_info = build_signer_info(&issuer_der, &serial_bytes, &sig_bytes, None);

    // Build SignedData
    let signed_data = build_signed_data(&signer_info, cert_der);

    // Wrap in ContentInfo
    Ok(build_content_info(&signed_data))
}

/// CMS verification options.
pub struct VerifyOptions {
    /// If true, skip certificate chain validation (for testing or when chain is validated elsewhere).
    pub skip_chain_validation: bool,
}

impl Default for VerifyOptions {
    fn default() -> Self {
        Self {
            skip_chain_validation: true,
        }
    }
}

/// Verify a CMS/PKCS#7 detached signature.
///
/// Returns the signer certificate DER on success.
pub fn verify(
    cms_signature: &[u8],
    detached_data: &[u8],
    _opts: &VerifyOptions,
) -> Result<Vec<u8>, VerifyError> {
    // Parse outer ContentInfo
    let (content_oid, signed_data_bytes) =
        parse_content_info(cms_signature).map_err(VerifyError::DerError)?;

    if content_oid != oid_to_bytes(&oid::ID_SIGNED_DATA) {
        return Err(VerifyError::InvalidSignature);
    }

    // Parse SignedData
    let sd = parse_signed_data(&signed_data_bytes).map_err(VerifyError::DerError)?;

    // Reject weak digest algorithms
    for alg_oid in &sd.digest_algorithm_oids {
        reject_weak_algorithm(alg_oid)?;
    }

    // Get the single signer info
    if sd.signer_infos.is_empty() {
        return Err(VerifyError::NoSigners);
    }
    let si = &sd.signer_infos[0];

    // Verify signer uses Ed25519
    if si.signature_algorithm_oid != oid_to_bytes(&oid::ID_ED25519) {
        return Err(VerifyError::SignatureInvalid);
    }

    // Find matching certificate
    let signer_cert_der = find_signer_cert(&sd.certificates, &si.issuer_der, &si.serial_bytes)
        .ok_or(VerifyError::CertNotFound)?;

    // Extract Ed25519 public key from certificate
    let x509 =
        cert::parse_cert(&signer_cert_der).map_err(|e| VerifyError::DerError(e.to_string()))?;
    let pubkey_bytes = x509
        .tbs_certificate
        .subject_public_key_info
        .subject_public_key
        .raw_bytes();
    let pubkey_arr: [u8; 32] = pubkey_bytes
        .try_into()
        .map_err(|_| VerifyError::CertNotFound)?;
    let verifying_key =
        VerifyingKey::from_bytes(&pubkey_arr).map_err(|_| VerifyError::CertNotFound)?;

    if let Some(ref signed_attrs_implicit) = si.signed_attributes_raw {
        // Case 1: With signed attributes
        // Verify messageDigest matches SHA-512(data)
        let expected_digest = Sha512::digest(detached_data);
        let stored_digest = extract_message_digest_from_attrs(&si.signed_attributes_parsed)
            .ok_or(VerifyError::DigestMismatch)?;
        if !constant_time_eq(&expected_digest, &stored_digest) {
            return Err(VerifyError::DigestMismatch);
        }

        // Reconstruct SET (0x31) from IMPLICIT [0] (0xA0) for verification
        let set_bytes = implicit0_to_set(signed_attrs_implicit);

        // Verify Ed25519 signature over reconstructed SET
        let sig = ed25519_dalek::Signature::from_bytes(
            si.signature
                .as_slice()
                .try_into()
                .map_err(|_| VerifyError::SignatureInvalid)?,
        );
        verifying_key
            .verify(&set_bytes, &sig)
            .map_err(|_| VerifyError::SignatureInvalid)?;
    } else {
        // Case 2: No signed attributes (PureEdDSA)
        let sig = ed25519_dalek::Signature::from_bytes(
            si.signature
                .as_slice()
                .try_into()
                .map_err(|_| VerifyError::SignatureInvalid)?,
        );
        verifying_key
            .verify(detached_data, &sig)
            .map_err(|_| VerifyError::SignatureInvalid)?;
    }

    Ok(signer_cert_der)
}

// ---------------------------------------------------------------------------
// DER encoding helpers (manual construction, mirrors go-cms)
// ---------------------------------------------------------------------------

fn encode_der_length(len: usize) -> Vec<u8> {
    if len < 0x80 {
        vec![len as u8]
    } else if len < 0x100 {
        vec![0x81, len as u8]
    } else if len < 0x10000 {
        vec![0x82, (len >> 8) as u8, len as u8]
    } else {
        vec![0x83, (len >> 16) as u8, (len >> 8) as u8, len as u8]
    }
}

fn encode_tlv(tag: u8, content: &[u8]) -> Vec<u8> {
    let mut out = vec![tag];
    out.extend_from_slice(&encode_der_length(content.len()));
    out.extend_from_slice(content);
    out
}

fn encode_oid(oid: &const_oid::ObjectIdentifier) -> Vec<u8> {
    let bytes = oid.as_bytes();
    encode_tlv(0x06, bytes)
}

fn oid_to_bytes(oid: &const_oid::ObjectIdentifier) -> Vec<u8> {
    oid.as_bytes().to_vec()
}

fn encode_octet_string(data: &[u8]) -> Vec<u8> {
    encode_tlv(0x04, data)
}

fn encode_integer(value: &[u8]) -> Vec<u8> {
    // DER integer: prepend 0x00 if high bit set to keep positive
    if !value.is_empty() && (value[0] & 0x80) != 0 {
        let mut padded = vec![0x00];
        padded.extend_from_slice(value);
        encode_tlv(0x02, &padded)
    } else {
        encode_tlv(0x02, value)
    }
}

fn encode_sequence(contents: &[u8]) -> Vec<u8> {
    encode_tlv(0x30, contents)
}

fn encode_set(contents: &[u8]) -> Vec<u8> {
    encode_tlv(0x31, contents)
}

// `encode_utc_time_now()` removed — signingTime attribute is no longer emitted
// per the comment on `sign_data`. Reintroduce only with a per-host time-source
// contract (js-sys::Date in V8, wasi:clocks in WASI, SystemTime native).

/// Build a CMS Attribute: SEQUENCE { OID, SET { value } }
fn build_attribute(oid: &const_oid::ObjectIdentifier, value_der: &[u8]) -> Vec<u8> {
    let oid_der = encode_oid(oid);
    let value_set = encode_set(value_der);
    let mut content = Vec::new();
    content.extend_from_slice(&oid_der);
    content.extend_from_slice(&value_set);
    encode_sequence(&content)
}

/// Encode sorted attributes as SET OF (tag 0x31) — used for signing.
fn encode_as_set(attrs: &[Vec<u8>]) -> Vec<u8> {
    let mut content = Vec::new();
    for attr in attrs {
        content.extend_from_slice(attr);
    }
    encode_set(&content)
}

/// Encode sorted attributes as IMPLICIT [0] (tag 0xA0) — used for storage in SignerInfo.
fn encode_as_implicit0(attrs: &[Vec<u8>]) -> Vec<u8> {
    let mut content = Vec::new();
    for attr in attrs {
        content.extend_from_slice(attr);
    }
    encode_tlv(0xA0, &content)
}

/// Build AlgorithmIdentifier SEQUENCE { OID } (no parameters for Ed25519)
fn build_algorithm_identifier(oid: &const_oid::ObjectIdentifier) -> Vec<u8> {
    encode_sequence(&encode_oid(oid))
}

/// Build AlgorithmIdentifier with NULL parameter: SEQUENCE { OID, NULL }
fn build_algorithm_identifier_with_null(oid: &const_oid::ObjectIdentifier) -> Vec<u8> {
    let mut content = encode_oid(oid);
    content.extend_from_slice(&[0x05, 0x00]); // NULL
    encode_sequence(&content)
}

/// Build SignerInfo (version 1)
fn build_signer_info(
    issuer_der: &[u8],
    serial_bytes: &[u8],
    signature: &[u8; 64],
    signed_attrs_implicit: Option<&[u8]>,
) -> Vec<u8> {
    let mut content = Vec::new();

    // version INTEGER 1
    content.extend_from_slice(&encode_integer(&[1]));

    // sid IssuerAndSerialNumber: SEQUENCE { issuer, serialNumber }
    let mut sid_content = Vec::new();
    sid_content.extend_from_slice(issuer_der); // already DER-encoded Name
    sid_content.extend_from_slice(&encode_integer(serial_bytes));
    content.extend_from_slice(&encode_sequence(&sid_content));

    // digestAlgorithm: SHA-512 with NULL param
    content.extend_from_slice(&build_algorithm_identifier_with_null(&oid::ID_SHA512));

    // signedAttrs [0] IMPLICIT (optional)
    if let Some(attrs) = signed_attrs_implicit {
        content.extend_from_slice(attrs);
    }

    // signatureAlgorithm: Ed25519 (no params)
    content.extend_from_slice(&build_algorithm_identifier(&oid::ID_ED25519));

    // signature OCTET STRING
    content.extend_from_slice(&encode_octet_string(signature));

    encode_sequence(&content)
}

/// Build SignedData (version 1)
fn build_signed_data(signer_info: &[u8], cert_der: &[u8]) -> Vec<u8> {
    let mut content = Vec::new();

    // version INTEGER 1
    content.extend_from_slice(&encode_integer(&[1]));

    // digestAlgorithms SET OF { SHA-512 }
    let sha512_alg = build_algorithm_identifier_with_null(&oid::ID_SHA512);
    content.extend_from_slice(&encode_set(&sha512_alg));

    // encapContentInfo: SEQUENCE { id-data } (detached — no eContent)
    content.extend_from_slice(&encode_sequence(&encode_oid(&oid::ID_DATA)));

    // certificates [0] IMPLICIT — wrap raw cert DER in context tag
    content.extend_from_slice(&encode_tlv(0xA0, cert_der));

    // signerInfos SET OF { signerInfo }
    content.extend_from_slice(&encode_set(signer_info));

    encode_sequence(&content)
}

/// Build outer ContentInfo: SEQUENCE { id-signedData, [0] EXPLICIT SignedData }
fn build_content_info(signed_data: &[u8]) -> Vec<u8> {
    let mut content = Vec::new();
    content.extend_from_slice(&encode_oid(&oid::ID_SIGNED_DATA));
    // [0] EXPLICIT wrapping — context-specific constructed tag
    content.extend_from_slice(&encode_tlv(0xA0, signed_data));
    encode_sequence(&content)
}

// ---------------------------------------------------------------------------
// DER parsing helpers (for verification)
// ---------------------------------------------------------------------------

/// Parse a DER TLV, returning (tag, content, rest).
fn parse_tlv(data: &[u8]) -> Result<(u8, &[u8], &[u8]), String> {
    if data.is_empty() {
        return Err("empty TLV".into());
    }
    let tag = data[0];
    if data.len() < 2 {
        return Err("truncated TLV".into());
    }
    let (len, header_size) = parse_der_length(&data[1..])?;
    let total_header = 1 + header_size;
    if data.len() < total_header + len {
        return Err(format!(
            "TLV truncated: need {} bytes, have {}",
            total_header + len,
            data.len()
        ));
    }
    let content = &data[total_header..total_header + len];
    let rest = &data[total_header + len..];
    Ok((tag, content, rest))
}

fn parse_der_length(data: &[u8]) -> Result<(usize, usize), String> {
    if data.is_empty() {
        return Err("empty length".into());
    }
    let first = data[0];
    if first < 0x80 {
        Ok((first as usize, 1))
    } else {
        let num_bytes = (first & 0x7F) as usize;
        if num_bytes == 0 || num_bytes > 3 || data.len() < 1 + num_bytes {
            return Err("invalid DER length".into());
        }
        let mut len = 0usize;
        for i in 0..num_bytes {
            len = (len << 8) | (data[1 + i] as usize);
        }
        Ok((len, 1 + num_bytes))
    }
}

/// Iterate TLV elements within a constructed TLV's content.
fn iter_tlv(mut data: &[u8]) -> Result<Vec<(u8, Vec<u8>)>, String> {
    let mut elements = Vec::new();
    while !data.is_empty() {
        let (tag, content, rest) = parse_tlv(data)?;
        elements.push((tag, content.to_vec()));
        data = rest;
    }
    Ok(elements)
}

/// Parse outer ContentInfo, return (contentType OID bytes, inner content).
fn parse_content_info(data: &[u8]) -> Result<(Vec<u8>, Vec<u8>), String> {
    let (tag, seq_content, _) = parse_tlv(data)?;
    if tag != 0x30 {
        return Err("ContentInfo: expected SEQUENCE".into());
    }
    let elements = iter_tlv(seq_content)?;
    if elements.len() < 2 {
        return Err("ContentInfo: expected OID + [0]".into());
    }
    let (oid_tag, oid_content) = &elements[0];
    if *oid_tag != 0x06 {
        return Err("ContentInfo: expected OID".into());
    }
    let (ctx_tag, ctx_content) = &elements[1];
    if *ctx_tag != 0xA0 {
        return Err("ContentInfo: expected [0] EXPLICIT".into());
    }
    Ok((oid_content.clone(), ctx_content.clone()))
}

struct ParsedSignedData {
    digest_algorithm_oids: Vec<Vec<u8>>,
    certificates: Vec<Vec<u8>>,
    signer_infos: Vec<ParsedSignerInfo>,
}

struct ParsedSignerInfo {
    issuer_der: Vec<u8>,
    serial_bytes: Vec<u8>,
    signature_algorithm_oid: Vec<u8>,
    signature: Vec<u8>,
    signed_attributes_raw: Option<Vec<u8>>,
    signed_attributes_parsed: Vec<(Vec<u8>, Vec<u8>)>, // (oid_bytes, value_set_content)
}

/// Parse SignedData from its DER content.
fn parse_signed_data(data: &[u8]) -> Result<ParsedSignedData, String> {
    let (tag, seq_content, _) = parse_tlv(data)?;
    if tag != 0x30 {
        return Err("SignedData: expected SEQUENCE".into());
    }

    let mut rest = seq_content;
    let mut digest_algorithm_oids = Vec::new();
    let mut certificates = Vec::new();
    let mut signer_infos = Vec::new();

    // version INTEGER
    let (_tag, _version, r) = parse_tlv(rest)?;
    rest = r;

    // digestAlgorithms SET OF AlgorithmIdentifier
    let (tag, da_content, r) = parse_tlv(rest)?;
    if tag != 0x31 {
        return Err("SignedData: expected SET for digestAlgorithms".into());
    }
    for (_, alg_content) in iter_tlv(da_content)? {
        // AlgorithmIdentifier is SEQUENCE { OID, ... }
        let alg_elements = iter_tlv(&alg_content)?;
        if let Some((0x06, oid_bytes)) = alg_elements.first() {
            digest_algorithm_oids.push(oid_bytes.clone());
        }
    }
    rest = r;

    // encapContentInfo SEQUENCE
    let (_tag, _eci, r) = parse_tlv(rest)?;
    rest = r;

    // certificates [0] IMPLICIT (optional) and signerInfos SET OF
    while !rest.is_empty() {
        let (tag, content, r) = parse_tlv(rest)?;
        match tag {
            0xA0 => {
                // certificates [0] IMPLICIT — content is one or more cert DER sequences
                let mut cert_data: &[u8] = content;
                while !cert_data.is_empty() {
                    let (ctag, ccontent, crest) = parse_tlv(cert_data)?;
                    if ctag == 0x30 {
                        // Re-encode the full certificate TLV
                        let cert_tlv = encode_tlv(ctag, ccontent);
                        certificates.push(cert_tlv);
                    }
                    cert_data = crest;
                }
            }
            0x31 => {
                // signerInfos SET OF
                for (_si_tag, si_content) in iter_tlv(content)? {
                    let si = parse_signer_info(&si_content)?;
                    signer_infos.push(si);
                }
            }
            _ => {} // skip unknown
        }
        rest = r;
    }

    Ok(ParsedSignedData {
        digest_algorithm_oids,
        certificates,
        signer_infos,
    })
}

/// Parse a single SignerInfo from its SEQUENCE content.
fn parse_signer_info(data: &[u8]) -> Result<ParsedSignerInfo, String> {
    let mut rest: &[u8] = data;

    // version INTEGER
    let (_tag, _version, r) = parse_tlv(rest)?;
    rest = r;

    // sid IssuerAndSerialNumber: SEQUENCE { issuer, serialNumber }
    let (tag, sid_content, r) = parse_tlv(rest)?;
    if tag != 0x30 {
        return Err("SignerInfo: expected SEQUENCE for sid".into());
    }
    let sid_elements = iter_tlv(sid_content)?;
    if sid_elements.len() < 2 {
        return Err("SignerInfo: sid needs issuer + serial".into());
    }
    let issuer_der = encode_tlv(sid_elements[0].0, &sid_elements[0].1);
    let serial_bytes = sid_elements[1].1.clone();
    rest = r;

    // digestAlgorithm AlgorithmIdentifier
    let (_tag, _da, r) = parse_tlv(rest)?;
    rest = r;

    // signedAttrs [0] IMPLICIT (optional)
    let mut signed_attributes_raw = None;
    let mut signed_attributes_parsed = Vec::new();
    if !rest.is_empty() {
        let (tag, _, _) = parse_tlv(rest)?;
        if tag == 0xA0 {
            // Capture raw bytes including tag+length for SET reconstruction
            let (_, content, r) = parse_tlv(rest)?;
            let raw_len = rest.len() - r.len();
            signed_attributes_raw = Some(rest[..raw_len].to_vec());

            // Parse individual attributes
            for (_attr_tag, attr_content) in iter_tlv(content)? {
                let attr_elements = iter_tlv(&attr_content)?;
                if attr_elements.len() >= 2 {
                    let oid_bytes = attr_elements[0].1.clone();
                    let value_content = attr_elements[1].1.clone();
                    signed_attributes_parsed.push((oid_bytes, value_content));
                }
            }
            rest = r;
        }
    }

    // signatureAlgorithm AlgorithmIdentifier
    let (_tag, sa_content, r) = parse_tlv(rest)?;
    let sa_elements = iter_tlv(sa_content)?;
    let signature_algorithm_oid = sa_elements
        .first()
        .map(|(_, b)| b.clone())
        .unwrap_or_default();
    rest = r;

    // signature OCTET STRING
    let (tag, sig_content, _) = parse_tlv(rest)?;
    if tag != 0x04 {
        return Err("SignerInfo: expected OCTET STRING for signature".into());
    }

    Ok(ParsedSignerInfo {
        issuer_der,
        serial_bytes,
        signature_algorithm_oid,
        signature: sig_content.to_vec(),
        signed_attributes_raw,
        signed_attributes_parsed,
    })
}

/// Convert IMPLICIT [0] (0xA0) encoded attributes to SET (0x31) for verification.
fn implicit0_to_set(raw: &[u8]) -> Vec<u8> {
    if raw.is_empty() || raw[0] != 0xA0 {
        return raw.to_vec();
    }
    let mut result = raw.to_vec();
    result[0] = 0x31; // Replace tag
    result
}

/// Reject MD5 (1.2.840.113549.2.5) and SHA-1 (1.3.14.3.2.26).
fn reject_weak_algorithm(oid_bytes: &[u8]) -> Result<(), VerifyError> {
    // MD5: 2a 86 48 86 f7 0d 02 05
    let md5_bytes = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x02, 0x05];
    // SHA-1: 2b 0e 03 02 1a
    let sha1_bytes = [0x2b, 0x0e, 0x03, 0x02, 0x1a];

    if oid_bytes == md5_bytes || oid_bytes == sha1_bytes {
        return Err(VerifyError::WeakAlgorithm);
    }
    Ok(())
}

/// Find a certificate whose issuer+serial matches the signer identifier.
fn find_signer_cert(certs: &[Vec<u8>], issuer_der: &[u8], serial_bytes: &[u8]) -> Option<Vec<u8>> {
    for cert_der in certs {
        if let Ok(cert) = cert::parse_cert(cert_der) {
            let (cert_issuer, cert_serial) = cert::signer_identifier(&cert).ok()?;
            if cert_issuer == issuer_der && cert_serial == serial_bytes {
                return Some(cert_der.clone());
            }
        }
    }
    None
}

/// Extract the messageDigest value from parsed signed attributes.
fn extract_message_digest_from_attrs(attrs: &[(Vec<u8>, Vec<u8>)]) -> Option<Vec<u8>> {
    let md_oid = oid_to_bytes(&oid::ID_MESSAGE_DIGEST);
    for (oid_bytes, value_content) in attrs {
        if *oid_bytes == md_oid {
            // value_content is the inner content of the SET { OCTET STRING }
            // Parse out the OCTET STRING
            if let Ok((0x04, octet_content, _)) = parse_tlv(value_content) {
                return Some(octet_content.to_vec());
            }
        }
    }
    None
}

/// Constant-time comparison to prevent timing attacks.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;
    use rand::rngs::OsRng;

    /// Generate a self-signed Ed25519 certificate for testing.
    pub(crate) fn generate_test_cert_and_key() -> (Vec<u8>, [u8; 64]) {
        let signing_key = SigningKey::generate(&mut OsRng);
        let cert_der = build_self_signed_cert(&signing_key);
        let keypair_bytes = signing_key.to_keypair_bytes();
        (cert_der, keypair_bytes)
    }

    /// Build a minimal self-signed X.509 certificate with Ed25519.
    pub(crate) fn build_self_signed_cert(signing_key: &SigningKey) -> Vec<u8> {
        let pubkey = signing_key.verifying_key().to_bytes();

        // tbsCertificate
        let mut tbs = Vec::new();

        // version [0] EXPLICIT INTEGER 2 (v3)
        tbs.extend_from_slice(&encode_tlv(0xA0, &encode_integer(&[2])));

        // serialNumber INTEGER
        tbs.extend_from_slice(&encode_integer(&[1]));

        // signature AlgorithmIdentifier (Ed25519)
        tbs.extend_from_slice(&build_algorithm_identifier(&oid::ID_ED25519));

        // issuer: CN=test
        let cn_oid = encode_oid(&const_oid::ObjectIdentifier::new_unwrap("2.5.4.3"));
        let cn_value = encode_tlv(0x0C, b"test"); // UTF8String
        let cn_attr = encode_sequence(&[cn_oid.as_slice(), cn_value.as_slice()].concat());
        let cn_rdn = encode_set(&cn_attr);
        let issuer = encode_sequence(&cn_rdn);
        tbs.extend_from_slice(&issuer);

        // validity: SEQUENCE { notBefore, notAfter }
        let not_before = encode_tlv(0x17, b"240101000000Z");
        let not_after = encode_tlv(0x17, b"340101000000Z");
        tbs.extend_from_slice(&encode_sequence(
            &[not_before.as_slice(), not_after.as_slice()].concat(),
        ));

        // subject: same as issuer
        tbs.extend_from_slice(&issuer);

        // subjectPublicKeyInfo
        let spki_alg = build_algorithm_identifier(&oid::ID_ED25519);
        let spki_key = encode_tlv(0x03, &[&[0x00], pubkey.as_slice()].concat()); // BIT STRING
        tbs.extend_from_slice(&encode_sequence(
            &[spki_alg.as_slice(), spki_key.as_slice()].concat(),
        ));

        let tbs_seq = encode_sequence(&tbs);

        // Sign TBS
        let tbs_sig = signing_key.sign(&tbs_seq);

        // Certificate: SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue }
        let sig_alg = build_algorithm_identifier(&oid::ID_ED25519);
        let sig_bits = encode_tlv(0x03, &[&[0x00], tbs_sig.to_bytes().as_slice()].concat());

        encode_sequence(&[tbs_seq.as_slice(), sig_alg.as_slice(), sig_bits.as_slice()].concat())
    }

    #[test]
    fn sign_and_verify_round_trip() {
        let (cert_der, key) = generate_test_cert_and_key();
        let data = b"hello, CMS world";

        let cms_sig = sign_data(data, &cert_der, &key).unwrap();
        assert!(!cms_sig.is_empty());

        let result = verify(&cms_sig, data, &VerifyOptions::default());
        assert!(result.is_ok(), "verify failed: {:?}", result.err());

        let signer_cert = result.unwrap();
        assert_eq!(signer_cert, cert_der);
    }

    #[test]
    fn sign_without_attributes_round_trip() {
        let (cert_der, key) = generate_test_cert_and_key();
        let data = b"PureEdDSA test data";

        let cms_sig = sign_data_without_attributes(data, &cert_der, &key).unwrap();
        assert!(!cms_sig.is_empty());

        let result = verify(&cms_sig, data, &VerifyOptions::default());
        assert!(result.is_ok(), "verify failed: {:?}", result.err());
    }

    #[test]
    fn tampered_data_rejected() {
        let (cert_der, key) = generate_test_cert_and_key();
        let data = b"original data";

        let cms_sig = sign_data(data, &cert_der, &key).unwrap();

        let result = verify(&cms_sig, b"tampered data", &VerifyOptions::default());
        assert!(result.is_err());
    }

    #[test]
    fn tampered_data_rejected_no_attrs() {
        let (cert_der, key) = generate_test_cert_and_key();
        let data = b"original data";

        let cms_sig = sign_data_without_attributes(data, &cert_der, &key).unwrap();

        let result = verify(&cms_sig, b"tampered data", &VerifyOptions::default());
        assert!(result.is_err());
    }

    #[test]
    fn key_cert_mismatch_rejected() {
        let (cert_der, _key) = generate_test_cert_and_key();
        let wrong_key = SigningKey::generate(&mut OsRng);
        let wrong_keypair = wrong_key.to_keypair_bytes();

        let result = sign_data(b"test", &cert_der, &wrong_keypair);
        assert!(matches!(result, Err(SignError::KeyMismatch)));
    }

    #[test]
    fn rfc8419_sha512_digest_algorithm() {
        let (cert_der, key) = generate_test_cert_and_key();
        let cms_sig = sign_data(b"test", &cert_der, &key).unwrap();

        // Parse and verify SHA-512 is in digestAlgorithms
        let (_oid, sd_bytes) = parse_content_info(&cms_sig).unwrap();
        let sd = parse_signed_data(&sd_bytes).unwrap();
        let sha512_oid = oid_to_bytes(&oid::ID_SHA512);
        assert!(
            sd.digest_algorithm_oids.contains(&sha512_oid),
            "digestAlgorithms should contain SHA-512"
        );
    }

    #[test]
    fn rfc8419_ed25519_signature_algorithm() {
        let (cert_der, key) = generate_test_cert_and_key();
        let cms_sig = sign_data(b"test", &cert_der, &key).unwrap();

        let (_oid, sd_bytes) = parse_content_info(&cms_sig).unwrap();
        let sd = parse_signed_data(&sd_bytes).unwrap();
        let ed25519_oid = oid_to_bytes(&oid::ID_ED25519);
        assert_eq!(
            sd.signer_infos[0].signature_algorithm_oid, ed25519_oid,
            "SignerInfo should use Ed25519"
        );
    }

    #[test]
    fn signed_attributes_dual_encoding() {
        let (cert_der, key) = generate_test_cert_and_key();
        let cms_sig = sign_data(b"test dual encoding", &cert_der, &key).unwrap();

        let (_oid, sd_bytes) = parse_content_info(&cms_sig).unwrap();
        let sd = parse_signed_data(&sd_bytes).unwrap();
        let si = &sd.signer_infos[0];

        // Signed attributes should be stored with IMPLICIT [0] tag (0xA0)
        let raw = si.signed_attributes_raw.as_ref().unwrap();
        assert_eq!(raw[0], 0xA0, "stored attributes should use IMPLICIT [0]");

        // Converting to SET should change tag to 0x31
        let set_form = implicit0_to_set(raw);
        assert_eq!(set_form[0], 0x31, "SET form should use tag 0x31");

        // Rest of bytes should be identical
        assert_eq!(raw[1..], set_form[1..]);
    }

    #[test]
    fn signed_attributes_omits_signing_time() {
        // Cloister ADR-0007 amendment 2026-05-08:
        // signingTime is intentionally omitted. SignedAttributes must contain
        // exactly contentType + messageDigest, with no signingTime attribute.
        let (cert_der, key) = generate_test_cert_and_key();
        let cms_sig = sign_data(b"omits-signing-time", &cert_der, &key).unwrap();

        let (_oid, sd_bytes) = parse_content_info(&cms_sig).unwrap();
        let sd = parse_signed_data(&sd_bytes).unwrap();
        let si = &sd.signer_infos[0];

        assert_eq!(
            si.signed_attributes_parsed.len(),
            2,
            "SignedAttributes must contain exactly 2 attributes (contentType, messageDigest)",
        );

        let signing_time_oid = oid_to_bytes(&oid::ID_SIGNING_TIME);
        let has_signing_time = si
            .signed_attributes_parsed
            .iter()
            .any(|(oid_bytes, _)| oid_bytes == &signing_time_oid);
        assert!(
            !has_signing_time,
            "signingTime attribute must not be present (see fn doc on sign_data)",
        );
    }

    #[test]
    fn empty_data_signs_and_verifies() {
        let (cert_der, key) = generate_test_cert_and_key();
        let data = b"";

        let cms_sig = sign_data(data, &cert_der, &key).unwrap();
        let result = verify(&cms_sig, data, &VerifyOptions::default());
        assert!(result.is_ok());
    }

    #[test]
    fn large_data_signs_and_verifies() {
        let (cert_der, key) = generate_test_cert_and_key();
        let data = vec![0xAB; 1_000_000]; // 1MB

        let cms_sig = sign_data(&data, &cert_der, &key).unwrap();
        let result = verify(&cms_sig, &data, &VerifyOptions::default());
        assert!(result.is_ok());
    }
}
