// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 cloister contributors
//
// Per-caller URL allow-list for the `/sign` endpoint.
//
// Closes the 2026-05-13 adversarial cycle's Cross-cut A:
//
//   POST /sign did not pin which URL a given caller could ask the helper
//   to sign with. A bearer-token holder (caller_name=router) could send
//   `{url: "op://attacker-vault/their-key/field", ...}` and the helper
//   would resolve the URL through nono and sign the caller's payload
//   under the attacker's key. The /resolve surface gates URL access via
//   `LEYLINE_SIGN_RESOLVE_ALLOW`; /sign had no analogue.
//
// This module supplies the analogue. `SignAllowList` is consulted in
// `host::server::post_sign` after authentication and before
// `keystore::resolve_bytes`. Default deny-all when `--require-sign-allow`
// is set; warn-and-allow otherwise (for local dev only).
//
// Env-var grammar (`LEYLINE_SIGN_SIGN_ALLOW`):
//
//   <caller>=<prefix>[,<prefix>...][;<caller>=<prefix>[,<prefix>...]]
//
// Example:
//
//   LEYLINE_SIGN_SIGN_ALLOW="router=keychain://com.cloister/master-sk;notme=keyring://com.cloister/notme/cloister"
//
// Wildcard caller `*` matches any authenticated caller. Use sparingly —
// the per-caller form is preferred in production.
//
// Findings closed by this module:
//
//   - trust-root-friend F2 (P0): /sign URL is not allow-listed
//   - isolation-friend F-iso-1 (P1): /sign doesn't consult resolve_allow

use std::collections::HashMap;

/// A parsed per-caller URL prefix allow-list.
#[derive(Clone, Debug, Default)]
pub struct SignAllowList {
    // `caller_name -> Vec<prefix>`. Wildcard caller `*` is stored under
    // its own key and consulted when no exact caller match exists.
    map: HashMap<String, Vec<String>>,
}

impl SignAllowList {
    pub fn empty() -> Self {
        Self { map: HashMap::new() }
    }

    /// True iff no caller has any allowed prefix. Used by the binary to
    /// decide whether `--require-sign-allow` should hard-fail at start.
    pub fn is_empty(&self) -> bool {
        self.map.values().all(|v| v.is_empty())
    }

    /// Count of distinct callers that have at least one prefix configured.
    pub fn caller_count(&self) -> usize {
        self.map.iter().filter(|(_, v)| !v.is_empty()).count()
    }

    /// Construct from `(caller, prefix)` pairs. Test helper.
    pub fn from_pairs<I, A, B>(pairs: I) -> Self
    where
        I: IntoIterator<Item = (A, B)>,
        A: Into<String>,
        B: Into<String>,
    {
        let mut map: HashMap<String, Vec<String>> = HashMap::new();
        for (caller, prefix) in pairs {
            map.entry(caller.into()).or_default().push(prefix.into());
        }
        Self { map }
    }

    /// Parse the env-var grammar described in the module preamble. Empty
    /// or whitespace-only input returns an empty allow-list (caller
    /// decides whether to require non-empty).
    pub fn parse(input: &str) -> Result<Self, &'static str> {
        let trimmed = input.trim();
        if trimmed.is_empty() {
            return Ok(Self::empty());
        }
        let mut map: HashMap<String, Vec<String>> = HashMap::new();
        for caller_entry in trimmed.split(';') {
            let entry = caller_entry.trim();
            if entry.is_empty() {
                continue;
            }
            let (caller, prefix_list) = entry
                .split_once('=')
                .ok_or("LEYLINE_SIGN_SIGN_ALLOW: entry missing '=' (want caller=prefix[,prefix...])")?;
            let caller = caller.trim().to_owned();
            if caller.is_empty() {
                return Err("LEYLINE_SIGN_SIGN_ALLOW: empty caller name");
            }
            let mut prefixes = Vec::new();
            for prefix in prefix_list.split(',') {
                let p = prefix.trim();
                if p.is_empty() {
                    continue;
                }
                prefixes.push(p.to_owned());
            }
            if prefixes.is_empty() {
                return Err("LEYLINE_SIGN_SIGN_ALLOW: caller has no prefixes");
            }
            map.entry(caller).or_default().extend(prefixes);
        }
        Ok(Self { map })
    }

    /// Is `caller` permitted to sign over `url`?
    ///
    /// Match rule:
    ///   1. If `caller` has an exact entry, any of its prefixes match → true.
    ///   2. Else if `*` exists, any of its prefixes match → true.
    ///   3. Else false (deny-by-default).
    ///
    /// Empty allow-list = deny-all.
    pub fn is_allowed(&self, caller: &str, url: &str) -> bool {
        if let Some(prefixes) = self.map.get(caller) {
            if prefixes.iter().any(|p| url.starts_with(p.as_str())) {
                return true;
            }
        }
        if let Some(prefixes) = self.map.get("*") {
            if prefixes.iter().any(|p| url.starts_with(p.as_str())) {
                return true;
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_denies_everything() {
        let a = SignAllowList::empty();
        assert!(!a.is_allowed("router", "keychain://anything"));
        assert!(!a.is_allowed("*", "keychain://anything"));
        assert!(a.is_empty());
    }

    #[test]
    fn exact_caller_match() {
        let a = SignAllowList::from_pairs([("router", "keychain://com.cloister/master-sk")]);
        assert!(a.is_allowed("router", "keychain://com.cloister/master-sk"));
        assert!(!a.is_allowed("notme", "keychain://com.cloister/master-sk"));
        assert!(!a.is_allowed("router", "keychain://other"));
    }

    #[test]
    fn wildcard_caller() {
        let a = SignAllowList::from_pairs([("*", "file:///etc/seed")]);
        assert!(a.is_allowed("anybody", "file:///etc/seed"));
        assert!(a.is_allowed("nobody", "file:///etc/seed"));
        assert!(!a.is_allowed("anybody", "keychain://x"));
    }

    #[test]
    fn caller_specific_overrides_not_wildcard_fallthrough() {
        // router has its own prefix; * has a different prefix. router
        // should still benefit from * when router's list doesn't match.
        let a = SignAllowList::from_pairs([
            ("router", "keychain://com.cloister/master-sk"),
            ("*", "file:///allowed/for/all"),
        ]);
        assert!(a.is_allowed("router", "keychain://com.cloister/master-sk"));
        assert!(a.is_allowed("router", "file:///allowed/for/all"));
        assert!(a.is_allowed("other-caller", "file:///allowed/for/all"));
        assert!(!a.is_allowed("router", "keychain://other"));
    }

    #[test]
    fn parse_single_pair() {
        let a = SignAllowList::parse("router=keychain://master-sk").unwrap();
        assert_eq!(a.caller_count(), 1);
        assert!(a.is_allowed("router", "keychain://master-sk"));
    }

    #[test]
    fn parse_multiple_callers() {
        let a = SignAllowList::parse(
            "router=keychain://master-sk;notme=keyring://notme/cloister",
        )
        .unwrap();
        assert_eq!(a.caller_count(), 2);
        assert!(a.is_allowed("router", "keychain://master-sk"));
        assert!(a.is_allowed("notme", "keyring://notme/cloister"));
        assert!(!a.is_allowed("router", "keyring://notme/cloister"));
    }

    #[test]
    fn parse_multiple_prefixes_per_caller() {
        let a = SignAllowList::parse("router=keychain://a,keychain://b").unwrap();
        assert!(a.is_allowed("router", "keychain://a-something"));
        assert!(a.is_allowed("router", "keychain://b-other"));
        assert!(!a.is_allowed("router", "keychain://c"));
    }

    #[test]
    fn parse_wildcard() {
        let a = SignAllowList::parse("*=file:///seed").unwrap();
        assert!(a.is_allowed("any", "file:///seed-1"));
    }

    #[test]
    fn parse_empty_input_is_empty_allowlist() {
        assert!(SignAllowList::parse("").unwrap().is_empty());
        assert!(SignAllowList::parse("   ").unwrap().is_empty());
    }

    #[test]
    fn parse_rejects_malformed() {
        assert!(SignAllowList::parse("noequals").is_err());
        assert!(SignAllowList::parse("=novalue").is_err());
        assert!(SignAllowList::parse("nokey=").is_err());
        assert!(SignAllowList::parse("router=a;noequals").is_err());
    }

    #[test]
    fn parse_skips_empty_segments() {
        // Operator might leave a trailing semicolon. Tolerate it.
        let a = SignAllowList::parse("router=a;;").unwrap();
        assert!(a.is_allowed("router", "a-prefix"));
    }
}
