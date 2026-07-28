---
title: "ADR-0058: Credentials reach the vault the way the KEK does — a declared source, resolved in-boundary"
status: Proposed (2026-07-28)
date: 2026-07-28
tags: [vault, credentials, kek, trust-boundary, declaration, dev-mode]
threat_model: docs/security/threat-model.md
relates_to:
  - 0010-vault-bundle-clusters.md
  - 0013-slice-grant-enforcement.md
  - 0014-pluggable-kek-source.md
  - 0021-per-bundle-vault-do.md
  - 0042-turnkey-local-harness.md
  - 0057-declaration-model.md
---

# ADR-0058: Credentials reach the vault the way the KEK does

Tracking bead: `cloister-7c9ca6`.

## Context

The vault has a working read side and no production write side.

- `vaultSlice` — appears **zero times** in `cluster.toml`,
  `manifest/cluster.capnp`, or `src/manifest/cluster-types.ts`. There is no
  schema field.

  Be precise about why, because two documents disagree. **ADR-0010 left this
  explicitly open**, §"What's still open", item 1: *"Whether `Bundle.vaultSlice`
  should appear in `cluster.capnp` as a manifest hint (tooling support…).
  **NOT for enforcement** — workerd bindings + vault `allowedSubs` enforce."*
  So its absence is an unanswered question, not an unimplemented decision.

  **CLAUDE.md:282 states it more strongly than its source supports** — "vault
  slices are the binding substrate. New bindings should land as `vaultSlice`
  declarations on a bundle" — instructing authors to use a field ADR-0010 never
  decided to create. That overstatement is itself worth correcting (this ADR
  does not fix CLAUDE.md; a separate change should).
- `putCredential` — exactly one caller: `vault-store.ts`'s `#devSeed`, gated on
  `CLOISTER_MODE === "dev"` and `DEV_VAULT_SEED`.
- `/vault/proxy` — the only vault route, and it is the read/inject side.

So today the only way a credential enters the vault is a dev seam that
`lint:no-dev-mode` exists to keep out of committed config. `task harness:dev`
works, credentials flow, the proxy injects — and every part of that path is
dev-only. The path that ships and the path that is exercised are disjoint, and
the working one must not ship.

**The "no external write route" decision is correct and this ADR keeps it.**
`vault-store.ts:451` states it deliberately: the dev seed ingests "in-boundary,
no external write route". An internet-reachable credential-write endpoint is an
attack surface worth not having. The gap is that no alternative was built
alongside it.

### What is already solved, and is the key to the answer

The **KEK** — the key that encrypts stored credentials — already has a
production-grade, non-dev, pluggable source. ADR-0014 shipped
`VAULT_KEK_SOURCE` with a scheme-routed resolver (`vault/src/kek-source.ts`):

| scheme | route |
|---|---|
| `file://` | `KEK_DISK`, a workerd disk service |
| `keychain://`, `secret-tool://` | `KEK_HELPER` — leyline-sign-helper (ADR-0019) |
| `http(s)://` | `KEK_HELPER`, deliberately helper-routed |

It is pinned to DO storage on first resolve and required equal on every
subsequent one, so an attacker cannot swap `keychain://prod` for
`env://ATTACKER` between instantiations.

That machinery is proven, in-boundary, and reaches host keystores from workerd —
which has no filesystem. The credential needs exactly the same thing.

## Decision

**A credential reaches the vault through a declared source, resolved
in-boundary by the vault DO at first use — the same shape as the KEK.**

Three parts.

### A. `vaultSlice` becomes a real declaration — answering ADR-0010's open question

ADR-0010 asked whether `Bundle.vaultSlice` should exist as a **manifest hint,
NOT for enforcement**. This ADR answers yes, and **changes its role**: a slice
here names a credential *source*, which is provisioning, not a hint.

That divergence is deliberate and must not be read as continuity. ADR-0010's
enforcement boundary is unchanged — workerd bindings and vault `allowedSubs`
still enforce, and a slice grants nothing. What a slice adds is *where the
credential comes from*, which ADR-0010 did not address because it had no
production write path to reason about.

```
struct VaultSlice {
  service    @0 :Text;   # vault service this credential authenticates
  source     @1 :Text;   # URL spec, same scheme vocabulary as VAULT_KEK_SOURCE
  provenance @2 :Text;   # who owns this fact (ADR-0057)
}
```

A slice declares *which* credential and *where it comes from* — never the
credential itself. A literal secret in `cluster.toml` is the thing ADR-0010
exists to prevent, and `lint:dev-escape` / `lint:no-dev-mode` already police
committed material.

### B. The source resolver mirrors the KEK's

Reuse `kek-source.ts`'s scheme routing rather than inventing a second
vocabulary. `file://` through a disk binding, keystore and helper schemes
through the helper binding. Same pin-on-first-resolve discipline: a slice's
source is pinned to DO storage and required equal thereafter, closing the same
swap attack ADR-0014 closed for the KEK.

The resolver returns the `{ upstream, headers, allowedSubs }` shape
`putCredential` already validates. No new credential format.

### C. Ingestion stays in-boundary

The vault DO resolves declared slices on first use and calls its existing
`putCredential`. That is the same in-boundary path `#devSeed` uses — the dev
seam was the right *mechanism* attached to the wrong *source*. No new route, no
external write surface, and `putCredential`'s rate-limit and payload-validation
gates apply unchanged.

## Consequences

**The dev seam becomes one source among several, not the only one.**
`DEV_VAULT_SEED` can stay as an `env://`-flavoured dev source rather than a
parallel code path, which shrinks what `CLOISTER_MODE=dev` is load-bearing for.

**`harness:dev`'s custody mode becomes operable in production.** ADR-0042's
turnkey run currently writes the API key to `DEV_VAULT_SEED`; with a declared
slice the same harness works with a real KEK and a real credential source. That
is the difference between `claude -p` being *runnable* and being *deployable*.

**The lattice gets an inhabitant.** A declared slice is a `requires` in
ADR-0027's sense, and per CLAUDE.md no input declares one today. A slice naming
a service no `[[gateway.vaultProxyServices]]` entry declares should fail the
build, exactly as harness targets now do (`cloister-742e19`).

**A rail is required in the same change.** Every declared slice resolves to a
declared service; every `holdsCredential` binding corresponds to a slice.
Without it this ADR is a comment — the failure mode `vaultSlice` has already
suffered once by being declared in prose and never in schema.

## Alternatives considered

**Operator CLI writing DO storage directly.** Same trust boundary as the dev
seed, no network surface. Rejected as the primary mechanism: on Cloudflare the
operator cannot reach a Durable Object's storage, so it cannot work in the
deployment target that motivates the vault. Viable as a local convenience later.

**Sealed-at-deploy: KEK-wrapped material shipped with the bundle.** Attractive —
no runtime dependency on a helper. Rejected as the primary mechanism because it
makes credential rotation a redeploy, and because it needs a wrapping format
this substrate does not have. Subsumed by (B) anyway: a `file://` source over a
disk binding IS sealed-at-deploy, without a new format.

**An authenticated write endpoint (lease-gated `PUT /vault/credentials`).**
Rejected. It re-introduces the external write route ADR-0010 deliberately
omitted, and its authentication would depend on the lease gate, which depends on
a CA bundle, which is fetched — a credential path with a network dependency in
its own bootstrap.

## Open questions

- **Does a slice's source resolve per-bundle or per-cluster?** ADR-0021 gives
  each bundle its own vault DO; a slice is declared on a bundle, so per-bundle
  is the natural reading. Two bundles naming the same `file://` path would then
  hold independently-encrypted copies, which is correct for isolation and
  wasteful for rotation.
- **What happens when a source resolves to nothing at first use?** Failing
  closed means a bundle cannot start without its credential; failing open means
  the proxy 401s later with a less obvious cause. The fail-closed reading is
  probably right, but it makes credential availability a boot dependency.
- **Rotation.** Pin-on-first-resolve deliberately prevents source swapping, and
  rotation is a source swap performed by the operator. ADR-0014 has the same
  tension for the KEK; whatever it settles on should apply here rather than
  being solved twice.
