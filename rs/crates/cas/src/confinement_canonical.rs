// SPDX-License-Identifier: AGPL-3.0-or-later
//
// §7 canonical serialization for cloister/confinement/v1 manifests
// (cloister-d95ff5). One implementation, shared by the conformance test and
// both examples, so the digest cannot depend on which copy ran.

use serde_json::{Map, Value};

/// Rebuild every object with its keys in ascending byte order. Arrays keep
/// their order. Sorting is explicit so the result does not depend on whether
/// serde_json's `preserve_order` feature is on (another crate in a
/// workspace-wide build can turn it on, and then `Map` keeps insertion order).
fn sort_keys(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut entries: Vec<(String, Value)> = map.into_iter().collect();
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            Value::Object(
                entries
                    .into_iter()
                    .map(|(k, v)| (k, sort_keys(v)))
                    .collect::<Map<String, Value>>(),
            )
        }
        Value::Array(items) => Value::Array(items.into_iter().map(sort_keys).collect()),
        other => other,
    }
}

/// §7 canonical bytes: keys sorted ascending at every depth, 2-space indent
/// (`to_string_pretty`), trailing newline stripped so the last byte is `}`.
pub fn canonical_confinement_json(json: &str) -> Result<Vec<u8>, serde_json::Error> {
    let value: Value = serde_json::from_str(json)?;
    let pretty = serde_json::to_string_pretty(&sort_keys(value))?;
    Ok(pretty.trim_end_matches('\n').as_bytes().to_vec())
}
