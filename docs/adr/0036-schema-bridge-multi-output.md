---
title: "ADR-0036: schema-bridge multi-output IR — Phase 1 in cloister, Phase 2 lift to LLO"
status: Proposed (2026-06-25)
date: 2026-06-25
tags: [substrate, schema-bridge, codegen, ir, leyline, positioning]
relates_to:
  - 0022-schema-bridge-substrate-positioning.md
  - 0025-bidi-toml-pipeline.md
  - 0026-tool-composition-model.md
  - 0028-capability-scheme.md
  - 0031-cloister-capnp-as-build-artifact.md
  - 0035-cloister-llo-boundary.md
---

## Context

`tools/schema-bridge/` today is a single-input single-output codegen: capnp IDL → zod TypeScript, applied to one schema (`manifest/cluster.capnp`). The IR (`src/ir/mod.rs`) is deliberately small + output-agnostic per its file header — "Inputs lower into this type-set. Outputs read from it." But the only output that exists is zod; the only input is capnp; the only invoking task is `cluster:zod`. That's the right starting shape — ADR-0022 ratified schema-bridge as the cluster.capnp → zod codegen — but the substrate has outgrown it.

Three forces push the generalization now:

1. **Multi-language client need.** ART substrate ships across Rust (cloister, signet, ley-line), Go (signet's `pkg/signet`, mache's MCP server, future TF/HCL consumers), and TS (cloister, notme). Each repo hand-writes types from the same conceptual schemas. The drift work the 2026-06-24 audits surfaced (`cloister-59c60e` leyline-sign, `notme-803923` cross-language canonical encoding) is the recurring failure mode.

2. **Centralization pressure.** "Library code sprawled throughout" is a real cost — N repos × M languages = N×M hand-written-and-divergent type surfaces. Schema-bridge becomes the single source of truth for typed boundaries: one capnp IDL → N language outputs → zero divergence.

3. **LLO positioning fit.** ADR-0035 ratified the cloister↔LLO boundary: "bridge crates in cloister; leyline-* names belong in LLO." LLO is already the substrate-level home for code-shaped data primitives (tree-sitter parse, LSP enrichment, sheaf cache). Schema codegen is a sibling primitive in the same family — runtime LLO parses existing code; build-time schema-bridge emits new code from schemas. Both are AST/IR over code-shaped data.

## Decision

**Two-phase generalization, sequenced for low cross-repo friction.**

### Phase 1 — generalize INSIDE cloister/tools/schema-bridge/

Stays in cloister for iteration speed. Lands:

- **Output-multiplexer** in `src/main.rs` — selector for `-oschema-bridge:zod:<dir>` vs `-oschema-bridge:go:<dir>` (vs future targets)
- **Go output** at `src/outputs/go.rs` — types + json/cbor tags + canonical encoders matching the wire shape capnp specifies
- **Round-trip verification** — `task cluster:go:verify` parallel to existing `task cluster:zod:verify`
- **Second schema** — proves generalization beyond `cluster.capnp` (signet or notme capnp the recommended target)

The IR (`src/ir/mod.rs`) stays deliberately small. New constructs the IR doesn't model (interfaces, generics, anyPointer) remain `UnmappedConstruct` until a real schema needs them, per the IR's existing header invariant.

Phase 1 tracking: `cloister-7536e7` umbrella; sub-beads `cloister-7585bc` (A — multiplexer), `cloister-75f6d5` (B — Go types), `cloister-765d83` (C — encoders, recommended-not-required), `cloister-76a9ea` (D — round-trip gate), `cloister-77172d` (E — second schema).

### Phase 2 — lift to LLO as `rs/ll-open/schema-bridge/`

Once Phase 1 is shipped (multi-output IR proven across ≥2 schemas), lift the crate to `ley-line-open/rs/ll-open/schema-bridge/` as a sibling to the existing tree-sitter + LSP + sheaf crates. Pattern matches the 2026-05-09 `leyline-sign` lift exactly (Apache-2.0 → AGPL-3.0; cloister consumes upstream + deletes vendored copy).

Phase 2 properties:

- Crate stays a standalone Rust binary — **no daemon, no port, no SQLite sidecar.** It's a build-time codegen, not a runtime data-plane primitive. Same posture as `leyline-cas-ffi` (already consumed cross-repo as a git dep).
- Cloister consumes via `Cargo.toml` git dep (or version pin once LLO publishes); deletes `tools/schema-bridge/` in favor of upstream.
- Other ART substrate repos (signet, notme, mache, ley-line) adopt the same way once they have schemas to consume.

Phase 2 tracking: separate bead, filed when Phase 1 closes (so the lift PR has a known-good artifact to move).

### Naming + license

Once lifted, schema-bridge follows ADR-0035 naming: it becomes `leyline-schema-bridge` (or just `schema-bridge` under the `ll-open/` workspace). License inherits LLO's AGPL-3.0-or-later (matching the substrate posture; matches the leyline-sign lift precedent).

## Why two phases (not one)

A direct cloister-side lift (file the LLO PR alongside the cloister generalization) would force every iteration cycle through cross-repo review. The 5 Phase 1 sub-beads are tight enough to land in days; the cross-repo lift adds weeks of friction per iteration. Phase 2 lifts ONCE, when the IR + emitter shape is stable.

The cost of Phase 1 staying in cloister: temporary code in cloister that will move. Mitigation: ADR-0035 + this ADR explicitly document the planned move so reviewers don't optimize for cloister-permanence.

## What this ADR does NOT decide

- **TF/HCL output target shape.** Three possible meanings (Terraform provider schema vs module variables vs tfvars config files); needs separate decision when picked up. Out of Phase 1.
- **Rust output reinvention.** `capnp compile -orust` already exists; serde-friendly Rust variant might justify a new emitter, but Phase 1 doesn't reinvent.
- **Multi-input expansion.** Phase 1 stays capnp-only on the input side. JSON Schema / protobuf inputs are out of scope until a real driver appears.
- **JSDoc / `# comment` carry-through** (`cloister-818f2b` half 2). Orthogonal to multi-output; landed when capnp-rust exposes source spans (currently upstream-blocked). Tracked separately.

## Risks

| Risk | Mitigation |
|---|---|
| Phase 1 sprawl — adding too many outputs before Phase 2 lifts | Acceptance criteria for `cloister-7536e7` closes the epic at TS + Go (+ 1 second schema). Further outputs (Rust, TF/HCL) explicitly deferred. |
| IR creep — fixing IR gaps for one schema breaks another | Existing test fixtures + per-schema integration tests (E sub-bead seeds this). Lift to LLO inherits the test corpus. |
| LLO maintainer review latency on Phase 2 lift | Phase 2 is one well-scoped PR (file move + license header + cargo workspace integration); no logic change. Same shape as leyline-sign lift which landed cleanly. |
| Cross-repo adoption stalls — signet / notme don't migrate after Phase 2 | Adoption is each repo's call. Generated code can sit alongside hand-written for migration period; no big-bang required. |

## References

- ADR-0022 — schema-bridge substrate positioning (the original ratification)
- ADR-0025 — bidi TOML pipeline (cluster.toml ↔ cluster.capnp; today's consumer)
- ADR-0026 — tool composition model (`[inputs.*]` pattern, conceptual cousin)
- ADR-0028 — capability identifier scheme (naming conventions for substrate-owned identifiers)
- ADR-0031 — cloister.capnp as build artifact (the emitter pattern Phase 1 extends)
- ADR-0035 — cloister↔LLO boundary (the principle Phase 2 implements)
- `tools/schema-bridge/src/ir/mod.rs:1-12` — IR header invariant: inputs lower in, outputs read out, new constructs land here first
- `cloister-7536e7` — Phase 1 umbrella; `cloister-7585bc` / `75f6d5` / `765d83` / `76a9ea` / `77172d` — sub-beads A-E
- `cloister-204ac9` / `cloister-818f2b` — sibling drift-gate + JSDoc work; not blocked by this ADR but converges with Phase 2's same crate
