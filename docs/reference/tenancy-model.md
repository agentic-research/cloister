# Tenancy model — reference

How the cloister substrate declares + enforces tenant boundaries.

**This page is the source of truth** for what a "tenant" means in
this substrate. ADR-0030 + ADR-0034 reference here; recipes link
here; the lint script (`lint:bundle-isolation`) enforces what this
page describes.

## Two existing tenancy primitives (in cluster.capnp)

The substrate has **TWO** tenancy concepts today. They serve different
purposes and compose; an operator declaring a multi-tenant deployment
uses both.

### 1. `InputSpec.tenancy` — per-input tenancy (ADR-0030 §A5)

Each `[inputs.X]` in `cluster.toml` carries a `tenancy` field. This
binds an input (a composable tool / skill / agent def — per ADR-0026)
to a workerd process via the `workerdId` field.

```toml
[inputs.llo]
ref = "io.github.org/agentic-research/ley-line-open@main"
version = "0.4.5"
urlBinding = "LLO_MCP_URL"
serviceBinding = "LSP_MCP"

  [inputs.llo.tenancy]
  mode = "co-located"      # share workerd with siblings of same workerdId
  workerdId = "alice"      # this input runs in alice's workerd
  trustedTier = false      # cluster-tier (not hypervisor-tier)
  sharesWorkerdWith = []   # explicit co-tenancy edges (optional)
```

Per-input tenancy is the operator's primary mechanism for declaring
"which workerd hosts what". Multiple inputs sharing a `workerdId`
collapse into one workerd process (ADR-0030 §A1).

`mode` values:
- `"co-located"` — share workerd with siblings of same workerdId
  (OSS-launch default; matches today's single-workerd shape)
- `"external"` — runs in its own process / container (mache today)
- `"per-tenant"` — its own workerd per declared tenant (strongest
  isolation under ADR-0030 §D1)
- `""` — empty → defaults to input's server.json
  `_meta.art.cloister/v1.tenancy.default_mode`

### 2. `TenantDispatchRow` — per-tenant routing (ADR-0030 §A2)

The `tenantDispatch` route declares HOW external traffic reaches
each tenant's workerd. Each `[[routes.tenantDispatch.tenants]]`
entry pairs a tenant name with a routing predicate (SNI host or
path prefix) and a service binding.

```toml
[[routes]]
kind = "tenantDispatch"
path = "/"

  [[routes.tenantDispatch.tenants]]
  name = "alice"
  mode = "sni"
  matchValue = "alice.cluster.example"
  binding = "T_ALICE"      # service binding to alice's workerd

  [[routes.tenantDispatch.tenants]]
  name = "bob"
  mode = "path-prefix"
  matchValue = "/t/bob"
  binding = "T_BOB"
```

This is the routing table — it tells the substrate where to send
incoming requests. It does NOT declare what runs inside each
tenant's workerd; that's the per-input tenancy above.

## How they compose

Per ADR-0034, the substrate's tenancy model is the COMPOSITION of
the two primitives:

1. `InputSpec.tenancy.workerdId` declares **which workerd** an input
   lives in.
2. `TenantDispatchRow` declares **how external traffic reaches** a
   workerd via its service binding.
3. The two pair via a naming convention: every `TenantDispatchRow.name`
   in the dispatch table SHOULD correspond to a `workerdId` value
   that appears on at least one `InputSpec.tenancy`. The
   `binding` resolves to the per-tenant workerd's service binding in
   `cluster.toml [[wires]]`.

The substrate enforces this composition via `lint:bundle-isolation`
**Invariant 7** (added by cloister-ce936e):

> Every `TenantDispatchRow.binding` MUST resolve to a `[[wires]]`
> entry whose `to` bundle hosts inputs sharing the same `workerdId`
> as the row's `name`. Mismatches surface at lint time, not at
> request time.

(Invariants 1-6 are documented in `scripts/lint-bundle-isolation.mjs`;
Inv 7 extends the existing tenancy-resolution machinery without
introducing a new concept.)

## What a multi-tenant deployment looks like

A minimal two-tenant cluster.toml. Per Inv 6, `tenancy.workerdId` MUST
match a bundle's `name`, so tenants name their bundles after their
tenant identity:

```toml
[metadata]
name = "cloister-multi-tenant"
version = "0.1.0"

[[bundles]]
name = "cloister-router"
tier = "hypervisor"
kind = "external"
# ... (the dispatcher; one instance, hosts the tenantDispatch route)

[[bundles]]
name = "alice"                # bundle name MATCHES workerdId per Inv 6
tier = "cluster"
kind = "external"
  [bundles.external]
  image = "rosary:0.2.0"
  args = [ "mcp", "--ipc-socket", "/run/cloister-uds/alice/rosary.sock" ]
  env = [ "BEADS_DIR=/data/alice/beads" ]
  ipcSocket = "/run/cloister-uds/alice/rosary.sock"

[[bundles]]
name = "bob"                  # same convention; bob's rosary sidecar
tier = "cluster"
kind = "external"
  [bundles.external]
  image = "rosary:0.2.0"
  args = [ "mcp", "--ipc-socket", "/run/cloister-uds/bob/rosary.sock" ]
  env = [ "BEADS_DIR=/data/bob/beads" ]
  ipcSocket = "/run/cloister-uds/bob/rosary.sock"

[[wires]]
from = "cloister-router"
to = "alice"
binding = "T_ALICE"
transport = "uds"

[[wires]]
from = "cloister-router"
to = "bob"
binding = "T_BOB"
transport = "uds"

[inputs.alice]                # input name == bundle name == workerdId
ref = "io.github.org/agentic-research/rosary@main"
version = "0.2.0"
serviceBinding = "T_ALICE"
  [inputs.alice.tenancy]
  workerdId = "alice"         # MUST match a bundle.name (Inv 6)
  trustedTier = false

[inputs.bob]
ref = "io.github.org/agentic-research/rosary@main"
version = "0.2.0"
serviceBinding = "T_BOB"
  [inputs.bob.tenancy]
  workerdId = "bob"
  trustedTier = false

[[routes]]
kind = "tenantDispatch"
path = "/"
  [[routes.tenantDispatch.tenants]]
  name = "alice"              # row.name aligns with workerdId
  mode = "sni"
  matchValue = "alice.cluster.example"
  binding = "T_ALICE"
  [[routes.tenantDispatch.tenants]]
  name = "bob"
  mode = "path-prefix"
  matchValue = "/t/bob"
  binding = "T_BOB"
```

The substrate's invariant chain:

- `TenantDispatchRow.name = "alice"` ⇔ `[inputs.alice].tenancy.workerdId = "alice"`
- The binding `T_ALICE` ↔ `[[wires]] binding = "T_ALICE"` ↔ `to = "alice"` bundle ↔ `[bundles.alice]`
- Inv 6 verifies `workerdId == "alice"` matches a bundle named `"alice"`
- Inv 7 verifies the dispatch row aligns: routing to T_ALICE reaches a bundle hosting an input with workerdId == "alice"
- Inv 8 verifies that any bundle with `perTenant = true` has a `tenantDispatch` route declared (existence check)
- Inv 9 verifies that the perTenant bundle is wired by at least one tenantDispatch row's binding (binding-correlation check)

The naming convention (`tenant_name == bundle_name == workerdId`) is
the only way to satisfy both Inv 6 and Inv 7. Operators who want
more flexibility (e.g. a rosary bundle named `rsry-alice` running
in alice's workerd) need to wait for the per-bundle tenancy field
(`perTenant: Bool`) tracked in `cloister-cedcf3`.

Same chain for bob. Cross-tenant isolation = no naming collision +
no shared storage + no shared workerd binding.

## Why this isn't a third top-level table

Earlier drafts of ADR-0034 considered adding a `[[tenants]]` top-level
table. After investigating the existing schema, the cleaner answer is:
the two existing primitives (per-input `tenancy` + per-route
`TenantDispatchRow`) already declare what a `[[tenants]]` table would.
Adding a third primitive would over-engineer the substrate without
adding expressive power.

The lint enforces the composition rule. The recipe pattern
demonstrates it. New operators don't need to know about a third
table; they declare inputs + a dispatch route, and the substrate
handles the rest.

## Per-bundle tenancy — `perTenant: Bool` (shipped Phase 1)

`cloister-cedcf3` Phase 1 (2026-06-24) added `perTenant: Bool` to
`BundleSpec`. Operators declare a bundle as tenant-scoped by setting
`perTenant = true`; the emitter will (Phase 2) spawn one instance per
`TenantDispatchRow.name` instead of one cluster-wide bundle.

### Status

| Phase | Piece | Status |
|---|---|---|
| 1 | `perTenant: Bool` field on BundleSpec | ✓ shipped |
| 2 piece 1 | Inv 8 (perTenant requires tenantDispatch route) | ✓ shipped |
| 2 piece 3 | Inv 9 (binding-correlation: wire reaches perTenant bundle) | ✓ shipped |
| 2 piece 2 | emit-compose per-tenant container emission | ✓ first-cut shipped 2026-06-24 — service name + container name + per-tenant labels + `TENANT_ID`/`TENANT_MODE`/`TENANT_MATCH_VALUE` env. Per-tenant ipcSocket fanout + per-tenant wire env rewriting NOT shipped (operator handles socket plumbing today). |

### Inv 9 binding-correlation chain

```
[[routes.tenantDispatch.tenants]] row.binding
    │
    │  (same string)
    ▼
[[wires]].binding
    │
    │  to: ...
    ▼
[[bundles]] (perTenant = true)
```

Without all three links, Inv 8 OR Inv 9 fails at lint time:

| Failure | Lint catches |
|---|---|
| No `tenantDispatch` route exists | Inv 8 — "NO tenantDispatch route" |
| Route exists, but its bindings don't reach the perTenant bundle | Inv 9 — "no [[wires]] entry whose binding is referenced" |
| Route + wire exist, but workerdId on inputs disagrees | Inv 7 (separate chain, for the per-input tenancy primitive) |

### Operator opt-in shape (Phase 1 + 2 lint)

```toml
[[bundles]]
name = "rosary"
description = "Per-tenant bead orchestrator (perTenant=true)"
tier = "cluster"
kind = "external"
perTenant = true                     # cedcf3 Phase 1

[[wires]]
from = "cloister-router"
to = "rosary"
binding = "T_ROSARY"
transport = "uds"

[[routes]]
kind = "tenantDispatch"
path = "/"
  [[routes.tenantDispatch.tenants]]
  name = "alice"
  mode = "sni"
  matchValue = "alice.cluster.example"
  binding = "T_ROSARY"                # binding-correlation chain — Inv 9
```

`task lint` walks all three checks; once Phase 2 piece 2 lands, the
same shape will emit `rosary-alice` + `rosary-bob` containers from
emit-compose.

## Cross-references

- [ADR-0030](../adr/0030-multi-workerd-tenant-isolation.md) — multi-workerd substrate (the §A1/A5 tenancy primitives)
- [ADR-0034](../adr/0034-multi-tenant-access-spec.md) — true multi-tenant access spec
- [ADR-0026](../adr/0026-tool-composition-model.md) — `[inputs.*]` tool composition (where per-input tenancy lives)
- [`docs/security/threat-model.md`](../security/threat-model.md) §13.7 — per-tenant security properties enforced by this model
- [`docs/reference/bundle-topology.md`](bundle-topology.md) — the bundle classification this composes with
- [`recipes/multi-tenant-smoke/`](../../recipes/multi-tenant-smoke/) — minimal multi-tenant recipe demonstrating `tenantDispatch`
- `scripts/lint-bundle-isolation.mjs` — the lint enforcing Inv 1-7
- Tracking beads: `cloister-ce936e` (this doc + Inv 7) — closed, `cloister-cedcf3` (perTenant Phase 1 + Inv 8 + Inv 9 + Phase 2 piece 2 first-cut all shipped; per-tenant socket / DO-volume / wire-env-rewrite are Phase 3 follow-ups), `cloister-cbfd7f` (ADR-0034 tracker) — closed
