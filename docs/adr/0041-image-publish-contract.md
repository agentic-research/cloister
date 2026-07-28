# ADR-0041 — OCI image-publish contract: each backend repo publishes its own distroless image

- **Status:** Proposed (2026-07-06)
- **Tracking bead:** `cloister-bd73a7` (this ADR + the rosary/mache/llo publish wiring it authorizes)
- **Pairs with:**
  - ADR-0038 (Derive bundle image from `packages[].oci` — this ADR **closes** its two deferred Opens: "publish pipeline" and "digest pinning")
  - ADR-0026 (Tool composition model — resolve→install→run; the `cluster.lock.toml` digest pin lives here)
  - ADR-0029 (Per-repo membership boundary for the OCI registry — the boundary that makes *each repo publishes its own* the natural shape)
  - ADR-0009 (Compute-substrate portability — the image is the bundle's deployment unit)
  - ADR-0030 (Multi-workerd substrate — the images a per-tenant process actually runs)

## Context

ADR-0038 taught cloister to *derive* a bundle's image from its input's
`server.json` `packages[].oci`, and explicitly deferred two things:

> **Open: publish pipeline.** … A tool that declares `ghcr.io/org/mache:0.13.0`
> but never pushes it produces a manifest that fails at `compose up`, not at
> resolve.
> **Open: digest pinning.** … which is *recommended* is a follow-up once a
> real publish pipeline exists.

Both Opens just bit real work. Auditing the three backend producers —
mache (Go), rosary (Rust), ley-line-open (Rust) — against the resolved
`cluster.lock.toml` shows the derivation is only as good as its premise,
and the premise is false today:

**Every producer already carries the image recipe, and none of them runs
it in CI.**

| Repo | Recipe present | What `release.yml` actually does |
|---|---|---|
| mache | `apko.yaml` + `melange.yaml` | builds binaries → `softprops/action-gh-release` (GitHub Release assets) |
| rosary | `apko.yaml` + `melange.yaml` + `image.Dockerfile` | builds `rsry` → `action-gh-release` + SLSA provenance |
| ley-line-open | `image.Dockerfile` | builds musl binaries → GitHub Release |

None has a `docker build-push` / `apko publish` step or `packages: write`.
rosary even declares `IMAGE_NAME: ghcr.io/${{ owner }}/rosary` as an env
var that is **never referenced again**. So each `packages[].oci` *names* a
ghcr image that CI never builds or pushes, and cloister's `inputs:pull`
(`pull_policy: never`) has nothing to pull. The recipe exists; the publish
step is missing.

Two secondary rot points surfaced in the same audit:

1. **The `packages[].oci` designation disagrees three ways.** In the
   resolved lockfile: llo bakes the tag into the identifier
   (`identifier = "ghcr.io/agentic-research/ley-line-open:0.5.6"`, no
   `version`); rosary splits (`identifier` + `version = "0.4.0"`); mache's
   *local* `server.json` carries no `packages[]` at all (the `github://…@v0.14.0`
   tag it resolves against does). Three shapes, one field.
2. **Recipe version drift.** rosary's `melange.yaml` pins `version: 0.1.0`
   while the release is `0.4.0`, and its `apko.yaml` builds `rosary:latest`.
   Even if wired today, it would publish the wrong version under a floating
   tag.

## Decision

Adopt a single **image-publish contract** across the backend producers.

### 1. Each backend repo publishes its own image

A backend tool's repository is the sole publisher of its container image.
CI, gated on a version tag, builds the image **from the recipe already in
the repo** and pushes it to ghcr under the repo's own namespace, with
`packages: write`. cloister does not build backend images — it *pulls*
them, consistent with ADR-0038's "cloister pulls an image, it does not
reproduce a build" and ADR-0029's per-repo OCI membership boundary.

This is **language-agnostic by construction.** apko assembles an image
from a *binary*, so mache (Go) and rosary/llo (Rust) use the identical
publish-job shape — the source language is invisible to the contract, the
same way `registryType: "oci"` makes the *builder* invisible to the
manifest (ADR-0038 §"Why `registryType`, not the build tool"). A repo that
prefers a Dockerfile (llo's `image.Dockerfile`) is equally conformant:
the contract fixes *what is published and how it is designated*, not *how
it is built*.

### 2. Canonical `packages[].oci` designation

One shape, for all producers:

```json
"packages": [
  {
    "registryType": "oci",
    "identifier": "ghcr.io/agentic-research/<name>",
    "version": "<x.y.z>"
  }
]
```

- **`identifier`** is the registry path **with no tag and no digest** — the
  address only.
- **`version`** is the human tag, and MUST equal **the tag the publish job
  actually pushes**. That is the whole rule: `<identifier>:<version>` has to
  resolve at the registry.

  **Corrected 2026-07-28.** This previously read "MUST match the git tag the
  publish job ran against *and* the `server.json` `version`". Those are two
  different strings whenever the git tag is `v`-prefixed, so the requirement
  was unsatisfiable, and the ecosystem split on which half to honour:

  | repo | publish job | image tag | `packages[].version` |
  |---|---|---|---|
  | rosary | `VERSION="${TAG#v}"` | `0.10.0` | `0.10.0` |
  | mache | `mache:${{ env.TAG }}` | `v0.19.0` | `v0.19.0` |
  | ley-line-open | (v-prefixed) | `v0.11.3` | `v0.11.3` |

  All three are **correct** — each matches its own pushed tag. The `v` prefix
  is a per-repo convention, not a mandate, and the ADR had no business
  requiring one.

  **Prerelease and platform strings are out of scope.** `1.0.0-beta.2`,
  `alpha`, `linux-amd64` and similar may or may not survive this path, and that
  is acceptable: `version` only has to work as a registry tag, never to parse
  as semver. A consumer deriving `<identifier>:<version>` neither sorts nor
  compares it. If a repo needs prerelease channels it declares whatever tag it
  pushes, and the rule still holds.

  This is checkable, unlike the old wording: a publish job can assert its
  pushed tag equals `packages[0].version` and fail if not. That assertion would
  have caught ley-line-open v0.11.2, which shipped an identifier with **no**
  version at all and therefore derived to nothing.
- The **digest** is not authored by hand; it is *resolved* — the publish
  job (or a resolve-time registry probe) records the pushed
  `sha256:…` into cloister's `cluster.lock.toml`.

This retires both deviant shapes: baking `:0.5.6` into `identifier` (llo)
conflates the mutable handle with the address and breaks ADR-0038's derive
rule 2 (`<identifier>:<version>`); an empty `packages[]` (mache local)
falls through to ADR-0038 rule 3 and yields no image.

### 3. cloister consumes by digest

`resolve-inputs` already records `identifier` + `version` (+ optional
`digest`) into `cluster.lock.toml`; `emit-compose` already derives the
image. The delta this ADR ratifies:

- **Prefer `<identifier>@<digest>` when a digest is present** — a tag is
  the human handle, the digest is the pin. This makes `cluster.lock.toml`
  a true lock (a re-resolve that yields a different digest for the same
  version is a drift the `lint-lockfile-drift` gate already surfaces).
- **Publish-verification at resolve/pull time** — a registry manifest
  `HEAD` for the declared ref, so a never-pushed image fails at
  `task inputs:pull` (or a lint), not silently at `compose up`. Closes
  ADR-0038's "fails at compose up, not resolve" gap.

cloister-the-hypervisor (the `cloister:0.1.0` router image) is the
**consumer** in this contract, not a producer; it keeps its own build
path and is out of scope here.

## Rationale

### Why distributed publish (each repo), not centralized (cloister builds)

The tempting alternative — cloister wraps each repo's already-published
release binary into an image at `inputs:pull` time — was rejected:

- The recipes **already live in each repo** (apko + melange, mature,
  wolfi-based, distroless, SBOM-ready). Centralizing would strand that
  investment and duplicate it in cloister.
- It puts packaging ownership where the code lives. The repo that cuts a
  release knows its runtime deps; cloister does not.
- It preserves ADR-0038's consumer/producer split and ADR-0029's per-repo
  OCI boundary. cloister stays a puller.

### Why apko / distroless

The existing recipes already choose it: a distroless image with just the
binary — no shell, no package manager, minimal attack surface, SBOM on
`apko publish`. The contract standardizes on the posture the repos already
adopted rather than inventing one.

### Why digest over tag as the pin

A version tag is mutable (a re-push moves it); a digest is the content
address. Pinning `@sha256:…` in the lockfile is what makes a deploy
reproducible and makes `lint-lockfile-drift` meaningful. The tag stays as
the readable `version`; the digest is the enforcement.

## Producer contract (what each repo adds)

1. **A tag-gated publish job** in `release.yml`: `melange build` (APK from
   source) → `apko publish ghcr.io/<org>/<name>:<version>` (or
   `docker/build-push-action` for Dockerfile repos) → record the pushed
   digest. Needs `permissions: packages: write`.
2. **Recipe version tracks the git tag** — kill the `melange.yaml`
   `0.1.0` / `apko.yaml :latest` drift; the version is the tag.
3. **Normalized `server.json` `packages[].oci`** per §2 (identifier
   without tag, explicit `version`).

## Bootstrap & migration

1. **This ADR** — the contract, inside cloister, touching no external CI.
2. **rosary as the reference impl** (`cloister-bd73a7` follow-on) — fix the
   version drift, add the publish job, normalize its designation, prove one
   `inputs:pull` end-to-end.
3. **Replicate to mache + llo** once the pattern is proven.
4. **Flip cloister `[inputs.*]`** from `from = file://…` to digest-pinned
   `ref` for reproducibility.

## Alternatives considered

- **Cloister builds images from release binaries (centralized).** Rejected
  — see Rationale; strands per-repo recipes, wrong ownership, breaks the
  ADR-0038 pull-not-build and ADR-0029 boundary.
- **Tag-only, no digest pin.** Rejected — leaves ADR-0038's digest Open
  open; not reproducible.
- **Tag-in-identifier (llo's current shape).** Rejected — conflates the
  mutable handle with the address and breaks ADR-0038 derive rule 2.
- **One shared reusable GH workflow across all three repos.** Deferred —
  DRY is attractive, but cross-repo workflow reuse is its own follow-up;
  get the contract and one reference impl right first.

## Consequences

- **Closes ADR-0038's two Opens** (publish pipeline; digest pinning).
- Each backend repo gains a publish job + `packages: write` — a
  supply-chain surface. rosary already emits SLSA provenance; extending
  provenance/signing (cosign, or an Interlace receipt over the image
  digest) to all three is the natural next seam.
- `cluster.lock.toml` becomes a genuine lock: digest-pinned, drift-checked.
- **Open: image signing.** A digest proves *what* you pulled, not *who*
  built it. Signing the digest (and eventually the ADR-0026 lockfile
  `signer` field carrying an Interlace receipt) is deferred to the
  receipt-signature phase already noted in the `cluster.lock.toml` header.

## Coordinated with

- `cloister-bd73a7` (this ADR + the publish wiring).
- ADR-0038 (`cloister-3c4b0c`) — the derivation this completes.
- `cloister-31a988` (constellation umbrella — mache producer side).
