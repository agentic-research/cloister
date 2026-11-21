---
title: "ADR-0079: MicroVM runs go through ley-line-open's execution daemon, on grants cloister signs"
status: Proposed (2026-11-21)
date: 2026-11-21
tags: [microvm, execution, workspace, authority, grant, signing, llo]
tracking-bead: cloister-dc4a53
threat_model: docs/security/threat-model.md
relates_to:
  - 0019-sign-only-helper-protocol.md
  - 0035-cloister-llo-boundary.md
  - 0042-turnkey-harness-dev-run.md
  - 0049-cloister-host-runtime.md
  - 0063-execution-v1-is-llo-owned-and-three-structs.md
  - 0078-needs-are-declared-once-every-placement-provides-them.md
---

# ADR-0079: MicroVM runs go through ley-line-open's execution daemon, on grants cloister signs

## Status

Proposed (2026-11-21). The direction (§1, §2, §4, §6) follows from ADR-0035,
ADR-0063 and ADR-0078. Who holds the issuing key (Q1) and the development
posture (Q2) are trust-boundary decisions for the owner.

## Context

ADR-0078 made the workspace a need a bundle declares, which every placement
provides or refuses. The microVM placement refuses it today (cloister-dc4a53),
and these are the facts behind that:

- **cloister's host runtime starts the libkrun backend directly**, with
  `ServedWorkspaces::none()`. The request it builds has `workspaces:
  Vec::new()`, whatever the plan says.
- **ley-line-open opens a workspace share only for an authorized run.**
  `ExecutionService::start` refuses a request naming a workspace "without a
  verified grant". A share is opened only by `start_authorized`, from a
  RunSpec (intent) and a RunGrant (authority bound to the spec's digest), the
  three-struct contract of ADR-0063.
- **ley-line-open's execution daemon already composes all of it.**
  - `--backend micro-vm` runs the libkrun worker.
  - `--source <dir>` parses that tree into the daemon's store and serves it to
    a run as `/work`, with accepted proposals written back into the tree.
  - `--catalog` is the trusted artifact-to-rootfs map.
  - `--trust-key` with `--evidence-store` accepts only grants signed by a key
    it trusts, with their DSSE evidence.
  - `--allow-unverified-evidence` accepts unsigned grants. It is named for
    local fixtures, and refuses to combine with a trust key.
- **cloister already holds the pieces of an issuer.**
  - `cli/lib/runtime/llo-client.mjs` talks to the daemon's socket, validated
    against LLO's generated contract.
  - The sign-only helper (ADR-0019) signs a payload with a keystore-held
    Ed25519 key, which never enters the caller's process.
  - cloister-host-runtime links LLO's runtime crate, which has the generated
    `execution/v1` types and `grant_signing_bytes`.

## Decision

### 1. A microVM run is started through the execution daemon

cloister stops calling the libkrun backend directly. `cloister cluster up`
starts ley-line-open's execution daemon with `--backend micro-vm`, a catalog,
its trust configuration and, when a bundle declares a workspace, `--source`
set to the operator's workspace. Each run is submitted to the daemon's socket.
The daemon is the one place a guest is started, so the mechanism stays in LLO
(ADR-0035) and cloister supplies policy: what runs, with what, on whose
authority.

### 2. cloister issues the RunSpec and RunGrant, built from LLO's own types

For each run, cloister-host-runtime builds the RunSpec and RunGrant with
LLO's generated Rust types, never a hand-written mirror (ADR-0063 §1):

- the rootfs, executable and arguments from the launch plan;
- the confinement digest and its §6 grants, as today;
- for a declared workspace, a workspace grant whose `graphRoot` is the
  daemon's store root, with operations from `workspace`: `read`, `list` and
  `query` for `"read"`; for `"write"`, those plus `mutate`, with a write scope
  of `["/"]`. A run proposes changes and does not `commit` them: landing a
  proposal stays with the store's merge path (ADR-0045);
- ceilings from the launch plan.

### 3. The grant is signed by a key the daemon trusts, held outside both

The RunGrant's signing bytes (`grant_signing_bytes`) are signed by an Ed25519
key that neither cloister-host-runtime nor the daemon holds (Q1). The daemon
is started with that key's public half as its `--trust-key`. The DSSE
evidence the grant references is written to the CAS evidence store the daemon
reads.

### 4. The catalog is generated from the lock

The daemon's catalog is generated from `cluster.lock.toml`'s imported rootfs
rows, so the daemon resolves exactly the executables the lock pins, and
nothing it does not.

### 5. Unsigned grants only in development

`--allow-unverified-evidence` is passed only when `CLOISTER_MODE=dev` is set
(Q2), and `lint:no-dev-mode` keeps it out of committed configuration, as it
does every other development seam (ADR-0042).

### 6. Nothing is lost in the move

The daemon path must carry everything the direct path carries before the
direct path is retired. That covers the §6 channel grants, the environment,
the CAS rootfs, cancellation on a signal and on the supervisor's death
(`--stop-on-stdin-eof`), and the wall-clock report. The host runtime's
existing launch tests run against the daemon path to prove it. Until they
pass, the direct path stays, and only a run that declares a workspace takes
the daemon path.

## Consequences

- mache's microVM plan starts, with its workspace at `/work`, and the refusal
  added by ADR-0078 is lifted. A write becomes a proposal against the store,
  validated on commit (ADR-0050), and the daemon writes accepted ones back
  into the tree.
- `cluster up` gains a daemon to start and stop, and a catalog to generate.
- A grant names what a run may do in one signed, verified object, so a run's
  authority can be audited from its receipt (ADR-0063 §3).
- Still needed for a service to lose nothing: no wall-clock ceiling
  (ley-line-open-e6b1bb), and state across runs (ley-line-open#600).

## Open questions — the owner's decisions

- **Q1. Who holds the issuing key?**
  - The sign-only helper (ADR-0019) holds an Ed25519 key in the keystore.
    This is the smallest change, and the key never enters a process that
    parses workload input.
  - Or notme mints it as identity, which makes actor provenance a Signet
    bridge cert (ADR-0063 §3). That waits on notme's mint path.
  - Recommendation: the helper now, with the evidence roles chosen so notme
    can take over without a change to the grant.
- **Q2. Development posture.** Unsigned grants under `CLOISTER_MODE=dev`, or a
  development key minted by the helper, so a developer's run is signed like
  production. Recommendation: a development key. That follows ADR-0007's
  removal of auth bypasses: a seam that skips verification is one more thing
  to keep out of production.
- **Q3. One daemon per workspace, or per cluster.** LLO serves one workspace
  per daemon. Recommendation: one daemon per distinct workspace a `cluster up`
  needs, which today is one.

## Alternatives considered

- **Embed `ExecutionService` in cloister-host-runtime.** That needs LLO's
  daemon context to serve a source tree, which means re-implementing the
  daemon's composition in cloister. cloister would then own mechanism that is
  LLO's.
- **Build and sign grants in JavaScript.** The signature is over canonical
  capnp bytes, and cloister has no generated TypeScript for `execution/v1`
  yet (cloister-3e86e8). A hand-built encoder is the parallel implementation
  ADR-0063 forbids.
- **Accept unverified evidence everywhere.** A grant nobody verifies is
  ambient authority, and the daemon names that mode for local fixtures only.
