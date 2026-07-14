// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 cloister contributors
//
// cloister-harness — apply kernel confinement from a DECLARED, default-deny
// capability manifest, then exec the harness. This is the "actual binary" that
// replaces the hand-assembled `nono run -a … --block-net --open-port … -- claude`
// CLI flags that used to live in scripts/harness-dev.mjs.
//
// Design commitments (each maps to a user requirement):
//   - DON'T REINVENT: the filesystem/network capability format IS nono's own
//     `CapabilityManifest` (JSON-Schema-generated, the same type the CLI compiles
//     profiles down to). We embed it verbatim and let nono's
//     `CapabilitySet::try_from` do the derive. cloister only adds the launch
//     concerns nono's manifest does not model: which binary to exec, the env to
//     set/strip, and an optional keystore-resolved credential.
//   - DEFAULT DENY, FAIL CLOSED: a fresh `CapabilitySet` defaults network to
//     `AllowAll` and nono's manifest makes the network section optional — so a
//     missing/loose network stanza would silently grant the whole internet and
//     let the harness bypass the vault proxy. We REFUSE to apply unless the
//     manifest explicitly declares `network.mode = Blocked | Proxy`. Deny is the
//     default by refusal, checked at the enforcement point.
//   - UNISON: the manifest is the kernel-plane half of one declaration; the
//     cloister plane (vault slice, the single localhost egress = the vault-proxy
//     seam, lease scope) is the other half. S1b derives this manifest from the
//     capnp bundle via the schema-bridge IR so both halves share one source.
//
// Credentials are cloister's vault-proxy job (do NOT use nono's own credential
// proxy — no double-proxy). The optional keystore field exists only to resolve a
// secret that would otherwise live in the macOS Keychain (audit mode) BEFORE the
// sandbox seals Keychain access off, and hand it to the harness narrowly.
//
// Usage: cloister-harness <policy.json>

use std::collections::BTreeMap;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;

use anyhow::{bail, Context, Result};
use nono::manifest::{CapabilityManifest, NetworkMode};
use nono::capability::CapabilitySet;
use nono::Sandbox;
use serde::Deserialize;

/// The launch policy: nono's capability manifest (not reinvented) plus the
/// cloister-side launch concerns nono's manifest does not model.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct HarnessPolicy {
    /// nono's own capability manifest — filesystem grants + network mode + ports.
    /// This is the declared, default-deny capability contract; we consume it as-is.
    capabilities: CapabilityManifest,
    /// Env vars to SET in the confined harness (e.g. ANTHROPIC_BASE_URL → the
    /// vault-proxy seam).
    #[serde(default)]
    env_set: BTreeMap<String, String>,
    /// Env vars to STRIP before exec — credentials must never enter the confined
    /// harness's environment (cloister injects them at the proxy).
    #[serde(default)]
    env_strip: Vec<String>,
    /// Optional: resolve a secret from a nono keystore URI (`keychain://`,
    /// `op://`, `apple-password://`, `env://`, `file://`) BEFORE confining — the
    /// keystore is reachable here, deliberately not after `Sandbox::apply` — and
    /// inject it under `dest_env`. Solves the audit-mode Keychain credential
    /// without granting the confined harness blanket Keychain access.
    #[serde(default)]
    credential: Option<Credential>,
    /// Optional §7 confinement commitment (cloister-c80953). When present, the
    /// runner verifies — BEFORE the irreversible `Sandbox::apply` — that the
    /// confinement it is about to enforce matches the digest committed in the
    /// workload's Interlace identity cert, and fail-closes on drift. Absent means
    /// there is no commitment to check: deployment-binding granularity, like the
    /// lease gate's `INTERLACE_ROOT_PUBKEY` switch — NOT a per-request bypass.
    #[serde(default)]
    confinement: Option<ConfinementCommitment>,
    /// The harness binary to exec, confined.
    harness_bin: PathBuf,
    /// Args to pass to the harness.
    #[serde(default)]
    harness_args: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Credential {
    service: String,
    uri: String,
    dest_env: String,
}

/// The §7 confinement commitment: the confinement/v1 manifest this workload is
/// bound to, plus the Interlace identity cert that commits its digest and the CA
/// master pubkey that anchors the chain. The runner recomputes the manifest's
/// digest and checks it against the cert-committed one — the manifest and the
/// cert arrive from independent plumbing, and the digest is only trusted because
/// the chain verifies, so this is a genuine (non-circular) attestation.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ConfinementCommitment {
    /// The confinement/v1 ConfinementManifest, verbatim. Canonicalized (§6) and
    /// BLAKE3-hashed here; the result must equal the cert-committed digest.
    manifest: serde_json::Value,
    /// The workload's Interlace identity cert (DER), base64url no-pad — the
    /// encoding `mint-dev-cert` emits as `certDerB64Url`.
    cert_der_b64url: String,
    /// The CA master pubkey (Ed25519, 32 bytes), base64 standard — the chain
    /// verification anchor; `mint-dev-cert`'s `masterPubB64Std`.
    master_pub_b64std: String,
}

/// Verify the §7 confinement commitment, fail-closed. Authenticates the identity
/// cert against the master pubkey, extracts the committed `confinementDigest`, and
/// checks it byte-for-byte against the BLAKE3-256 of the §6-canonical manifest the
/// runner is about to enforce. Any failure — bad encoding, invalid cert chain, no
/// committed digest, or a digest mismatch — is an error; the caller bails before
/// `Sandbox::apply`.
fn verify_confinement_commitment(c: &ConfinementCommitment) -> Result<()> {
    use base64::Engine;

    let cert_der = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(c.cert_der_b64url.trim())
        .context("decoding confinement.cert_der_b64url (base64url)")?;
    let master_pub = base64::engine::general_purpose::STANDARD
        .decode(c.master_pub_b64std.trim())
        .context("decoding confinement.master_pub_b64std (base64 standard)")?;

    // Authenticate the identity cert against the CA master — the trust anchor. A
    // digest trusted without a verified cert would be circular; the committed
    // digest is load-bearing only because this chain verifies.
    let claims = leyline_sign::cert_chain::verify_cert_chain(&cert_der, &master_pub)
        .map_err(|e| anyhow::anyhow!("confinement cert chain verify failed: {e:?}"))?;

    let committed = claims.confinement_digest.ok_or_else(|| {
        anyhow::anyhow!(
            "confinement commitment present but the identity cert commits no confinementDigest \
             (Interlace extension OID .1.7 absent) — refusing to confine against an unbound manifest"
        )
    })?;

    let computed = confinement_digest(&c.manifest);
    if computed != committed {
        bail!(
            "confinement drift: the manifest to be enforced digests to {} but the identity cert \
             commits {} — refusing to apply an un-attested confinement",
            hex(&computed),
            hex(&committed),
        );
    }
    Ok(())
}

/// BLAKE3-256 of the §6-canonical bytes of a confinement/v1 manifest. §6: object
/// keys ASCII-sorted at every level, 2-space indent, no trailing newline (last
/// byte `}`). Byte-identical to `mint-dev-cert`'s digest and the TS/`confinement-
/// digest.rs` reference impls, so the runner and the minter agree.
fn confinement_digest(manifest: &serde_json::Value) -> [u8; 32] {
    // Sort keys explicitly (don't lean on serde_json's map-ordering feature, which
    // cross-crate feature unification could flip to insertion-order) so §6.2 holds
    // regardless of the resolved `serde_json` features in this binary's graph.
    let sorted = sort_keys_deep(manifest);
    let pretty = serde_json::to_string_pretty(&sorted).expect("serialize confinement manifest");
    let canonical = pretty.trim_end_matches('\n');
    *blake3::hash(canonical.as_bytes()).as_bytes()
}

/// Recursively rebuild a JSON value with ASCII-sorted object keys (§6.2). Array
/// order is significant and preserved; scalars pass through.
fn sort_keys_deep(value: &serde_json::Value) -> serde_json::Value {
    use serde_json::Value;
    match value {
        Value::Object(map) => {
            let sorted: serde_json::Map<String, Value> = map
                .iter()
                .map(|(k, v)| (k.clone(), sort_keys_deep(v)))
                .collect::<std::collections::BTreeMap<_, _>>()
                .into_iter()
                .collect();
            Value::Object(sorted)
        }
        Value::Array(arr) => Value::Array(arr.iter().map(sort_keys_deep).collect()),
        other => other.clone(),
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn main() -> Result<()> {
    let policy_path = std::env::args()
        .nth(1)
        .context("usage: cloister-harness <policy.json>")?;
    let policy: HarnessPolicy = serde_json::from_str(
        &std::fs::read_to_string(&policy_path)
            .with_context(|| format!("reading policy {policy_path}"))?,
    )
    .with_context(|| format!("parsing policy {policy_path}"))?;

    if !Sandbox::is_supported() {
        bail!("nono sandbox unsupported on this platform");
    }

    // nono's own semantic validation of the manifest.
    policy
        .capabilities
        .validate()
        .context("capability manifest failed nono validation")?;

    // DEFAULT-DENY, FAIL CLOSED. `CapabilitySet` defaults network to AllowAll and
    // the manifest's network section is optional — so we refuse to confine unless
    // the manifest explicitly declares a deny-by-default network mode. Without
    // this, an omitted/loose network stanza would let the harness reach the whole
    // internet and bypass the vault proxy.
    match policy.capabilities.network.as_ref().map(|n| &n.mode) {
        Some(NetworkMode::Blocked) | Some(NetworkMode::Proxy) => {}
        other => bail!(
            "default-deny violated: capabilities.network.mode must be \"blocked\" or \"proxy\" \
             (the harness's only egress is the vault-proxy seam); got {other:?}"
        ),
    }

    // §7 identity-digest verify (cloister-c80953). BEFORE we confine, prove the
    // manifest we are about to enforce is the one the workload's Interlace
    // identity commits to. Fail-closed — drift here means the confinement was
    // tampered relative to the signed commitment, so we refuse to apply it. No-op
    // when the policy carries no commitment (deployment-binding granularity).
    if let Some(commitment) = policy.confinement.as_ref() {
        verify_confinement_commitment(commitment)
            .context("§7 confinement commitment verification failed")?;
        eprintln!(
            "cloister-harness: §7 confinement commitment verified — the manifest to be enforced \
             matches the identity-committed digest"
        );
    }

    // Resolve the credential BEFORE applying the sandbox — the keystore/Keychain
    // is still reachable here; after Sandbox::apply it deliberately is not.
    let secret = policy
        .credential
        .as_ref()
        .map(|c| nono::keystore::load_secret_by_ref(&c.service, &c.uri))
        .transpose()
        .context("resolving credential from the nono keystore")?;

    // The derive: nono's manifest → CapabilitySet (nono's own converter).
    let caps = CapabilitySet::try_from(&policy.capabilities)
        .context("converting capability manifest to a CapabilitySet")?;

    // Apply — IRREVERSIBLE. After this, this process and everything it execs can
    // only touch what the manifest granted (Seatbelt on macOS, Landlock on Linux).
    let _applied = Sandbox::apply(&caps).context("applying the nono sandbox")?;

    // Exec the harness, confined. env_strip removes inherited credentials;
    // env_set points it at the vault-proxy seam; the optional resolved secret is
    // injected narrowly under its dest env var.
    let mut cmd = Command::new(&policy.harness_bin);
    cmd.args(&policy.harness_args);
    for k in &policy.env_strip {
        cmd.env_remove(k);
    }
    for (k, v) in &policy.env_set {
        cmd.env(k, v);
    }
    if let (Some(cred), Some(secret)) = (&policy.credential, &secret) {
        cmd.env(&cred.dest_env, secret.as_str());
    }

    // On success, exec() replaces this process and never returns; it only returns
    // an io::Error on failure.
    Err(cmd.exec()).with_context(|| format!("exec {}", policy.harness_bin.display()))
}

#[cfg(test)]
mod tests {
    //! §7 identity-digest verify (cloister-c80953). Proves the runner's own
    //! canonicalizer conforms to the pinned confinement/v1 vector, then that a
    //! cert-committed digest is enforced fail-closed: accept on match, reject on
    //! manifest tamper, on a cert that commits no digest, and on a wrong master.
    use super::*;
    use ed25519_dalek::SigningKey;
    use leyline_sign::cert_chain::tests_helpers::mint_test_cert;
    use rand::RngCore;
    use rand::rngs::OsRng;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn key() -> SigningKey {
        let mut seed = [0u8; 32];
        OsRng.fill_bytes(&mut seed);
        SigningKey::from_bytes(&seed)
    }

    fn now() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64
    }

    fn b64url(b: &[u8]) -> String {
        use base64::Engine;
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
    }
    fn b64std(b: &[u8]) -> String {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(b)
    }

    /// The confinement/v1 canonical vector (LLO CONFINEMENT_DIGESTS.blake3).
    fn canonical_manifest() -> serde_json::Value {
        serde_json::json!({
            "version": "cloister/confinement/v1",
            "fs": { "allow": ["/etc/hosts", { "path": "/var/lib/bundle-X/", "mode": "rw" }] },
            "network": { "allowHosts": ["*.telemetry.example.com", "api.example.com"] },
            "port": { "bind": 8443, "address": "127.0.0.1" },
            "credentialSource": "keychain://bundle-X-credentials"
        })
    }

    /// Mint a currently-valid dev cert committing `digest`, wrapped as a commitment
    /// carrying `manifest`. Returns (commitment, master pubkey b64std) so callers
    /// can swap the master to simulate a bad anchor.
    fn commitment(manifest: serde_json::Value, digest: Option<[u8; 32]>) -> ConfinementCommitment {
        let master = key();
        let ephemeral = key();
        let cert = mint_test_cert(
            &master,
            &ephemeral,
            now() - 300,
            now() + 3600,
            Some(1),
            Some("sha256:deadbeef"),
            Some("*"),
            digest,
        );
        ConfinementCommitment {
            manifest,
            cert_der_b64url: b64url(&cert),
            master_pub_b64std: b64std(master.verifying_key().as_bytes()),
        }
    }

    #[test]
    fn canonicalizer_reproduces_llo_v1_pin() {
        const PIN: &str = "d9b5b7270bb6e5ec068aec92798dd76b0f71d1fe2640b3a09833b7742d51c617";
        assert_eq!(hex(&confinement_digest(&canonical_manifest())), PIN);
    }

    #[test]
    fn accepts_when_manifest_matches_commitment() {
        let m = canonical_manifest();
        let d = confinement_digest(&m);
        let c = commitment(m, Some(d));
        verify_confinement_commitment(&c).expect("a manifest matching the commitment must verify");
    }

    #[test]
    fn rejects_on_manifest_tamper() {
        // Cert commits the canonical digest; the enforced manifest is widened.
        let committed = confinement_digest(&canonical_manifest());
        let mut tampered = canonical_manifest();
        tampered["fs"]["allow"] =
            serde_json::json!(["/etc/hosts", "/", { "path": "/var/lib/bundle-X/", "mode": "rw" }]);
        let c = commitment(tampered, Some(committed));
        let err = verify_confinement_commitment(&c).unwrap_err();
        assert!(
            format!("{err:#}").contains("confinement drift"),
            "expected drift rejection, got: {err:#}"
        );
    }

    #[test]
    fn rejects_when_cert_commits_no_digest() {
        let c = commitment(canonical_manifest(), None);
        let err = verify_confinement_commitment(&c).unwrap_err();
        assert!(
            format!("{err:#}").contains("commits no confinementDigest"),
            "expected no-commitment rejection, got: {err:#}"
        );
    }

    #[test]
    fn rejects_when_master_pubkey_wrong() {
        let m = canonical_manifest();
        let d = confinement_digest(&m);
        let mut c = commitment(m, Some(d));
        // Swap in an unrelated master → the chain no longer verifies.
        c.master_pub_b64std = b64std(key().verifying_key().as_bytes());
        let err = verify_confinement_commitment(&c).unwrap_err();
        assert!(
            format!("{err:#}").contains("cert chain verify failed"),
            "expected chain-verify rejection, got: {err:#}"
        );
    }
}
