---
title: "ADR-0078: A bundle's needs are declared once, and every placement provides each one or refuses"
status: Accepted (2026-11-21)
date: 2026-11-21
tags: [placement, microvm, compose, workspace, isolation, no-exemptions, fail-closed]
tracking-bead: cloister-ca2582
relates_to:
  - 0050-fs-mediation-approach.md
  - 0062-process-mode-is-an-exemption-not-a-posture.md
  - 0063-execution-v1-is-llo-owned-and-three-structs.md
  - 0069-declared-connections.md
  - 0070-placements-and-channel-strength.md
  - 0074-the-graph-is-derived-cluster-toml-holds-intent.md
---

# ADR-0078: A bundle's needs are declared once, and every placement provides each one or refuses

## Status

Accepted (2026-11-21), on the owner's direction: no exemptions, and nothing is
lost when a bundle moves placement. The workspace (§3) is the first need this
covers. The rule (§2) applies to every need already declared.

## Context

Cloister is a hypervisor, and a hypervisor of hypervisors. The gateway runs
Workers in V8 isolates inside workerd. Cloister also places bundles, workerd
ones included, in microVMs through ley-line-open's execution API and libkrun.
The two layers stack: workerd in a microVM keeps its isolates and gains a
kernel boundary. So moving a bundle into a microVM should add a boundary and
take nothing away.

mache showed what happens instead when a bundle's needs are written in one
tier's mechanism:

- Its `cluster.toml` entry said `microvm`, with its listener and its
  `/workspace` path declared as `confinement` grants (`port`, `fs.allow`).
- No placement honoured either one. The compose emitter does not read
  `confinement`, so mache's container was given no workspace. The microVM
  tier cannot apply a host path or a raw listener, so the host runtime refused
  the plan at launch.
- The check that now refuses such grants on a microVM bundle (cloister-ca2582)
  could have been satisfied by deleting them. That would have removed the only
  statement that mache needs a workspace at all.

ADR-0062 made `process` an exemption from the microVM posture rather than a
peer of it. The owner's direction goes one step further: a capability the
microVM tier lacks is engineering to do, not a reason to exempt the bundle.

## Decision

### 1. A need is declared once, on the bundle, in no tier's vocabulary

A bundle states what it needs, whatever runs it:

| Need | Declared as |
|---|---|
| a listener | `[[bundles.ports]]` (ADR-0069) |
| an outbound channel | `[[connections]]` (ADR-0069) |
| the operator's workspace | `[bundles.external] workspace` (§3, new) |
| configuration | `[[bundles.external.env]]` |

`confinement` grants are not needs. They are one tier's enforcement
vocabulary (confinement/v1 §2–§5), and a microVM bundle may not declare them
(`cli/lib/cluster/confinement.mjs`).

### 2. Every placement provides each declared need, or refuses by name

When a bundle is placed somewhere, that placement either provides every need
the bundle declares, or refuses the placement and names the need it cannot
provide. It never starts the bundle without one, and the operator never
deletes a need to make a placement accept it. A refusal is a work item: the
engineering that lets the placement provide the need.

### 3. The workspace is a declared need, presented at `/work`

`workspace` on the external facet is `"read"`, `"write"`, or empty (none).
The bundle is given the operator's workspace at `/work`, and its own arguments
name that path.

`/work` because that is where ley-line-open serves a workspace to a microVM
guest (execution/v1, "Workspace delivery"). Every placement presents it at
the same path, so a bundle's arguments do not change with its placement.

| Placement | Provides the workspace by |
|---|---|
| compose | a bind mount at `/work`, from `${CLOISTER_WORKSPACE:-.}`, read-only for `"read"`. The default is the directory holding the compose file. |
| microvm | ley-line-open's workspace share, opened only for a run started with a RunSpec and RunGrant naming the tree's store root (ADR-0063). Cloister does not issue those yet (cloister-dc4a53), so the plan carries `workspaceAccess`, and the host runtime's `validate` and `run` refuse it by name until it does. |
| kubernetes, knative, cloudRun | not lowered: a volume is a decision for the operator's manifest. Checked placements are not changed by this. |

A write is a write in compose. In a microVM it is a proposal against the
store, validated on commit (ADR-0050).

## Consequences

- mache declares `workspace = "write"` and `--path /work`, and its listener
  is a `[[bundles.ports]]` entry. Its compose service mounts the workspace,
  which it never had. Its microVM plan is refused by name, naming the
  workspace, instead of launching without one.
- What a microVM placement must still be built to provide, for nothing to be
  lost:
  1. the workspace (cloister-dc4a53, by cloister issuing RunSpec and RunGrant);
  2. a service with no wall-clock ceiling (ley-line-open-e6b1bb);
  3. state that survives a run (ley-line-open#600);
  4. outbound access, through the broker (ley-line-open-e2c5ce);
  5. the gateway reaching a microVM bundle, by a host-side join or with the
     gateway itself in a microVM.
- The remaining `process` exemptions are read against this list, not
  re-justified.

## Alternatives considered

- **Exempt the bundle.** Rejected on the owner's direction. An exemption
  records the gap and closes nothing.
- **Keep `fs.allow`, and teach the microVM tier to carry it.** ley-line-open
  never folds a host path into a guest: that would widen what LLO grants
  itself. The guest's files come from its rootfs or from a workspace share.
- **Declare the need per placement.** The need is the bundle's; the mechanism
  is the placement's. Per-placement declarations are how a need gets written
  for one tier and lost in the next.
