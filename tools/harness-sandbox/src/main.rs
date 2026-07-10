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
