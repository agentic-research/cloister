---
title: "ADR-0084: Cloister keeps no Rust; each crate it still has names its exit"
status: Accepted (2026-11-22)
date: 2026-11-22
tags: [rust, llo, boundary, migration, build]
tracking-bead: cloister-ca2582
# A coarse ceiling on cloister's Rust, in lines of tracked .rs files, read by
# lint/rust-exits.mjs. It only comes down: lower it when a crate leaves.
# Raising it is a change here that says why.
rust-budget: 6000
relates_to:
  - 0035-cloister-llo-boundary.md
  - 0049-cloister-host-runtime.md
  - 0063-execution-v1-is-llo-owned-and-three-structs.md
  - 0079-microvm-runs-go-through-llo-execution-daemon.md
  - 0081-cloister-is-a-core-drivers-and-features.md
---

# ADR-0084: Cloister keeps no Rust; each crate it still has names its exit

## Status

Accepted (2026-11-22). The owner asked whether cloister has any reason to keep
Rust, and answered: "I don't think so." This ADR records that answer, says
where each remaining crate goes, and adds the rail that holds it.

## Context

ADR-0049's 2026-07-31 amendment moved the generic execution runtime to LLO.
Cloister keeps its own policy, authorization, audit, receipts linkage and CLI,
and none of that needs Rust. ADR-0035 (Proposed) had kept "bridge crates" in
cloister.

After #371 removed the mediator, cloister has four Rust trees, 5,943 lines in
all:

| Tree | Lines | What it is | Why it is Rust |
|---|---:|---|---|
| `rs/crates/cas` | 942 | LLO's `leyline-cas-ffi` (BLAKE3, partition fold), built for wasm32 for the gateway | So LLO's source enforces the substrate hash. Cloister replaced an npm BLAKE3 for that reason (`cloister-713b4e`). |
| `rs/crates/host-runtime` | 4,296 | Builds the spec, grant and evidence cloister hands LLO's execution daemon, and runs them through LLO's execution API | It uses LLO's generated execution/v1 builders and signing functions. ADR-0063 §1 forbids a hand-written copy of that wire format. |
| `tools/harness-sandbox` | 615 | Applies kernel confinement for a harness run, and checks the identity certificate's confinement digest before `Sandbox::apply` | It holds the only live kernel-level confinement assertions in either repository. |
| `tools/edge-probe` | 90 | The guest program that witnesses "no declared edge, no channel" inside a microVM | A static guest binary was the easiest thing to put in a minimal rootfs. |

Each one is a way to reach LLO's code, or LLO's kernel enforcement, from
cloister before LLO offers a way that is not Rust. None is cloister policy that
needs Rust for its own sake.

## Decision

### 1. Cloister's target is no Rust

Each Rust tree in cloister is migration state, and it names the work that ends
it. A new Rust tree is an amendment to this ADR, not a new crate. When cloister
needs LLO's Rust, it asks LLO for a surface that is not Rust.

### 2. Where each tree goes

- **`rs/crates/cas`**: LLO publishes `leyline-cas-ffi` built for wasm32 as a
  release artifact (ley-line-open#605), and cloister pins that artifact by
  digest, as it pins LLO's spec files. The reason for the bridge holds: LLO's source enforces the
  substrate hash, and a digest pin cannot drift the way a semver range can.
- **`rs/crates/host-runtime`** has two parts:
  - runs go through LLO's execution daemon (ADR-0079), which waits on
    ley-line-open#602 and ley-line-open#603;
  - LLO gives a caller that is not Rust a way to build a run's spec, grant
    and evidence from LLO's own definitions (ley-line-open#606). That could be generated
    TypeScript builders, a wasm32 build of the builders, or the daemon
    accepting the request and building it itself. Cloister then builds them
    without a copy of the wire format, as ADR-0063 §1 requires.
- **`tools/harness-sandbox`**: LLO ports its kernel-level confinement
  assertions (`ley-line-open-704853`). Until that closes, deleting this tree
  would trade proof for convention (ADR-0049).
- **`tools/edge-probe`**: the witness becomes a script run in a pinned image,
  as compose-hold's workloads are. That waits for a microVM boot in CI, so the
  swap is proven rather than assumed.
- **`rs/`** (the workspace, its lock and its audit configuration) goes with
  the last crate in it.

### 3. A rail holds it

`lint/rust-exits.mjs` runs in `task lint`:

- every tracked Rust or Cargo file lies in a tree `RUST_EXITS` lists;
- every tracked `Cargo.toml` is a listed tree's own, so a new crate inside the
  workspace is refused too;
- each entry names its exit (a bead, an issue in a named repository, or an
  ADR), the rule Inv 13 applies to a process bundle;
- an entry whose tree is gone is refused, so the list only shrinks;
- cloister's Rust stays under `rust-budget`, in this ADR's frontmatter.

## Consequences

- ADR-0035's "bridge crates stay in cloister" ends with the cas crate's exit.
  No new bridge crate is added.
- When the last tree leaves, cloister's build drops its Rust toolchain, the
  wasm build, and `cargo audit` and `cargo deny`.
- Until then, a change to cloister's Rust is a fix, or it is one of these
  exits.
- The two asks of LLO are filed: the published wasm32 build is
  ley-line-open#605, and a non-Rust way to build a run is ley-line-open#606.

## Alternatives considered

- **Keep the bridge crates (ADR-0035).** That keeps a Rust toolchain in
  cloister's build to call one function, BLAKE3. LLO owns it, so LLO should
  ship it.
- **Replace the cas bridge with an npm BLAKE3.** That was the state before
  `cloister-713b4e`. A digest-pinned LLO artifact keeps the reason that change
  was made.
- **Hand-write the execution/v1 messages in TypeScript.** ADR-0063 §1 refuses
  a copy of a schema another repository owns.
