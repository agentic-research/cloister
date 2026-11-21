---
title: "ADR-0080: The host runs the platform; every bundle is a guest"
status: Accepted (2026-11-21)
date: 2026-11-21
tags: [isolation, microvm, placement, platform, no-exemptions, prior-art]
tracking-bead: cloister-ca2582
relates_to:
  - 0044-compute-isolation-substrate.md
  - 0062-process-mode-is-an-exemption-not-a-posture.md
  - 0070-placements-and-channel-strength.md
  - 0078-needs-are-declared-once-every-placement-provides-them.md
  - 0079-microvm-runs-go-through-llo-execution-daemon.md
external_refs:
  - ley-line-open:docs/adr/0046-connection-broker.md
  - https://pve.proxmox.com/pve-docs/
---

# ADR-0080: The host runs the platform; every bundle is a guest

## Status

Accepted (2026-11-21), on the owner's direction that no bundle is exempt from
isolation by nature, and that "permanent" and "structural" are not reasons.
Amends ADR-0062.

## Context

ADR-0062 made `process` an exemption from the microVM posture rather than a
peer of it, and required each exemption to say why. It named one exemption
**structural and permanent**: "`cloister-router` is the host … you cannot put
the hypervisor inside its own guest." That claim did work. It is why ADR-0062
rejected two stricter rules, forbidding `process` outright and allowing it only
in development: "`cloister-router` needs it in production."

The claim confused two hypervisors. A microVM's hypervisor is libkrun, which
ley-line-open runs in a process of its own. The gateway is workerd, which keeps
Workers apart in V8 isolates. It starts no microVMs, so it can run inside one:
it keeps its isolates and gains a kernel boundary. Cloister is a hypervisor (V8
isolates) and a hypervisor of hypervisors (it places bundles, workerd ones
included, in microVMs), and the two layers stack.

The exemption records followed the same pattern. They were sorted into
STRUCTURAL, CONTINGENT and UNDECIDED. "Structural" asserts that no work could
remove an exemption. It turned out wrong for the gateway, and it rested on a
deleted file (`krunvm.rs`) for two others, while reading as settled. ADR-0062
deferred a stricter rule, requiring a reference rather than free prose, until
every exemption had a rationale. Every exemption has one now.

### Prior art: Proxmox VE

Proxmox VE is the shape this is heading toward, already built for KVM and LXC.

- **Only the platform runs on the host.** The host runs Proxmox's API, its
  replicated configuration store (pmxcfs, over corosync), the hypervisors, and
  the storage, bridge and firewall services. A workload never runs as a bare
  host process. The router many clusters put at their front door is itself a
  VM.
- **Guest types are peers, each with a stated boundary.** VMs and containers
  share one lifecycle (start, stop, migrate, back up), one configuration shape,
  and one storage and network model. A container's shared kernel is a known
  trade-off, and unprivileged containers are the default. Nothing is exempted
  from being a guest.
- **A guest's needs are first-class objects.**
  - A disk is a volume on a declared storage. It outlives a restart, it can be
    snapshotted and backed up, and a migration refuses when the target node
    lacks it.
  - A guest runs until it is stopped.
  - The host reaches into a guest over the guest agent's own channel.
  - Backups and templates are content-addressed: Proxmox Backup Server stores
    deduplicated chunks by digest, and a linked clone is a cheap copy of a
    template.

Cloister is stricter in one place, deliberately. A Proxmox guest gets a network
card on a bridge, filtered by a firewall. A cloister guest gets no network card,
only the channels it declares (confinement/v1 §6). The broker
(ley-line-open-e2c5ce) is cloister's bridge and firewall in one.

## Decision

### 1. The host runs the platform, and nothing else

The platform is what starts, connects and supervises guests:

- cloister's host runtime and ley-line-open's execution daemon (ADR-0079);
- the broker;
- the signing and key helpers (ADR-0019).

These are not bundles, and they are not declared in `[[bundles]]`.

### 2. Every bundle is a guest

A bundle runs in a microVM, in a container, or on a forwarded placement
(ADR-0070). The gateway is a bundle like any other: it parses untrusted MCP
traffic, which is guest work, and it fronts the cluster the way a router VM
fronts a Proxmox cluster.

### 3. `process` means "not yet a guest", and names its exit

`executionMode = "process"` stays in the schema while bundles still use it, and
its meaning changes. It no longer says isolation is impossible for the bundle.
It says the bundle is not yet a guest.

- No rationale is "structural" or "permanent", and the category labels are
  retired. A rationale says what the bundle needs that no guest placement gives
  it yet.
- A rationale **names its exit**: at least one work item that, once done,
  removes the exemption. That is a bead (`cloister-5fe44f`), an issue
  (`ley-line-open#600`) or an ADR (`ADR-0079`).
- `lint:bundle-isolation` Inv 13 checks that an exit is named. Inv 15 checks
  that any file a rationale cites exists. The rail checks presence, not
  truth, as ADR-0062's did; the exit is what a reviewer follows.

Forbidding `process`, the alternative ADR-0062 rejected, is the end state. It
is reached by retiring each exemption, not by declaring it.

### 4. What Proxmox gives a guest, cloister owes as a declared need

Each is a need in the sense of ADR-0078: declared once, and provided by every
placement or refused by name.

| Proxmox | cloister | Status |
|---|---|---|
| volumes that outlive a restart | state across runs | ley-line-open#600 |
| guests run until stopped | `runs = "service"` gets no wall-clock ceiling | ley-line-open-e6b1bb |
| bridges and firewall | declared connections, through the broker | ley-line-open-e2c5ce |
| a socket into the guest, as well as TCP | a channel presented as a Unix socket | ley-line-open#601 |
| a guest's own disk image | a workspace served at `/work` | ADR-0079, ley-line-open#602 |
| migration refuses a missing need | every placement provides each need or refuses | ADR-0078 |
| content-addressed backups, linked clones | CAS rootfs, per-run copy | shipped |

## Consequences

- The four exemptions are rewritten to lead with what each needs and to name
  their exits. None is called structural or permanent.
- ADR-0062's permanence claim and the two rejections that rested on it are
  withdrawn there by an amendment note. Its "require a reference" alternative
  is adopted here.
- A new bundle cannot record an exemption without a work item, so an exemption
  can only be written as something to finish.

## Alternatives considered

- **Keep the categories and add the exit.** "Structural" still asserts that
  no exit exists, beside a field that names one. A category that can be wrong
  for months while reading as settled is the failure this replaces.
- **Forbid `process` now.** Four bundles run as processes today, in compose and
  in development. Forbidding it before their exits are built would remove
  those placements, and lose what ADR-0078 says no change may lose.
