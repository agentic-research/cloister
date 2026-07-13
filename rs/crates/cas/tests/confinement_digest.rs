// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Conformance test for cloister's cloister/confinement/v1 §6 canonicalizer +
// confinementDigest, against LLO's pinned digest (confinement/v1 @ v0.7.3, bead
// ley-line-open-193170). Guards §8.2 cross-impl conformance in CI: cloister's
// substrate BLAKE3 of the §6-canonical bytes MUST equal LLO's blake3-crate pin.
//
// (The runnable CLI form is examples/confinement-digest.rs; this test is the
// gate.)

use cloister_cas::leyline_hash_bytes;

/// LLO confinement/v1 @ v0.7.3 CONFINEMENT_DIGESTS.blake3 pin for
/// `test-vectors/manifest-canonical.json`.
const LLO_0_7_3_PIN: &str = "d9b5b7270bb6e5ec068aec92798dd76b0f71d1fe2640b3a09833b7742d51c617";

/// §6 canonical serialization: sorted keys (serde_json's default BTreeMap Map),
/// 2-space indent (`to_string_pretty`), last byte `}` (trailing newline
/// stripped).
fn canonicalize(json: &str) -> Vec<u8> {
    let value: serde_json::Value = serde_json::from_str(json).expect("valid JSON");
    let pretty = serde_json::to_string_pretty(&value).expect("serialize");
    pretty.trim_end_matches('\n').as_bytes().to_vec()
}

fn confinement_digest(canonical: &[u8]) -> String {
    let mut out = [0u8; 32];
    // SAFETY: valid slice; 32-byte buffer = BLAKE3-256.
    let rc = unsafe {
        leyline_hash_bytes(canonical.as_ptr(), canonical.len(), out.as_mut_ptr(), out.len())
    };
    assert_eq!(rc, 32);
    out.iter().map(|b| format!("{b:02x}")).collect()
}

/// The confinement/v1 canonical example manifest (§1-5 shape). Kept inline so the
/// test is self-contained (cloister CI has no LLO checkout); it is content-
/// addressed — if LLO changes the vector, the pin changes and this fails loud.
const CANONICAL_MANIFEST: &str = r#"{
  "credentialSource": "keychain://bundle-X-credentials",
  "fs": {
    "allow": [
      "/etc/hosts",
      { "path": "/var/lib/bundle-X/", "mode": "rw" }
    ]
  },
  "network": { "allowHosts": ["*.telemetry.example.com", "api.example.com"] },
  "port": { "bind": 8443, "address": "127.0.0.1" },
  "version": "cloister/confinement/v1"
}"#;

#[test]
fn digest_matches_llo_v0_7_3_pin() {
    let digest = confinement_digest(&canonicalize(CANONICAL_MANIFEST));
    assert_eq!(
        digest, LLO_0_7_3_PIN,
        "cloister's confinementDigest diverged from LLO confinement/v1 @ v0.7.3"
    );
}

#[test]
fn canonicalization_is_order_and_whitespace_invariant() {
    // A deliberately non-canonical manifest (shuffled keys, ragged whitespace)
    // must reach the SAME digest — that is what §6 buys.
    let messy = r#"{  "version":"cloister/confinement/v1",
        "port":{"bind":8443,"address":"127.0.0.1"},
   "network":{"allowHosts":["*.telemetry.example.com","api.example.com"]},
 "credentialSource":"keychain://bundle-X-credentials",
     "fs":{"allow":["/etc/hosts",{"mode":"rw","path":"/var/lib/bundle-X/"}]}}"#;
    assert_eq!(
        confinement_digest(&canonicalize(messy)),
        LLO_0_7_3_PIN,
        "canonicalization must be key-order and whitespace invariant"
    );
}
