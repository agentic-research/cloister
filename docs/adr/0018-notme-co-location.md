---
title: "ADR-0018: Co-locate notme as a workerd-bundle tenant inside cloister-router"
status: Proposed (2026-05-12) — pending math-friend dual review (cloister-db99cd)
date: 2026-05-12
tags: [identity, notme, trust-root, tier-classification, slice-grant, metavisor]
threat_model: docs/security/threat-model.md
relates_to:
  - 0011-hypervisor-bundle-boundary.md
  - 0013-slice-grant-enforcement.md
  - 0014-pluggable-kek-source.md
  - 0007-interlace-substrate.md
---

## Context

Today notme runs as a **separate `workerd` process** bound to
cloister-router via the `NOTME` service binding. Locally, `task dev`
spawns two wrangler-dev processes (cloister + notme); the cluster
compose file declares them as two services.

The motivation in the original architecture was process-level isolation:
notme holds the master signing key (`master_sk`); a separate process
gives kernel-level OS isolation between cloister's request-handling
code paths and the key material itself.

Three things have changed since that decision:

1. **[ADR-0011](0011-hypervisor-bundle-boundary.md) classified bundles
   into tiers.** notme is unambiguously hypervisor-tier — it holds
   load-bearing cluster trust. Per the three-criterion test, hypervisor
   bundles live inside cloister-router's process. notme being external
   is a tier violation.

2. **[ADR-0013](0013-slice-grant-enforcement.md) ratified slice-grant
   enforcement** via the V8 isolate boundary + service-binding-as-syscall.
   We trust this for the CredentialVault DO (holding per-bundle DEKs).
   The trust model is identical for `master_sk`: a workerd bundle's V8
   isolate cannot reach outside its declared bindings.

3. **[ADR-0014 v2](0014-pluggable-kek-source.md) requires `master_sk`
   to live in an OS keystore (or HSM) accessed through a URL-spec
   resolver**, not in process heap. With v2, the daemon (notme, today)
   is a *router* — it mediates keystore access, but the key bytes
   themselves stay in Keychain/libsecret/TPM. The process-level
   isolation argument loses its load-bearing role once master_sk
   isn't in any process's heap.

## Decision

**Co-locate ONLY notme's cluster-internal surface as a workerd-bundle
tenant inside cloister-router's workerd process. Keep notme's public
surface as a separate Cloudflare Worker deploy unit.** This is
"Alternative 4" from the §Alternatives section — selected as the
decision rather than the fallback after the external-consumer survey
(see `docs/research/notme-external-consumer-survey-2026-05-12.md`)
found concrete consumers requiring notme's public surface up
independently of cloister-router.

Specifically:

- A new bundle `notme-identity` declared in `cluster.capnp` at
  `tier = hypervisor`. This bundle serves **only the cluster-internal
  paths**: `/internal/ca-bundle`, `/internal/sign-jwt`, and any
  future paths consumed only by other in-process bundles.
- **The public notme worker stays as a separate Cloudflare Worker**
  at `auth.notme.bot`, serving `/cert`, `/cert/gha`, `/token`,
  `/authorize`, `/auth/oidc/login`, `/auth/passkey/*`, `/invites`,
  `/join`, `/connections`, `/.well-known/jwks.json`, and browser
  assets. This preserves availability for the external consumers
  the survey identified (signet-resign GHA, rig deploy, rig CF
  Worker, browser passkey/OAuth users).
- `NOTME` service binding in cloister-router resolves to the
  `notme-identity` in-process bundle for `/internal/*` calls; the
  public worker stays addressed at its own hostname.
- `master_sk` access for the cluster-internal path mediated via the
  URL-spec resolver + sign-only helper (`cloister-127a3c` + ADR-0019).
  Key bytes stay in OS keystore / HSM; same shape applies to the
  public worker's signing path.
- Bundle-isolation lint (ADR-0013 Inv 2/3/4 + new Inv 5) updated to
  whitelist the `notme-identity` bundle for the bindings master_sk
  access needs; no other bundle may hold those bindings.

### Why Alternative 4 (split surface), not Alternative 3 (full co-location)

The external-consumer survey (ADR-0018 prerequisite gate #5,
satisfied 2026-05-12) found four classes of external consumer that
need notme's public surface up while cloister-router is restarting:

1. **GHA workflows** (`signet-resign.yml`, `rig/deploy.yml`,
   `signet/gha-identity.yml`, `notme/action/`) minting bridge certs
   via `/cert/gha` during CI runs that can fire at any time
2. **`rig` Cloudflare Worker** (rosary-dashboard) on its own zone
   calling auth.notme.bot for cert minting, JWKS verification, and
   authorize redirects
3. **Browser passkey/OAuth users** at `auth.notme.bot/login`
4. **301-redirect callers** from `auth.rosary.bot/*` →
   `auth.notme.bot/*` (rig middleware)

Full co-location would couple these consumers to cloister-router
restart windows. Alternative 4 keeps the public surface independent
while still landing the tier-alignment win for cluster-internal
trust mediation.

## Rationale

Three load-bearing claims:

1. **The V8 isolate + bundle-isolation lint is a strictly stronger
   boundary than process-level isolation IF the lint holds.** A
   compromised cluster-tier bundle in cloister-router can't reach
   `notme-identity`'s service binding because it's not on its
   manifest; the workerd binding system enforces this at the
   binding-resolution layer, not at runtime. Process boundary requires
   the OS kernel to enforce; V8 boundary requires V8 (which is in our
   trust base anyway since cloister-router runs there). Net: equal
   trust base, finer-grained policy.

2. **`master_sk` not being in any process heap is what actually
   matters.** ADR-0014 v2 already requires this. With the URL-spec
   resolver, neither the current notme process NOR a co-located
   notme bundle holds the raw key bytes. They both just route signing
   requests to the helper sidecar that talks to OS keystore. The
   process boundary's only remaining role is "isolate the routing
   logic" — which the V8 isolate also achieves.

3. **Operational simplification (reduced under Alternative 4).** Under
   the original full-co-location framing, one workerd process to deploy
   + observe + scale. **Under Alternative 4 (the actual decision after
   the external-consumer survey), TWO deploy units remain** — the
   in-process `notme-identity` bundle AND the public notme Cloudflare
   Worker. The operational-simplification claim weakens: we save the
   wrangler-dev/cluster-compose entry for the cluster-internal mediation
   path only. The trade is: weaker simplification, but availability
   decoupling for external consumers preserved. Per the survey, the
   trade is the right one.

   The metavisor model (cloister hosting cloister-shaped substrates)
   still gets a reference implementation — the cluster-internal
   `notme-identity` bundle is structurally a child substrate hosting
   an in-process identity authority. The public-surface worker is a
   sibling, not an alternative to the metavisor framing.

## Threats and mitigations

[INTENTIONALLY LEFT FOR MATH-FRIEND DUAL REVIEW. Categories the
Synthesized from math-friend dual review (cloister-db99cd, 2026-05-12).

### Cryptographic boundary (math-friend #1)

The original §Rationale claim — "V8 isolate is STRICTLY STRONGER than
process boundary" — does not hold. Process boundary contributes
separate page tables, ASLR, KASLR, hardware-level memory protection.
V8 boundary contributes JS-level reachability + sandboxed-pointer
compression — but these are SOFTWARE in ONE process. A V8 0-day in
any bundle reaches the workerd process's address space, including
other isolates' heaps.

**Correct framing:** V8 boundary trades memory-isolation for
finer-grained policy expression. We accept the tradeoff because
(a) V8 is already in cloister-router's TCB, (b) one-tenant self-host
deployments have no cross-customer side-channel concern, (c) the
operational + tier-alignment wins are real. Equal kernel-derived
guarantees, plus a software-only reachability gate (the lint),
minus the cross-process memory-isolation guarantee the sidecar gave.

**Attack-surface delta vs sidecar:**

| New attack surface | Mitigation |
|---|---|
| V8 0-day in cloister-router → reaches notme-identity heap | Track workerd CVEs as P0 substrate patches |
| Cross-isolate microarchitectural side channels (Spectre/RIDL) | Best-effort V8 mitigations; document as residual for self-host |
| Wasm-RCE adjacency (wasm corruption pollutes all isolates) | Wasm modules MUST be signed + verified at load (future bead) |
| Single core-dump captures master_sk heap | Sign-only helper (ADR-0019) — master_sk is in helper process, not workerd |
| Shared CPU-time accounting | workerd's per-isolate CPU caps; not security boundaries today |
| Confused-deputy via leaked Fetcher/DO stub | Code review of any RPC returning callable handles |

**Closed attack surfaces (the win side):**
- No exposed `notme-bot` port (eliminates the current `network = (allow=["public"])`)
- No inter-process serialization round-trip of trust-bundle bytes
- No two-process race conditions on epoch rotation

### Implementation completeness (math-friend #1)

The lint invariants (`scripts/lint-bundle-isolation.mjs`) had 7 specific
gaps before cloister-988589 closed them. With the lint-gaps fix shipped,
the invariants are:

- **Inv 1** — no `globalOutbound` to network OR external-server service
  unless tier=hypervisor (gap 4 closed)
- **Inv 2** — credential bindings only on allow-listed bundles. Allow-list
  is now read from `cluster.capnp` `holdsCredential` field (gap 2 closed)
- **Inv 3** — every bundle declares a tier; hypervisor-tier requires
  non-empty `hypervisorRationale` (gap 1 closed)
- **Inv 4** — cluster-tier service bindings resolve to (a) wire or (b)
  external service
- **Inv 5** — hypervisor-to-hypervisor service bindings MUST appear in
  cluster.capnp wires (gap 5 closed; new ADR-0018-blocker for the
  multi-hypervisor topology)

**`master_sk`-not-in-heap is conditional on ADR-0019 sign-only.** The
v2a helper (today) returns key bytes; for the boundary argument to be
load-bearing, the helper MUST evolve to sign-only per ADR-0019. Until
then, `master_sk` traverses V8 heap during the sign window and the
co-location wins reduce to tier alignment + operational simplification,
NOT heap isolation.

### Recovery (math-friend #2)

**Compromise → rotation.** Pre-ADR-0019 sign-only: rotation requires
either operator-initiated `SigningAuthority.rotate()` RPC (compromised
bundle could refuse or pre-empt) or destruction of `/data/do` (breaks
identity continuity). Operator playbook: redeploy clean cloister-router
image with `task identity:rotate` startup hook; accept 5-min revocation
window. **Post-ADR-0019 sign-only:** rotation = OS-keystore-entry
rotation + bundle redeploy. Compromised bundle can still sign during
its lifetime (but cannot exfil master_sk bytes); operator playbook
unchanged in shape.

**Crash → state recovery.** `SigningAuthority` DO storage moves into
cloister-router's `/data/do` volume. Backup/restore atomicity now spans
identity + bead state. Inconsistent restore (T1 notme state + T2 bead
state) breaks the attestation chain. **Operator playbook:** backup
`/data/do` as a single atomic snapshot; NEVER restore selectively.
Threat model §13.4 needs a row covering cross-DO backup/restore
atomicity (file as separate bead).

**Bootstrap.** On a fresh `/data/do` volume,
`SigningAuthority.getOrCreateSigningKey` auto-generates a new master_sk.
**Operator surface change:** `docker volume rm cloister-do` now destroys
identity continuity, which previously required wiping notme's separate
volume. **Post-ADR-0019:** master_sk lives in OS keystore + survives
`/data/do` reset — a genuine improvement to recovery posture, and a
cleaner argument FOR this ADR.

**Keystore unavailability.** Post-ADR-0019, the helper binary becomes
a single point of failure for both vault KEK reads and master_sk
operations. Threat model §2 grows a row for the helper. See ADR-0019
§"Operational" for failure-mode catalog.

### Operational correlation (math-friend #2)

**Replaces the original "acceptable per hypervisor-tier classification"
gloss, which was a category error.** Hypervisor-tier classification
justifies WHERE trust mediation lives (ADR-0011); it says nothing about
availability semantics. Two independent axes.

**Honest framing:** Single-process failure mode correlates
cloister-router and notme availability. We accept this because:

1. **External consumers of notme's HTTP surface are themselves gated on
   cloister-router** being up for their MCP traffic. Independent notme
   availability gives them nothing.
2. **Cluster-internal consumers are by definition co-resident anyway.**

**If condition (1) is NOT empirically true** for some external consumer
(e.g., a GHA CI workflow minting bridge certs via `/cert/gha` while
cloister-router is being restarted), then **Alternative 4 (below) is
preferred** over full co-location.

**Resource correlation in V8 isolate budget.** workerd schedules across
V8 isolates inside one process. CPU contention is at the task-queue
layer; memory contention is process-wide. **Concrete failure mode:**
`tools/call bead_create` burst could starve concurrent cert mints past
their 5-min TTL → lease refresh fails → cluster fails closed. **Joint
benchmark** (bead_create + cert_mint on one workerd process) is filed
as a follow-up; this ADR does not currently characterize the load
profile.

## Alternatives considered

1. **Keep notme as separate process (status quo).**
   - Pro: kernel-level OS isolation; familiar boundary.
   - Con: tier violation per ADR-0011; operational overhead; the
     master_sk-in-heap concern is the same either way (until
     ADR-0019 sign-only); not aligned with the metavisor model.

2. **Co-locate notme but in a separate workerd config / process
   reachable via UDS.**
   - Pro: process boundary preserved.
   - Con: only saves the wrangler-dev part of dev tooling; doesn't
     resolve the tier violation; adds UDS complexity.

3. **Co-locate via V8 isolate (this decision).**
   - Pro: tier alignment; operational simplification; ADR-0013 trust
     model applies; ADR-0019 sign-only delivers heap isolation; the
     metavisor model gets a reference implementation.
   - Con: V8 attack surface IS larger than process attack surface,
     but already in trust base for cloister-router; single-fault-domain
     for the notme surface.

4. **Internal-only co-location (math-friend #2 alternative). ← SELECTED**
   Move only the cluster-internal paths (`/internal/ca-bundle`,
   `/internal/sign-jwt`) into the `notme-identity` bundle in-process;
   keep the public notme surface (`/cert`, `/cert/gha`, `/token`,
   `/authorize`, `/.well-known/jwks.json`, passkey/OAuth web flows,
   browser assets at `auth.notme.bot`) as a separate Cloudflare Worker
   deploy unit.
   - Pro: capability-mediation co-located (tier-alignment win);
     public notme availability decoupled from cloister-router; resource
     correlation reduced (only sign-jwt + ca-bundle compete with /mcp
     traffic).
   - Con: two notme deploy units in operations; operational-
     simplification claim weakens; `ll sign` and GHA CI workflows still
     depend on the public-side deploy unit being up — but that's
     unchanged from today.
   - **Selected as the decision** per the external-consumer survey
     (2026-05-12) which found four classes of external consumer
     requiring availability independent of cloister-router: GHA
     workflows (signet-resign, rig deploy, signet gha-identity),
     rig CF Worker (rosary-dashboard), browser users at
     auth.notme.bot/login, and 301-redirect callers from
     auth.rosary.bot/*.

## Consequences

- `cluster.capnp` gains `notme-identity` as a hypervisor-tier bundle
  with non-empty `hypervisorRationale` (per Inv 3 / gap 1 fix).
- `config.capnp` declares the bundle; `NOTME` service binding resolves
  to it instead of the external Worker.
- `cluster.capnp` `notme-identity` bundle's `holdsCredential` field
  (per Inv 2 / gap 2 fix) extends to include the master_sk-access
  binding name (TBD — landed when ADR-0019 sign-only helper ships).
- `task dev` spawns one wrangler-dev process.
- The `cluster.compose.yaml` `notme-identity` service entry goes
  away (it's now in-process).
- **ADR-0019 (sign-only helper protocol)** is a hard dependency. Without
  sign-only, `master_sk` is in V8 heap during the sign window,
  defeating the heap-isolation argument. ADR-0018 implementation is
  unblocked at **cloister-993bef Phase C** (sign-only helper available
  as opt-in), NOT Phase F.
- **cloister-988589** (lint gaps fix, shipped) provides Inv 5
  (hypervisor-to-hypervisor wires MUST appear in cluster.capnp) +
  manifest-driven credential allow-list. Without these, the lint
  argument doesn't hold for multi-hypervisor topology.
- Failure-mode correlation: cloister-router and notme are now a
  single fault domain. **We accept this** because external consumers
  of notme's HTTP surface are themselves gated on cloister-router
  uptime for MCP traffic, so independent notme availability gives
  them nothing. If this empirical assumption breaks (external
  consumer survey finds counter-examples), Alternative 4 (split
  notme surface) is the right answer.
- **Operator-side documentation:** rotation playbook (covered in
  Recovery section above); backup/restore atomicity discipline
  (snapshot `/data/do` atomically, never restore selectively); joint
  benchmark needed for resource-correlation characterization.

## Coordinated with

- **`cloister-127a3c` / `signet-20a875`** — signet master_sk adopts the
  URL-spec resolver (prerequisite for the master_sk-not-in-heap
  property)
- **`cloister-12b062` / `signet-20e1c7`** — shared trust-anchor-helper
  (the keystore-mediation layer)
- **`cloister-125199`** (shipped) — ADR-0014 v2 amendment establishing
  the URL-spec contract this builds on
- **`cloister-db99cd`** — tracking bead for this ADR

## Status

- **Accepted** (2026-05-12) — math-friend dual review (cloister-db99cd)
  synthesized into the Threats and mitigations + Rationale sections.

### Prerequisite gate (must ALL be satisfied before implementation)

1. **ADR-0019 (sign-only helper protocol) — ACCEPTED.** ✓ (shipped 2026-05-12)
2. **cloister-988589 (lint gaps fix) — SHIPPED.** ✓ (shipped 2026-05-12)
3. **cloister-99165e (leyline-sign host-binary target) — SHIPPED.**
   Implementation of ADR-0019's wire spec.
4. **cloister-993bef (kek-helper.mjs migration) — Phase C.**
   `--use-rs-helper` flag works; sign-only path available as opt-in.
   (Phase F — full removal of JS helper — is NOT required for ADR-0018
   to unblock; Phase C is sufficient.)
5. **External-consumer survey for notme's public surface.** ✓
   **Completed 2026-05-12.** Report at
   `docs/research/notme-external-consumer-survey-2026-05-12.md`.
   Finding: four classes of external consumer require notme's public
   surface up independently of cloister-router. **Decision: Alternative
   4 (split surface) — public worker stays separate; only cluster-
   internal paths co-located.** ADR §Decision updated accordingly.
6. **Joint benchmark.** bead_create burst + cert_mint on one workerd
   process. Resource-correlation characterization. File as separate
   bead; required to characterize the load profile before ADR-0018
   implementation, even if the result is "it's fine."
7. **Threat model §13.x update** for cross-DO backup/restore atomicity.
   File as separate bead.

When all 7 gates are satisfied, ADR-0018 implementation proceeds.
