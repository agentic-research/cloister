---
title: "ADR-0079: MicroVM runs go through ley-line-open's execution daemon, on grants cloister signs"
status: Accepted (2026-11-21)
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
external_refs:
  - ley-line-open:rs/ll-open/runtime/src/catalog.rs
  - ley-line-open:rs/ll-open/storefs/src/daemon.rs
  - ley-line-open:rs/ll-open/cli/tests/guest_harness/mod.rs
  - https://github.com/agentic-research/ley-line-open/issues/602
  - https://github.com/agentic-research/ley-line-open/issues/603
---

# ADR-0079: MicroVM runs go through ley-line-open's execution daemon, on grants cloister signs

## Status

Accepted (2026-11-21). The owner delegated the open questions to the
implementer, and they are decided on the recommendations: Q1 in §3, Q2 in §5,
Q3 in §1. Reading ley-line-open v0.30.0 to implement this found two facts the
proposal did not have (the last two bullets of Context). They correct §2 and
§4, and add §7. Implementing §3 found a third: the helper cannot yet sign the
grant's evidence (§3).

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
  - The sign-only helper (ADR-0019) signs a payload of up to 64 KiB with a
    keystore-held Ed25519 key, which never enters the caller's process.
  - cloister-host-runtime links LLO's runtime crate, which has the generated
    `execution/v1` types and `grant_signing_bytes`.
- **A run's executable is named by its bytes.** The RunSpec names its
  executable as an artifact: a digest and a media type. The daemon refuses
  any digest but a lowercase `blake3-256`. The catalog maps that artifact to
  a rootfs and a path inside it. ley-line-open's own OCI-rootfs test names
  the artifact by the `blake3-256` of the executable file inside the image,
  with the media type `application/vnd.leyline.executable`.
- **A workspace is named by its tree root, and the root moves.** A workspace
  input is `{name, graphRoot}`, where `graphRoot` is the store's tree root,
  `blake3-256:<storeRoot>`. Three things must agree on it:
  - the share opens only when the store holds the grant's `graphRoot` when
    the run starts;
  - the catalog entry's workspace inputs must equal the RunSpec's exactly;
  - the daemon reads its catalog once, when it starts.

  The root changes with every proposal the store accepts. A caller learns it
  only from a running daemon: `read_source` of a file the store holds reports
  it, and `status` reports the source directory, not its root. So
  ley-line-open's own guest tests start the daemon twice: once over the tree
  with an empty catalog to read the root, then again with a catalog naming
  it.

## Decision

### 1. A microVM run is started through the execution daemon

cloister stops calling the libkrun backend directly. `cloister cluster up`
starts ley-line-open's execution daemon with `--backend micro-vm`, a catalog,
its trust configuration and, when a bundle declares a workspace, `--source`
set to the operator's workspace. Each run is submitted to the daemon's socket.
The daemon is the one place a guest is started, so the mechanism stays in LLO
(ADR-0035) and cloister supplies policy: what runs, with what, on whose
authority.

`cluster up` starts one daemon for each distinct workspace its bundles
declare, and one for the bundles that declare none (Q3). ley-line-open serves
one workspace per daemon, and today one bundle declares one.

### 2. cloister issues the RunSpec and RunGrant, built from LLO's own types

For each run, cloister-host-runtime builds the RunSpec and RunGrant with
LLO's generated Rust types, never a hand-written mirror (ADR-0063 §1):

- the executable artifact: the `blake3-256` of the entry point's bytes in the
  bundle's imported rootfs, with the media type
  `application/vnd.leyline.executable`. cloister-host-runtime hashes the file
  in the CAS when it builds the spec. The lock does not restate it, so it
  cannot disagree with the rootfs it came from;
- the arguments and environment from the launch plan;
- the confinement digest and its §6 grants, as today;
- for a declared workspace, a workspace grant whose `graphRoot` is the
  store's root when the run starts, with operations from `workspace`: `read`,
  `list` and `query` for `"read"`; for `"write"`, those plus `mutate`, with a
  write scope of `["/"]`. A run proposes changes and does not `commit` them:
  landing a proposal stays with the store's merge path (ADR-0045);
- ceilings from the launch plan.

### 3. The grant is signed by a key the daemon trusts, held outside both

The RunGrant's signing bytes (`grant_signing_bytes`) and the DSSE evidence it
references are signed by an Ed25519 key that neither cloister-host-runtime
nor the daemon holds. The daemon is started with that key's public half as
its `--trust-key`, and the evidence is written to the CAS evidence store the
daemon reads.

The key is held by the sign-only helper (ADR-0019), under a key URL used for
nothing but execution grants and their evidence (Q1). The helper signs any
bytes it is given, so the separation comes from the key, not from the
payload. Only cloister-host-runtime is listed as a caller of that URL.
Moving the issuer to notme, with actor provenance as a Signet bridge cert
(ADR-0063 §3), is a later change; it waits on notme's mint path.

The helper can sign the grant today: cloister computes the DSSE
pre-authentication bytes with ley-line-open's `pae` and sends them to the
helper. It cannot yet sign the evidence. ley-line-open's DSSE envelope is
signed only by an in-process key, and cloister will not write a second
encoder of it. ley-line-open#603 asks for a way to build the envelope from a
signature made outside the process. Until that lands, the daemon path is
built and tested with a key held by the test, and no run takes it.

### 4. The catalog is generated each time a daemon starts

The daemon's catalog is generated at each start, from three things:

- the lock's imported rootfs rows for the host's guest platform;
- each rootfs's executable digest, hashed from that rootfs in the CAS (§2);
- for a daemon serving a workspace, the workspace's root at that start.

So the daemon resolves exactly the executables the lock pins, and nothing it
does not. The catalog cannot be generated from the lock alone: a workspace's
root is not a pin, and it moves with every accepted proposal. It is written
to the daemon's state directory and is never committed.

### 5. Every grant is signed, in development too

cloister never passes `--allow-unverified-evidence` (Q2). A development run is
signed by a development key the helper holds, and the development daemon
trusts that key. A developer's run therefore takes the production path, and
there is no unsigned seam to keep out of production. That follows ADR-0007's
removal of auth bypasses.

### 6. Nothing is lost in the move

The daemon path must carry everything the direct path carries before the
direct path is retired. That covers:

- the §6 channel grants;
- the environment;
- the CAS rootfs;
- cancellation on a signal and on the supervisor's death
  (`--stop-on-stdin-eof`);
- the wall-clock report.

The host runtime's existing launch tests run against the daemon path to prove
it. Until they pass, the direct path stays, and runs move to the daemon path
together, once they do.

### 7. A workspace waits for ley-line-open to report its root at start

A daemon serving a workspace needs the tree's root in its catalog before it
starts (Context). cloister does not ship the two-start sequence
ley-line-open's tests use. It parses the tree twice, and it has to ask for
the root through a file the issuer guesses the store holds. An edit between
the two starts also refuses the run.

ley-line-open#602 asks for two things:

- the store root in `status`;
- a way to start a daemon with a catalog that admits its own workspace
  without knowing the root beforehand.

Until that lands, a microVM bundle that declares a workspace stays refused by
name (ADR-0078). §1 to §6 are built and tested without one, and the workspace
is added to them when #602 lands.

## Consequences

- When ley-line-open#603 lands and the daemon path reaches parity (§6),
  every microVM run moves to a signed, verified grant (§3, §5), and its
  authority can be audited from its receipt (ADR-0063 §3).
- When #602 lands too, mache's microVM plan starts, with its workspace at
  `/work`, and the refusal added by ADR-0078 is lifted. A write becomes a
  proposal against the store, validated on commit (ADR-0050), and the daemon
  writes accepted ones back into the tree.
- `cluster up` gains daemons to start and stop, and catalogs to generate.
- Still needed for a service to lose nothing: no wall-clock ceiling
  (ley-line-open-e6b1bb), and state across runs (ley-line-open#600).

## Questions decided

- **Q1. Who holds the issuing key?** The sign-only helper (ADR-0019), under a
  URL used only for execution grants (§3). notme can take over as issuer
  later, once its mint path exists. The other option was notme now, which
  waits on that path.
- **Q2. Development posture.** A development key the helper holds; no
  unsigned grants (§5). The other option was unsigned grants under
  `CLOISTER_MODE=dev`. That would add one more seam that skips verification
  and has to be kept out of production.
- **Q3. One daemon per workspace, or per cluster.** One per distinct
  workspace, plus one for runs that declare none (§1), because LLO serves one
  workspace per daemon.

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
- **Start the daemon twice to learn a workspace's root.** This is what
  ley-line-open's tests do. It works today, but cloister would then own a
  probe-file guess and a race, to be deleted once ley-line-open reports the
  root (§7).
- **Record the executable's digest in the lock at import.** That would be a
  second statement of a fact the rootfs already holds, which could disagree
  with it after a hand edit. Hashing the file in the CAS at spec time cannot
  disagree (§2).
