# Autonomous-session prompt — finish the bidi TOML ↔ capnp pipeline

**Paste this prompt (or `claude -p "$(cat
docs/prompts/finish-bidi-toml-pipeline.md)"`) into a fresh Claude
Code session. The session must not stop until the feature is done.**

---

You are picking up `cloister-ae06f3` — the bidi TOML ↔ capnp pipeline.
This is the substrate-vocabulary work that lets operators declare
cluster shape in TOML, lowers to the existing capnp manifest, and can
roundtrip back to TOML. It's Phase 1 of the substrate-as-kernel arc
(`cloister-1b59a2`) — substrate-schema-neutral; no manifest schema
additions, just format pipeline.

**The branch is `feat/cloister-ae06f3-bidi-toml-pipeline`** (already
exists on origin, branched off main at `54bedcd` after PR #8 merged
the credential-isolation docs scaffold).

## Your standing directives

1. **You must not finish until the feature is done.** "Done" is
   defined in the "Definition of done" section below. Until those
   criteria are all met, keep working. No "I think this is a good
   stopping point" — read your work against the criteria and keep
   going.

2. **The plan is falsifiable.** Tests are the proof. If a test
   passes for the wrong reason (e.g. the assertion is too loose, the
   mock returns a hardcoded value, the test doesn't actually exercise
   the path), that's a failure of the proof, not a success. Strengthen
   the test before claiming the phase done.

3. **If the design hits a wall, evolve the design — don't silently
   work around.** Examples of "design hits a wall":
   - TOML can't round-trip a discriminated union losslessly because
     of an edge case the ADR didn't anticipate.
   - `@iarna/toml` (or whatever lib you pick) has a behavior that
     contradicts the plan.
   - The schema-bridge IR doesn't carry information you need.
   When this happens: update the bead with a comment, update ADR-0024
   (or the ADR you're working under) with the new constraint, update
   the failing tests to reflect the new reality, then continue. The
   ADR + tests + bead stay in sync with what the code actually does.
   **Never silently emit `z.unknown()`, `as any`, or any other "I'll
   come back to this" escape hatch.** This violates the fail-fast
   substrate convention.

4. **Use the existing patterns.** This repo has established
   conventions. Don't invent new ones:
   - Beads track work (`rsry_bead_comment` as you go).
   - Tests fail first (TDD); impl makes them green.
   - Schema-bridge is the codegen authority for capnp → other.
   - Manifest schema changes are append-only (ADR-0004).
   - Specs live in `cloister-spec/` or `interlace-spec/`; impls don't
     depend on impls.
   - Commit messages use the `[cloister-XXXXXX] type(scope):` shape;
     the commit-msg hook enforces it.

5. **Stop conditions (the only acceptable terminations):**
   - **(a) Done:** every criterion in "Definition of done" is met +
     PR is merged to main + STATUS.md is updated to move
     `cloister-ae06f3` from Blocked to Shipped.
   - **(b) Genuinely unresolvable blocker:** a decision needs human
     judgment that the ADR doesn't speak to (NOT a coding problem you
     can solve). File a bead comment explicitly framing the blocker
     in one paragraph, then stop. Examples of acceptable blockers:
     a load-bearing security tradeoff with no clear right answer; a
     dependency version conflict that requires a project-wide
     decision. Examples of NOT-acceptable blockers: "tests are
     failing" (fix them); "I'm unsure about an implementation
     detail" (make the call, document the rationale, continue).

## Context you need

Read these files before starting:
- `docs/STATUS.md` — project reality index. Tells you what's
  Shipped vs Drafted vs Blocked. Update it when this work ships.
- `docs/adr/0024-credential-isolation-capability.md` — template for
  the ADR shape this feature will need (you'll write an ADR for
  bidi-pipeline parallel to it).
- `tools/schema-bridge/README.md` — the codegen tool you're
  extending. Read the "What's mapped today" + "Deliberately unmapped"
  tables. Your work is adding a TOML emit/parse target alongside the
  existing zod target.
- `tools/schema-bridge/src/outputs/zod.rs` — the existing emit target.
  Your new TOML target sits beside it.
- `scripts/build-cluster.mjs` + `scripts/emit-compose.mjs` — existing
  capnp-eval pipeline that produces `src/generated/cluster.ts` from
  `cluster.capnp`. Your work makes TOML the operator-facing source;
  this script becomes one of the consumers.
- `Taskfile.yml` — task `cluster:zod`, `cluster:zod:verify`,
  `cluster:zod:check-drift` are the existing schema-bridge tasks.
  You're adding `cluster:toml`, `cluster:toml:export`,
  `cluster:toml:roundtrip`.

Read these beads:
- `cloister-ae06f3` — this work. Description has the full deliverable
  list.
- `cloister-1b59a2` — substrate-as-kernel framing this feeds into.
- `cloister-ae587d` — ADR-0022 schema-bridge positioning. **Land this
  ADR first** if it's not already there; it sets the schema-bridge
  framing that your bidi pipeline lives under.
- `cloister-9ea507` — schema-bridge top-level `const` support.
  Probably NOT a prerequisite for bidi (cluster.capnp has no
  top-level consts) but check.

User feedback shaping the work:
- "Speak a language" — the manifest IS the substrate vocabulary; TOML
  is the operator-facing dialect; capnp is the substrate dialect.
  schema-bridge is the compiler between them.
- "Imperative we make sure it's bidi" — every Phase 2 schema addition
  (later work) must round-trip TOML ↔ capnp losslessly or with
  explicitly-documented loss. This Phase 1 lays that rail.
- Substrate-as-kernel framing (cloister-1b59a2): TOML overlay is the
  operator-facing surface; capnp stays the substrate schema. They are
  two views of the same data.

## Definition of done

**All of the following must be true:**

1. **Six files exist** (per `cloister-ae06f3` deliverable list):
   - `scripts/toml-to-cluster.mjs` — TOML → JSON → validate against
     `ClusterSchema` from `src/generated/cluster.zod.ts` → emit
     `src/generated/cluster.ts`. Validation FAILS the build if
     the JSON doesn't conform.
   - `scripts/cluster-to-toml.mjs` — `src/generated/cluster.ts` →
     JSON → canonical TOML (deterministic key order, stable
     inline-vs-multiline formatting; data-faithful, comments not
     preserved in Phase 1).
   - `cluster.toml` at repo root — derived from current
     `src/generated/cluster.ts` state. Becomes the authoritative
     operator source going forward; `cluster.ts` becomes a generated
     artifact like `cluster.zod.ts`.
   - `test/cluster-toml-roundtrip.test.ts` — golden test proving
     TOML → capnp → TOML preserves shape byte-equal (or with
     documented diff allowance for known reorderings).
   - `docs/adr/0025-bidi-toml-pipeline.md` (or whatever next ADR
     number is free — check `docs/adr/` for next sequential) —
     records the decision, library choice, comment-preservation
     tradeoff, future extensions (Phase 2 schema additions ride
     this rail).
   - Updates to `Taskfile.yml`, `README.md`, `GETTING-STARTED.md` per
     the bead description.

2. **All tests pass.** `task lint` green. The new
   `test/cluster-toml-roundtrip.test.ts` must:
   - Load `cluster.toml`, lower to capnp shape, emit JSON, re-emit
     TOML, byte-diff against `cluster.toml`. Pass.
   - Load `src/generated/cluster.ts` directly, emit TOML, byte-diff
     against `cluster.toml`. Pass.
   - Fail with a clear error if `cluster.toml` violates the schema.
   - Cover at least one "schema-conformant-but-semantically-wrong"
     case (e.g. wire pointing at a nonexistent bundle) and assert it
     fails validation with a clear message.

3. **The bidi rail is real.** Manually verify by:
   - Editing `cluster.toml` (e.g. add a bundle).
   - Running `task cluster:toml` — produces a new
     `src/generated/cluster.ts`.
   - Running `task cluster:toml:export` — produces a new TOML that
     byte-equals the edited input.
   - Running `task cluster:toml:roundtrip` — passes.

4. **PR is open + merged to main.** Self-review your work before
   merging (read your own diff with fresh eyes; if something feels
   half-baked, fix it). Address any Copilot inline comments
   completely (file → resolve, not just acknowledge).

5. **`docs/STATUS.md` is updated** to move `cloister-ae06f3` from
   "Blocked" to "Shipped." Add the PR number, the ADR reference, and
   any new Taskfile entries to the relevant sections.

6. **Bead `cloister-ae06f3` is closed** via `rsry_bead_close` after
   the PR merges.

## Reasonable design choices that are NOT design questions

If you find yourself uncertain about these, just pick one and continue:
- **TOML library:** `@iarna/toml` (MIT, mature, canonical output).
  Pin it via `pnpm add`.
- **Comment preservation:** Phase 1 is data-faithful, NOT
  comment-preserving. Operators who add `# notes` to `cluster.toml`
  lose them on round-trip. Document this in the ADR; file a P3
  follow-up bead.
- **Key ordering:** alphabetical per TOML spec where the spec
  defines it; otherwise stable insertion order from capnp's
  declaration order.
- **Discriminated unions in TOML:** flatten to `kind = "<name>"` +
  sibling shape-specific fields. This is the standard TOML pattern.
- **Schema validation:** use the existing `ClusterSchema` from
  `src/generated/cluster.zod.ts` (zod). Don't re-validate at the
  TOML level; let zod be the source of truth.

## What to expect from the work

Rough effort: **2-3 focused days.** Most of the time is in
`scripts/cluster-to-toml.mjs` (canonical emission is fiddly) and
the golden roundtrip test. The `toml-to-cluster.mjs` side is mostly
delegation to `@iarna/toml` + zod validation.

The codepath is mostly mechanical once the design choices land. The
hard part is the byte-equal roundtrip; budget more time than you
think for canonicalization (sort keys, inline-vs-multiline arrays,
escape encoding, trailing newlines, etc.).

## Reporting cadence

Update `cloister-ae06f3` with a comment per phase (TOML reader done /
TOML writer done / roundtrip test green / ADR drafted / PR open / PR
merged). The user is intentionally hands-off until done; the bead
comments are your record.

If a `<task-notification>` arrives mid-flight, handle the event and
continue working. Don't wait for human input unless you've hit an
acceptable blocker per directive 5(b).

## When you've finished

Send one final message summarizing:
- PR # + merge SHA.
- New Taskfile entries.
- Any design evolutions that landed (and the bead comment that
  documents them).
- Confirmation that STATUS.md updated + bead closed.

Then stop.
