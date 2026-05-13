---
title: "ADR-0021: Per-bundle vault DO instances — implementing ADR-0013's identity-by-binding design"
status: Proposed (2026-05-12) — closes the open question in ADR-0013 §"in-cluster bundle identity propagation"; implementation lands WITH ADR-0018's internal-bundle portion (cloister-db99cd), not before it
date: 2026-05-12
tags: [security, vault, identity, isolation, slice-grant, adr-0013-implementation]
threat_model: docs/security/threat-model.md
relates_to:
  - 0010-vault-and-bundle-clusters.md
  - 0011-hypervisor-bundle-boundary.md
  - 0013-slice-grant-enforcement.md
  - 0014-pluggable-kek-source.md
  - 0018-notme-co-location.md
  - 0019-sign-only-helper-protocol.md
  - 0020-adversarial-team-charter.md
---

## Context

ADR-0013 ratified the slice-grant enforcement model (V8 isolate +
service-binding-as-syscall) and explicitly placed cross-bundle
isolation at the **binding layer**: each bundle wired to a distinct
vault DO via its own `env.VAULT_STORE.idFromName(...)` namespace, with
the manifest grants as the load-bearing thing. The original ADR
treated this as the *design*, not the *implementation*.

The implementation hasn't followed: today
`src/vault-store.ts` runs as a **singleton per cluster**
(`idFromName("cluster")`), same convention as TrustStore + BlobStore.
Only `cloister-router` reaches the singleton, threading
`VerifiedLease.peerFp` (the external peer's cert fingerprint) as
`subjectFp`. The single-caller invariant has been the load-bearing
isolation property and **still holds today** — notme runs as a
separate workerd process (`cluster.capnp:notme-identity` is
`kind = (external = ...)`, image `notme:0.1.0`, port 8788), reached
over UDS via the NOTME service binding. The in-process portion of
ADR-0018 (Alternative 4 split surface, accepted 2026-05-12) is
`in_progress` as cloister-db99cd but has NOT shipped.

When that in-process portion lands, notme becomes the **first
non-router bundle to need vault access**, breaking the single-caller
invariant. This ADR resolves the identity-propagation question
*ahead* of that landing so the design is settled before the trigger
arrives — but the implementation lands *alongside* ADR-0018's
internal-bundle portion, not in advance. Migrating router to
`idFromName("router")` before there's a second caller would be
busywork.

The dos-resilience-auditor pilot on 2026-05-12 (ADR-0020) surfaced
this as finding F2 (`cloister-2140b5`): with the current shape, a
per-`subjectFp` denial counter or capability check is keyed on the
*external user's* fingerprint, not the *internal calling bundle*.
Two bundles serving the same user share a counter key; a compromised
bundle calling vault is indistinguishable from an honest one beyond
"who's the end user."

The vault-store.ts file header (lines 92–110) lists three candidate
mechanisms for identity propagation:

  (a) Pre-issued DPoP token in the bundle's env.
  (b) Workerd surface for "which Worker is calling me."
  (c) Router-proxies vault calls on the bundle's behalf.

This ADR resolves the open question by selecting **ADR-0013's own
documented design (per-bundle DO instance)** — not the listed (a) /
(b) / (c), all of which add machinery to retain a singleton. The
selected path requires no new identity mechanism: the DO identity
*is* the bundle identity because each bundle reaches exactly one DO.

## Decision

**Migrate the vault from singleton-per-cluster to one DO instance per
bundle**, keyed by the bundle's manifest-declared name:

```
env.VAULT_STORE.idFromName(bundleName)
```

No `vaultInstance:` field is added to the manifest. The bundle's
existing `name` field is the DO instance name. A bundle that wants
to share a DO with another bundle (rare and architecturally
suspicious) would need an explicit override field added in a future
ADR; today the default is "one bundle, one vault DO."

Each bundle's vault DO holds only the credentials granted to that
bundle. Credentials are NOT shared across bundles for the same end
user. If bundle-mache and bundle-rosary both serve user X with
GitHub credentials, each bundle's vault DO stores its own
separately-granted credential. Separation is the security property,
not a regression.

**Caller of vault becomes a bundle, not a peer:** `cloister-router`
gets its own `idFromName("router")` instance for the legacy
peer-threading path. The composite primary key in vault's
`credentials` table stays `(subject_fp, service)` —
defense-in-depth against the (now-impossible-by-binding-shape)
case where two bundles end up in the same DO via a manifest
mistake. The key shape doesn't change; only the binding does.

**Layered defense follow-on (out of scope for this ADR):**
ADR-0019's sign-only helper enables a future per-call signature
gate where each bundle's vault DO additionally verifies a DPoP-style
signature against the bundle's per-bundle Ed25519 key held by the
helper. Useful belt-and-braces once the per-bundle DO migration
lands. Filed as a follow-up bead.

## Rationale

**Why not (a) DPoP-in-env?** Adds per-call signature verify on the
hot path (~50µs Ed25519) and a helper round-trip or batched
issuance. Useful as layered defense atop (d), not as the primary
gate, because the per-bundle DO already gives binding-layer identity
for free.

**Why not (b) workerd-caller-name?** Earlier code-search of
`config.capnp` + workerd's RPC documentation suggests workerd does
NOT natively surface "which bound Worker is calling me" on DO RPC.
This may change in a future workerd release, but the gate would
remain (a) or (d) until then. Filed as a research bead for future
workerd-capability check.

**Why not (c) router-proxy?** Explicitly flagged as a substrate-
isolation regression in `src/vault-store.ts:104-107`: puts the
router back in the credential path, which is exactly what the
slice-grant model (ADR-0013) was designed to avoid.

**Why (d) per-bundle DO?** It's already the ADR-0013 design.
Implementing it dissolves the identity-propagation question — the
DO instance *is* the identity. No new mechanism, no per-call
verification cost, no machinery to maintain.

**Why decide now (when implementation lands later)?** ADR-0018's
internal-bundle portion is `in_progress` (cloister-db99cd) and will
ship in the near term. Shipping that without F2 resolved would mean
the first multi-caller deployment of vault uses a denial-counter /
capability check keyed on the *wrong identity*, creating a "we
already did vault rate-limiting" excuse against revisiting. Settling
the design ahead of the trigger lets the ADR-0018 implementation
adopt the right binding shape from day one — no interim
singleton-plus-identity-propagation phase. Implementation work
itself lands alongside ADR-0018's internal-bundle portion, not
before.

**Why no new manifest field?** The bundle's `name` is already
unique (lint-tenant-docs enforces uniqueness in the route table).
Reusing it as the DO instance name keeps the manifest minimal and
makes the binding-to-bundle mapping discoverable by reading any
bundle's declaration.

## Consequences

**Migration shape (pre-1.0, no production data):**

1. **Schema:** no change. `credentials` table stays
   `(subject_fp, service)`-keyed. DO instance binding changes.

2. **Vault DO callsites:** `env.VAULT_STORE.idFromName(...)` is
   centralized in `src/routes/` callers. Router uses
   `idFromName("router")`. Future bundles use
   `idFromName(<bundleName>)` derived from cluster.capnp.

3. **cluster.capnp:** no new field. Each bundle's `name` already
   uniquely identifies it. The vault binding in a bundle's
   declaration uses the bundle's own name as the DO instance.

4. **Existing data:** vault is pre-1.0 with no production users
   today. The destructive-recreate playbook documented in the
   vault-store.ts file header (PRAGMA `table_info` check at
   constructor) handles the cutover cleanly for any
   workerd-local dev data.

5. **Test surface:** existing `test/vault/multi-tenant-isolation.test.ts`
   already covers the (subject_fp, service) composite-key SQL-layer
   defense. New tests pin the binding-layer property:
   `idFromName("notme") !== idFromName("router")` reach independent
   storage; bundle-A's `putCredential` is unreachable from bundle-B's
   stub.

6. **Migration order:** land the migration as part of ADR-0018's
   internal-bundle portion (cloister-db99cd). Same commit (or
   tightly-coupled PR pair) moves router from
   `idFromName("cluster")` → `idFromName("router")` AND introduces
   notme's in-process bundle with `idFromName("notme")` from the
   start. Don't migrate router solo — there's no second caller yet,
   so the singleton-to-per-bundle switch by itself is busywork.

**Layered defense follow-on (separate bead):** per-call signature
verification against the bundle's ADR-0019-helper-held Ed25519 key.
Adds ~50µs to each vault call but closes the "honest manifest +
compromised bundle calls its own vault DO" attack surface. Useful
once the substrate carries multiple bundles in production.

**Forward compatibility:** when a future bundle genuinely needs to
share a vault DO with another bundle (unusual — credential sharing
across bundles is a security regression), an explicit
`vaultInstance: "shared-pool-x"` override field can be added in a
future ADR. Today's default of `idFromName(bundleName)` covers the
1:1 case which is the right default.

## Status notes

- ADR-0018's design landed Accepted 2026-05-12, but the in-process
  bundle portion is `in_progress` (cloister-db99cd). Today
  `cluster.capnp:notme-identity` is still `kind = (external = ...)`
  (separate workerd process). This ADR's implementation lands
  alongside that bundle portion — not before.
- The implementation bead is filed separately
  (see comments on cloister-2140b5). Layered-defense bead (per-call
  signature gate) is a follow-on tagged for synthesis-lead's next
  cycle.
- Once implementation lands, the file header at
  `src/vault-store.ts:92-110` will be rewritten to document the
  decision rather than list open options.
