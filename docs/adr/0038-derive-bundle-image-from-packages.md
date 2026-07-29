# ADR-0038 — Derive bundle image from `server.json` `packages[].oci`

- **Status:** Accepted (consumer side shipped 2026-07-04 via `cloister-505fb9`;
  producer side tracked under `cloister-31a988`)
- **Tracking bead:** `cloister-3c4b0c` (filed alongside this ADR)
- **Pairs with:**
  - ADR-0026 (Tool composition model — derives *backends* from `_meta.art.cloister/v1`; this ADR extends the same input→manifest derivation to the *image*)
  - ADR-0025 (Bidi TOML ↔ capnp pipeline — `cluster.toml` is the operator surface this changes)
  - ADR-0009 (Compute-substrate portability — declares the bundle deployment model whose image field this populates)
  - ADR-0031 (`cloister.capnp` as build artifact — the emit pipeline this threads through)
  - `cloister-31a988` (Secure ART tool constellation — mache is the first producer)

## Context

A tool like mache shows up in a cloister deployment as **two independent
declarations** in `cluster.toml`, and nothing links them:

```toml
[[bundles]]                          # the RUNTIME container
name = "mache"
kind = "external"
  [bundles.external]
  image = "mache:0.13.0"            # ← hand-typed, hand-bumped

[inputs.mache]                       # the MCP SURFACE
ref = "io.github.org/agentic-research/mache@main"   # ← resolved from server.json
```

ADR-0026 made the *surface* self-describing: cloister resolves the tool's
`server.json` and derives backend declarations from its
`_meta.art.cloister/v1.groups[]`. But the **image** stayed a hand-set
field (`emit-compose.mjs` copies `ext.image` verbatim). So every tool
requires an operator to hand-maintain, in cloister, a version string that
the tool already knows about itself. When mache cuts 0.13.0, the operator
must edit `image = "mache:0.12.0"` → `0.13.0` by hand — the tool cannot
tell cloister its own runtime the way it tells cloister its own tools.

The MCP registry `server.json` schema already has the slot for this: a
top-level **`packages[]`** array whose entries carry a `registryType`
(`oci`, `npm`, `pypi`, …), an `identifier`, and a `version`. An `oci`
package entry *is* the tool declaring its own container image. cloister
just doesn't read it.

### Empirical confirmation (PR #96, `cloister-2d987e`)

Confirmed against the live tree while migrating mache to the resolver
pipeline: `emit-compose.mjs:322` reads a bundle's image straight from
`cluster.toml`'s `[[bundles]].external.image`, and a grep across
`emit-compose.mjs`, `emit-workerd-config.mjs`, and `resolve-inputs.mjs`
finds **no** read of `packages`/OCI anywhere — the image is purely
hand-maintained. This is precisely why mache's tag had silently drifted
to `0.8.0` in `cluster.toml` and had to be hand-bumped to `0.13.0`
mid-PR: the stale-tag failure this ADR closes at the source.

## Decision

Extend the input→bundle derivation so a bundle's `image` **can be derived
from the resolved input's `packages[]` entry** where `registryType ==
"oci"`, with an explicit, loud precedence order:

1. **Operator override wins.** A non-empty `ext.image` in `cluster.toml`
   is used verbatim and never overridden. Operators keep the last word.
2. **Else derive from `packages[].oci`.** When the bundle's image is
   unset and the linked input's resolved `server.json` carries an `oci`
   package, cloister derives `image = "<identifier>:<version>"` (or
   `<identifier>@<digest>` when the package is digest-pinned).
3. **Else warn loudly and leave unset.** No silent empty image. If
   neither an operator image nor an `oci` package is available, emit a
   stderr warning naming the bundle + input — the same "noisy default"
   discipline the `[gateway]` fall-through (ADR-0031 Phase 4a) and the
   `no _meta.art.cloister/v1` fallback (ADR-0026) already use.

### The bundle ↔ input link

Derivation requires knowing *which input backs which bundle*. The link is
the existing ADR-0030 §A5 tenancy resolution used by `emit-compose`:

1. explicit `inputs.<name>.tenancy.workerdId` wins;
2. otherwise, an input with the same name as a bundle colocates there;
3. otherwise, the input falls back to the first hypervisor/gateway bundle.

Image derivation reuses that resolution. It introduces no new
cross-reference, only a new *field* populated across the one that exists.
The substrate-isolation lint's Inv 10 uses the same resolver so warning
behavior matches compose emission, including the gateway fallback path.

### Producer contract (`packages[]`)

A tool opts in by adding an `oci` entry to its `server.json`:

```json
"packages": [
  { "registryType": "oci", "identifier": "ghcr.io/agentic-research/mache", "version": "0.13.0" }
]
```

This is a standard MCP registry field, valid and useful independent of
cloister (any registry client can read it). Tools whose `server.json`
carries no `packages[]` fall through to rule 3 — this ADR adds no new
build error.

### Consumer changes (cloister)

- **`scripts/resolve-inputs.mjs`** — when parsing a resolved `server.json`,
  record the first `oci` package (`identifier`, `version`, optional
  `digest`) into the input's `cluster.lock.toml` row, alongside the
  existing `generated_backends`.
- **`scripts/emit-compose.mjs`** — apply the precedence order above when
  emitting a bundle's image. Workerd config does not emit OCI images.
- **`scripts/lint-bundle-isolation.mjs`** — a new invariant: an external
  bundle whose image is neither operator-set nor derivable from a linked
  `oci` package is a warning (fail-loud, not fail-closed — an operator
  mid-migration is legitimate).

## Amendment 2026-07-29 — artifact-only producers (`cloister-02dd65`)

A producer that publishes **images and serves no MCP** cannot express itself
through `packages[]` at all. The 2025-12-11 registry schema's
`Package.required` is `["registryType","identifier","transport"]`, so a
transport-less package **fails the schema its own `$schema` key names** —
notme's `server.json` was in exactly that state (`notme-6e5330`).

The tempting fix is a placeholder `{"type":"stdio"}`. That is worse than the
problem: it is schema-valid and semantically **false**, and this ADR's own
mechanism means cloister derives session behaviour from
`packages[].transport.type` — so a fake transport makes cloister generate
backends for tools that do not exist. notme was right to omit it.

**Amended decision.** The image may also be derived from
`_meta['io.modelcontextprotocol.registry/publisher-provided'].artifacts[]`,
whose entries carry the same `registryType` / `identifier` / `version` shape.
The schema makes `packages[]` optional and declares this `_meta` slot an
extension point (`additionalProperties: true`), so an artifact-only document
validates against the schema it names.

Precedence: **`packages[]` wins when both are present.** A producer
mid-migration may carry both, and behaviour must not change under one who adds
the extension before dropping `packages[]`.

**The load-bearing constraint.** An `artifacts` entry is **package identity
only**. It never implies a transport, a session, or a backend.
`declaredTransportTypes` and `deriveRequiresSession` deliberately do not read
that slot, and two tests pin the negative — because leaking it there
reintroduces precisely the defect the placeholder transport would have caused.

This is a strictly additive read path; nothing about the `packages[]` behaviour
above changes. Three-sided contract with notme (`6e5330`) and LLO's
`leyline-mcp-descriptor` emitter side.

## Rationale

### Why `packages[]` (not a cloister-specific `_meta` field)

The same reasoning as ADR-0026 §"Why MCP `server.json`": the registry
schema already models "how to run this server," and `packages[]` with
`registryType: "oci"` is exactly "run it as this container." Inventing
`_meta.art.cloister/v1.image` would fork a concept the standard already
owns and make mache's manifest less useful to non-cloister consumers.

### Why `registryType`, not the build tool

`packages[].registryType` names *where the artifact is fetched from*
(`oci`, `npm`, `pypi`), not *how it was built*. mache is built with
melange + apko; rosary might use `ko`; a third tool a Dockerfile. All
three produce an OCI image and all three declare `registryType: "oci"`.
The builder is invisible to the manifest, which is correct — cloister
pulls an image, it does not reproduce a build.

### Why operator-override-wins precedence

Pinning an image in `cluster.toml` is how an operator overrides a tool's
self-declared default (air-gapped mirror, a patched fork, a pinned digest
for reproducibility). Making the operator field win keeps the tool's
declaration a *default*, not a mandate — mirroring the ADR-0030 §A5
tenancy precedence (`server.json` declares, operator overrides).

## Bootstrap & migration

1. **mache first** (`cloister-31a988`) — mache's `server.json` generator
   (`tools/server-json-gen`) emits an `oci` package; its `cluster.toml`
   bundle keeps `image` set until the consumer side lands (rule 1 keeps
   it working throughout).
2. **Consumer side shipped** — resolver + `emit-compose` + lint, behind
   the loud fallback so no existing deployment changes behavior until an
   operator *removes* a hand-set image to opt into derivation.
3. Existing recipes are unaffected: their bundles keep explicit images,
   which rule 1 honors.

## Alternatives considered

- **Keep hand-wiring the image.** Rejected — it is the exact seam this
  ADR closes; it forces operators to track version strings the tool
  already publishes.
- **A cloister-specific `_meta.art.cloister/v1.image`.** Rejected — see
  Rationale; reuse the standard `packages[]`.
- **Derive image *only*, never allow override.** Rejected — operators
  need the last word (mirrors, forks, digest pins).
- **Support all `registryType`s (npm/pypi) in v1.** Deferred — a bundle
  is a container; `oci` is the only `registryType` that maps to a bundle
  image. npm/pypi packages describe a *different* run model (in-process /
  subprocess) that the bundle abstraction doesn't cover yet.

## Consequences

- A tool becomes **fully self-describing**: one `cloister add <ref>`
  yields both its backends (ADR-0026) and its runtime image (this ADR).
- Operators still may pin; nothing is taken away.
- **Open: publish pipeline.** Derivation is only as good as the `oci`
  identifier being *pullable*. A tool that declares
  `ghcr.io/org/mache:0.13.0` but never pushes it produces a manifest that
  fails at `compose up`, not at resolve. This ADR does not mandate a
  publish pipeline; it assumes the declared ref is real and defers
  publish-verification (a resolve-time registry HEAD?) to a follow-up.
- **Open: digest pinning.** `packages[]` may carry a digest; deriving
  `<identifier>@sha256:…` is stronger than a tag but requires the tool to
  emit digests. v1 supports both shapes; which is *recommended* is a
  follow-up once a real publish pipeline exists.

## Coordinated with

- `cloister-3c4b0c` (this ADR + STATUS row).
- `cloister-31a988` (constellation umbrella — mache producer side).
- ADR-0026 (`cloister-cf7a3b`) — the derivation this extends.

## Status

Accepted. Consumer side shipped under `cloister-505fb9`: resolver parses
`packages[].oci` into `cluster.lock.toml`, compose derives image when
`ext.image` is empty, and bundle-isolation Inv 10 warns when neither an
operator image nor a linked input's OCI package is available. Producer
side remains tracked under `cloister-31a988` for mache's generated
`server.json`.
