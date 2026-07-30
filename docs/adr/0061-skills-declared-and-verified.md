---
title: "ADR-0061: Skills are declared and digest-verified, not discovered"
status: Accepted (2026-07-30)
date: 2026-07-30
tags: [skills, delivery, confinement, attestation, schema]
relates_to:
  - 0043-delivery-plane-skills-agents-tools.md
  - 0042-turnkey-harness-dev-run.md
  - 0026-tool-composition-model.md
---

# ADR-0061 — Skills are declared and digest-verified, not discovered

## Context

`cloister run` confines a harness, and confinement is inherited by everything it
execs. Measured three levels deep, across a language boundary:

```
[d0] sh        granted repo:      REPO-FILE
[d1] sh child  ungranted sibling: Operation not permitted
[d2] python    ~/.ssh:            Operation not permitted
[d2] python    egress:            PermissionError [Errno 1]
```

So a skill's bash spawning python spawning a network call is already bounded. A
`skills.sh` that pulls from the internet fails before a packet leaves.

What is NOT bounded is **which skills ran**. They arrive by filesystem:
`stateDir = ".claude"` is granted rw and `~/.claude/skills` sits under it. So
"run an arbitrary skill" today means "whatever happens to be in that directory"
— unpinned, unverified, unrecorded. And because the directory is writable, a
skill can write other skills.

Confinement answers *how much damage*. It does not answer *what ran*, and that
second question is the one an operator has to answer to a colleague.

## The constraint, measured

The obvious fix — grant the state dir rw and the skills subdirectory read-only —
does not work. nono's grants are a **union, not an intersection**:

```
nono run -a <state> -r <state>/skills -- sh -c 'echo y > <state>/skills/w2.txt'
→ WROTE — the read grant did NOT narrow the rw parent
```

and `deny` is a full deny rather than a write-deny. **A read-only subtree inside
a writable tree is not expressible in the current manifest.** Any design that
assumes otherwise is building on something that does not hold.

## Decision

**Skills are DECLARED in the manifest and DIGEST-VERIFIED before the run mints
anything.** A `[[gateway.skills]]` entry names a skill, its source path, and its
expected digest. `resolvePlan` verifies every declared skill and refuses the run
on mismatch — the same fail-before-side-effects ordering every other
precondition already follows (`cloister-eb27ae`).

The run then emits a **load receipt** naming each verified skill and digest, so
what loaded is recorded rather than inferred.

### What this does and does not give you

- **Does**: you know exactly which skills were present, by digest, before the
  harness started. A substituted or edited skill fails the run.
- **Does NOT**: prevent tampering *during* the run. The directory stays
  writable, because the constraint above says it must. A skill that rewrites a
  peer mid-run is detected on the NEXT run, not blocked in this one.

Stating that boundary plainly is the point. "Verified at load" is a real and
useful property; "immutable while running" is a different one we cannot honestly
claim with this substrate.

## Alternatives

**Move skills outside the state dir** and point the harness at them. Cleanest,
and it would give genuine read-only. Rejected *for now* only because it requires
the harness to support a skills path independent of its config dir, which is
unverified for Claude Code — if skills load only from `$CLAUDE_CONFIG_DIR/skills`
it collapses into the next option. Worth revisiting the moment someone checks.

**cloister owns the whole config dir** (`CLAUDE_CONFIG_DIR` → a cloister-owned
path). Strongest isolation, and it would make skills read-only by construction.
Rejected now because the harness loses the user's settings and auth, and
audit-mode auth is already unavailable under confinement (`cloister-72f540`) —
compounding two auth problems to solve one delivery problem is the wrong trade.

**Do nothing and rely on confinement.** Rejected: confinement bounds damage, and
the question a colleague actually asks is "what ran?". An unanswerable question
is not made safe by a small blast radius.

## Consequences

- A skill must be declared to be trusted. An undeclared skill in the directory
  is reported, not silently honoured.
- Adding a skill is a manifest edit plus a digest — deliberately the same shape
  as adding an input (ADR-0026), because it is the same kind of act: admitting
  third-party content to a trust boundary.
- The receipt makes a run's skill set auditable after the fact, which is what
  ADR-0043 promised and did not yet deliver.
