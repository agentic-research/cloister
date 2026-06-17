# ADR-0031 — cloister.capnp as build artifact

- **Status:** Draft (2026-06-17)
- **Tracking bead:** `cloister-345ad1`
- **Pairs with:** ADR-0004 (capnp manifest, append-only schema
  evolution), ADR-0025 (bidi TOML ↔ capnp pipeline for `cluster.toml`),
  ADR-0026 (tool composition model + `[[generated_backends]]` in
  `cluster.lock.toml`), ADR-0027 (substrate-as-kernel capability
  matchmaker — future consumer of the unified operator surface).
- **Framing:** Closes the "one operator surface" half of the
  substrate-as-kernel arc (`cloister-1b59a2`). ADR-0025 moved
  *bundles + wires + storage* to TOML; this ADR moves *routes +
  backends* to TOML; together they make `cluster.toml` the single
  hand-edited file at the repo root.

## Context

Pre-Phase-2 of the "cloister.capnp as build artifact" arc, the repo
root carried two manifest files an operator was expected to edit:

- **`cluster.toml`** — bundles, wires, storage, inputs. The ADR-0025
  bidi pipeline made this the canonical TOML operator surface;
  `src/generated/cluster.ts` is a derived artifact.
- **`cloister.capnp`** — routes, backends, actor, policy. Still
  hand-edited capnp text. The TS module
  `src/generated/manifest.ts` was the only derived artifact in this
  half of the stack.

Two manifests at the operator surface is one too many:

1. **Different authoring languages.** TOML for half the cluster
   shape, capnp for the other half. The split has no semantic
   justification — both are operator-authored, both express cluster
   structure.
2. **Capnp tooling stays a hard dep.** ADR-0025 §"Why TOML" laid
   out why capnp is a poor authoring language for the on-call SRE
   case; the same argument applies to routes + backends.
3. **The ADR-0026 lockfile already crosses the seam.** Phase 1 of
   the LLO arc (`cloister-05334b`) wired
   `cluster.lock.toml [[generated_backends]]` directly into
   `cloister.capnp`'s `/mcp.backends` list at build-manifest time.
   That overlay only makes sense if `cloister.capnp` is already
   tooling-mediated; pushing it the rest of the way to fully-generated
   removes a mixed-state hazard ("did I edit the right file? did the
   lockfile overlay land?").
4. **ADR-0027's matchmaker assumes a single operator surface.** The
   substrate-as-kernel framing makes `cluster.toml` the n-dimensional
   capability declaration the matchmaker walks; routes are the
   public-facing edge of those capabilities. Keeping routes outside
   `cluster.toml` keeps them outside the matchmaker's awareness.

## Decision

**`cloister.capnp` is a build artifact.** Operators author
`cluster.toml`; the emitter
(`scripts/emit-cloister-capnp.mjs`) projects routes into a canonical
`cloister.capnp` Gateway value. The downstream pipeline
(`scripts/build-manifest.mjs` → `src/generated/manifest.ts`) stays
unchanged in shape; it just reads a generated file instead of a
hand-edited one.

### Decade arc (Phase 2 = this ADR)

```
Phase 1 (cloister-05334b, shipped 2026-05-26)
  cluster.lock.toml [[generated_backends]]
  → build-manifest.mjs overlay
  → src/generated/manifest.ts (with lsp/lifecycle/sheaf backends)
  Hand-edited cloister.capnp at repo root still required.

Phase 2 (cloister-345ad1, this ADR — 2026-06-17)
  cluster.toml [[routes]] → emit-cloister-capnp.mjs
  → canonical cloister.capnp (auto-generated, drift-gated)
  → build-manifest.mjs (lockfile overlay still applies)
  → src/generated/manifest.ts
  Hand-edited cloister.capnp NO LONGER at the operator surface for
  this repo's root. Per-recipe cloister.capnp still hand-edited
  (Phase 3 scope).

Phase 3 (deferred — separate bead)
  Recipes ship cluster.toml ONLY. Per-recipe cloister.capnp shells
  retired; the emitter handles every recipe shape.

Phase 4 (deferred — per-upstream beads)
  Mache + rsry + future upstreams join the lockfile-driven backend
  pattern. Cluster.toml's [[routes.mcp.backends]] shrinks to just
  intra-cluster backends (DO-backed). Mcp upstream backends become
  lockfile-only.
```

### Phase 2 scope (what shipped)

`manifest/cluster.capnp` gains a `Route` field + per-kind specs
(append-only ordinals per ADR-0004; `Cluster.routes @5
:List(Route)`). The bidi pipeline (ADR-0025) round-trips
`[[routes]]` losslessly. A new emitter,
`scripts/emit-cloister-capnp.mjs`, reads `cluster.toml` →
`parseTomlToCluster` → renders canonical capnp text.

Output is byte-stable: two consecutive runs on the same input produce
identical bytes. The drift gate
(`task emit:cloister-capnp:drift`) is wired into `task verify`,
matching the shape of `task cluster:toml:roundtrip` and
`task cluster:zod:check-drift`.

### What's pinned in the emitter (Phase 2 only)

Three Gateway-level fields aren't in `cluster.toml` today; the
emitter carries them forward from a hardcoded ART-default template:

- **`gateway.metadata`** — `name = "cloister-art"`, `version = "0.1.0"`.
  Distinct from `cluster.metadata` ("art-default") per ADR-0009;
  changing the emitter default + committing the cloister.capnp delta
  is the override path today.
- **`actor`** — `fingerprint = "sha256:placeholder-pinned-at-deploy-time"`,
  algorithm = ed25519, etc. ART-default placeholder per ADR-0007.
- **`policy`** — `maxCertLifetimeSeconds = 300`, `requireInterlock =
  true`, `minAlgorithm = "ed25519"`. ART-default per ADR-0007.

Phase 3+ adds a `[gateway]` section to `cluster.toml` so operators
can override these via the TOML surface without editing the emitter.

### Layering: lockfile overlay stays in build-manifest

The emitter does NOT inject `cluster.lock.toml [[generated_backends]]`
rows into `cloister.capnp`. That overlay stays in
`scripts/build-manifest.mjs:overlayLockfileBackends` (Phase 1
location, unchanged).

Rationale: pre-revision, the emitter merged lockfile rows. The
downstream `build-manifest` overlay then saw them as hand-shell
collisions on every regen — same-name → "generated WINS" → noisy
warnings + redundant replacement. One source of truth per overlay:
`cloister.capnp` carries the cluster.toml routes; build-manifest
injects the lockfile rows.

The net effect on `src/generated/manifest.ts` is identical to Phase 1.

## Consequences

### Positive

- **One operator surface at the repo root.** `cluster.toml` is the
  single hand-edited cluster shape file. `cloister.capnp` joins
  `cluster.ts` + `manifest.ts` + `cluster.zod.ts` in the
  derived-artifact column.
- **Drift gate.** `task emit:cloister-capnp:drift` fails CI if the
  committed `cloister.capnp` diverges from what
  `emit-cloister-capnp.mjs` would generate. Operators can't accidentally
  hand-edit `cloister.capnp` without the gate catching it.
- **Schema additions go through ADR-0004.** Adding a new route kind
  means extending `Route.kind` union in `manifest/cluster.capnp` (one
  schema file, append-only). The TS mirror in
  `src/manifest/cluster-types.ts` + the schema-bridge zod regen +
  the bidi pipeline un-flattener all flow from there.
- **ADR-0027 matchmaker has a unified surface to walk.** When the
  matchmaker lands, routes are first-class capability declarations
  alongside bundles + wires + inputs.

### Negative / accepted trade-offs

- **Comments lost.** The hand-edited `cloister.capnp` had
  documentation-grade route-level comments (why this route exists,
  what it serves, which ADR it traces to). Canonical regeneration
  strips them. The intent moves to:
  (a) `cluster.toml` operator comments,
  (b) ADRs / `docs/security/threat-model.md` for the why-layer,
  (c) the schema (`manifest/cluster.capnp`) for the per-variant docstrings.
- **Per-recipe hand-edited cloister.capnp still exist.** Phase 3
  handles those — Phase 2 explicitly leaves them alone (the bead
  said NOT TO TOUCH them, and the recipe lint
  `lint:recipes` validates them as-is).
- **Gateway-level fields pinned in emitter source.** Until Phase 3
  adds `[gateway]` to `cluster.toml`, overriding `actor.fingerprint`
  for a real deployment means editing `emit-cloister-capnp.mjs`
  (and committing the cloister.capnp delta). Documented + acceptable
  for Phase 2 because no real ART deployment uses non-placeholder
  values yet.
- **mache backend stays hand-declared in cluster.toml [[routes]].**
  Phase 4 retires it to the lockfile pattern; Phase 2 keeps it as
  the bridge case (lockfile-driven vs hand-shell coexistence is
  already a Phase 1 contract).

## Alternatives considered

### A. Keep cloister.capnp hand-edited; add `[[routes]]` to cluster.toml as an *additive* operator surface

Operators could write routes in either file; build-manifest would merge.

**Rejected:** mixed-state hazard is exactly what Phase 2 is trying to
remove. Two source-of-truth files for the same data is a recipe for
"did I edit the right one?" bugs.

### B. Move routes to `cluster.toml`, leave `cloister.capnp` deprecated-but-functional

Operators stop editing `cloister.capnp`; nothing regenerates it.

**Rejected:** drift would silently accumulate. The drift gate is a
load-bearing property of the design — without it, `cloister.capnp`'s
relationship to `cluster.toml` is undefined.

### C. Inline lockfile overlay into the emitter (Phase 2's initial design)

Emitter reads both cluster.toml + cluster.lock.toml; produces a
fully-materialized cloister.capnp.

**Rejected during Commit 4** after observing the double-overlay
collision in real `task manifest` runs. Build-manifest's pre-existing
overlay saw the emitter-injected rows as hand-shell collisions on
every regen. Layering preserves one source of truth per overlay.

### D. Skip the ADR; ship the emitter as an "internal tool" without naming the design

**Rejected:** this is a substrate decision an operator-six-months-from-
now needs to be able to reverse if a real signal emerges (e.g. operators
need per-route comments in the manifest, or Phase 3's [gateway] surface
turns out wrong). ADR-0004 made `cloister.capnp` a contract; ADR-0031
re-shapes that contract. Both halves deserve the same documentation
treatment.

## Rationale

The substrate-as-kernel framing (`cloister-1b59a2`) treats
`cluster.toml` as the n-dimensional capability declaration the
matchmaker (ADR-0027) walks. Routes are public-facing capabilities —
they're the edge of every `cloister/<name>/v<n>` interface a peer
sees. Keeping them outside `cluster.toml` keeps them outside the
matchmaker's reach, which would force a Phase 5+ "now move routes
into the matchmaker too" delta that's harder than just doing it now.

ADR-0025 set the bidi pipeline rail and made `cluster.toml` the
authoritative operator surface for half the manifest. Phase 1 of
the LLO arc (`cloister-05334b`) crossed the seam from `cluster.toml`
inputs into `cloister.capnp` backends via the lockfile. Phase 2
closes the loop: `cluster.toml` is fully authoritative;
`cloister.capnp` exists only as a build artifact for the workerd
runtime's consumption.

Per-recipe and per-upstream migrations (Phase 3 + Phase 4) are
separate beads. The decade thread `interlace-substrate/adrs`
tracks the unified arc.

## Coordinated with

- **ADR-0004** — capnp schema-evolution rules apply to
  `manifest/cluster.capnp`'s `Route` field + per-kind specs.
  Append-only ordinals; never renumber.
- **ADR-0025** — bidi TOML ↔ capnp pipeline. Phase 2 extends the
  pipeline to `[[routes]]` rows via the same un-flatten /
  canonicalize pattern that handles `Bundle.kind` + `Wire.transport`.
- **ADR-0026** — `cluster.toml [inputs.*]` resolver outputs
  `cluster.lock.toml [[generated_backends]]`. Phase 2's emitter
  intentionally does NOT consume the lockfile; that overlay stays
  in `scripts/build-manifest.mjs` (Phase 1 location).
- **ADR-0027** — substrate-as-kernel matchmaker. Phase 2 prepares
  the unified operator surface the matchmaker will eventually walk.
  Routes become n-dimensional capability declarations alongside
  bundles + wires + inputs.

## Status table entry

| Capability | Reference | Bead | Notes |
|---|---|---|---|
| `cloister.capnp` as build artifact | ADR-0031 | `cloister-345ad1` | Phase 2 of the arc (route surface in cluster.toml + emitter). Phase 3 (per-recipe migration) + Phase 4 (per-upstream backend retirement) deferred to separate beads. |
