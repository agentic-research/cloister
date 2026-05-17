# ADR-0025 — Bidi TOML ↔ capnp pipeline (Phase 1)

- **Status:** Accepted (2026-05-17)
- **Tracking bead:** `cloister-ae06f3`
- **Pairs with:** ADR-0004 (capnp manifest), ADR-0009 (compute
  substrate portability), `tools/schema-bridge/README.md` (capnp →
  zod codegen).
- **Framing:** Phase 1 of the substrate-as-kernel arc
  (`cloister-1b59a2`). Substrate-schema-neutral; lays the rail for
  Phase 2 schema additions to ride.

## Context

Cloister's `cluster.capnp` is the source-of-truth deployment manifest:
bundles, wires, storage. Today it's edited as capnp + lowered to TS
via `task cluster:manifest` (capnp eval → JSON → `src/generated/cluster.ts`).

Two problems with capnp as the operator surface:

1. **Capnp is a poor authoring language for humans.** It's terse and
   strict — great as a wire format, awkward as a config file an SRE
   edits when they're on-call at 3am. The `( name = "foo", kind = (
   external = ( image = "..." ) ) )` paren-heavy nesting is closer to
   Lisp than to typical config (TOML, YAML, HCL).
2. **Capnp tooling is a hard dep.** Editing `cluster.capnp` requires
   the `capnp` CLI on PATH to regenerate `cluster.ts`. Wolfi (apko's
   package ecosystem) doesn't have it; CI workarounds exist. An
   operator forking cloister to tweak their cluster shouldn't have to
   install capnp.

The schema-bridge work (`tools/schema-bridge/`) is the right shape to
solve this — capnp stays the source-of-truth *schema* (ADR-0004's
append-only / monotonic-ordinal guarantees still hold) but human-
authored content moves to TOML, with capnp/zod as the validator at
the boundary.

This ADR formalizes the bidi pipeline: TOML ↔ capnp is lossless on
the data layer, comments excepted.

## Decision

Add `cluster.toml` at the repo root as the **authoritative operator
surface** for cluster shape. `src/generated/cluster.ts` becomes a
derived artifact. capnp stays the schema authority; schema-bridge's
zod emit (`src/generated/cluster.zod.ts`) is the validation authority
at the TOML → TS boundary.

### Pipeline (forward)

```
cluster.toml                                  (operator source)
  │
  │  @iarna/toml.parse  (TOML → JS object)
  ▼
{ metadata, bundles, wires, storage }         (in-memory JSON)
  │
  │  ClusterSchema.parse  (zod gate, fail-fast)
  ▼
validated Cluster object
  │
  │  semantic check: every Wire.from/to references a declared bundle
  ▼
validated semantic Cluster
  │
  │  scripts/toml-to-cluster.mjs render  (same shape as build-cluster.mjs)
  ▼
src/generated/cluster.ts                      (typed TS module — derived)
```

### Pipeline (reverse)

```
src/generated/cluster.ts                      (the live cluster const)
  │
  │  dynamic import → cluster object
  ▼
in-memory Cluster
  │
  │  canonicalize (ordering, union shape)
  ▼
canonical-form JSON
  │
  │  @iarna/toml.stringify
  ▼
cluster.toml                                  (canonical operator source)
```

### Hard contracts

1. **Lossless on the data layer.** `TOML → cluster.ts → TOML`
   produces byte-equal output when the input was already canonical.
   Operator-edited TOML may differ from the canonical form (e.g.
   different key order); a roundtrip normalizes it. The normalization
   itself is deterministic.
2. **Schema validation at the boundary.** TOML that violates
   `ClusterSchema` fails fast with a clear error. The zod schema is
   the source of truth for what shapes are accepted; semantic checks
   (e.g. wire references exist) layer on top.
3. **No new manifest schema fields in this ADR.** Phase 1 is
   substrate-schema-neutral. The capnp schema (`manifest/cluster.capnp`)
   is unchanged. Phase 2 (`cloister-ae4ed2`, blocked on the
   network-identity ADR) is where the `bundle.implements` /
   `wire.requires` / `route.requiresCapability` additions ride.
4. **Existing pipelines keep working.** `task cluster:manifest`
   (capnp-eval) still functions. The new TOML path is **additive** in
   Phase 1 — both paths produce the same `src/generated/cluster.ts`.
   Eventually the capnp-eval path retires; Phase 1 doesn't force that
   migration. Operators stay un-broken across the cutover.

### Library: `@iarna/toml`

`@iarna/toml` v2.2.5 (MIT, mature, last published 2020) is the
canonical-output TOML library for Node. Picked because:

- **Deterministic output.** `stringify` produces the same bytes for
  the same input (modulo key-order, which we control via
  pre-sorting).
- **TOML 1.0.0 spec compliance.** Handles inline tables, arrays of
  tables, datetimes, multiline strings.
- **Pure JS, no native deps.** Vendors cleanly into the apko OCI
  build via npm; no Wolfi-side gymnastics.
- **No active maintenance is OK** for this surface — the TOML spec is
  stable at 1.0.0, and the library predates the bidi work; it's not
  a security boundary.

Pin via `pnpm add @iarna/toml`.

### Canonicalization rules

The canonical-write path is **deterministic**: given the same
in-memory Cluster object, the writer produces byte-identical TOML.
This is what makes `task cluster:toml:roundtrip` meaningful as a
drift gate.

The rules:

| Level | Rule |
|---|---|
| Top-level keys | Declaration order from `cluster-types.ts`: `metadata`, `bundles`, `wires`, `storage`. Operators expect cluster identity first, then composition. |
| Inside a table | Alphabetical by key. Reduces churn when fields are added; operators don't reorder by hand. |
| Arrays of tables (`[[bundles]]`) | Preserve declaration order from the input. Reordering bundles changes the cluster's semantics (start-order, dependency probing); the writer never reorders. |
| Inline arrays of scalars | Preserve declaration order. |
| Discriminated unions | Flatten to `kind = "<variant-name>"` + shape-specific sibling fields. See below. |

### Discriminated unions in TOML

Capnp unions become a kind-tag + the variant payload. In zod they
appear as `z.union([z.object({ workerd: WorkerdBundleSchema }).strict(), z.object({ external: ExternalBundleSchema }).strict()])`
(one strict single-key object per variant).

In TOML, the canonical shape is:

```toml
# Non-Void variant (carries payload):
[[bundles]]
name = "cloister-router"
# ... base fields ...
kind = "external"
[bundles.external]
image = "cloister:0.1.0"
ipcSocket = "/run/cloister-uds/router.sock"
httpPort = 8787
args = []
env = []

# Void variant (no payload):
[[wires]]
from = "cloister-router"
to = "mache"
binding = "MACHE_BUNDLE"
transport = "uds"
```

The `kind` / `transport` discriminator is a sibling string field; the
payload (when non-Void) is a nested table named after the variant.
Void variants emit as just the string tag — no nested table, no `null`
sentinel.

**Why not nest the union under a single key?**

Two readable alternatives existed:

1. `[bundles.kind.external]` (nested table with the discriminator as
   the path component). Rejected because the variant name appears
   twice in the path, and the discriminator-as-string is what humans
   actually scan for.
2. `kind = { external = { image = "..." } }` (inline table). Rejected
   because inline tables don't compose with multiline arrays; the
   manifest grows and inline-table syntax stops being readable.

The flat sibling-table shape is what `cargo` / `pyproject.toml` /
most production TOML files use for variant-like data; matches what
operators already know.

### Comments: not preserved in Phase 1

Operator-written comments in `cluster.toml` are **lost** on a
roundtrip through `cluster.ts`. Documented loss; not a bug.

The trade-off:

| Option | Cost | Value |
|---|---|---|
| Preserve comments | Either AST-preserving reader/writer (no @iarna/toml — needs a different lib) OR a custom side-channel that maps comments to JSON-path locations (complex, brittle) | Operators can annotate the manifest |
| Drop comments | Free — @iarna/toml does this by default | Phase 1 ships; comments tracked as P3 follow-up |

Phase 1 prioritizes the data-faithful rail over comment fidelity.
The rail is what makes Phase 2 schema additions possible; comments
are a P3 polish item filed as a follow-up bead. Operators who need
in-tree documentation can use a sibling `cluster.toml.md` (not
parsed; lives next to the manifest).

### Test location: `scripts/test/` not `test/`

The plan called for `test/cluster-toml-roundtrip.test.ts` (vitest).
Reality: vitest-pool-workers runs inside workerd, which has no
`node:fs`, `node:child_process`, or `@iarna/toml`. The tests need
the host runtime.

The repo already has node-native tests under `scripts/test/*.test.mjs`
(`cli-init.test.mjs`, `lint-bundle-isolation.test.mjs`,
`emit-workerd-config.test.mjs`) for exactly this reason — anything
that shells out to a Node script or uses host-only APIs lives here
and runs via `node --test scripts/test/*.test.mjs`.

The bidi roundtrip tests live at
`scripts/test/cluster-toml-roundtrip.test.mjs` and run as part of
`task test:lint-scripts` (already wired into `task lint`).

## Consequences

- **Operator workflow becomes:** edit `cluster.toml` → `task cluster:toml`
  → workerd consumes the regenerated `cluster.ts`. No capnp CLI on
  PATH; just a text editor and `task`.
- **Drift between TOML and TS is gated** by `task cluster:toml:roundtrip`
  (same shape as `task cluster:zod:check-drift`). Wiring into `task
  lint` happens in Phase 2 once the new rail is exercised in CI.
- **The capnp schema (`manifest/cluster.capnp`) remains the
  substrate-level authority.** zod is derived from it via
  schema-bridge; TOML is validated against zod. No competing
  authority; the chain is one-way: capnp → zod → TOML-validation.
- **Phase 2 schema additions ride this rail.** When the
  network-identity ADR adds `bundle.implements` / `wire.requires`,
  the changes land in the capnp schema; schema-bridge regenerates
  zod; the TOML reader picks up the new shape automatically because
  it validates against zod, not against a hand-mirrored shape.
- **The TOML library choice is reversible.** If `@iarna/toml`
  develops a behavior issue (e.g. spec drift, perf cliff), swap to a
  different parser-stringifier. The hard contract is "byte-equal
  roundtrip on canonical input," not "uses @iarna/toml".
- **`cluster.toml` lands as a tracked file.** Same trade-off as
  `src/generated/cluster.ts`: tracking lets reviewers see the diff
  on PRs that touch cluster shape, and the OCI build doesn't need
  the TOML library at image-build time (only at edit time).

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Keep capnp as the operator surface | Bad ergonomics; hard dep on `capnp` CLI; alienates operators who haven't worked with capnp before. |
| YAML overlay instead of TOML | YAML's whitespace-sensitivity + tag system + multi-doc semantics are over-feature for this use case. Operators consistently report TOML reads more cleanly for "tables of configs." Matches `cargo`, `pyproject.toml`, `wrangler.toml` (which cloister already uses). |
| JSON overlay | No comments, no inline arrays-of-tables, no trailing-comma forgiveness. Workable but worse ergonomics than TOML for human authoring. |
| HCL overlay | Pulls in HashiCorp's tooling story; not Node-native; over-feature (HCL's expression engine isn't needed). |
| Custom YAML/Lispy DSL | More moving parts, worse tooling support (no editor highlighting); rejected as accidental complexity. |
| Schema-bridge emits the TOML reader/writer directly | Schema-bridge's IR doesn't have a TOML-shape concept yet. Phase 1 ships hand-written reader/writer scripts; if/when a third overlay (JSON Schema, etc.) needs the same shape, lift the canonicalization into schema-bridge as a new emit target. Premature today. |
| Preserve comments via AST-aware library | `@iarna/toml` doesn't preserve; alternatives (`@ltd/j-toml`, `toml-eslint-parser`) add weight and have their own pitfalls. Defer to P3 follow-up. |
| Roundtrip via `capnp eval --output toml` | Capnp's `eval` has no TOML output (only JSON, capnp-text, binary). Adding one would require capnp-core changes; out of scope. |

## Implementation

Phased per `docs/plans/bidi-toml-pipeline.md`. Each phase closes when
its test tranche turns green. TDD-shape: tests written first
(failing); impl turns them green.

Summary of phases:

1. **Phase 0 (housekeeping)** — pin `.rsry-bead-id`, gitignore it,
   start bead comment.
2. **Phase 1 (this ADR)** — `docs/adr/0025-bidi-toml-pipeline.md`
   covering the decision, library choice, canonicalization rules,
   comment trade-off.
3. **Phase 2 (failing test baseline)** —
   `scripts/test/cluster-toml-roundtrip.test.mjs` with 8 red tests
   describing the bidi contract; stub scripts that throw `not
   implemented`.
4. **Phase 3 (TOML reader)** — `scripts/toml-to-cluster.mjs` parses
   TOML → JS → zod-validates → semantic-check → renders `cluster.ts`.
5. **Phase 4 (TOML writer)** — `scripts/cluster-to-toml.mjs` loads
   `cluster.ts` → canonicalizes → emits TOML.
6. **Phase 5 (roundtrip green)** — reconcile reader + writer until
   byte-equal canonical + semantically-equivalent reverse passes.
7. **Phase 6 (Taskfile integration)** — `cluster:toml`,
   `cluster:toml:export`, `cluster:toml:roundtrip` mirroring
   `cluster:zod:*` shape.
8. **Phase 7 (`cluster.toml` at repo root)** — generate from current
   `cluster.ts` state, commit, verify roundtrip.
9. **Phase 8 (docs)** — README, GETTING-STARTED, STATUS.md updates.
10. **Phase 9 (PR + bead close)** — self-review, skeptic-agent gate,
    open PR, merge, close bead, comment on framing bead.

## Tracking

- Bead: `cloister-ae06f3` (this ADR + impl).
- Framing: `cloister-1b59a2` (substrate-as-kernel).
- Sibling: `cloister-ae4ed2` (Phase 2 schema additions; blocked on
  network-identity ADR).
- Follow-up: file a P3 bead for comment-preservation if operators
  ask for it.
- Follow-up: wire `cluster:toml:roundtrip` into `task lint` once the
  rail is proven in a few CI cycles (gates against silent drift the
  same way `cluster:zod:check-drift` does).
