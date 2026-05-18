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
// # Env-var grammar (`LEYLINE_SIGN_SIGN_ALLOW`)
//
// ```text
//   ALLOW_LIST    := CALLER_ENTRY (";" CALLER_ENTRY)*
//   CALLER_ENTRY  := CALLER_NAME "=" PREFIX_LIST
//   PREFIX_LIST   := PREFIX ("," PREFIX)*
//   CALLER_NAME   := <bearer-token caller name, or "*" for wildcard>
//   PREFIX        := <URL prefix; matches via String::starts_with>
// ```
//
// **`;` separates callers. `,` chains prefixes within one caller. The
// two are NOT interchangeable.**
//
// ## Worked examples
//
// Single caller, single prefix:
// ```text
//   LEYLINE_SIGN_SIGN_ALLOW="router=keychain://com.cloister/master-sk"
// ```
// `router` may sign over `keychain://com.cloister/master-sk` and any URL
// starting with that prefix. No other caller is permitted any URL.
//
// Single caller, multiple prefixes (commas):
// ```text
//   LEYLINE_SIGN_SIGN_ALLOW="router=keychain://com.cloister/master-sk,keychain://com.cloister/backup-sk"
// ```
// `router` may sign over either of the two prefixes.
//
// Multiple callers, each with their own prefix (semicolons):
// ```text
//   LEYLINE_SIGN_SIGN_ALLOW="router=keychain://com.cloister/master-sk;notme=keyring://com.cloister/notme/cloister"
// ```
// `router` is pinned to the master-sk; `notme` is pinned to its own
// keyring entry. Neither caller can sign over the other's URL.
//
// Multiple callers AND multiple prefixes per caller:
// ```text
//   LEYLINE_SIGN_SIGN_ALLOW="router=keychain://a,keychain://b;notme=file:///etc/notme-seed"
// ```
//
// Wildcard caller `*` (use sparingly — preferred only for local-dev
// where there's effectively one caller):
// ```text
//   LEYLINE_SIGN_SIGN_ALLOW="*=file:///tmp/dev-seed"
// ```
// Any authenticated caller may sign over `file:///tmp/dev-seed`.
//
// ## Common pitfalls
//
// **Wrong:** `LEYLINE_SIGN_SIGN_ALLOW="router=A,router=B"` — the parser
// treats this as caller=`router`, prefixes=[`A`, `router=B`]. The `,` is
// the *prefix* separator within one caller; you don't repeat the caller.
//
// **Right:** `LEYLINE_SIGN_SIGN_ALLOW="router=A,B"` (commas chain
// prefixes) or `LEYLINE_SIGN_SIGN_ALLOW="router=A;router=B"`
// (semicolons re-open the caller and merge — works but is misleading;
// use the comma form).
//
// **Wrong:** `LEYLINE_SIGN_SIGN_ALLOW="router=A B"` — spaces inside
// prefixes are not interpreted (they remain part of the prefix string).
//
// # Findings closed by this module
//
//   - trust-root-friend F2 (P0): /sign URL is not allow-listed
//   - isolation-friend F-iso-1 (P1): /sign doesn't consult resolve_allow
//   - trust-root-friend NEW-2 (P2, cloister-9bee1f): /resolve allow-list
//     entries that could match a signing-key URL are rejected at startup
//     (see `validate_resolve_allow_prefixes` below the SignAllowList impl).

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

// ── /resolve allow-list startup validation (cloister-9bee1f) ─────────────
//
// `LEYLINE_SIGN_RESOLVE_ALLOW` entries are matched via String::starts_with
// (see `host::server::get_resolve`). An operator who sets a too-broad
// prefix — say `keychain://com.cloister/vault-kek-` — silently authorizes
// `/resolve` to emit the bytes of any item starting with that prefix.
// If a signing-key URL happens to share the prefix (`vault-kek-master-sk`
// is a plausible-but-wrong name), the helper exfils the signing key
// without ever consulting `SignAllowList`.
//
// The 2026-05-12 trust-root-friend cycle filed NEW-2 against this. The
// initial mitigation was supervisor-template doc warnings; this
// validator is the code-side enforcement (deferred follow-up).
//
// Match rule: a prefix is rejected if any of `DANGEROUS_SUBSTRINGS`
// appears in it (case-insensitive ASCII). The list deliberately errs
// toward false-positive rejection — an operator who legitimately needs
// a prefix like `keychain://com.cloister/rocketmaster` can rename the
// keystore item; the cost of a too-permissive false-negative is
// signing-key exfil.

/// Substrings that signal "this prefix could match a signing-key URL".
/// Matched case-insensitively against each `LEYLINE_SIGN_RESOLVE_ALLOW`
/// entry. Order is preserved so error messages cite the first hit
/// deterministically.
const DANGEROUS_SUBSTRINGS: &[&str] = &[
    "master-sk",
    "master_sk",
    "signing-key",
    "signing_key",
    "-sk",
    "_sk",
    "signing",
    "master",
];

/// One offending prefix paired with the substring that triggered the
/// rejection. Returned in a `Vec` so the helper can log every problem
/// at once rather than making the operator fix one, restart, fix the
/// next, restart, etc.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolveAllowViolation {
    pub prefix: String,
    pub matched: &'static str,
}

impl std::fmt::Display for ResolveAllowViolation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "LEYLINE_SIGN_RESOLVE_ALLOW entry {:?} contains signing-key substring {:?} — \
             /resolve must not be authorized to emit signing-key bytes (cloister-9bee1f). \
             Rename the keystore item OR scope the prefix more narrowly.",
            self.prefix, self.matched,
        )
    }
}

/// Validate the parsed `LEYLINE_SIGN_RESOLVE_ALLOW` entries against the
/// signing-key substring blocklist. Returns Ok if every prefix is safe,
/// or a non-empty `Vec` of violations otherwise.
///
/// Empty input is Ok (deny-all is already safe).
pub fn validate_resolve_allow_prefixes(entries: &[String]) -> Result<(), Vec<ResolveAllowViolation>> {
    let mut violations = Vec::new();
    for entry in entries {
        let lower = entry.to_ascii_lowercase();
        for needle in DANGEROUS_SUBSTRINGS {
            if lower.contains(needle) {
                violations.push(ResolveAllowViolation {
                    prefix: entry.clone(),
                    matched: needle,
                });
                break; // one match per entry; first hit wins
            }
        }
    }
    if violations.is_empty() { Ok(()) } else { Err(violations) }
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

    // ── validate_resolve_allow_prefixes (cloister-9bee1f) ────────────────

    fn v(prefixes: &[&str]) -> Vec<String> {
        prefixes.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn resolve_allow_empty_input_is_safe() {
        assert!(validate_resolve_allow_prefixes(&[]).is_ok());
    }

    #[test]
    fn resolve_allow_safe_vault_kek_prefix_passes() {
        // The textbook deploy: vault-KEK family with no signing-key tokens.
        assert!(
            validate_resolve_allow_prefixes(&v(&[
                "keychain://com.cloister/vault-kek-",
                "file:///etc/cloister/vault-kek",
            ]))
            .is_ok()
        );
    }

    #[test]
    fn resolve_allow_rejects_master_sk_compound() {
        let err = validate_resolve_allow_prefixes(&v(&[
            "keychain://com.cloister/vault-kek-master-sk",
        ]))
        .unwrap_err();
        assert_eq!(err.len(), 1);
        assert_eq!(err[0].matched, "master-sk");
    }

    #[test]
    fn resolve_allow_rejects_bare_master() {
        let err = validate_resolve_allow_prefixes(&v(&["keychain://com.cloister/master-"]))
            .unwrap_err();
        assert_eq!(err[0].matched, "master");
    }

    #[test]
    fn resolve_allow_rejects_signing_token() {
        let err = validate_resolve_allow_prefixes(&v(&["keychain://com.cloister/signing-"]))
            .unwrap_err();
        // "signing-key" doesn't match the bare "signing-" but "signing" does.
        assert_eq!(err[0].matched, "signing");
    }

    #[test]
    fn resolve_allow_rejects_dash_sk_suffix() {
        let err = validate_resolve_allow_prefixes(&v(&["keychain://com.cloister/router-sk"]))
            .unwrap_err();
        assert_eq!(err[0].matched, "-sk");
    }

    #[test]
    fn resolve_allow_rejects_underscore_sk_suffix() {
        let err = validate_resolve_allow_prefixes(&v(&["keychain://com.cloister/router_sk"]))
            .unwrap_err();
        assert_eq!(err[0].matched, "_sk");
    }

    #[test]
    fn resolve_allow_is_case_insensitive() {
        let err = validate_resolve_allow_prefixes(&v(&[
            "KEYCHAIN://COM.CLOISTER/MASTER-SK",
        ]))
        .unwrap_err();
        assert_eq!(err[0].matched, "master-sk");
    }

    #[test]
    fn resolve_allow_collects_all_violations_not_just_first() {
        // Operator gets one clean error report, not one-fix-restart-repeat.
        let err = validate_resolve_allow_prefixes(&v(&[
            "keychain://com.cloister/vault-kek-",            // safe
            "keychain://com.cloister/master-sk",             // rejected
            "keychain://com.cloister/backup-signing-key",    // rejected
            "keychain://com.cloister/ok-bundle-kek",         // safe
        ]))
        .unwrap_err();
        assert_eq!(err.len(), 2);
        assert!(err.iter().any(|v| v.prefix.contains("master-sk")));
        assert!(err.iter().any(|v| v.prefix.contains("signing-key")));
    }

    #[test]
    fn resolve_allow_violation_display_names_the_substring_and_the_prefix() {
        let err = validate_resolve_allow_prefixes(&v(&[
            "keychain://com.cloister/vault-kek-master-sk",
        ]))
        .unwrap_err();
        let s = format!("{}", err[0]);
        assert!(s.contains("master-sk"));
        assert!(s.contains("vault-kek-master-sk"));
        assert!(s.contains("cloister-9bee1f"));
    }

    #[test]
    fn resolve_allow_first_substring_wins_per_entry() {
        // "master-sk" is listed before "-sk" in DANGEROUS_SUBSTRINGS, so
        // an entry containing both reports "master-sk" — a more specific
        // diagnosis is more useful to the operator than the generic
        // "-sk" alone.
        let err = validate_resolve_allow_prefixes(&v(&[
            "keychain://com.cloister/master-sk-mirror",
        ]))
        .unwrap_err();
        assert_eq!(err.len(), 1);
        assert_eq!(err[0].matched, "master-sk");
    }
}
