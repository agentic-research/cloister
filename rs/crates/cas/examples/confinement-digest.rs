// SPDX-License-Identifier: AGPL-3.0-or-later
//
// confinement-digest — compute the `confinementDigest` (BLAKE3-256 of the §7
// CANONICAL ConfinementManifest bytes, per cloister/confinement/v1 §7/§8) using
// cloister's OWN substrate hash: the leyline-cas-ffi `leyline_hash_bytes`
// re-export (proven == blake3::hash by cloister-cas's
// `hash_via_re_export_matches_blake3` test). This is the value the identity
// claim commits to (§8) and cloister's half of the §9.2 cross-impl conformance.
//
// Pinned reference (LLO confinement/v1 @ v0.7.3, SHA 2491ccdffd61…): the
// canonical manifest `test-vectors/manifest-canonical.json` digests to
// PIN_0_7_3 below (LLO's CONFINEMENT_DIGESTS.blake3). This example CANONICALIZES
// its input first, so any equivalent manifest (keys shuffled, whitespace
// varied) reaches the same digest — that's what §7 buys.
//
// Run: cargo run -q -p cloister-cas --example confinement-digest -- <manifest.json>

use cloister_cas::leyline_hash_bytes;

/// The identity-committed digest of the canonical example manifest, pinned by
/// LLO confinement/v1 @ v0.7.3 (CONFINEMENT_DIGESTS.blake3, bead ley-line-open-193170).
const PIN_0_7_3: &str = "d9b5b7270bb6e5ec068aec92798dd76b0f71d1fe2640b3a09833b7742d51c617";

/// §7 canonical serialization: parse → `serde_json::Value` (default Map is a
/// sorted `BTreeMap`, giving §7 item-2 ASCII-sorted keys at every level) →
/// `to_string_pretty` (2-space indent, §7 item 3) → strip the trailing newline so
/// the last byte is `}` (§7 item 3). Null-field omission (§7 item 4) is inherent: input
/// manifests don't carry explicit nulls.
fn canonicalize(json: &str) -> Vec<u8> {
    let value: serde_json::Value = serde_json::from_str(json).expect("input is not valid JSON");
    let pretty = serde_json::to_string_pretty(&value).expect("serialize");
    pretty.trim_end_matches('\n').as_bytes().to_vec()
}

/// BLAKE3-256 of the given bytes via the substrate FFI, as lowercase hex.
fn confinement_digest(canonical: &[u8]) -> String {
    let mut out = [0u8; 32];
    // SAFETY: valid input slice; 32-byte output buffer matches BLAKE3-256.
    let rc = unsafe {
        leyline_hash_bytes(canonical.as_ptr(), canonical.len(), out.as_mut_ptr(), out.len())
    };
    assert_eq!(rc, 32, "leyline_hash_bytes returned {rc}, expected 32");
    out.iter().map(|b| format!("{b:02x}")).collect()
}

fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("usage: confinement-digest <manifest.json>");
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));

    let canonical = canonicalize(&raw);
    let digest = confinement_digest(&canonical);
    let matches = digest == PIN_0_7_3;

    eprintln!("canonical bytes ({}):", canonical.len());
    eprintln!("{}", String::from_utf8_lossy(&canonical));
    println!("confinementDigest (BLAKE3-256): {digest}");
    println!(
        "vs LLO confinement/v1 @ v0.7.3 pin: {}",
        if matches { "MATCH ✓" } else { "MISMATCH ✗" }
    );
    if !matches {
        std::process::exit(1);
    }
}
