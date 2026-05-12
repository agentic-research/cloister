---
title: "ADR-0020: Cloister adversarial red-team rotation — charter"
status: Proposed (2026-05-12) — charter for the 7-role adversarial reviewer rotation (cloister-1f249f)
date: 2026-05-12
tags: [security, governance, threat-model, red-team, ops, reviewer-rotation]
threat_model: docs/security/threat-model.md
relates_to:
  - 0007-interlace-substrate.md
  - 0010-vault-and-bundle-clusters.md
  - 0011-hypervisor-bundle-boundary.md
  - 0013-slice-grant-enforcement.md
  - 0014-pluggable-kek-source.md
  - 0018-notme-co-location.md
  - 0019-sign-only-helper-protocol.md
---

## Context

Cloister's existing reviewer rotation has two strong specialties:

- **math-friend** (`theoretical-foundations-analyst`) — cryptographic
  correctness, protocol design, formal posture.
- **code-architect** — substrate shape, ADR coherence, decade/thread
  topology.

A 5-why exercise on 2026-05-12 (cloister-1f249f) — prompted by Gemini's
self-DoS framing for the compromised-agent threat model — surfaced a
recurring gap. Every major drift this session traced back to the same
structural bias: **pioneer-mode under-resources the ops-shaped half of
the substrate.** The mechanism for slice-grant enforcement shipped
(ADR-0013); the per-bundle accounting that makes the mechanism
enforceable against a *hostile* bundle did not. Threat-model rows
cover what gets exfiltrated, not what gets exhausted. The disclosure
endpoint's constant-time-404 fix (§9.4.b) is the only ops-shaped
adversarial closure in the threat model today, and it was found by
math-friend in passing — not by a dedicated reviewer.

The gap is structural, not personnel. Adding "more discipline" doesn't
close it. Adding a missing reviewer role does.

## Decision

Establish a 7-role adversarial reviewer rotation. Six specialists, one
synthesis lead. Specialists are read-only; only the synthesis lead has
write access (to threat model, ADR record, bead-thread topology).

| Role | Colloquial | Threat class |
|---|---|---|
| `dos-resilience-auditor` | dos-friend | Resource exhaustion, self-DoS, fairness, queue saturation |
| `enumeration-oracle-hunter` | oracle-friend | Side-channel + response-shape oracles |
| `bundle-isolation-tester` | isolation-friend | Cross-tenant slice escapes, manifest misconfig |
| `protocol-replay-adversary` | replay-friend | Replay, epoch confusion, chain forking, partial-failure replay |
| `trust-root-adversary` | trust-root-friend | Helper-binary tamper, keystore confusion, kid collisions, signer rotation |
| `observability-gap-auditor` | silence-friend | Silent failures, alert deadlock under load, "silence is evidence" boundary conditions |
| `adversarial-synthesis-lead` | synthesis-friend | Cross-cut integration, threat-model owner |

Agent definitions live at `~/github/jamestexas/agents/agents/` and
follow the existing convention (frontmatter, persona, scope,
look-for, ignore, output format, bead-creation pattern, Golden Rules
reference). The synthesis lead's output cycle produces two artifacts:
a threat-model patch and a markdown synthesis report under
`docs/security/adversarial-cycles/YYYY-MM-DD.md`.

**Bead tagging.** Findings are filed with the `red-team:<class>`
label (`red-team:dos`, `red-team:oracle`, etc.) so the synthesis lead
can pull all findings of a class at cycle close. Cross-cut beads from
synthesis carry `red-team:synthesis`.

**Cadence.** Weekly dispatch of the six specialists, synthesis on
Friday. Cycle skip is acceptable if no surface changed in the prior
week. Quarterly trend report comes from synthesis-lead.

**Calibration.** "Complete safety" is not the target. The honest
target is complete coverage of *known* threat classes under
*documented* assumptions, with adversary cost ≥ N× defender cost for
some defensible N (per finding). Unknown unknowns are why the
rotation stays in place, not why we declare victory.

## Rationale

**Why seven, not one ("just hire more math-friends").** The threat
surface has distinct shapes — crypto correctness, resource economics,
side channels, protocol state, supply chain, observability. A
generalist reviewer recognizes some but misses others. The specialist
team makes the missing axis visible by *its absence on the roster*,
not by relying on a single reviewer to remember everything.

**Why read-only.** Adversarial reviewers conflict-of-interest into
defenders if they can patch. Their value depends on the engineering
team — feature-dev, principal-agent, dev-agent rotations — owning the
fix. Mirrors the discipline `skeptic-agent` (rosary) already holds.

**Why a synthesis lead.** Six specialists will find overlapping
symptoms of one underlying gap. Without integration, the engineering
team sees six beads and fixes six surfaces. With integration, the
team sees one bead and fixes the gap. The lead is the only role
authorized to update the threat model because that's where
integration *lives* — every finding either becomes a row, refines a
row, or gets logged as accepted residual risk with rationale.

**Why include `trust-root-adversary` when `security-auditor` exists.**
`security-auditor` is broad-spectrum (supply chain, OIDC, key
management generally). `trust-root-adversary` is cloister-specific —
focused on the small set of long-lived keys, helper binaries, CA
bundles, and KEK sources whose compromise breaks everything
downstream. The two complement; trust-root-adversary is the focused
recurring rotation, security-auditor is the broad audit cycle.

## Consequences

**Velocity cost.** A weekly cycle is ~2–4 hours of dispatched work
plus synthesis. At pre-launch project size this is a meaningful share
of total review time. The trade is real but it's the smaller cost
than the first user-facing security incident.

**Bead volume.** Each cycle will produce ~3–15 findings. Most will be
P2/P3 (residual risk, paper claims to pin with tests). The P1s — the
load-bearing ones — drive ADR drafts or new threat-model rows.

**ADR pressure.** Some findings will require new manifest fields,
new substrate components, or new wire formats. Drafting those ADRs
falls to code-architect and the engineering rotation. The
adversarial team surfaces; the engineering team builds.

**Observability layer comes first.** The first cycle's likely output
is `vault_call_budget` (per-bundle accounting) and a constant-shape
collapse of the vault 403/404 distinguishability. Both are
prerequisites for downstream findings to be enforceable.

**Personnel.** The user is ops by trade and will likely run the
synthesis-lead role manually for the first 2–3 cycles before
delegating. The six specialists run as dispatched subagents (Task
tool or rsry dispatch). Output volume should be manageable in this
arrangement.

## Status notes

- Charter ADR (this doc): Proposed pending ratification.
- Bead: cloister-1f249f tracks ratification + first-cycle pilot.
- Pilot: dos-resilience-auditor dry-run against `src/vault-store.ts`
  this session (2026-05-12) produces the first concrete adversarial
  posture report. Result will be appended to the bead's comments.
- Threat-model "Availability" section: does not exist yet; proposed by
  dos-friend in the pilot. Synthesis-lead promotes if pilot lands.
