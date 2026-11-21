---
title: "ADR-0081: Cloister is a core, drivers and features"
status: Accepted (2026-11-21)
date: 2026-11-21
tags: [architecture, core, drivers, features, layering, tcb, budget]
tracking-bead: cloister-ca2582
# Core's size in lines, read by lint/layers.mjs (§4). Raising it is an
# amendment to this ADR; the change that raises it says why.
core-budget: 21351
relates_to:
  - 0002-edge-router-protocol-agnostic-backends.md
  - 0011-hypervisor-bundle-boundary.md
  - 0013-slice-grant-enforcement.md
  - 0035-cloister-llo-boundary.md
  - 0077-cli-is-declared-in-capnp.md
  - 0078-needs-are-declared-once-every-placement-provides-them.md
  - 0079-microvm-runs-go-through-llo-execution-daemon.md
  - 0080-the-host-runs-the-platform-every-bundle-is-a-guest.md
external_refs:
  - https://github.com/FileSherlock/k15
  - https://kubernetes.io/docs/concepts/architecture/cri/
---

# ADR-0081: Cloister is a core, drivers and features

## Status

Accepted (2026-11-21). The owner made two decisions: cloister's core is
separated from its features, and the gateway is not the core. The
classification, the snapshot and the correction in Context are the
implementer's.

**Amended the same day, when the import rail landed.** The rail checks which
way imports point, and it found mistakes in the first map:

- The MCP gateway's backend kinds, manifest and wires were counted as the
  workerd driver.
- The module that instantiates the gateway was counted as a driver.
- The shared logging and script-entry helpers were counted as features.

They are corrected here, in Context and in the Snapshot. The amendment also
makes three changes:

- core gains a seventh area, support;
- features may import other features;
- core's budget now lives in this file's frontmatter.

No code moves.

**Amended again when core declared its own environment.** An import of a
platform module that is one driver's own API, such as `cloudflare:workers`,
is now an import of that driver (§3). A change that shrinks core lowers the
budget with it (§4).

## Context

A 14 KB HTTPS server that is its own operating system (k15) prompted the
question. Its security argument is that there is almost nothing in it to
trust. Cloister's argument is a 2,078-line threat model, and nobody had
measured what it asks a deployment to trust.

The measurement (Snapshot, below) counts 52,788 lines of cloister's own
runtime code. Tests, generated files, vendored files and the lint, gen and
dev tooling are not counted. Four things stand out:

- **Core is 40% of it.** That is 21,363 lines: the declaration, authority,
  credentials, audit, confinement policy, content addressing, and the support
  code they share.
- **More than half of core lives in the worker.** 12,094 of core's lines are
  in `src/`: leases, the trust store, the vault, receipts and attestation.
  They are written as gateway code, beside the gateway's routes.
- **Every import that points outward starts in core.** There are 14 such
  imports:
  - nine core files are typed against the workerd driver's `Env`;
  - the trust store keeps the OCI registry feature's tables;
  - two core files read the MCP gateway's manifest types;
  - core's lock writer carries the microVM driver's rootfs rows.
- **The largest core file is `cli/lib/cluster/resolve-inputs.mjs`** (1,479
  lines). Pinning an input by content address is core. Its fetchers for
  GitHub, HTTPS and registries are feature-shaped.

**A correction, made before acceptance.** In the discussion, core was first
described as "the platform underneath the gateway", the host side where
ADR-0080 puts the broker and the signing helper. That cannot be right. On
Cloudflare Workers there is nothing underneath: the worker is the whole
deployment. So core is not a place. It is the code every deployment shares,
and the guarantees that code makes true. Where it runs is the driver's
choice.

## Decision

### 1. Three layers, joined only at composition roots

- **Core** is what cloister guarantees in every deployment (§2). It has seven
  areas, and an eighth is an amendment here:
  - the declaration: its schema, parser, checker, canonical form and lock;
  - authority: identity, leases and grants;
  - credentials: the vault;
  - audit: receipts and attestation;
  - confinement policy;
  - content addressing;
  - support: code core needs that carries no policy of its own. That is the
    trust surface's structured log, atomic writes, canonical paths, and
    telling a script from an import.
- **Drivers** come one per placement. Each isolates bundles its own way, and
  each meets ADR-0078's contract: provide every declared need, or refuse it
  by name. The drivers today:
  - workerd: V8 isolates and the bindings each isolate is given (ADR-0013).
    This holds the gateway's own bundles and the whole Cloudflare deployment.
  - compose.
  - microVM, through ley-line-open (ADR-0079).
  - Kubernetes and Knative.
- **Features** are built on core and drivers:
  - the MCP gateway: its routes, its backend kinds, its manifest, and the
    wires its backends speak;
  - beads;
  - the OCI and MCP registries;
  - disclosure;
  - the harness launcher;
  - the plan checker;
  - skills;
  - the CLI's own surface.
- **Composition roots** are the only modules that wire layers together:
  - `src/index.ts`;
  - `src/manifest/runtime.ts`, which instantiates the gateway from its
    manifest;
  - `bin/cloister.mjs`;
  - `cli/index.mjs`.

So the gateway is not one thing. Its isolate hosting and bindings are the
workerd driver. Its routes, backends and manifest are a feature. Today it is
also where most of core happens to be written.

The prior art draws the same line:

- **Kubernetes** keeps its core ignorant of runtimes, networks and storage,
  behind CRI, CNI and CSI.
- **Proxmox** (ADR-0080) treats the router VM as a guest, not the hypervisor.
- **ley-line-open** (ADR-0035) holds the mechanism, and cloister holds the
  policy.

### 2. What core guarantees, in every deployment

These five guarantees are what core's code makes true. Drivers enforce them
at their boundary, and no feature may weaken them.

1. A bundle runs only what its declaration pins, by content address.
2. A bundle reaches only the channels its declaration grants. It is reached
   only where it declares.
3. A bundle holds no credential. Credentials are injected at a boundary
   outside it.
4. Every call across a boundary is authenticated, held to a declared scope,
   and recorded.
5. A need a placement cannot provide is refused by name, never dropped
   (ADR-0078).

### 3. Dependencies point inward

- Core imports only core, and third-party code, ley-line-open included.
- A driver imports core and itself, but not another driver.
- Features import core, drivers and other features.
- Composition roots import anything.
- Runtime code imports no tooling, configuration or examples.
- A platform module that is one driver's own API counts as that driver.
  Importing `cloudflare:workers` is importing the workerd driver. Node's
  `node:` modules do not count: Node runs the CLI and is no placement.
- Tests are exempt.

`lint/layers.mjs` holds a committed map that assigns every tracked code file
to a layer, by path. A generated file takes the layer of the schema it is
generated from. Its rail runs in `task lint` and refuses:

- a code file the map does not classify, and a map entry that names no
  tracked file;
- an import that points outward, unless the rail's `OUTWARD` list names it;
- an `OUTWARD` entry that no longer exists, so that list only shrinks. This
  is the ratchet `cli/test/flags.test.mjs` uses for unmoved commands.

The rail reads imports with TypeScript's own pre-processor for scripts. For
Rust it reads `mod` declarations and crate paths, after removing comments and
strings. For Cap'n Proto it reads `import` statements, after removing
comments.

### 4. Core has a budget

Core's size in lines is `core-budget` in this file's frontmatter. The rail
measures core from the same map and refuses core larger than its budget.
Core may shrink freely, and a change that shrinks it lowers `core-budget` to
match, so no headroom builds up. Core grows only by raising `core-budget`
here, in the change that grows it, and that change says why. The number matters less
than the habit: adding to what every deployment must trust becomes a
decision someone writes down. The budget started at 21,363 lines, core's
size when the rail landed.

### 5. Nothing moves yet

Until a file moves, the map is the boundary, not the directory. A file
moves when it is next changed for a reason of its own. Moving files only to
tidy them would churn history and every open branch.

## Consequences

- "Where does this go?" has an answer before code is written. A new code file
  needs a layer to pass `task lint`. A new core file states why it is core,
  and if it grows core past its budget, the change raises the budget here.
- The outward imports are the first work:
  - core declares the environment it reads, in `src/core-env.ts`, and the
    workerd driver's `Env` extends it. Configuration and the endpoints core
    calls are typed there, never by a platform's binding types;
  - the trust store and the vault are written as Durable Object classes, and
    the lease middleware reaches the trust store through a Durable Object
    namespace. Each gets a port that core calls and the workerd driver hosts;
  - the OCI registry's tables leave the trust store;
  - core stops reading the MCP gateway's manifest types;
  - the lock writer's rootfs carry-forward moves to the microVM driver,
    behind a hook core calls.
- Two files hold more than one layer's code, and each will be split:
  - `src/types.ts`: the workerd driver's `Env`, beside JSON-RPC, MCP and bead
    types that belong to features;
  - `resolve-inputs.mjs`: pinning, which is core, beside fetchers, which are
    features.
- README, `docs/ARCHITECTURE.md` and CLAUDE.md still describe cloister as the
  workerd gateway. They change when the code does. CLAUDE.md points here now.

## Alternatives considered

- **Keep the gateway as core.** That makes one driver's isolation, V8
  isolates, the definition of cloister. Every other placement becomes second
  class, and the tangle measured above becomes the design.
- **Core as the host platform.** This was the first proposal. Cloudflare
  Workers has no host, so core would not exist in production.
- **Move files into `core/` directories now.** That churns history and every
  open branch. A map states the same boundary, and a rail enforces it before
  any file moves.
- **A size budget with no dependency rule.** A number with no boundary
  measures the wrong thing. The rule is what keeps features from quietly
  growing back into core.
- **A budget with headroom.** Every core change would then stay silent until
  the headroom ran out. A budget at core's size makes each increase visible
  in the change that makes it.

## Snapshot (2026-11-21)

From `task lint:layers`, with the map as corrected by the amendment. It
counts lines of tracked `.ts`, `.mjs`, `.js`, `.rs` and `.capnp` files.
Tests, generated files and `.d.ts` files are not counted, and the rows
outside cloister's runtime code (tooling, config, examples, vendored) are
not shown.

| Layer | Lines | Files |
|---|---:|---:|
| core: declaration | 7,316 | 15 |
| core: authority | 4,586 | 19 |
| core: credentials | 3,635 | 11 |
| core: audit | 3,550 | 11 |
| core: content addressing | 1,570 | 9 |
| core: confinement | 483 | 5 |
| core: support | 223 | 4 |
| **core** | **21,363** | **74** |
| driver: microVM | 5,081 | 19 |
| driver: compose | 1,179 | 4 |
| driver: Kubernetes and Knative | 1,076 | 3 |
| driver: workerd | 884 | 3 |
| **drivers** | **8,220** | **29** |
| feature: MCP gateway | 7,883 | 32 |
| feature: CLI | 4,561 | 22 |
| feature: harness | 3,546 | 9 |
| feature: plan checker | 2,581 | 11 |
| feature: registries | 1,832 | 4 |
| feature: beads | 1,158 | 4 |
| feature: disclosure | 537 | 2 |
| feature: skills | 294 | 1 |
| **features** | **22,392** | **85** |
| composition roots | 813 | 4 |

Core's lines live in `src/` 12,094, `cli/` 5,010, `manifest/` 1,673,
`vault/` 1,353 and `rs/` 1,233.
