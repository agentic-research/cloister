// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ADR-0079 §2–§4: what cloister issues for a run is checked by ley-line-open's
// own code, not by a reading of it. Each test runs `authorize_with_verifier`
// (the daemon's authorization, with its DSSE evidence verifier) and
// `CatalogResolver::resolve` (the daemon's catalog) on what `issue` produced.
// The parity test then requires the resolved request to be the one the direct
// path builds for the same plan (§6: nothing is lost in the move).
//
// The plans are the ones `cloister runtime plan` emits for the dolt/orders
// fixture (test/fixtures/runtime-plan/), so their §6 grants are real. Each runs
// in a synthetic rootfs whose manifest lists the plan's entry point. Signing
// uses a key held by the test: production signing goes through the sign-only
// helper, and the evidence envelope waits on ley-line-open#603.

#![cfg(feature = "llo-execution")]

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use cloister_host_runtime::execution::{default_limits, to_execution_request, Deployment};
use cloister_host_runtime::issue::{
    catalog, catalog_entry, evidence_statement, executable_artifact, grant_pae, run_grant,
    run_identity, run_spec, signed_grant, GrantTerms,
};
use cloister_host_runtime::LaunchPlan;
use leyline_envelope::{Ed25519RootSigner, Envelope};
use leyline_runtime::artifacts::rootfs_manifest::{FileSpec, RootfsSpec, ROOTFS_MANIFEST};
use leyline_runtime::authorization::{authorize_with_verifier, AuthorizationPolicy};
use leyline_runtime::cas_evidence::{CasEvidenceStore, TrustKey};
use leyline_runtime::{
    AuthorizedExecution, BackendClass, CasDsseEvidenceVerifier, CatalogResolver, DigestRef,
    EnforcedCeilings, ErrorCode, ExecutionError, ExecutionRequest, ExecutionResolver,
};

const NOW: u64 = 1_800_000_000_000;

fn fixture(bundle: &str) -> LaunchPlan {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test/fixtures/runtime-plan")
        .join(format!("{bundle}.plan.json"));
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()))
}

fn deployment() -> Deployment {
    Deployment {
        runtime_files: vec!["/opt/homebrew/lib/libkrunfw.5.dylib".into()],
        devices: Vec::new(),
    }
}

/// A CAS directory holding rootfs manifests, and the manifests' digests.
struct Cas {
    dir: tempfile::TempDir,
}

impl Cas {
    fn new() -> Self {
        Self {
            dir: tempfile::tempdir().expect("tempdir"),
        }
    }

    /// Store `spec`'s canonical manifest; return the rootfs digest.
    fn put(&self, spec: &RootfsSpec) -> DigestRef {
        let manifest = spec.to_canonical_v2();
        let value = blake3::hash(&manifest).to_hex().to_string();
        let rootfs = self.dir.path().join(&value);
        std::fs::create_dir_all(&rootfs).expect("rootfs dir");
        std::fs::write(rootfs.join(ROOTFS_MANIFEST), manifest).expect("manifest");
        DigestRef {
            algorithm: "blake3-256".into(),
            value,
        }
    }
}

/// A v2 tree: `files` (path → content) and `links` (path → target), with
/// every ancestor directory at 0755.
fn tree(files: &[(&str, &[u8])], links: &[(&str, &str)]) -> RootfsSpec {
    let mut directories = BTreeMap::from([(String::new(), 0o755)]);
    for path in files.iter().map(|f| f.0).chain(links.iter().map(|l| l.0)) {
        let parts: Vec<&str> = path.split('/').collect();
        for end in 1..parts.len() {
            directories.insert(parts[..end].join("/"), 0o755);
        }
    }
    RootfsSpec {
        version: 2,
        directories,
        files: files
            .iter()
            .map(|(path, content)| {
                (
                    path.to_string(),
                    FileSpec {
                        mode: 0o755,
                        blake3: blake3::hash(content).to_hex().to_string(),
                    },
                )
            })
            .collect(),
        symlinks: links
            .iter()
            .map(|(path, target)| (path.to_string(), target.to_string()))
            .collect(),
    }
}

fn signer(seed: u8) -> Ed25519RootSigner {
    Ed25519RootSigner::from_seed(&[seed; 32])
}

/// Everything one issued run needs, with the daemon's view of it.
struct Issued {
    spec: Vec<u8>,
    grant: Vec<u8>,
    run_id: String,
    catalog: Vec<u8>,
    evidence: Arc<CasEvidenceStore>,
    _evidence_dir: tempfile::TempDir,
}

/// Issue `plan` as cloister does, with the grant and the evidence signed by
/// `issuer` and the evidence statement bound to `bound_run` (this run's own
/// identity unless a test says otherwise).
fn issue(
    plan: &LaunchPlan,
    cas: &Cas,
    issuer: &Ed25519RootSigner,
    bound_run: Option<&str>,
) -> Issued {
    let rootfs = rootfs_of(plan);
    let artifact = executable_artifact(cas.dir.path(), &rootfs, &plan.artifact.entrypoint)
        .expect("executable artifact");
    let limits = default_limits(&EnforcedCeilings::hypervisor_backed());
    let spec = run_spec(plan, &artifact, &limits).expect("run spec");
    let grant_id = format!("grant-{}", plan.bundle);
    let replay_key = format!("replay-{}", plan.bundle);
    let run_id = run_identity(&spec, &grant_id, &replay_key).expect("run identity");

    let evidence_dir = tempfile::tempdir().expect("evidence dir");
    let evidence = Arc::new(CasEvidenceStore::open(evidence_dir.path()).expect("evidence store"));
    let statement = evidence_statement(bound_run.unwrap_or(&run_id), &grant_id);
    let envelope = Envelope::sign(&statement, issuer).to_json_vec();
    let evidence_digest = evidence.insert(&envelope).expect("store evidence");

    let unsigned = run_grant(
        &spec,
        plan,
        &limits,
        &deployment(),
        &GrantTerms {
            grant_id: &grant_id,
            replay_key: &replay_key,
            expires_at_unix_ms: NOW + 60_000,
            evidence: &evidence_digest,
        },
    )
    .expect("run grant");
    let signature = issuer
        .sign_message(&grant_pae(&unsigned).expect("grant pae"))
        .to_bytes();
    let grant = signed_grant(
        &unsigned,
        &TrustKey::new(issuer.verifying_key()).kid,
        &signature,
    )
    .expect("signed grant");

    let catalog = catalog(vec![catalog_entry(
        &artifact,
        &rootfs,
        &plan.artifact.entrypoint,
    )
    .expect("catalog entry")])
    .expect("catalog");
    Issued {
        spec,
        grant,
        run_id,
        catalog,
        evidence,
        _evidence_dir: evidence_dir,
    }
}

fn rootfs_of(plan: &LaunchPlan) -> DigestRef {
    let (algorithm, value) = plan.artifact.digest.split_once(':').expect("algorithm:hex");
    DigestRef {
        algorithm: algorithm.into(),
        value: value.into(),
    }
}

/// The daemon's authorization of `issued`, trusting `trusted`.
fn authorize(
    issued: &Issued,
    trusted: &Ed25519RootSigner,
) -> Result<AuthorizedExecution, ExecutionError> {
    let verifier =
        CasDsseEvidenceVerifier::new(Arc::clone(&issued.evidence), vec![trusted.verifying_key()]);
    let policy = AuthorizationPolicy {
        now_unix_ms: Some(NOW),
        required_backend: BackendClass::MicroVm,
        required_confinement_digest: None,
    };
    authorize_with_verifier(&issued.spec, &issued.grant, &policy, &verifier)
}

/// `bundle`'s emitted plan, running in a rootfs whose manifest lists its
/// entry point.
fn plan_in(cas: &Cas, bundle: &str) -> LaunchPlan {
    let mut plan = fixture(bundle);
    let entry = plan.artifact.entrypoint.trim_start_matches('/').to_owned();
    let rootfs = cas.put(&tree(&[(entry.as_str(), b"the guest program")], &[]));
    plan.artifact.digest = format!("blake3-256:{}", rootfs.value);
    plan
}

#[test]
fn an_issued_run_is_authorized_by_llo_and_resolves_to_the_request_the_direct_path_builds() {
    let cas = Cas::new();
    let issuer = signer(7);
    for bundle in ["dolt", "orders"] {
        let plan = plan_in(&cas, bundle);
        let issued = issue(&plan, &cas, &issuer, None);
        let authorized = authorize(&issued, &issuer)
            .unwrap_or_else(|e| panic!("{bundle}: LLO refused the issued run: {e}"));
        assert_eq!(
            authorized.run_id, issued.run_id,
            "{bundle}: the run the evidence names"
        );

        let resolver = CatalogResolver::from_json(&issued.catalog).expect("catalog");
        let resolved = resolver
            .resolve(&authorized)
            .unwrap_or_else(|e| panic!("{bundle}: LLO's catalog refused the issued run: {e}"));

        let direct: ExecutionRequest =
            to_execution_request(&plan, &EnforcedCeilings::hypervisor_backed(), &deployment())
                .expect("direct request");
        assert!(
            !plan.confinement.unix_socket.allow.is_empty(),
            "{bundle}: the fixture carries §6 grants, so both paths carry the same document"
        );
        // The daemon names the run from the spec and grant; everything else
        // must be what the direct path runs.
        let expected = ExecutionRequest {
            run_id: resolved.run_id.clone(),
            replay_key: resolved.replay_key.clone(),
            ..direct
        };
        assert_eq!(
            resolved, expected,
            "{bundle}: the daemon path loses nothing (ADR-0079 §6)"
        );
    }
}

#[test]
fn a_grant_signed_by_a_key_the_daemon_does_not_trust_is_refused() {
    let cas = Cas::new();
    let plan = plan_in(&cas, "dolt");
    let issued = issue(&plan, &cas, &signer(7), None);
    let error = authorize(&issued, &signer(8)).expect_err("an untrusted issuer");
    assert_eq!(error.code, ErrorCode::Unauthenticated, "{error}");
}

#[test]
fn evidence_bound_to_another_run_does_not_authorize_this_one() {
    let cas = Cas::new();
    let plan = plan_in(&cas, "dolt");
    let other = format!("run-{}", "0".repeat(64));
    let issued = issue(&plan, &cas, &signer(7), Some(&other));
    let error = authorize(&issued, &signer(7)).expect_err("evidence for another run");
    assert_eq!(error.code, ErrorCode::Unauthenticated, "{error}");
}

#[test]
fn the_executable_artifact_is_the_file_the_guest_runs_reached_through_the_rootfs_links() {
    let cas = Cas::new();
    let program: &[u8] = b"the real program";
    let rootfs = cas.put(&tree(
        &[("opt/tool/bin/tool", program)],
        &[("usr/bin/tool", "/opt/tool/bin/tool")],
    ));
    let artifact = executable_artifact(cas.dir.path(), &rootfs, "/usr/bin/tool").expect("artifact");
    assert_eq!(
        artifact,
        format!("blake3-256:{}", blake3::hash(program).to_hex())
    );

    let directory = executable_artifact(cas.dir.path(), &rootfs, "/opt/tool")
        .expect_err("a directory is not an executable");
    assert!(
        directory.to_string().contains("not a regular file"),
        "{directory}"
    );
    let missing = executable_artifact(cas.dir.path(), &rootfs, "/usr/bin/absent")
        .expect_err("an entry point the rootfs does not hold");
    assert!(missing.to_string().contains("names nothing"), "{missing}");
}

#[test]
fn a_manifest_that_does_not_hash_to_its_rootfs_digest_names_no_executable() {
    let cas = Cas::new();
    let rootfs = cas.put(&tree(&[("usr/bin/tool", b"x")], &[]));
    let manifest = cas.dir.path().join(&rootfs.value).join(ROOTFS_MANIFEST);
    let other = tree(&[("usr/bin/tool", b"y")], &[]).to_canonical_v2();
    std::fs::write(&manifest, other).expect("tamper");
    let error = executable_artifact(cas.dir.path(), &rootfs, "/usr/bin/tool")
        .expect_err("a manifest that is not the pinned one");
    assert!(
        error
            .to_string()
            .contains("does not hash to its rootfs digest"),
        "{error}"
    );
}

#[test]
fn a_plan_that_declares_a_workspace_is_refused_until_llo_reports_its_root() {
    let cas = Cas::new();
    let mut plan = plan_in(&cas, "dolt");
    plan.workspace_access = "write".into();
    let limits = default_limits(&EnforcedCeilings::hypervisor_backed());
    let artifact = format!("blake3-256:{}", "a".repeat(64));
    let error = run_spec(&plan, &artifact, &limits).expect_err("a workspace");
    assert!(error.to_string().contains("ley-line-open#602"), "{error}");
}

#[test]
fn a_catalog_llo_would_refuse_is_refused_when_it_is_written() {
    let rootfs = DigestRef {
        algorithm: "blake3-256".into(),
        value: "b".repeat(64),
    };
    let artifact = format!("blake3-256:{}", "a".repeat(64));
    let entry = catalog_entry(&artifact, &rootfs, "/usr/bin/tool").expect("entry");
    let error = catalog(vec![entry.clone(), entry]).expect_err("a duplicate artifact identity");
    assert!(
        error.to_string().contains("duplicate artifact identity"),
        "{error}"
    );
}
