> **SHIPPED 2026-05-17 — historical artifact.** This plan was
> executed end-to-end via PR #9 (bidi pipeline) + PR #12 (operator
> workflow chain) + PR #16 (README claims-table split). Bead
> `cloister-ae06f3` is closed. ADR-0025 is in
> [`docs/adr/0025-bidi-toml-pipeline.md`](../../adr/0025-bidi-toml-pipeline.md);
> `cluster.toml` is at the repo root; `task cluster:toml` chains
> both legs. Preserved here for audit trail + as a worked example
> of a TDD-shape plan run through to completion. See the generated
> [`adr/INDEX.md`](../../adr/INDEX.md) for current ADR status.

---

# Plan — Bidi TOML ↔ capnp pipeline (Phase 1)

- **Bead:** `cloister-ae06f3`
- **Framing:** Phase 1 of the substrate-as-kernel arc
  (`cloister-1b59a2`). Substrate-schema-neutral; lays the rail for
  Phase 2 schema additions to ride.
- **ADR (to be drafted):** `docs/adr/0025-bidi-toml-pipeline.md`
  (next free ADR number; check `docs/adr/` for the latest).

## How to read this plan

Mirrors the credential-isolation plan's TDD shape
(`docs/plans/credential-isolation-capability.md`). Each phase has a
test tranche; **impl makes the tranche green.** No phase ships
without its tests passing. Design evolutions land in the ADR + plan
+ tests in sync — never silently work around an unmet assumption.

## Goal (one sentence)

Operators declare cluster shape in TOML (`cluster.toml` at repo
root); cloister lowers it to capnp; cloister can roundtrip back to
TOML byte-equal. TOML is the operator surface; capnp stays the
substrate schema. schema-bridge mediates.

## Hard constraints

1. **Lossless roundtrip on the data layer.** TOML → JSON → capnp →
   JSON → TOML produces a byte-equal `cluster.toml`. Comments are
   NOT preserved in Phase 1; this is the only documented loss.
2. **Schema validation at the boundary.** TOML → JSON must pass
   `ClusterSchema` from `src/generated/cluster.zod.ts` before
   producing `cluster.ts`. Garbage in fails fast.
3. **No new manifest schema fields.** This plan is Phase 1 —
   substrate-schema-neutral. Phase 2 (`cloister-ae4ed2`) adds the
   `bundle.implements` / `wire.requires` fields; that's separate
   work blocked on the network-identity ADR.
4. **Existing pipelines keep working.** `task cluster:manifest`
   (capnp-eval) + `task cluster:emit` (compose YAML) continue to
   function. The new TOML path is additive; eventually `cluster.ts`
   becomes a derived artifact and the capnp-eval pipeline retires,
   but Phase 1 doesn't force that migration.

## Dependency rail

- **Consumes:** `tools/schema-bridge/` (capnp → zod). The emitted
  `ClusterSchema` is the validation authority for the TOML reader.
- **Library:** `@iarna/toml` (MIT, mature, canonical output). Pin
  via `pnpm add @iarna/toml`.
- **Specs touched:** none. This is format-pipeline work, not
  protocol work. (Phase 2 work later WILL touch
  `cloister-spec/...`.)

## Phases

### Phase 0 — Scaffold (this commit)

**Lands:** this plan doc + the `/evolve`-compatible prompt at
`docs/prompts/finish-bidi-toml-pipeline.md`.

**Tests:** none yet.

**Closes when:** the branch is pushed + the user invokes /evolve
against `cloister-ae06f3` OR a fresh session picks up the prompt.

### Phase 1 — ADR-0025 drafted

**Lands:** `docs/adr/0025-bidi-toml-pipeline.md` documenting:
- The decision (TOML overlay, capnp substrate, schema-bridge as
  compiler).
- Library choice (`@iarna/toml`) + why.
- Comment-preservation tradeoff (data-faithful in Phase 1).
- Canonicalization rules (key ordering, inline vs multiline arrays,
  escape encoding).
- Discriminated-union convention in TOML (`kind = "..."` +
  shape-specific sibling fields).
- How Phase 2 schema additions ride this rail (the bidi rail is
  what makes the substrate-as-kernel framing real).

**Tests:** none — ADR is design.

**Closes when:** ADR-0025 marked Accepted (or Drafted if needs
review) + linked from `docs/STATUS.md`.

### Phase 2 — Failing test baseline

**Lands:** `test/cluster-toml-roundtrip.test.ts` with red tests
describing the bidi contract. Stub modules
`scripts/toml-to-cluster.mjs` + `scripts/cluster-to-toml.mjs` exist
but throw `not implemented`.

**Tests (all failing):**
- `toml-to-cluster: parses cluster.toml, validates against ClusterSchema, emits cluster.ts`
- `toml-to-cluster: rejects TOML that violates ClusterSchema with a clear error`
- `toml-to-cluster: rejects TOML where a wire references a nonexistent bundle (semantic, not just schema)`
- `cluster-to-toml: emits canonical TOML from cluster.ts (deterministic key order)`
- `cluster-to-toml: discriminated unions emit as { kind = "...", ... }`
- `cluster-to-toml: void union variants emit as { kind = "...", "<name>" = null } or equivalent stable form`
- `roundtrip: TOML → cluster.ts → TOML produces byte-equal output`
- `roundtrip: cluster.ts → TOML → cluster.ts produces semantically-equivalent output (Zod validates both)`

**Closes when:** all tests fail with `not implemented`; `parseToml`
side-tasks (path parsing, etc.) may have green smoke tests.

### Phase 3 — TOML reader (`scripts/toml-to-cluster.mjs`)

**Tests this phase greens:**
- `parses cluster.toml, validates against ClusterSchema, emits cluster.ts`
- `rejects TOML that violates ClusterSchema with a clear error`
- `rejects TOML where a wire references a nonexistent bundle`

**Impl:** `@iarna/toml` parses TOML → JS object → validate via zod
`ClusterSchema.parse()` → render as a TS module (mirrors current
`scripts/build-cluster.mjs` output shape) → write
`src/generated/cluster.ts`.

The semantic validation (wire references existing bundle) goes
beyond schema validation — schema lets ANY string in `wire.from`
and `wire.to`. Cross-check after schema-parse.

**Closes when:** the 3 tests above pass.

### Phase 4 — TOML writer (`scripts/cluster-to-toml.mjs`)

**Tests this phase greens:**
- `cluster-to-toml: emits canonical TOML from cluster.ts (deterministic key order)`
- `cluster-to-toml: discriminated unions emit as { kind = "...", ... }`
- `cluster-to-toml: void union variants emit as { kind = "...", "<name>" = null }`

**Impl:** load `cluster.ts` (which exports `cluster` const), convert
to TOML via `@iarna/toml`'s `stringify`. Canonicalization rules:
- Top-level keys in declaration order from cluster-types.ts (NOT
  alphabetical — operators expect cluster name first, then bundles,
  then wires, then storage).
- Inside `[[bundles]]` entries: alphabetical by key.
- Arrays of tables (`[[bundles]]`) preserve declaration order from
  cluster.ts.
- Discriminated unions: flatten to `[bundles.kind]` table with
  `name = "..."` + shape-specific fields.

**Closes when:** the 3 tests above pass + existing Phase 3 tests
still pass.

### Phase 5 — Roundtrip test green

**Tests this phase greens:**
- `roundtrip: TOML → cluster.ts → TOML produces byte-equal output`
- `roundtrip: cluster.ts → TOML → cluster.ts produces semantically-equivalent output`

**Impl:** any reconciliation needed between reader + writer.
Likely: minor formatting tweaks in the writer to match the
canonical form the reader expects. May surface bugs in either
direction; fix until tests pass.

**Closes when:** all tests pass.

### Phase 6 — Taskfile integration

**Lands in `Taskfile.yml`:**
- `cluster:toml` — `node scripts/toml-to-cluster.mjs` (forward,
  TOML → cluster.ts).
- `cluster:toml:export` — `node scripts/cluster-to-toml.mjs`
  (reverse, cluster.ts → TOML written to `/tmp` or stdout for diff).
- `cluster:toml:roundtrip` — runs both, byte-diffs, fails on drift.
  Same shape as `cluster:zod:check-drift` (the schema-bridge drift
  check pattern is the precedent).

**Tests:** the existing test suite covers the underlying scripts;
this phase just wires the Taskfile entries. Verify by running
`task cluster:toml:roundtrip` and observing clean exit.

**Closes when:** Taskfile entries work end-to-end against the real
`cluster.toml`.

### Phase 7 — `cluster.toml` at repo root

**Lands:** `cluster.toml` at repo root, generated FROM the current
`src/generated/cluster.ts` state via `task cluster:toml:export`.
Becomes the authoritative operator source going forward.

`src/generated/cluster.ts` becomes a derived artifact (like
`src/generated/cluster.zod.ts` today). Future schema changes happen
in `cluster.toml`; `task cluster:toml` regenerates the TS.

**Tests:** confirm `cluster:toml:roundtrip` still passes against
the committed `cluster.toml`.

**Closes when:** the committed `cluster.toml` is the source of
truth; the existing capnp-eval pipeline (`build-cluster.mjs`)
either retires or stays as a sibling validator.

### Phase 8 — Docs

**Lands:**
- `README.md` mentions TOML as the operator surface.
- `GETTING-STARTED.md` documents the operator workflow: edit
  `cluster.toml` → `task cluster:toml` → workerd consumes the
  regenerated `cluster.ts`.
- `docs/STATUS.md` moves `cloister-ae06f3` from Blocked to Shipped.

**Tests:** none — docs.

**Closes when:** docs reviewed and merged.

### Phase 9 — Bead close + framing handoff

**Lands:** comment on `cloister-ae06f3` summarizing what shipped;
close the bead. Update `cloister-1b59a2` (substrate-as-kernel
framing bead) with a comment noting Phase 1 is shipped + Phase 2
(schema additions) remains blocked on the network-identity ADR.

**Tests:** none.

**Closes when:** bead closed + framing-bead updated.

## Test-vs-implementation invariants

These are properties the tests should pin so future work can't
regress them silently:

1. **`ClusterSchema` is the validation source of truth.** Any TOML
   that passes the schema produces a `cluster.ts` that the runtime
   accepts; any TOML that the runtime would reject MUST fail
   `ClusterSchema.parse()`.
2. **Roundtrip is data-faithful, not byte-stable.** TOML → cluster.ts
   → TOML produces semantically-equivalent output (zod-validated to
   the same shape) BUT may differ in formatting (the canonical
   writer normalizes operator-edited TOML).
3. **The canonical-write path is deterministic.** Given the same
   input cluster object, the writer produces byte-identical output.
   This is what makes the drift-check task meaningful.

## Reasonable design choices (NOT design questions)

The prompt for the autonomous session enumerates these
explicitly. The session shouldn't re-litigate:

- **Library:** `@iarna/toml`.
- **Comments:** not preserved in Phase 1.
- **Key ordering:** declaration-order at top level; alphabetical
  within tables.
- **Union shape in TOML:** `kind = "<name>"` + shape-specific
  siblings, flat (not nested objects).
- **Validation:** zod via `ClusterSchema`.
- **Drift check pattern:** mirrors `cluster:zod:check-drift`.

## Stop conditions

Same as the prompt's `(a)` and `(b)`:
- **(a) Done:** all phase tests green + PR merged + STATUS.md
  updated + bead closed.
- **(b) Unresolvable human-judgment blocker:** filed as a bead
  comment with explicit framing. Coding problems are NOT acceptable
  blockers.

## Out of scope for this plan

- Phase 2 manifest schema additions (`bundle.implements`,
  `wire.requires`, `route.requiresCapability`) — separate bead
  (`cloister-ae4ed2`), blocked on network-identity ADR.
- Comment preservation — P3 follow-up if operators complain.
- TOML schema generation alongside zod (`*.zod.toml`?) — speculative,
  defer to Phase 2 of the bidi work if useful.
- TOML as the substrate schema (replacing capnp) — explicitly not
  the goal. capnp stays the substrate; TOML is the overlay.
