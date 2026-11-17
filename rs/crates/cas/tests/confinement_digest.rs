// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Conformance test for cloister's cloister/confinement/v1 §7 canonicalizer +
// confinementDigest, against LLO's pinned digest (confinement/v1 @ v0.7.3, bead
// ley-line-open-193170). Guards §9.2 cross-impl conformance in CI: cloister's
// substrate BLAKE3 of the §7-canonical bytes MUST equal LLO's blake3-crate pin.
//
// (The runnable CLI form is examples/confinement-digest.rs; this test is the
// gate.)

use cloister_cas::leyline_hash_bytes;

/// LLO confinement/v1 @ v0.7.3 CONFINEMENT_DIGESTS.blake3 pin for
/// `test-vectors/manifest-canonical.json`.
/// The canonical-vector digest LLO publishes, UNMOVED since v0.7.3 and still
/// current at the pinned v0.17.0 — through the addition of §6 `unixSocket.allow`
/// and the §6→§7→§8→§9 renumbering underneath it.
///
/// That stability is the additive claim cloister depends on, and it holds for a
/// structural reason rather than by luck: absent fields are omitted from the
/// canonical bytes, so a dimension no manifest declares cannot move the digest.
/// LLO asserts it upstream by test rather than by argument.
///
/// Named for the digest rather than for a release, because it belongs to
/// neither: the old name (`LLO_CANONICAL_VECTOR_DIGEST`) read as "the v0.7.3 value" and would
/// have invited someone to go looking for a v0.17.0 replacement that does not
/// exist.
const LLO_CANONICAL_VECTOR_DIGEST: &str =
    "d9b5b7270bb6e5ec068aec92798dd76b0f71d1fe2640b3a09833b7742d51c617";

/// §7 canonical serialization via the shared library function: keys sorted
/// explicitly (independent of serde_json's `preserve_order`), 2-space indent,
/// trailing newline stripped.
fn canonicalize(json: &str) -> Vec<u8> {
    cloister_cas::canonical_confinement_json(json).expect("valid JSON")
}

fn confinement_digest(canonical: &[u8]) -> String {
    let mut out = [0u8; 32];
    // SAFETY: valid slice; 32-byte buffer = BLAKE3-256.
    let rc = unsafe {
        leyline_hash_bytes(
            canonical.as_ptr(),
            canonical.len(),
            out.as_mut_ptr(),
            out.len(),
        )
    };
    assert_eq!(rc, 32);
    out.iter().map(|b| format!("{b:02x}")).collect()
}

/// The confinement/v1 canonical example manifest (§1-6 shape). Kept inline so the
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
fn digest_matches_llos_published_canonical_vector() {
    let digest = confinement_digest(&canonicalize(CANONICAL_MANIFEST));
    assert_eq!(
        digest, LLO_CANONICAL_VECTOR_DIGEST,
        "cloister's confinementDigest diverged from LLO confinement/v1 @ v0.7.3"
    );
}

#[test]
fn canonicalization_is_order_and_whitespace_invariant() {
    // A deliberately non-canonical manifest (shuffled keys, ragged whitespace)
    // must reach the SAME digest — that is what §7 buys.
    let messy = r#"{  "version":"cloister/confinement/v1",
        "port":{"bind":8443,"address":"127.0.0.1"},
   "network":{"allowHosts":["*.telemetry.example.com","api.example.com"]},
 "credentialSource":"keychain://bundle-X-credentials",
     "fs":{"allow":["/etc/hosts",{"mode":"rw","path":"/var/lib/bundle-X/"}]}}"#;
    assert_eq!(
        confinement_digest(&canonicalize(messy)),
        LLO_CANONICAL_VECTOR_DIGEST,
        "canonicalization must be key-order and whitespace invariant"
    );
}

#[test]
fn canonicalization_sorts_nested_and_array_contained_objects() {
    // Descending key order at every depth, including objects inside arrays.
    let descending =
        r#"{"z":{"y":1,"b":{"q":[{"n":2,"m":1},{"d":4,"c":3}],"a":0}},"a":[{"k":2,"j":1}]}"#;
    let ascending =
        r#"{"a":[{"j":1,"k":2}],"z":{"b":{"a":0,"q":[{"m":1,"n":2},{"c":3,"d":4}]},"y":1}}"#;
    assert_eq!(canonicalize(descending), canonicalize(ascending));
}

#[test]
fn canonical_bytes_are_exactly_the_sorted_two_space_form() {
    // Exact bytes, not two inputs compared with each other: a canonicalizer
    // that sorted nothing would still agree with itself on sorted input.
    let canonical = canonicalize(r#"{"b":[{"d":1,"c":2}],"a":{"z":true,"y":"x"}}"#);
    let expected = r#"{
  "a": {
    "y": "x",
    "z": true
  },
  "b": [
    {
      "c": 2,
      "d": 1
    }
  ]
}"#;
    assert_eq!(String::from_utf8(canonical).unwrap(), expected);
}

#[test]
fn this_test_build_does_not_get_sorted_keys_for_free() {
    // Guards the dev-dependency in Cargo.toml: these tests only exercise the
    // explicit sort while serde_json keeps insertion order. If this fails, the
    // feature was dropped and the tests above pass with the sort deleted.
    let value: serde_json::Value = serde_json::from_str(r#"{"b":1,"a":2}"#).unwrap();
    let keys: Vec<&String> = value.as_object().unwrap().keys().collect();
    assert_eq!(
        keys,
        ["b", "a"],
        "serde_json's preserve_order is off in this test build"
    );
}
