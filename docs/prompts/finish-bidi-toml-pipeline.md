# Brief for `/rosary:evolve` — finish bidi TOML ↔ capnp pipeline

**For invoking `/rosary:evolve` against `cloister-ae06f3`.**

```sh
# At cloister repo root, on branch feat/cloister-ae06f3-bidi-toml-pipeline:
/rosary:evolve --focus cloister-ae06f3

# Or compose with /loop for autonomous continuation:
/loop 15m /rosary:evolve --focus cloister-ae06f3
```

The `/evolve` skill's scoping-agent reads this file + the bead +
the plan (`docs/plans/bidi-toml-pipeline.md`) and writes a
worktree-local `plan.md`. Generator agents (dev-agent for impl;
principal-agent if `--simplify` mode comes up) implement; the
skeptic / staging agent gates each commit; team lead commits when
green.

This document is the **contract** the scoping-agent reads. It
codifies what the agents must NOT do, what "done" looks like, and
when stopping is acceptable.

---

## Goal (one sentence)

Implement the bidi TOML ↔ capnp pipeline per
`docs/plans/bidi-toml-pipeline.md`. Ship `cluster.toml` at repo
root as the operator-facing source; `cluster.ts` becomes derived.
schema-bridge mediates. Tests prove the bidi rail.

## Standing directives (read before scoping)

**1. Don't stop until the feature is done.** "Done" is defined
below. Until every criterion is met, keep working. No "I think
this is a good stopping point" — read your work against the
criteria.

**2. The plan is falsifiable.** Tests are the proof. A test that
passes for the wrong reason (assertion too loose, mock returns
hardcoded value, doesn't exercise the actual path) is a failure of
the proof. Strengthen tests before claiming phases done. The
skeptic-agent / staging-agent's job in /evolve is exactly this
adversarial check; respect their findings.

**3. If the design hits a wall, evolve the design — don't
silently work around.**

Examples of "design hits a wall":
- `@iarna/toml` has a behavior that contradicts the plan's
  canonicalization rules.
- TOML can't round-trip a discriminated union shape losslessly.
- The schema-bridge IR doesn't carry information needed for the
  writer.

When this happens:
- Update `cloister-ae06f3` with a bead comment naming the wall.
- Update `docs/plans/bidi-toml-pipeline.md` (or ADR-0025 once
  drafted) with the new constraint.
- Update failing tests to reflect the new reality.
- Continue.

**Never silently emit `z.unknown()`, `as any`, or "// TODO: fix
later" escape hatches.** This violates the fail-fast substrate
convention (see `tools/schema-bridge/README.md` for the
substrate-wide rule).

**4. Use existing patterns.** This repo has established
conventions:
- Beads track work; comment as you go via `rsry_bead_comment`.
- Tests fail first (TDD); impl makes them green.
- schema-bridge is the codegen authority for capnp → other
  targets.
- Manifest schema changes are append-only (ADR-0004) — though
  Phase 1 has NO schema changes.
- Specs live in `cloister-spec/` or `interlace-spec/`; impls don't
  depend on impls.
- Commits: `[cloister-ae06f3] type(scope): description`. The
  commit-msg hook enforces it; `.rsry-bead-id` pin auto-prefixes.
- For `/evolve`: **no per-agent commits** — generator stages
  changes, evaluator gates, team lead commits.

**5. Stop conditions (the only acceptable terminations):**

**(a) Done:** every criterion in "Definition of done" below is
met + PR is merged to main + `docs/STATUS.md` is updated to move
`cloister-ae06f3` from Blocked to Shipped + bead closed.

**(b) Genuinely unresolvable human-judgment blocker:** a decision
needs human judgment the plan / ADR doesn't speak to. File a bead
comment with one paragraph framing the blocker, then stop.

Acceptable blocker examples:
- A load-bearing security tradeoff with no clear right answer.
- A dependency version conflict requiring a project-wide
  decision.

NOT-acceptable blocker examples:
- "Tests are failing." → fix them.
- "I'm unsure about an implementation detail." → make the call,
  document the rationale in the bead, continue.
- "The library doesn't do X." → evolve the design per directive
  3, document, continue.

## Required reading (scoping-agent does this first)

Before writing `plan.md`, read:

1. `docs/STATUS.md` — project reality index. Tells you what's
   Shipped vs Drafted vs Blocked. You'll update it when this work
   ships.
2. `docs/plans/bidi-toml-pipeline.md` — the canonical plan
   for this work. The 10 phases. Your worktree-local `plan.md`
   adapts (NOT replaces) this.
3. `docs/adr/0024-credential-isolation-capability.md` — template
   for the ADR you'll draft (`docs/adr/0025-bidi-toml-pipeline.md`).
4. `tools/schema-bridge/README.md` — codegen tool you're
   extending. Pay attention to "What's mapped today" + the
   fail-fast invariant.
5. `tools/schema-bridge/src/outputs/zod.rs` — the existing emit
   target. Your TOML reader/writer sit beside it as scripts (NOT
   as a new schema-bridge emit target in Phase 1 — that's Phase 2
   territory).
6. `scripts/build-cluster.mjs` — existing capnp-eval pipeline.
   Your TOML reader replaces this AS the source-of-truth path
   eventually; in Phase 1 they coexist.
7. `Taskfile.yml` — existing `cluster:zod` / `cluster:zod:verify`
   / `cluster:zod:check-drift` tasks. Your new tasks
   (`cluster:toml` / `:export` / `:roundtrip`) mirror their shape.

Required beads to know about:
- `cloister-ae06f3` — this work.
- `cloister-1b59a2` — substrate-as-kernel framing this feeds
  into. Comment when Phase 9 closes.
- `cloister-ae587d` — ADR-0022 schema-bridge positioning
  (overdue). NOT a hard blocker; ship bidi without it, but a
  parallel PR drafting ADR-0022 is welcome.
- `cloister-9ea507` — schema-bridge top-level `const` support.
  Probably NOT a prerequisite (cluster.capnp has no top-level
  consts) but verify in scoping.

## Definition of done

**All must be true:**

1. **ADR-0025 drafted** at `docs/adr/0025-bidi-toml-pipeline.md`.
   Marked Accepted (or Drafted with reviewer named). Per the plan
   Phase 1.

2. **Six files exist:**
   - `scripts/toml-to-cluster.mjs` — TOML → JSON → zod-validate →
     `cluster.ts`.
   - `scripts/cluster-to-toml.mjs` — `cluster.ts` → JSON →
     canonical TOML.
   - `cluster.toml` at repo root — generated from current
     `src/generated/cluster.ts` state; becomes authoritative source.
   - `test/cluster-toml-roundtrip.test.ts` — TDD baseline; all
     tests turn green by Phase 5.
   - `docs/adr/0025-bidi-toml-pipeline.md` — design ADR.
   - Updates to `Taskfile.yml`, `README.md`,
     `GETTING-STARTED.md`, `docs/STATUS.md` per plan Phases 6/7/8.

3. **All tests pass.** `task lint` green. The new tests in
   `test/cluster-toml-roundtrip.test.ts` cover (per plan Phase 2):
   - Forward parse + zod-validate.
   - Schema-violation rejection.
   - Semantic-violation rejection (wire references nonexistent
     bundle).
   - Canonical-write deterministic.
   - Discriminated-union TOML shape.
   - Void-union variant TOML shape.
   - TOML → cluster.ts → TOML byte-equal.
   - cluster.ts → TOML → cluster.ts semantically-equivalent.

4. **Manual bidi verification:**
   - Edit `cluster.toml` (add a bundle).
   - `task cluster:toml` regenerates `cluster.ts`.
   - `task cluster:toml:export` produces TOML that byte-equals
     the edited input.
   - `task cluster:toml:roundtrip` passes.

5. **PR is open + merged to main.** Self-review your work before
   merging (read your own diff with fresh eyes). Address any
   Copilot inline comments completely (file changes → resolve, not
   just acknowledge). Use the existing PR review skill
   (`pr-respond`) if useful.

6. **`docs/STATUS.md` updated.** `cloister-ae06f3` moves from
   Blocked to Shipped. PR number, ADR ref, new Taskfile entries
   listed.

7. **Bead `cloister-ae06f3` closed** via `rsry_bead_close` after
   PR merges. Comment on `cloister-1b59a2` referencing Phase 1
   shipped.

## Reasonable design choices (NOT design questions)

If uncertain about these, pick the listed default and continue:

- **TOML library:** `@iarna/toml` (MIT, mature, canonical output).
  `pnpm add @iarna/toml`.
- **Comments:** Phase 1 is data-faithful, NOT comment-preserving.
  Document in ADR-0025; file P3 follow-up bead.
- **Key ordering:** declaration-order at top level; alphabetical
  within tables.
- **Discriminated unions in TOML:** flatten to `kind = "<name>"` +
  shape-specific siblings.
- **Schema validation:** zod via `ClusterSchema` from
  `src/generated/cluster.zod.ts`.
- **Drift check pattern:** mirrors `cluster:zod:check-drift`.

## /evolve-specific mechanics

When `/rosary:evolve --focus cloister-ae06f3` runs:

1. **scoping-agent** reads this brief + the plan + the bead.
   Writes worktree-local `plan.md` adapting the phases to the
   `/evolve` generator → evaluator handoff format. The plan in
   `docs/plans/bidi-toml-pipeline.md` is the canonical reference;
   the worktree `plan.md` is the operational version.

2. **Team composition** (per `/evolve`'s scaling rules):
   - 2-5 files, same module → generator + evaluator.
   - This work is 4-6 files (scripts + tests + ADR + docs + Taskfile
     + cluster.toml) but spans `scripts/`, `test/`, `docs/`,
     `manifest/` — full pipeline applies: scoping + generator +
     evaluator + skeptic.

3. **Generator: dev-agent.** Implements per the phases. Stages
   changes, does NOT commit.

4. **Evaluator: skeptic-agent + staging-agent.**
   - skeptic-agent: assumes wrong until proven. Reviews each
     phase's tests for "passing for the wrong reason" (loose
     assertions, hardcoded mocks, missing edge cases).
   - staging-agent: confirms tests test real behavior, not mocks.
   - Both must approve before team lead commits.

5. **Retry budget:** 3 attempts per phase per `/evolve`'s default.
   If a phase fails 3 times, post-mortem fires (pm-agent) and the
   prompt gets refined. Then the user's notified.

6. **Post-mortem** (after merge): pm-agent runs, captures what
   slowed the work, what prompts could be tighter. Findings get
   written back to this prompt file as durable improvements.

## /loop composition

For autonomous continuation across days:

```sh
/loop 15m /rosary:evolve --focus cloister-ae06f3
```

Fires every 15 minutes; idempotent. Once Phase 9 closes (bead
closed), the next /loop fire is a no-op. /loop auto-expires after
7 days; if not done by then, /loop re-invokes itself.

## When the autonomous session reports done

The pm-agent's final summary (or the dev-agent's, if working solo)
should hit these points:
- PR # + merge SHA.
- New Taskfile entries.
- Any design evolutions that landed (bead comment that documents
  them).
- Confirmation STATUS.md updated + bead closed.
- Brief retro: what worked, what didn't.

Then stop.
