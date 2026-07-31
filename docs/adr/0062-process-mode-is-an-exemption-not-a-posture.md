---
title: "ADR-0062: `process` is an exemption, not a posture"
status: Accepted (2026-07-31)
date: 2026-07-31
tags: [isolation, confinement, execution-mode, schema, fail-closed]
relates_to:
  - 0048-unified-tool-primitive.md
  - 0044-compute-isolation-substrate.md
  - 0011-hypervisor-bundle-boundary.md
  - 0042-turnkey-harness-dev-run.md
---

# ADR-0062 — `process` is an exemption, not a posture

## Context

ADR-0048 made the sandbox one of the four tool facets a bundle must declare
rather than leave ambient, and `lint:bundle-isolation` Inv 13 enforces it: every
external bundle names an `executionMode`, and it must be one the host runtime
implements. Today that is `microvm` or `process`.

Inv 13 worked, in the sense it was built for. Before it, four of five bundles
left the facet unstated and `emit-host-launch-plan.mjs` would have refused them
at launch — a deferred hard failure nothing surfaced. After it, every bundle
declares.

What they declare is the problem:

| bundle | mode | justified in the manifest? | what it holds |
|---|---|---|---|
| `cloister-router` | `process` | yes — it **is** the workerd host, so it cannot be a microVM of itself | Durable Object state |
| `rosary` | `process` | yes — dispatches host subprocess agents, git worktrees, Keychain | beads |
| `notme-identity` | `process` | **no reason given** | Signet master CA, lease cert mint |
| `notme-proxy` | `process` | **no reason given** | bridge cert + private key |
| `mache` | `microvm` | — | code index |

Four of five run with no isolation, and the isolation substrate this project
exists to provide is used by exactly one bundle. Two of the four give no reason
at all — and they are the two holding the highest-value secrets in the cluster.
`notme-proxy`'s own `hypervisorRationale`, in the same manifest entry, says its
"compromise blast radius is every upstream the cluster reaches".

The schema treats `microvm` and `process` as peers. Nothing in the type, the
rail, or the operator surface says one of them means *no isolation at all*. So
"no isolation" is reachable by writing a word that looks exactly as legitimate
as its alternative, and two bundles reached it without anyone deciding to.

This is a familiar shape here, one step further along than usual. The repo's
recurring defect is an invariant that is stated and never invoked. This is the
next one: an invariant that IS invoked, by a rail that accepts the wrong answer
as readily as the right one. **Making a choice explicit is not the same as
making it correct** — Inv 13 moved the answer into the manifest and stopped
there.

## Decision

`process` stops being a peer of `microvm` and becomes a **declared exemption**:
a bundle asserting that isolation is impossible for it, with the reason recorded
where the rail can check that a reason exists.

1. **`microvm` is the default posture.** A bundle that says nothing gets the
   isolated one. (Inv 13 currently fails an unstated mode; that stays, because
   silence about a security posture is still worth a hard error — but the
   *meaning* of the default changes.)

2. **`process` requires a declared justification.** A new
   `executionModeRationale` field on the external facet, non-empty whenever
   `executionMode = "process"`, in the same shape as `hypervisorRationale` on
   `Bundle` (ADR-0011) — which exists for exactly this reason and is exactly the
   precedent. A rail checks presence, not prose: the rail cannot judge whether
   an argument is good, only that someone was made to write one down.

3. **The exemption is visible.** `lint:bundle-isolation` reports the count of
   `process` bundles on every run, the way Inv 10 warns rather than hiding. A
   cluster where four of five are exempt should say so out loud rather than
   pass silently.

Three of today's four exemptions are, or may be, legitimate:

- `cloister-router` is the host. This is structural and permanent — you cannot
  put the hypervisor inside its own guest.
- `rosary` dispatches host subprocesses. This ADR first called that exemption
  **contingent** on `rosary-56b557` making cloister a `ComputeProvider`, on the
  reasoning that it would remove the requirement. **That was wrong.** The work
  shipped (rosary #464) and the requirement remains: `CloisterProvider` confines
  the *dispatched agent* — each now runs under `cloister run` instead of as a
  bare host subprocess, a real gain — but rosary itself is what spawns them.
  **Confining what a process spawns is not the same as confining the process.**

  Worth keeping visible rather than quietly amending: an exemption carrying the
  *wrong* expiry condition is more dangerous than one carrying none, because it
  reads as handled. The mechanism still did its job — writing the condition
  down is precisely what let someone else check it and find it false.
- `notme-identity` and `notme-proxy` are **unknown**. Nobody wrote a reason, so
  nobody can say whether one exists. That is the gap this ADR closes: today
  their posture is indistinguishable from an oversight, because it may be one.

## Alternatives considered

**Leave it as is; the rail already forces a declaration.** Rejected on the
evidence. Inv 13 has been in force and two bundles still hold master-CA-grade
secrets in an unisolated process with no stated reason. A rail that accepts both
answers equally selects for whichever is easier to write, and `process` is
easier because it is what already worked.

**Forbid `process` outright.** Rejected: `cloister-router` is a permanent,
structural counter-example. A rule with a standing exception needs to model the
exception, or the exception becomes an ignored rule.

**Make `process` dev-only, behind `CLOISTER_MODE=dev`** — the operator's first
instinct, and the ADR-0042 `lint:no-dev-mode` pattern. Rejected for the same
reason: `cloister-router` needs it in production, so a dev-only gate would be
violated on day one by the host itself. The justification requirement gets the
same effect (you cannot ship "no isolation" without saying why) without a rule
the substrate immediately breaks. Worth revisiting if the router's case is ever
modelled separately from bundle execution.

**Require an ADR reference rather than free prose.** Attractive — it would make
the justification reviewable rather than merely present. Deferred: two of the
four exemptions have no analysis at all yet, and demanding an ADR per exemption
before any of them has a reason written down is a barrier to recording the truth.
Revisit once every exemption carries a rationale.

## Consequences

- A schema field is added to the external facet. Per ADR-0004 it is appended,
  monotonically numbered, never renumbered.
- `notme-identity` and `notme-proxy` must either justify their exemption or move
  to `microvm`. **Nobody currently knows which**, and that is the finding.
- `rosary`'s exemption was given an expiry condition, which turned out to be the
  wrong one — see above. That is the mechanism working, not failing.
- The lint gains one rail and one always-on report. Per this repo's rule, the
  rail ships in the same change as the rule, with a test asserting the shipped
  tree satisfies it.
- `microvm` becoming the default means a future bundle that forgets is safe by
  omission rather than exposed by omission.

## Status of the claim

Shipped with the rail, per this repo's rule that a substrate rule and its
enforcement land together. `executionModeRationale` is on the external facet,
Inv 13 fails an unjustified `process`, the exemption count is reported on every
lint run, and four tests cover it — including one against the shipped tree,
which is the assertion that would have failed before this change.

Implementing it turned up something the ADR had not: **only `mache` can emit a
launch plan at all.** All four `process` bundles fail `emit-host-launch-plan` on
a *different* precondition — no `entryPoint`:

```
mache             PLAN OK
notme-proxy       FAILS: requires an absolute external.entryPoint
notme-identity    FAILS: requires an absolute external.entryPoint
rosary            FAILS: requires an absolute external.entryPoint
cloister-router   FAILS: requires an absolute external.entryPoint
```

So `process` on those four was never a security decision. It is the value in a
bundle the host runtime **cannot launch in either mode**. Inv 13 was written
because leaving the facet ambient "defers the failure to `task runtime:plan`
instead of reporting it here" — and it checked one of that consumer's
preconditions while hand-mirroring it, so the deferred failure it existed to
eliminate survived, for the same bundles, at the same consumer, one line
further down. **A rail that mirrors a slice of its consumer inherits exactly the
gap it was built to close.** Tracked as `cloister-8ae1f2`.

The two `UNDECIDED` rationales now in `cluster.toml` say precisely that. Writing
the field is what forced the distinction between "we decided not to isolate
this" and "nobody decided anything", and the answer was the second one.
