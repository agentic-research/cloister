---
title: "ADR-0034: True multi-tenant access spec for rosary / mache / ley-line / notme / signet"
status: Proposed (2026-06-24)
date: 2026-06-24
tags: [substrate, multi-tenancy, mcp, rosary, mache, ley-line, notme, signet]
threat_model: docs/security/threat-model.md
relates_to:
  - 0011-hypervisor-bundle-boundary.md
  - 0013-slice-grant-enforcement.md
  - 0015-mcp-spec-alignment.md
  - 0018-notme-co-location.md
  - 0021-per-bundle-vault-instances.md
  - 0024-credential-isolation-capability.md
  - 0030-multi-workerd-tenant-isolation.md
  - 0033-bd-substrate-binding.md
---

## Context

ADR-0030 ratifies the substrate direction: per-tenant workerd
processes outside V8's slice-grant boundary, with cross-tenant
isolation enforced at the kernel rather than only at the isolate.
The implementation epic (`cloister-f289c8`) is incremental — vault
first, then bundle types as they need multi-tenant scoping.

**The goal is true multi-tenancy**: each tenant has its own
isolated substrate consumption surface, with cross-tenant data
unreachable EVEN IF a V8 sandbox escape lands.

The substrate today wires five tool surfaces, each in a different
state of multi-tenant readiness:

| Tool | MCP surface | Current state | Multi-tenant gap |
|---|---|---|---|
| rosary (rsry) | `rsry_*` (post-cloister-c2bd47) | Cluster-tier sidecar; one cluster-wide instance | One bd Dolt store per cluster, not per tenant |
| mache | `mache_*` | Cluster-tier sidecar; one cluster-wide instance | One mache index per cluster; cross-tenant code visibility |
| ley-line | (not yet) | NOT wired; standalone UDP/FEC substrate | No MCP surface; would need wrapper |
| notme | `/identity/*` (NOT `/mcp`) | Hypervisor-tier bundle (singleton) | Identity authority IS cluster-wide by design; per-tenant scope at lease layer |
| signet | (CLI today; possibly MCP later) | NOT in cluster.toml | CLI for cert provisioning; questionable whether MCP wrapping is desired |

This ADR scopes each tool's multi-tenant access requirements, picks
a migration shape per tool, and sequences the work so the first
multi-tenant deployment can land without requiring every tool to
flip simultaneously.

This ADR is **direction**, not implementation. Each tool's actual
multi-tenant migration spawns its own sub-bead under
`cloister-f289c8`.

## What "true multi-tenancy" means here

A tenant boundary is enforced when:

1. **Storage isolation** — tenant A's data physically lives in a
   separate disk path / database / FS than tenant B's. A read
   request from tenant A is mechanically incapable of returning
   tenant B's bytes.
2. **Identity propagation** — every request entering a tenant's
   substrate carries an attested identity (Signet lease) bound to
   that tenant. Mediation happens at the lease layer per ADR-0007,
   NOT at the application layer.
3. **Process isolation (where applicable)** — per ADR-0030, the
   workerd process running tenant A's code MUST be distinct from
   tenant B's. V8 isolate boundary is necessary but not sufficient.
4. **Credential isolation** — per-bundle vault DO instances
   (ADR-0021) extend to per-tenant bundle instances. Tenant A's
   bundle's vault DO is a different SQLite store than tenant B's.
5. **Audit trail** — silence-is-evidence (§13.2 / §13.7.2) holds
   per-tenant; a compromised supervisor terminating one tenant
   doesn't silence others.

The five properties compose. A tool that satisfies (1) + (2) + (4)
is multi-tenant-capable at the application layer; adding (3) is
ADR-0030's substrate decision. (5) is the audit invariant the
threat model ratifies.

## Per-tool analysis

### Tool 1: rosary (rsry MCP)

**Current state**: shipped via cloister-c2bd47 as a cluster-tier
sidecar bundle (`bundles[name = "rosary"]`, image `rosary:0.2.0`,
listening on `/run/cloister-uds/rosary.sock`). The `rsry_*` mcpProxy
backend routes through `ROSARY_BUNDLE` service binding. ADR-0033
Phase 1: one rsry instance per cluster, no per-tenant scope on the
wire.

**Multi-tenant gap**:

- Storage isolation: bd's `.beads/dolt/<repo>/` is a single per-repo
  Dolt store today; multiple tenants in the same cluster share it.
- Identity propagation: rsry's MCP wire is UDS-internal,
  unauthenticated (ADR-0033 D4 Phase 1). No per-tenant claim flows.
- Process isolation: rosary bundle is shared across tenants
  (cluster-tier).

**Multi-tenant access requirements**:

1. **Per-tenant `BEADS_DIR`**: bd supports `BEADS_DIR` env var to
   point at a per-repo storage location. Per-tenant deployment
   sets `BEADS_DIR=/run/tenant-<id>/beads/dolt/`. Storage
   isolation achieved.
2. **Per-tenant rosary instance**: each per-tenant workerd (per
   ADR-0030 §A1) gets its own `rosary` bundle instance, with its
   own UDS socket, its own bd-Dolt directory. Process isolation
   achieved.
3. **Lease-bound rsry calls**: when an in-cluster bundle calls
   `rsry_bead_*`, the mcpProxy backend includes the verified
   `peerFp` (from cloister-router's lease middleware per ADR-0007)
   in the request `_meta`. rsry-side: refuse calls whose `peerFp`
   doesn't match the tenant's expected scope. Identity propagation
   achieved.
4. **Bearer-token on the wire**: ADR-0033 D4 Phase 2 lands. Per-
   tenant vault slice issues per-tenant rsry tokens; rosary verifies.

**Migration shape**: per-tenant rsry sidecar, scoped via `BEADS_DIR`
+ tenant-vault token. Cluster.toml grows a `[per_tenant]` table or
the `[[tenants]]` table-of-tenants overrides each cluster-tier bundle's
storage path.

**Sequencing**: rosary's multi-tenant flip is the FIRST tool to flip
under ADR-0030 (vault is the second, per cloister-f289c8 epic). Why
rosary first: bd's `BEADS_DIR` is already plumbed; no upstream
rosary change required; can ship as a manifest-only change.

**Estimated effort**: 1-2 weeks. Mostly cluster.toml schema +
emit-compose changes.

### Tool 2: mache

**Current state**: cluster-tier sidecar (`bundles[name = "mache"]`,
image `mache:0.8.0`, HTTP on `localhost:7532`). mcpProxy backend
`mache_*` with `dynamicTools=true`. One mache index per cluster,
indexed across whichever repos the operator pointed it at via
`MACHE_GO_MODULE` or similar config.

**Multi-tenant gap**:

- Storage isolation: mache's FUSE projection + tree-sitter index
  cover whichever directories the operator mounted. Cross-tenant
  code visibility today.
- Identity propagation: mache doesn't model identity; its MCP wire
  is internal-trust.
- Process isolation: one mache binary shared across tenants.

**Multi-tenant access requirements**:

1. **Per-tenant mache instance**: each tenant gets its own mache
   sidecar with its own scope of mounted code. Cluster.toml
   `[bundles.mache]` becomes `[bundles."mache-tenant-<id>"]`
   with per-tenant `MACHE_GO_MODULE` / source path.
2. **Per-tenant LLO backend** (mache's upstream): mache internally
   uses ley-line-open's LSP. Per-tenant mache → per-tenant LLO.
   LLO is currently cluster-wide too (one LLO daemon per cluster);
   per-tenant LLO is a separate migration but composes cleanly.
3. **Lease-bound mache calls**: same shape as rsry — peerFp in
   `_meta`, mache-side scope check. Mache today doesn't do this; it
   relies on the cloister-router's lease gate before its requests
   arrive. With multi-tenant routing, the per-tenant workerd's
   lease gate is what enforces the scope; mache stays
   identity-unaware.

**Migration shape**: per-tenant mache sidecar. Like rsry's shape but
with the additional complexity of per-tenant LLO underneath.

**Sequencing**: mache flips AFTER ley-line-open is per-tenant. LLO
multi-tenant work needs its own scoping (out of cloister's scope —
LLO repo decision).

**Estimated effort**: 2-4 weeks once LLO multi-tenant lands.
Substantial because mache's FUSE projection has assumptions about
single-tenant code mount; per-tenant requires either (a) per-mache-
instance distinct FUSE mounts, or (b) a tenant-aware projection
layer that scopes queries by tenant identity.

### Tool 3: ley-line (the UDP/FEC substrate, NOT ley-line-open)

**Current state**: NOT wired into cloister. Standalone UDP/FEC
substrate with CLI binaries (`leyline-blast`, `leyline-read`). Per
its `ARCHITECTURE.md`: a content-distribution substrate using
fountain codes over UDP, double-buffered arena layout, NFS/FUSE
flow. Not an MCP server; not currently a cloister consumer.

**Multi-tenant gap**:

- ley-line has no current cloister surface, so "multi-tenant access"
  means "is there value in exposing ley-line to cloister tenants
  AT ALL?" The substrate doesn't currently need ley-line for any
  feature.

**Multi-tenant access requirements**:

If ley-line becomes a cloister-consumed substrate, the same five
properties apply. Likely shape:

1. ley-line gets an MCP wrapper or stays out of cloister's substrate
   surface.
2. If wrapped: per-tenant ley-line bundle (cluster-tier), with
   per-tenant UDP port + per-tenant arena mount.

**Migration shape**: Two options:

- **Defer**: ley-line stays a host-side tool, not a cloister
  consumer. No multi-tenant work needed.
- **Adopt**: write an `mcpProxy` wrapper around ley-line's CLI or
  add an MCP server to ley-line itself. Then per-tenant ley-line
  instance per ADR-0030.

**Recommendation**: defer. ley-line solves the content-distribution
problem at a layer below cloister's substrate; the substrate doesn't
currently consume it. If a future cloister tenant wants
ley-line-accelerated content distribution, the wrapper lands then.

**Sequencing**: not blocking ADR-0030 implementation. Track as a
future bead.

**Estimated effort (if adopted)**: 2-3 weeks for the wrapper + per-
tenant scoping. Currently UNTRACKED.

### Tool 4: notme (notme-identity)

**Current state**: hypervisor-tier singleton bundle (`bundles[name
= "notme-identity"]`, image `notme:0.1.0`). Mints lease certs. The
`/identity/*` route on cloister-router proxies to notme's
`/identity/*` via the `NOTME` service binding. Critically, notme
runs on cloister via ADR-0018 (notme co-location).

**Multi-tenant gap**:

- Identity authority is INTENTIONALLY cluster-wide singleton: one
  master CA per cluster mints all lease certs. Per ADR-0011's
  three-criterion test, notme is hypervisor-tier because compromise
  blast radius is cluster-wide (forge any peer's identity).
- Multi-tenancy at notme means: **per-tenant lease scopes**, not
  per-tenant notme instances. One notme mints all leases, but each
  lease's `scope` field constrains it to a tenant's substrate
  surface.

**Multi-tenant access requirements**:

1. **Per-tenant scope minting**: notme's `LocalCA.IssueBridgeCert`
   (Go-side) takes a `scope` parameter. Today scopes are
   per-service (`vault:proxy:openai`, `disclosure:<fp>`). Add
   per-tenant scoping: `tenant:<id>:*` claims that a tenant-bound
   lease can only authorize calls within that tenant's substrate.
2. **Per-tenant CA rotation** (optional, future): if the operator
   wants tenants to have independently rotatable identity roots,
   per-tenant intermediate CAs branching from notme's master. NOT
   in this ADR's scope.
3. **Cross-tenant disclosure**: notme's existing disclosure surface
   (`/interlace/peers/<fp>`) becomes per-tenant routed (ADR-0030
   §A2 / §13.7.1 — already shipped). Notme-side no work; cloister-
   side already done in the C1-C7 cycle.

**Migration shape**: scope vocabulary extension in notme + cloister's
lease middleware enforces. Notme stays singleton; the multi-tenancy
is at the lease-scope layer.

**Sequencing**: notme scope-extension is a small ADR (or amendment
to ADR-0018). Lands when the first multi-tenant deployment needs
per-tenant lease scoping — i.e., concurrent with rosary's
per-tenant flip.

**Estimated effort**: 1-2 weeks (notme Go changes + cloister
lease-middleware scope check + threat-model update).

### Tool 5: signet

**Current state**: CLI-only today. `signet auth register` provisions
client certs for MCP endpoint authentication; `signet authority
identity` exposes a trust-anchor URL. CLI binaries; NO MCP server.
`SIGNET_URL` env var exists in cloister but is empty (`signet not
yet deployed`).

**Multi-tenant gap**:

- Signet is currently an OPERATOR tool, not an in-cluster substrate.
  Operators run `signet auth register` locally to get client certs
  for accessing the cluster.
- The question is whether signet needs an MCP surface at all, and
  whether per-tenant signet matters.

**Multi-tenant access requirements**:

If signet stays operator-CLI-only: no work. The certs it provisions
are consumed at the cloister boundary (cloister verifies the
client cert; signet doesn't enter the substrate).

If signet grows an MCP surface (e.g. for runtime cert rotation
without operator intervention): per-tenant signet instance OR
shared-instance-with-per-tenant-scoping. Same pattern as notme.

**Migration shape**: TWO options:

- **Defer**: signet stays a CLI. Per-tenant deployments use per-
  tenant client certs minted by per-tenant signet invocations.
  Operator runs signet for each tenant individually.
- **Adopt**: signet ships an MCP server, per-tenant signet bundles
  in cluster.toml with per-tenant scoping.

**Recommendation**: defer. signet's primary value is its CLI flow
(GitHub OIDC → bridge cert → SSH-into-cluster). MCP-wrapping the
cert provisioning doesn't add substrate value; it adds substrate
complexity. If a future cloister tenant wants runtime cert
provisioning, the wrapper lands then.

**Sequencing**: not blocking ADR-0030 implementation. Track as a
future bead.

**Estimated effort (if adopted)**: 2-3 weeks. Currently UNTRACKED.

## Decision

The five tools split into three classes:

1. **In-scope for ADR-0030 multi-tenant deployment** (substantive work):
   - **rosary (rsry MCP)** — per-tenant rsry sidecar + bd `BEADS_DIR` +
     lease-bound calls. SIBLING bead `cloister-c2bd47` Phase 2 covers
     this; promote to its own bead `cloister-?` upon ADR ratification.
   - **mache** — per-tenant mache + per-tenant LLO. SUBSTANTIAL;
     requires LLO multi-tenant first.
   - **notme** — per-tenant scope minting. Small ADR amendment +
     cloister lease-middleware scope check.

2. **Deferred (not blocking ADR-0030)**:
   - **ley-line (UDP substrate)** — defer until a tenant needs it.
   - **signet** — CLI flow is sufficient; MCP wrapping only when a
     specific tenant requires runtime cert rotation.

3. **Already shipped (no further work)**:
   - notme's per-tenant DISCLOSURE routing (§13.7.1) — landed in C1
     of the 2026-06-22 adversarial cycle.

## Sequencing

The minimum multi-tenant deployment requires:

1. Cluster.toml grows a `[[tenants]]` table (or `[per_tenant]`
   override mechanism). Existing `tenantDispatch` route consumes
   it. **Scoped under**: `cloister-c2bd47` Phase 2 (rsry per-tenant)
   + a new bead.
2. Per-tenant workerd processes per ADR-0030 §A1 — compose-emitter
   change. **Scoped under**: `cloister-f289c8`.
3. Per-tenant rsry sidecar with per-tenant `BEADS_DIR`. **Scoped
   under**: rsry per-tenant follow-up bead.
4. Per-tenant vault DO instances (ADR-0021 extended to per-tenant
   bundle instances). **Scoped under**: `cloister-f289c8` Phase 2.
5. notme scope-extension (`tenant:<id>:*` claim vocabulary). **Scoped
   under**: notme-side bead + cloister lease-middleware bead.

mache + LLO multi-tenant work composes AFTER rsry + vault land —
mache is the next-most-isolation-critical tool but its complexity
is concentrated in LLO's per-tenant flip (LLO repo's call).

ley-line + signet are out-of-band; no sequencing pressure.

## What this is NOT

- **NOT a commitment to per-tenant ley-line or per-tenant signet.**
  Both defer until a specific tenant requires them.
- **NOT a rosary-bead-tracker substrate decision.** rosary's internal
  storage is its choice (today: bd-Dolt; the multi-tenant flip uses
  bd's `BEADS_DIR`). If rosary later swaps storage, cloister
  doesn't care.
- **NOT a deprecation of the BeadStore Durable Object.** That's
  `cloister-c8b907` — a separate dedup question. Multi-tenant
  access spec is orthogonal to which substrate hosts beads.
- **NOT a substrate-wide bearer-token rollout.** ADR-0033's Phase 2
  bearer-token work is per-substrate; this ADR doesn't blanket-
  authorize bearer tokens for non-bd substrates.

## Open questions

1. **`[[tenants]]` schema shape.** Does the operator declare tenants
   inline (a flat list in cluster.toml) or via per-tenant overrides
   on existing bundles? Lean inline list; mirrors the existing
   `tenantDispatch` route shape and keeps the bidi pipeline simple.
2. **Per-tenant DO key derivation.** Per ADR-0021,
   `idFromName(bundleIdName)` is the per-bundle vault DO seam. For
   per-tenant: `idFromName("<bundleIdName>:<tenantId>")` or a
   nested `idFromName` style? Pick whichever the existing forward-
   guard lint (`cloister-93b0c2`) handles.
3. **Lease scope grammar.** `tenant:<id>:*` is the shape proposed
   above. Confirm `:` separator is OK against notme's existing scope
   vocabulary; align with ADR-0028 capability identifier scheme.
4. **mache + per-tenant LLO sequencing.** Can mache ship per-tenant
   BEFORE LLO does (with shared-cluster LLO)? Or does cross-tenant
   LLO visibility break mache's per-tenant scope?
5. **Cluster.toml backward compat.** Existing operator configs with
   no `[[tenants]]` table get back-compat single-tenant behavior
   (matching today). New operator-onboard recipes ship with
   `[[tenants]]` as the canonical shape.

## Tracking

- This ADR: cloister-cbfd7f
- Parent epic: `cloister-f289c8` (vault first, then bundle types)
- Sub-beads to spawn from this ADR's decision:
  - rsry per-tenant migration (rosary repo + cloister-side wiring)
  - notme scope-extension (notme repo: `tenant:<id>:*` minting)
  - cloister lease-middleware scope check (cloister repo)
  - `[[tenants]]` schema + emitter (cloister repo)
  - mache + LLO multi-tenant composition (mache + LLO repos, deferred)

## References

- ADR-0030 — multi-workerd tenant isolation substrate direction
- ADR-0033 — bd substrate binding (sibling — rsry MCP wire)
- ADR-0018 — notme co-location (where notme sits in the substrate)
- ADR-0024 — cred-iso/v1 (the credential isolation capability per-tenancy
  composes with)
- ADR-0021 — per-bundle vault DO instances (extends to per-tenant)
- ADR-0007 — Interlace substrate (lease verification, the scope-check
  layer)
- `cloister-f289c8` — implementation epic
- `cloister-c8b907` — BeadStore DO deprecation (separate question)
- `cloister-c2bd47` — bd substrate impl (rsry Phase 1 shipped; Phase 2
  is per-tenant rsry which this ADR scopes)
