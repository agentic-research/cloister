---
title: "ADR-0081: Cloister is a core, drivers and features"
status: Accepted (2026-11-21)
date: 2026-11-21
tags: [architecture, core, drivers, features, layering, tcb, budget]
tracking-bead: cloister-ca2582
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
implementer's. No code moves in this change.

## Context

A 14 KB HTTPS server that is its own operating system (k15) prompted the
question. Its security argument is that there is almost nothing in it to
trust. Cloister's argument is a 2,078-line threat model, and nobody had
measured what it asks a deployment to trust.

The measurement, taken on 2026-11-21 (Snapshot, below), counts 52,788 lines
of cloister's own runtime code. Tests, generated files, vendored files and
the lint, gen and dev tooling are not counted. Three things stand out:

- **Core is 42% of it.** That is 21,972 lines: the declaration, authority,
  credentials, audit, confinement policy and content addressing.
- **More than half of core lives in the worker.** 12,349 of core's lines are
  in `src/`: leases, CA bundles, the trust store, the vault, receipts and
  attestation. They are written as gateway code, beside the gateway's routes
  and its isolate hosting.
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

- **Core** is what cloister guarantees in every deployment (§2). It has six
  areas, and a seventh is an amendment here:
  - the declaration: its schema, parser, checker, canonical form and lock;
  - authority: identity, leases and grants;
  - credentials: the vault;
  - audit: receipts and attestation;
  - confinement policy;
  - content addressing.
- **Drivers** come one per placement. Each isolates bundles its own way, and
  each meets ADR-0078's contract: provide every declared need, or refuse it
  by name. The drivers today:
  - workerd: V8 isolates and service bindings (ADR-0013). This holds the
    gateway's own bundles and the whole Cloudflare deployment.
  - compose.
  - microVM, through ley-line-open (ADR-0079).
  - Kubernetes and Knative.
- **Features** are built on core and drivers:
  - the MCP gateway's routes;
  - beads;
  - the OCI and MCP registries;
  - disclosure;
  - the harness launcher;
  - the plan checker;
  - skills;
  - the CLI's own surface.
- **Composition roots** are the only modules that wire layers together:
  `src/index.ts`, `bin/cloister.mjs`, `cli/index.mjs` and `cluster generate`.

So the gateway is not one thing. Its isolate hosting is a driver, its
routes are features, and today it is where most of core happens to be
written.

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
- Drivers import core.
- Features import core and drivers.
- Composition roots import anything.
- Tests are exempt.

`lint/layers.mjs` holds a committed map that assigns every tracked source
file to a layer, by path. Its rail, which is in `task lint` now, refuses a
file the map does not classify and a map entry that names no tracked file.

The import-direction rail reads the same map and lands next. It will refuse
an import that points outward. The outward imports that exist when it lands
are listed where a reviewer sees them, and that list only shrinks. This is
the ratchet `cli/test/flags.test.mjs` uses for unmoved commands.

### 4. Core has a budget

Core's size is measured in CI from the same map. It may shrink freely. It
grows only with an amendment here that says why. The number matters less
than the habit: adding to what every deployment must trust becomes a
decision someone writes down. The budget lands with the import rail, and
starts at core's size on that day.

### 5. Nothing moves yet

Until a file moves, the map is the boundary, not the directory. A file
moves when it is next changed for a reason of its own. Moving files only to
tidy them would churn history and every open branch.

## Consequences

- "Where does this go?" has an answer before code is written. A new source
  file needs a layer to pass `task lint`, and a new core file states why it
  is core.
- The snapshot points at the first work:
  - The worker's core-shaped half becomes a core module that the gateway
    imports, instead of gateway code. Where it runs stays the driver's
    choice: in the worker on Cloudflare, and with the platform on a host.
  - `resolve-inputs.mjs` splits its fetchers (features) from pinning (core).
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

## Snapshot (2026-11-21)

From `task lint:layers`. It counts lines of tracked `.ts`, `.mjs`, `.js`,
`.rs` and `.capnp` files. Tests, generated files and `.d.ts` files are not
counted, and the rows outside cloister's runtime code (tooling, config,
examples, vendored) are not shown.

| Layer | Lines | Files |
|---|---:|---:|
| core: declaration | 7,401 | 17 |
| core: authority | 4,964 | 20 |
| core: credentials | 4,083 | 12 |
| core: audit | 3,550 | 11 |
| core: content addressing | 1,491 | 8 |
| core: confinement | 483 | 5 |
| **core** | **21,972** | **73** |
| driver: workerd | 5,308 | 18 |
| driver: microVM | 5,014 | 18 |
| driver: compose | 1,179 | 4 |
| driver: Kubernetes and Knative | 1,076 | 3 |
| **drivers** | **12,577** | **43** |
| feature: CLI | 4,182 | 22 |
| feature: harness | 3,546 | 9 |
| feature: MCP gateway | 3,446 | 18 |
| feature: plan checker | 2,581 | 11 |
| feature: registries | 1,979 | 5 |
| feature: beads | 1,158 | 4 |
| feature: disclosure | 537 | 2 |
| feature: skills | 294 | 1 |
| **features** | **17,723** | **72** |
| composition roots | 516 | 4 |

Core's lines live in `src/` 12,349, `cli/` 4,978, `manifest/` 1,673,
`rs/` 1,619 and `vault/` 1,353.
