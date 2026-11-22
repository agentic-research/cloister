---
title: "ADR-0083: Every placement runs images by digest, resolved for you"
status: Accepted (2026-11-21)
date: 2026-11-21
tags: [images, content-addressing, compose, kubernetes, lock, dev-experience]
tracking-bead: cloister-ca2582
relates_to:
  - 0026-tool-composition-model.md
  - 0038-derive-bundle-image-from-packages.md
  - 0041-image-publish-contract.md
  - 0078-needs-are-declared-once-every-placement-provides-them.md
  - 0081-cloister-is-a-core-drivers-and-features.md
external_refs:
  - https://carvel.dev/kbld/
  - https://ko.build/
---

# ADR-0083: Every placement runs images by digest, resolved for you

## Status

Accepted (2026-11-21). The owner asked for correctness and developer experience
together: every image runs by content address, and nobody types a digest or
runs an extra step to get there. The design is the implementer's.

## Context

ADR-0081's first guarantee is that a bundle runs only what its declaration
pins, by content address. Mapping guarantees to tests found that only the
microVM placement keeps it:

| Placement | What it runs |
|---|---|
| microVM | The rootfs by digest, recorded by `runtime import`; a mutable tag is refused |
| compose | A lock-pinned digest only for an image derived from an input. An operator's `image = "cloister:0.1.0"` wins, unpinned |
| Kubernetes | The `image` string from `cluster.toml`, verbatim. It never reads the lock |

Every shipped configuration and recipe names its images by tag. Several are
local builds (`task image` builds `cloister:0.1.0` with apko). Inputs are
already pinned by `cluster resolve`, which probes the registry
(`probeOciDigest`) and records `identifier@sha256:…` in `cluster.lock.toml`.

Two constraints shape the answer:

- **Committed renders must be deterministic.** `cluster.compose.yaml` is
  generated, committed, and regenerated in CI by `cluster:emit:check-drift`.
  It can only hold facts that are themselves committed. A local build's
  digest is a fact about one machine, at one moment.
- **A bare name is not a registry reference.** Docker reads `cloister:0.1.0`
  as Docker Hub's `library/cloister`, an image anyone could publish. Resolving
  a bare name against a registry would let a stranger's image take its place.

## Decision

### 1. One image resolution, for every placement

`cli/lib/oci-artifact.mjs` resolves a bundle's image the same way for compose
and Kubernetes. The microVM placement already runs from the lock. In order:

1. An image the declaration writes with a digest is used as written.
2. Otherwise, the lock's pin for it is used. That covers an input's pin and,
   with §2, an operator's image.
3. Otherwise, the image is unpinned.

A pinned image is written `name:tag@sha256:…`. Docker and Kubernetes run the
digest, and the tag stays readable.

### 2. `cluster resolve` pins operator images too

`cluster resolve` already pins inputs. It now also pins every operator image
that names a registry and is not written by digest, through the same
`probeOciDigest`, into `[[images]]` rows of `cluster.lock.toml`. Docker's rules
decide what a reference means:

- It names a registry only if its first component contains a `.` or a `:`, or
  is `localhost`. A bare name is never looked up in any registry.
- One with no tag means `latest`, the tag that moves most.
- `docker.io` is asked at `registry-1.docker.io`, where Docker asks, with a
  one-component name under `library/`.

An image the registry does not resolve is refused by name, as an input's is
(ADR-0041). The probe asks anonymously, as it does for inputs, so a private
image is written by digest until the probe reads registry credentials.

### 3. A committed render shows what it does not pin

The compose file and the Kubernetes manifests are rendered from committed
facts: a digest the declaration writes, or the lock's pin. An unpinned image
keeps its declared reference, and the file's header names it as unpinned,
with the fix. The render stays deterministic, so the drift check holds.

### 4. A run resolves at the moment of use

The command that starts a run resolves every image it is about to start:

- the lock's pin, as in §1;
- for a local build, the local Docker daemon's digest at that moment.

It refuses, by name, an image it cannot resolve. It records the digests it
started, so correctness does not depend on a tag standing still. For compose,
that command is `cloister cluster up`. A developer rebuilds an image and runs
`cluster up` as before, and the new digest is what runs. `cluster up` prints
the change when the digest has moved.

For compose, it works like this (`cli/lib/cluster/compose-up.mjs`):

- **The committed file runs as it is, with one override.** The override names
  each service's image by its content address and records it on the
  container. The run's directory holds it, and the run's end removes it. The
  committed file comes first, so the cluster root stays the project directory,
  and relative paths and `.env` keep their meaning. Every compose
  implementation merges `-f` files.
- **Images are resolved through the engine compose drives** (docker, podman or
  nerdctl):
  - an image written by digest runs as written;
  - any other image the engine holds runs by its image ID, under a tag made
    from the ID (`cloister:sha256-<hex>`), so a rebuild while compose starts
    cannot change what runs. ko (`ko.local/…:<digest>`) and Tilt
    (`:tilt-<hash>`) tag local builds the same way. The ID is a content
    address in docker's classic image store and in its containerd store. In
    the containerd store a local build also carries a repository digest, so
    "use the repository digest when there is one" would treat a local build
    as a pulled image in one store and not in the other. One rule serves
    both.
- **Only cloister pulls, and only what is safe to pull.** The emitter writes
  `pull_policy: never`, so compose pulls nothing. Cloister pulls an image
  written by digest by that digest alone. It pulls an image that names a
  registry by its tag, with the engine's own credentials, and then runs it by
  its image ID, as it runs one already held. A bare name is never pulled. That closes, at run
  time, the hole the Context names: compose would fetch Docker Hub's
  `library/<name>` for a local build that is missing.
- **It refuses before it changes anything.** Every image is inspected first. A
  bare name the engine does not hold is refused by name, and then nothing is
  pulled, tagged or started.
- **The record lives on the container, so `up` keeps no state file.** Labels
  hold it: `cloister.image` (the image as the compose file names it),
  `cloister.image.digest` (the content address that ran) and
  `cloister.image.by` (`pinned` or `id`). Neither value changes between runs
  of the same image, so the record never makes compose recreate a container.
  The next `up` reads
  them back to print what moved. It then removes the tag the previous local
  build ran under, so rebuilds do not pile up images that
  `docker image prune` would keep.

### 5. `--locked` makes the lock authoritative

With `--locked`, a run starts only a digest the declaration writes or the lock
pins, and refuses the rest by name before anything starts or is written:

- **compose** (`cluster up --locked`): an image with no digest, and a committed
  `cluster.compose.yaml` whose images are not what cluster.toml and
  cluster.lock.toml render. The second is the lock out of date with the
  declaration.
- **Kubernetes** (`cluster k8s --locked`): a container whose image has no
  digest, or runs a digest other than the lock's pin for its bundle. Lowering
  never overwrites a manifest, so one lowered before its image was pinned is
  caught here.
- **microVM**: it already runs only the rootfs the lock records, by digest.

CI uses it. The kind jobs run `cluster resolve`, then `cluster lower`, then
`cluster k8s --locked`, and the compose e2e checks both a refusal and a locked
start. This is the split Cargo (`--locked`), npm (`ci`) and Nix flakes draw
between a development loop that updates the lock and a build that must not.

> **Amended 2026-11-22.** As accepted, §5 also refused "a tag that now resolves
> to a different digest than the lock records". None of the prior art it cites
> does that. Each refuses only a lock that would have to change to cover the
> declaration, and none asks the registry what a tag names today. A locked run
> that did would depend on the registry's current state, which is what pinning
> removes. Whether a pinned tag has moved is `cluster resolve`'s question, and
> the lock it rewrites is a reviewed change.

## Consequences

- An operator image by tag on a registry is pinned the next time
  `cluster resolve` runs. Compose then runs it by digest.
- A manifest `cluster lower` writes carries the same pins compose does.
  Lowering never overwrites a manifest, so one lowered before its image was
  pinned keeps its tag until the operator updates it. Under §5,
  `cluster k8s --locked` refuses a manifest whose image is neither written by
  digest nor the lock's pin.
- A local build is content-addressed when it runs, not when it is declared.
  The declaration says which image. The run records which bytes.
- The work lands in this order:
  - §1–§3 first: they need no Docker daemon, and the unit tests and CI's
    drift check cover them;
  - §4 next, since it needs a daemon, which CI's compose job has;
  - §5 last, once CI can run `--locked` against a fully pinned configuration.
  All five have landed.
- A Kubernetes cluster pulls from a registry, so §4's local resolution covers
  compose first.
- Two things are open:
  - reading registry credentials the way Docker does (its config file and
    credential helpers), for inputs and operator images alike;
  - naming an image loaded into kind, which has no registry digest. That is
    settled with §4.

## Alternatives considered

- **Refuse every tag.** That is correct, but every rebuild would mean editing
  a digest by hand, so the configuration would not be usable.
- **Record local digests in the committed lock.** Every build would change a
  committed file with a fact about one machine, and the drift check could not
  hold.
- **Resolve bare names against Docker Hub.** That is what Docker does, and it
  is how a stranger's image takes the place of a local one.
- **Leave compose bundles to `docker compose up`.** Then the run is outside
  cloister, and nothing resolves or records what it starts.
- **Run a local build by its bare image ID** (`image: sha256:…`). Docker
  accepts it, but not every engine compose can drive is known to, and
  `docker ps` would show an ID where the image's name was. Every engine runs a
  tag.
- **Keep the record in a state file.** It would disagree with the containers
  the moment someone ran compose by hand. Labels are on the thing that runs.
