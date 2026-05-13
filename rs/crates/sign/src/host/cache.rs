// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 cloister contributors
//
// Parsed-key cache for the sign helper (ADR-0019 §"Keystore-byte caching
// policy").
//
// Policy:
//   - cache key  = URL spec string
//   - cache value= (byte_hash = SHA-256(keystore bytes), parsed SigningKey)
//   - we re-read keystore bytes on every /sign call (per-call trust boundary
//     — ops invariant from math-friend #2)
//   - if SHA-256(re-read) == byte_hash → reuse parsed SigningKey
//   - else → drop entry, re-parse from fresh bytes
//
// The cache is shared across concurrent requests via tokio::sync::Mutex
// (low contention — only held while inserting/dropping entries; the
// parsed SigningKey is cloned out for the actual sign call).

use std::collections::HashMap;
use std::sync::Arc;

use ed25519_dalek::SigningKey;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

/// SHA-256(keystore bytes) — used as cache identity.
pub type ByteHash = [u8; 32];

#[derive(Clone)]
struct Entry {
    byte_hash: ByteHash,
    signing_key: Arc<SigningKey>,
}

/// The cache. Implements ADR-0019 §"Keystore-byte caching policy".
#[derive(Clone, Default)]
pub struct KeyCache {
    inner: Arc<Mutex<HashMap<String, Entry>>>,
}

impl KeyCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Look up or insert a SigningKey for `spec` given freshly-read
    /// `keystore_bytes`. Returns the SigningKey to sign with.
    ///
    /// Behavior:
    ///   - if no cache entry: parse, store, return
    ///   - if cache entry hash matches: reuse parsed key (zero-parse path)
    ///   - if cache entry hash mismatches: drop, re-parse, store, return
    ///
    /// Per ADR-0019 normative req. 9 ("new kid in response on rotation —
    /// no operator action required") — caller observes a new `kid` whenever
    /// this function re-parses.
    pub async fn get_or_load<F, E>(
        &self,
        spec: &str,
        keystore_bytes: &[u8],
        parse: F,
    ) -> Result<Arc<SigningKey>, E>
    where
        F: FnOnce(&[u8]) -> Result<SigningKey, E>,
    {
        let hash = hash_bytes(keystore_bytes);
        let mut map = self.inner.lock().await;
        if let Some(entry) = map.get(spec)
            && entry.byte_hash == hash
        {
            return Ok(entry.signing_key.clone());
        }
        // Either no entry or hash mismatch — re-parse.
        let sk = parse(keystore_bytes)?;
        let sk = Arc::new(sk);
        map.insert(spec.to_string(), Entry { byte_hash: hash, signing_key: sk.clone() });
        Ok(sk)
    }

    /// Count of entries — for test assertions only.
    #[cfg(test)]
    pub async fn len(&self) -> usize {
        self.inner.lock().await.len()
    }
}

pub fn hash_bytes(b: &[u8]) -> ByteHash {
    let mut h = Sha256::new();
    h.update(b);
    let out = h.finalize();
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&out);
    arr
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;

    fn parse_ok(b: &[u8]) -> Result<SigningKey, ()> {
        let arr: [u8; 32] = b.try_into().unwrap();
        Ok(SigningKey::from_bytes(&arr))
    }

    #[tokio::test]
    async fn cache_hit_reuses_signing_key() {
        let c = KeyCache::new();
        let bytes = [7u8; 32];
        let a = c.get_or_load("u", &bytes, parse_ok).await.unwrap();
        let b = c.get_or_load("u", &bytes, parse_ok).await.unwrap();
        // Same Arc pointer — proves we reused, not re-parsed.
        assert!(Arc::ptr_eq(&a, &b));
    }

    #[tokio::test]
    async fn cache_invalidates_on_byte_change() {
        let c = KeyCache::new();
        let bytes_a = [7u8; 32];
        let bytes_b = [9u8; 32];
        let a = c.get_or_load("u", &bytes_a, parse_ok).await.unwrap();
        let b = c.get_or_load("u", &bytes_b, parse_ok).await.unwrap();
        // Different Arc — proves we dropped + re-parsed.
        assert!(!Arc::ptr_eq(&a, &b));
        assert_eq!(c.len().await, 1);
    }

    #[tokio::test]
    async fn distinct_specs_distinct_entries() {
        let c = KeyCache::new();
        let b = [3u8; 32];
        let _ = c.get_or_load("u1", &b, parse_ok).await.unwrap();
        let _ = c.get_or_load("u2", &b, parse_ok).await.unwrap();
        assert_eq!(c.len().await, 2);
    }
}
