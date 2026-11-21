// SPDX-License-Identifier: AGPL-3.0-or-later
//
// issue — what cloister hands ley-line-open's execution daemon for one run
// (ADR-0079 §2–§4): the RunSpec (intent), the RunGrant (authority bound to
// the spec's digest), the evidence statement the grant's three evidence
// references commit to, and the catalog entry the daemon resolves the spec's
// executable through.
//
// Everything is built with ley-line-open's own types: the generated
// execution/v1 builders, `derive_run_id`, `grant_signing_bytes`, the DSSE
// `pae` and the in-toto `Statement`. Nothing here is a hand-written mirror of
// a wire format (ADR-0063 §1). What the daemon makes of the result is checked
// in tests/issue.rs by LLO's `authorize_with_verifier` and
// `CatalogResolver::resolve`, against the request the direct path builds.
//
// Signing is not done here. The grant's signature is over `grant_pae`, which
// the sign-only helper signs (ADR-0079 §3). The evidence statement is signed
// into a DSSE envelope, which today only an in-process key can do
// (ley-line-open#603), so this module stops at the unsigned statement.

use std::fs;
use std::path::Path;

use capnp::message::Builder;
use leyline_envelope::{pae, Statement, Subject};
use leyline_public_schema::execution_capnp;
use leyline_runtime::artifacts::rootfs_manifest::{RootfsSpec, ROOTFS_MANIFEST};
use leyline_runtime::authorization::{
    canonical_digest, derive_run_id, grant_signing_bytes, EvidenceField, EXECUTION_CAPABILITY,
    EXECUTION_SCHEMA_VERSION, GRANT_SIGNATURE_PAYLOAD_TYPE,
};
use leyline_runtime::{DigestRef, ResourceLimits};

use crate::execution::{confinement_document, Deployment};
use crate::{LaunchPlan, RuntimeError};

/// The media type ley-line-open names an executable artifact by.
pub const EXECUTABLE_MEDIA_TYPE: &str = "application/vnd.leyline.executable";

/// The evidence media type LLO's DSSE verifier accepts.
pub const EVIDENCE_MEDIA_TYPE: &str = "application/vnd.in-toto+json";

/// The in-toto predicate type LLO's DSSE verifier requires of grant evidence
/// (APAS Handoff/v1). LLO keeps it private; tests/issue.rs runs LLO's
/// verifier on a statement carrying it, so a change on LLO's side fails
/// there rather than at a daemon.
pub const EVIDENCE_PREDICATE_TYPE: &str = "https://rosary.dev/Handoff/v1";

/// The digest algorithm a statement subject binds the run identity under.
/// Private in LLO for the same reason, and held to it the same way.
const RUN_BINDING_ALGORITHM: &str = "blake3";

const SIGNATURE_ALGORITHM: &str = "ed25519";

fn invalid(error: impl std::fmt::Display) -> RuntimeError {
    RuntimeError::InvalidPlan(error.to_string())
}

/// The rule LLO's execution/v1 reader applies to every digest it reads: the
/// algorithm `blake3-256` and 64 lowercase hex digits. (LLO's own check is
/// crate-private.)
fn is_blake3(digest: &DigestRef) -> bool {
    digest.algorithm == "blake3-256"
        && digest.value.len() == 64
        && digest
            .value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn check_blake3(digest: &DigestRef, field: &str) -> Result<(), RuntimeError> {
    if is_blake3(digest) {
        Ok(())
    } else {
        Err(invalid(format!(
            "{field} {}:{} is not a lowercase blake3-256 digest",
            digest.algorithm, digest.value
        )))
    }
}

/// `blake3-256:<hex>` split into the execution/v1 `DigestRef` fields,
/// refused unless it is a lowercase 64-hex blake3-256 digest.
fn blake3_digest(digest: &str, field: &str) -> Result<DigestRef, RuntimeError> {
    let (algorithm, value) = digest.split_once(':').unwrap_or(("", ""));
    let digest = DigestRef {
        algorithm: algorithm.to_owned(),
        value: value.to_owned(),
    };
    check_blake3(&digest, field)?;
    Ok(digest)
}

fn set_digest(mut builder: execution_capnp::digest_ref::Builder<'_>, digest: &DigestRef) {
    builder.set_algorithm(digest.algorithm.as_str());
    builder.set_value(digest.value.as_str());
}

fn set_evidence(mut reference: execution_capnp::evidence_ref::Builder<'_>, evidence: &DigestRef) {
    reference.set_media_type(EVIDENCE_MEDIA_TYPE);
    set_digest(reference.init_digest(), evidence);
}

fn set_limits(mut builder: execution_capnp::resource_limits::Builder<'_>, limits: &ResourceLimits) {
    builder.set_wall_time_ms(limits.wall_time_ms);
    builder.set_output_bytes(limits.output_bytes);
    builder
        .reborrow()
        .init_memory()
        .set_limit(limits.memory.limit);
    let mut cpu = builder.reborrow().init_cpu();
    cpu.set_quota(limits.cpu.quota);
    cpu.set_period(limits.cpu.period);
    builder.init_pids().set_limit(limits.pids.limit);
}

fn serialize<A: capnp::message::Allocator>(message: &Builder<A>) -> Vec<u8> {
    let mut bytes = Vec::new();
    capnp::serialize::write_message(&mut bytes, message)
        .expect("writing a capnp message into a Vec cannot fail");
    bytes
}

/// The guest-relative path ley-line-open names an executable by: the plan's
/// absolute entry point without its leading `/`, refused if any component is
/// empty, `.` or `..`. The same rule as the direct path's request.
pub fn guest_executable(entrypoint: &str) -> Result<&str, RuntimeError> {
    let relative = entrypoint.strip_prefix('/').ok_or_else(|| {
        invalid("artifact.entrypoint must be absolute in the host plan so it can be converted to a guest-relative LLO path")
    })?;
    if relative.is_empty()
        || relative
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(invalid(
            "artifact.entrypoint cannot be converted to a safe guest-relative LLO path",
        ));
    }
    Ok(relative)
}

/// The executable's artifact digest (ADR-0079 §2): `blake3-256` of the file
/// the guest runs for `entrypoint`, read from the manifest of the rootfs
/// `rootfs` names under `cas_root`. The manifest's bytes are checked against
/// the rootfs digest before they are parsed, so the digest returned is the
/// one the pinned rootfs commits to. Links are followed as the guest's
/// kernel follows them (`RootfsSpec::resolve_file`); nothing on the host is
/// read but the manifest.
pub fn executable_artifact(
    cas_root: &Path,
    rootfs: &DigestRef,
    entrypoint: &str,
) -> Result<String, RuntimeError> {
    check_blake3(rootfs, "rootfs digest")?;
    let path = cas_root.join(&rootfs.value).join(ROOTFS_MANIFEST);
    let metadata = path
        .symlink_metadata()
        .map_err(|error| RuntimeError::Backend(format!("read {}: {error}", path.display())))?;
    if !metadata.is_file() {
        return Err(RuntimeError::Backend(format!(
            "{} is not a regular file",
            path.display()
        )));
    }
    let bytes = fs::read(&path)
        .map_err(|error| RuntimeError::Backend(format!("read {}: {error}", path.display())))?;
    if blake3::hash(&bytes).to_hex().as_str() != rootfs.value {
        return Err(RuntimeError::Backend(format!(
            "{} does not hash to its rootfs digest blake3-256:{}",
            path.display(),
            rootfs.value
        )));
    }
    let spec = RootfsSpec::parse(&bytes)
        .map_err(|reason| RuntimeError::Backend(format!("{}: {reason}", path.display())))?;
    let relative = guest_executable(entrypoint)?;
    let real = spec.resolve_file(relative).map_err(|reason| {
        invalid(format!(
            "artifact.entrypoint {entrypoint} is not a regular file in rootfs blake3-256:{}: {reason}",
            rootfs.value
        ))
    })?;
    let file = spec.files.get(&real).ok_or_else(|| {
        RuntimeError::Backend(format!("rootfs manifest resolved {real} to no file entry"))
    })?;
    Ok(format!("blake3-256:{}", file.blake3))
}

/// The RunSpec for `plan` (ADR-0079 §2): its executable artifact, arguments,
/// environment and requested ceilings. It carries no workspace: a workspace
/// waits on ley-line-open#602 (§7), and a plan that declares one is refused.
pub fn run_spec(
    plan: &LaunchPlan,
    artifact: &str,
    limits: &ResourceLimits,
) -> Result<Vec<u8>, RuntimeError> {
    if !plan.workspace_access.is_empty() {
        return Err(invalid(format!(
            "bundle {:?} declares a workspace ({}), which a signed run cannot carry until \
             ley-line-open#602 lands (ADR-0079 §7)",
            plan.bundle, plan.workspace_access
        )));
    }
    if plan.artifact.args.iter().any(|arg| arg.contains('\0')) {
        return Err(invalid("artifact arguments must not contain NUL bytes"));
    }
    let artifact = blake3_digest(artifact, "executable artifact")?;
    let mut message = Builder::new_default();
    let mut spec = message.init_root::<execution_capnp::run_spec::Builder<'_>>();
    spec.set_schema_version(EXECUTION_SCHEMA_VERSION);
    {
        let mut executable = spec.reborrow().init_executable();
        executable.set_media_type(EXECUTABLE_MEDIA_TYPE);
        set_digest(executable.init_digest(), &artifact);
    }
    {
        let arguments = &plan.artifact.args;
        let mut list = spec.reborrow().init_arguments(arguments.len() as u32);
        for (index, argument) in arguments.iter().enumerate() {
            list.set(index as u32, argument.as_str());
        }
    }
    {
        let environment = &plan.environment;
        let mut list = spec
            .reborrow()
            .init_public_environment(environment.len() as u32);
        for (index, variable) in environment.iter().enumerate() {
            let mut entry = list.reborrow().get(index as u32);
            entry.set_key(variable.name.as_str());
            entry.set_value(variable.value.as_str());
        }
    }
    set_limits(spec.init_requested_limits(), limits);
    Ok(serialize(&message))
}

/// The run's identity, which the evidence must commit to: LLO's
/// `derive_run_id` over the spec's canonical digest and the grant's identity.
pub fn run_identity(spec: &[u8], grant_id: &str, replay_key: &str) -> Result<String, RuntimeError> {
    let digest = canonical_digest(spec).map_err(|error| invalid(error.detail))?;
    Ok(derive_run_id(&digest, grant_id, replay_key))
}

/// The in-toto statement every evidence reference of the grant points to:
/// one subject per evidence role, each binding `run_id`, so the statement
/// authorizes this run in each role and no other run in any.
pub fn evidence_statement(run_id: &str, grant_id: &str) -> Statement {
    let subjects = [
        EvidenceField::Issuer,
        EvidenceField::WorkloadIdentity,
        EvidenceField::ActorProvenance,
    ]
    .into_iter()
    .map(|role| Subject::with_digest(role.as_str(), RUN_BINDING_ALGORITHM, run_id))
    .collect();
    Statement::new(
        subjects,
        EVIDENCE_PREDICATE_TYPE,
        serde_json::json!({ "dispatchId": grant_id }),
    )
}

/// What a grant names besides the plan: its identity, when it expires, and
/// the evidence it cites (the stored, signed envelope of `evidence_statement`).
#[derive(Debug, Clone)]
pub struct GrantTerms<'a> {
    pub grant_id: &'a str,
    pub replay_key: &'a str,
    pub expires_at_unix_ms: u64,
    /// `blake3-256:<hex>` of the DSSE envelope in the daemon's evidence store.
    pub evidence: &'a str,
}

/// The unsigned RunGrant for `spec` (ADR-0079 §2): the microVM backend
/// class, the execution capability, the confinement document the worker
/// applies (carried, with its digest), the plan's ceilings and the evidence.
pub fn run_grant(
    spec: &[u8],
    plan: &LaunchPlan,
    limits: &ResourceLimits,
    deployment: &Deployment,
    terms: &GrantTerms<'_>,
) -> Result<Vec<u8>, RuntimeError> {
    plan.confinement.check_microvm_grants()?;
    let spec_digest = canonical_digest(spec).map_err(|error| invalid(error.detail))?;
    let spec_digest = blake3_digest(&spec_digest, "run spec digest")?;
    let evidence = blake3_digest(terms.evidence, "evidence digest")?;
    let (confinement_digest, confinement_json) = confinement_document(plan, deployment)?;
    let confinement_digest = blake3_digest(&confinement_digest, "confinement digest")?;

    let mut message = Builder::new_default();
    let mut grant = message.init_root::<execution_capnp::run_grant::Builder<'_>>();
    grant.set_grant_id(terms.grant_id);
    grant.set_expires_at_unix_ms(terms.expires_at_unix_ms);
    grant.set_replay_key(terms.replay_key);
    set_digest(grant.reborrow().init_run_spec_digest(), &spec_digest);
    // One statement asserts all three roles for this run (evidence_statement).
    set_evidence(grant.reborrow().init_issuer_evidence(), &evidence);
    set_evidence(
        grant.reborrow().init_workload_identity_evidence(),
        &evidence,
    );
    set_evidence(grant.reborrow().init_actor_provenance_evidence(), &evidence);
    {
        let mut capability = grant.reborrow().init_capabilities(1).get(0);
        capability.set_grant(EXECUTION_CAPABILITY);
        capability.set_interface(EXECUTION_SCHEMA_VERSION);
    }
    set_digest(
        grant.reborrow().init_confinement_digest(),
        &confinement_digest,
    );
    grant.set_backend_class(execution_capnp::BackendClass::MicroVm);
    set_limits(grant.reborrow().init_limits(), limits);
    grant.set_confinement_manifest(confinement_json.as_str());
    Ok(serialize(&message))
}

/// The bytes the issuer signs for `grant` (ADR-0079 §3): DSSE PAE over the
/// grant's signing bytes, under LLO's grant payload type. The sign-only
/// helper signs exactly these.
pub fn grant_pae(grant: &[u8]) -> Result<Vec<u8>, RuntimeError> {
    let signing_bytes = grant_signing_bytes(grant).map_err(|error| invalid(error.detail))?;
    Ok(pae(GRANT_SIGNATURE_PAYLOAD_TYPE, &signing_bytes))
}

/// `grant` with its issuer signature: Ed25519 `signature` over `grant_pae`,
/// by the key `key_id` names (an unauthenticated hint; LLO tries every
/// trusted key regardless).
pub fn signed_grant(
    grant: &[u8],
    key_id: &str,
    signature: &[u8; 64],
) -> Result<Vec<u8>, RuntimeError> {
    let message =
        capnp::serialize::read_message(&mut &grant[..], capnp::message::ReaderOptions::new())
            .map_err(|error| invalid(format!("read RunGrant: {error}")))?;
    let root = message
        .get_root::<execution_capnp::run_grant::Reader<'_>>()
        .map_err(|error| invalid(format!("read RunGrant root: {error}")))?;
    let mut signed = Builder::new_default();
    signed
        .set_root(root)
        .map_err(|error| invalid(format!("copy RunGrant: {error}")))?;
    {
        let mut builder = signed
            .get_root::<execution_capnp::run_grant::Builder<'_>>()
            .map_err(|error| invalid(format!("RunGrant root: {error}")))?;
        let mut field = builder.reborrow().init_signature();
        field.set_algorithm(SIGNATURE_ALGORITHM);
        field.set_key_id(key_id);
        field.set_value(signature);
    }
    Ok(serialize(&signed))
}

/// The catalog entry the daemon resolves `artifact` through (ADR-0079 §4):
/// the rootfs it runs in and the guest-relative executable. No workspace
/// input: see `run_spec`.
pub fn catalog_entry(
    artifact: &str,
    rootfs: &DigestRef,
    entrypoint: &str,
) -> Result<serde_json::Value, RuntimeError> {
    blake3_digest(artifact, "executable artifact")?;
    check_blake3(rootfs, "rootfs digest")?;
    Ok(serde_json::json!({
        "artifactDigest": artifact,
        "mediaType": EXECUTABLE_MEDIA_TYPE,
        "rootfs": { "algorithm": rootfs.algorithm, "value": rootfs.value },
        "executable": guest_executable(entrypoint)?,
        "workspaceInputs": [],
    }))
}

/// A catalog document of `entries`, checked by LLO's own reader before it is
/// returned: a document cloister writes that LLO would refuse is refused
/// here, by LLO's words, rather than at the daemon's start.
pub fn catalog(entries: Vec<serde_json::Value>) -> Result<Vec<u8>, RuntimeError> {
    let bytes = serde_json::to_vec(&serde_json::json!({ "entries": entries }))
        .expect("a JSON value serializes");
    leyline_runtime::CatalogResolver::from_json(&bytes).map_err(|error| invalid(error.detail))?;
    Ok(bytes)
}
