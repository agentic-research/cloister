---
title: "ADR-0030: Multi-workerd substrate — process-level tenant isolation beyond V8 boundaries"
status: Proposed (2026-06-21) — substrate-level direction; implementation lands incrementally, starting with vault per the cloister-f289c8 epic
date: 2026-06-21
tags: [substrate, isolation, multi-tenancy, workerd, vault, deployment, networking]
threat_model: docs/security/threat-model.md
relates_to:
  - 0007-interlace-substrate.md
  - 0009-compute-substrate-portability.md
  - 0010-vault-and-bundle-clusters.md
  - 0011-hypervisor-bundle-boundary.md
  - 0013-slice-grant-enforcement.md
  - 0018-notme-co-location.md
  - 0021-per-bundle-vault-instances.md
  - 0024-credential-isolation-capability.md
---

## Context

ADR-0013 ratified the slice-grant enforcement model: V8 isolate
boundary + service-binding-as-syscall, with cross-bundle isolation
sitting at the binding layer. ADR-0021 went one rung deeper:
per-bundle vault DO instances so SQLite storage is also separated.
The result is **multi-tenancy at the V8-isolate granularity** — N
isolates inside one workerd process, with the substrate refusing
cross-isolate reads through anything other than declared service
bindings.

But the **workerd process itself is shared**. Every tenant on the
same workerd binary inherits:

- The same kernel namespace, the same file-descriptor table, the
  same network namespace, the same `/dev`.
- The same workerd binary version — a workerd-level CVE compromises
  every tenant on that process, not just the bundle that triggered
  it.
- The same V8 build — a V8 sandbox escape that breaks the isolate
  boundary breaks ALL isolates in the process.
- The same process-level resources — file handles, sockets, signal
  handlers.

ADR-0013's slice-grant claim is **load-bearing at the V8 layer and
nowhere else**. The outer ring (workerd process + kernel + V8 binary)
is implicitly trusted by every tenant. For deployments where
tenants are mutually-distrusting peers, that implicit trust is the
gap.

The cred-iso/v2 disposition tracker (`cloister-f289c8`, codified
2026-06-19) gestured at a related-but-narrower direction: Path 4 —
"nono sandbox wraps workerd, kernel-level outer-ring." That path
re-uses one workerd and adds a sandbox AROUND it. This ADR goes
further: **multiple workerd processes**, one per tenant, eliminating
the shared-binary surface entirely.

The trigger to ratify this now is operational, not theoretical: the
substrate's published security claim ("a compromised bundle cannot
read another tenant's vault") is binding only as far as V8's
sandbox holds. Every published V8 0-day moves the goalposts. A
multi-workerd shape lets us define a threat model in which a V8
escape is **not catastrophic** because the blast radius is one
tenant's workerd.

## Decision

Introduce a **multi-workerd substrate** with four load-bearing
properties:

### D1 — One workerd process per tenant (when isolated)

The substrate gains a deployment shape where each tenant runs in
its own `workerd` process. A compromised V8 isolate cannot reach
another tenant's process address space, file descriptors, or
sockets — process-level isolation provided by the kernel, not by
V8.

This **does not deprecate ADR-0013**. V8 isolate boundaries still
matter inside each per-tenant workerd, for bundles sharing the
same tenant. Slice-grant enforcement is now **two-layered**:

  - **Outer (this ADR):** process-per-tenant. Kernel-enforced.
  - **Inner (ADR-0013):** isolate-per-bundle within a tenant's
    workerd. V8-enforced.

The two compose: a bundle inside tenant T1's workerd cannot read
bundle 2's heap inside T1 (V8 protects), and tenant T1's workerd
cannot read tenant T2's vault DO storage (kernel protects).

### D2 — Polymorphic tenant boundary

The substrate does NOT pre-decide what counts as a tenant. Three
expression modes are first-class, and a deployment may use any one
(or compose them):

| Mode | Boundary | When to use |
|---|---|---|
| **Per-peer** | One workerd per authenticated signet-identity peer (`subject_fp`) | Strongest isolation; highest process count. Right when peers are mutually-distrusting (e.g. agent constellations across orgs). |
| **Per-bundle** | One workerd per `Bundle.name` in the manifest | Coarser; reuses ADR-0021's per-bundle vault DO seam. Right when bundles ARE the trust boundary and peers within a bundle are trusted. |
| **Per-operator-declared** | A new `[[tenants]]` table in `cluster.toml` declares the boundary explicitly | Operator decides the granularity per deployment. Right for hybrid models — see D4. |

The mechanism (workerd-process-per-tenant) is uniform; the
**definition of tenant** is configurable. Implementation must keep
the three modes expressible from the same substrate primitives.

### D3 — Typed cross-tenant edges (Istio-AppProtocol pattern)

Cross-tenant calls are **first-class**, not deferred. The substrate
does not invent a new network plumbing layer — workerds reach each
other over whatever the deployment provides (loopback HTTP for
single-host pods, UDS for tightly-co-located processes,
CF-tunnel/WARP for off-platform, real network for distributed
deployments). The substrate is intentionally **not** prescribing the
transport.

What the substrate DOES add is a **network-type** label per
cross-tenant edge, modeled on Istio's `AppProtocol` annotation. The
label classifies the traffic semantically — the substrate uses it
for routing, observability, and policy enforcement; the underlying
transport is whatever the operator wires.

Initial label set (extensible; see Open Questions):

```
app_protocol = "http" | "http2" | "grpc" | "tcp" | "tls"
             | "mcp-jsonrpc" | "interlace-capnp" | "capnp-uds"
```

The substrate-specific labels (`mcp-jsonrpc`, `interlace-capnp`,
`capnp-uds`) are first-class: they encode the protocol the substrate
already understands and routes natively. Generic labels (`http`,
`grpc`, etc.) are for tenants that publish non-MCP / non-Interlace
surfaces (`cloister-6fc72e`).

**Explicitly excluded:** raptorq from `ley-line`. raptorq is a
UDP-based reliable transport; the substrate adopts the IDEA of
typed edges but not the specific transport. The substrate stays
transport-agnostic.

### D4 — Vault first, hybrid model preserved

The first concrete migration is the **vault DO**. Rationale:

- Vault is the load-bearing trust boundary in cred-iso/v1
  (ADR-0024). A V8 escape that reaches one tenant's vault reaches
  every other tenant's credentials on the same workerd.
- ADR-0021 already gave each bundle its own DO INSTANCE. The next
  step is each tenant's vault DO living in its own WORKERD PROCESS.
- The vault wire (`/vault/proxy/<service>/<upstream-path>` per
  ADR-0024) is small and well-tested; the migration touches a
  bounded surface.

**Hybrid model.** Some bundles SHOULD remain co-located even in a
multi-workerd world — notably trusted-tier identity (notme), where
co-location with the router gains lease-verification latency that
matters on every authenticated request, and the trust boundary
between notme and router is intentionally shared. The two co-locate
decision beads (`cloister-db99cd` for notme, `cloister-18f456` for
mache) stay open under this ADR — they become questions about
**which tenants share a workerd** rather than "consolidate vs
split." Operator chooses per deployment.

This means the substrate must support:

- `tenant.workerd_id = "<process-name>"` — operator names which
  workerd hosts the tenant.
- Multiple tenants on the same workerd (the hybrid case): they
  share process resources but get separate vault DOs (ADR-0021
  still applies).
- One tenant per workerd (the isolated case): the strict shape this
  ADR adds.

## Consequences

### Manifest changes

- New `[[tenants]]` table in `cluster.toml`:
  ```toml
  [[tenants]]
  name = "alice"               # operator-chosen
  mode = "per-peer"            # | "per-bundle" | "explicit"
  workerd_id = "alice-vault"   # workerd process name; can be
                               # shared across tenants in hybrid mode
  ```
- New `[[edges]]` table for cross-tenant routing:
  ```toml
  [[edges]]
  from = "alice"
  to = "shared-mcp"
  app_protocol = "mcp-jsonrpc"
  transport = "loopback-http"  # operator-specified plumbing
  ```
- Schema changes land in `manifest/cluster.capnp` (append-only
  ordinals, per ADR-0004).

### Process supervisor

The substrate gains a **per-tenant workerd supervisor**. v1
constraints:

- Lifecycle: start / health-check / stop / restart per workerd.
- Resource limits: per-workerd CPU/memory caps (kernel-enforced).
- Crash isolation: one workerd crashing does NOT cascade.
- Logging: per-workerd structured logs; tenant ID is the
  correlation key.

Concrete choice between systemd unit-per-workerd, supervisord,
docker-compose `services:`, or a cloister-owned supervisor is
**deferred to the implementation ADR** (`cloister-f289c8` epic
output). This ADR ratifies the requirement, not the choice.

### DO state moves with the workerd

Each per-tenant workerd owns its own DO storage (per workerd, per
ADR-0007 + 0010 + 0021). Migrating a tenant from "shared workerd"
to "own workerd" requires moving the DO's SQLite file. The
migration is a one-time operator action, not a substrate
auto-migration in v1.

### Substrate-property lint gains a property

`cloister-ac30e7` (substrate-property lint for workerd-bundle
Workers) extends with a new gate: **workerd-process boundary
matches tenant boundary in the manifest**. If `cluster.toml`
declares tenant T1 with `workerd_id = "alice"` and the generated
workerd config puts T1's bundles in a different workerd, the lint
fails.

### Routing layer

The router (today `cloister-router`) becomes **a router per
deployment, not per tenant**. It dispatches inbound traffic to the
right per-tenant workerd based on:

- SNI (for TLS-terminating deployments)
- Path-prefix (for HTTP-routing deployments)
- A new `routes_to_tenant` field in the manifest's route table

The router workerd itself may host trusted-tier bundles (notme,
TrustStore) under the hybrid model.

### Threat model update

Threat-model §13 (silence-is-evidence) extends to a new property:
**tenant T1's workerd terminating does NOT silence T1's attestation
ledger**, because T1's TrustStore DO lives in T1's workerd. The
disclosure endpoint (ADR-0007 §discovery) becomes per-tenant
dispatched.

**Residual posture (post adversarial cycle 2026-06-22, cloister-93d674
roll-up):** the per-tenant-workerd direction this ADR ratifies still
carries three explicit residuals that operators reading this ADR
should know up front, captured in full in threat-model §13.7.3 + §13.7.7
+ §13.7.8:

1. **§13.7.3 service-tier separation is design-only.** No
   service-tier consumer ships in tree as of 2026-06-22. The cross-tier
   reject property is structural-by-HKDF-input but untested at runtime.
   First service-tier consumer to land MUST ship a property test.
2. **§13.7.7 Inv 6 is no-op on empty `inputs[]`.** Pre-ADR-0030
   `cluster.toml` with no inputs gets no workerd-boundary lint
   protection — correct (nothing to check), but operators migrating
   to multi-workerd MUST re-run `task lint:bundle-isolation` after
   adding the first `[inputs.*]` row.
3. **§13.7.8 boot-time config errors name both tenants.** The
   manifest compiler's fail-fast errors carry tenant names in
   plaintext to operator logs by design — needed for diagnosis. Log-
   aggregator-tier observers who can read boot stderr see tenant
   names; mitigate at the supervisor layer, not in the substrate.

### Operational cost

- Image size grows: each tenant carries a workerd binary + its
  bundles. Mitigation: shared base layer, per-tenant overlay only
  carries bundle code + state.
- Memory footprint grows: each workerd is ~50-100MB resident
  baseline. N tenants = N × baseline. Not free; not catastrophic.
- Cold-start latency: per-tenant workerd cold start is independent.
  Hot path is unchanged.

## What this is NOT

- **NOT a network-layer rewrite.** No new transport. The substrate
  stays plumbing-agnostic; `app_protocol` labels are metadata, not
  code. raptorq from `ley-line` is explicitly out of scope.
- **NOT a deprecation of ADR-0013.** V8 isolate boundaries remain
  load-bearing inside each per-tenant workerd. This ADR adds an
  OUTER ring; the inner ring stays.
- **NOT a replacement for ADR-0021.** Per-bundle vault DO instances
  remain the bundle-level seam. This ADR's per-tenant workerd is
  the tenant-level seam ABOVE that.
- **NOT a forced-multi-workerd substrate.** Hybrid model means an
  operator may run everything in one workerd (the current shape)
  and that remains a valid deployment. Multi-workerd is opt-in via
  the `[[tenants]]` declaration.
- **NOT a per-request workerd spawn.** Workerds are long-lived per
  tenant; we are not modeling FaaS-style cold spawn per request.

## Open questions (to be resolved during implementation)

1. **Process supervisor choice.** systemd / supervisord /
   docker-compose / cloister-owned. Deferred to `cloister-f289c8`
   epic. Constraint: the choice must work both for cloister-on-CF
   (where workers are CF-managed) and cloister-self-hosted (where
   workerd is a process).

2. **Routing fabric.** SNI vs path-prefix vs both. Likely both,
   operator-configurable. The router needs a table.

3. **Cross-workerd shared secrets.** Today `VAULT_KEK_SECRET` (now
   ADR-0014 URL-spec resolver) is workerd-binding-scoped. With N
   workerds, each needs its own KEK source — and either each KEK
   must derive from a cluster-level root (HKDF, per ADR-0010's
   original framing) or be operator-provisioned independently per
   tenant. Resolve in the implementation ADR.

4. **app_protocol extensibility.** The initial label set is finite.
   How do new labels get added — operator-extensible or
   substrate-controlled? Lean substrate-controlled v1 to avoid
   sprawl; revisit if a real third-party tenant needs a new label.

5. **Hybrid-mode density.** How many tenants can share a workerd
   while still being meaningful? Probably 1 (strict isolation) or
   "trusted-tier only" (notme + router) or "all in one" (the
   current shape). Operator decides; substrate enforces what's
   declared.

## Amendment 2026-06-21 — Decisions ratified

All five open questions above resolved per operator direction. This
amendment captures the **aspirational goal state** of the substrate,
not just current implementation. Doc honesty per session feedback:
"we are aspirational in design and less good in documentation."

### A1 — Process supervisor: compose-shape YAML, runtime operator-pick

**Decision:** the supervisor declaration is a **docker-compose v3+
YAML file** (`cluster.compose.yaml`); the operator picks the runtime
from any compose-compatible engine (Docker Desktop on macOS, colima,
podman, nerdctl, docker on Linux). On CF prod, CF's managed-worker
scheduler IS the supervisor — the compose file is irrelevant there
because the workers aren't host processes.

Rationale: existing `task cluster:up` already shells out to
compose-shape; CI uses Docker. Mac dev (Apple Silicon) works via
Docker Desktop or colima. Linux works native. CF is already managed.
**Zero new substrate primitive.**

What this rules out: writing our own Rust supervisor (deferred to v2
if real consumer demand emerges); requiring systemd (Linux-only);
requiring supervisord (extra Python dep on host).

### A2 — Routing fabric: both SNI + path-prefix, per-tenant operator-set

**Decision:** the router data structure carries BOTH modes; operator
declares per tenant which one applies.

```toml
[[tenants]]
name = "alice"
route_mode = "sni"           # | "path-prefix"
route_value = "alice.cluster.example.com"   # for sni; or "/t/alice/" for path-prefix
```

SNI fits external-facing peers with their own cert chain; path-prefix
fits internal/dev/single-host where TLS termination isn't worth the
cert ops. Forcing one mechanism would exclude a real deployment.

### A3 — Cross-workerd secrets: three-tier hierarchy

**Decision:** three secret scopes, declared independently:

| Scope | How keyed | Source |
|---|---|---|
| **cluster** | one root KEK per cluster | derived via HKDF(`cluster_kek`, `"cluster"`) where `cluster_kek` comes from the ADR-0014 URL-spec resolver (operator picks Keychain / libsecret / env / file / sign-helper) |
| **service** | per service (per `[inputs.*]` or `[[services]]` entry) | declared in the input's `cluster.toml` block via ADR-0014 URL-spec resolver — operator-provisioned per service |
| **user** | per authenticated peer (`subject_fp`) | **deferred to v2**. The other two tiers cover v1's needs. |

Key derivation for the cluster tier follows ADR-0010's original
framing (HKDF from the Signet master pubkey root). The service tier
gives operators a separate provisioning surface for credentials that
shouldn't share fate with the cluster master (e.g. an external
service's API token).

What this rules out: per-tenant KEK derivation as the ONLY model
(too rigid — operators need a per-service escape hatch); pure
operator-provisioning as the only model (HKDF-from-root is the
substrate's identity rail and stays load-bearing).

### A4 — `app_protocol` extensibility: hybrid namespace

**Decision:** label namespace mirrors HTTP-header / OCI-media-type
convention:

- **`art.*`** — substrate-blessed canonical names. Substrate guarantees
  semantic handling. Adding a name requires a PR + ADR amendment.
  Initial set: `art.mcp-jsonrpc`, `art.interlace-capnp`, `art.capnp-uds`,
  `art.http`, `art.http2`, `art.grpc`, `art.tcp`, `art.tls`.
- **`x-<vendor>-*`** — operator-extensible experimental space. Substrate
  routes as opaque pass-through; no semantic claims. Operators may use
  for unblessed protocols (`x-myorg-redis`, `x-deploy-bespoke-rpc`).
- **Other shapes** — rejected by the manifest validator.

The hybrid namespace is declared in `cluster.toml [[edges]]`:

```toml
[[edges]]
from = "alice"
to = "shared-mcp"
app_protocol = "art.mcp-jsonrpc"   # blessed
# or
app_protocol = "x-myorg-redis"     # experimental, opaque pass-through
```

Promotion path: an `x-*` label that proves load-bearing across enough
operators moves to `art.*` via PR + ADR amendment. No silent sprawl.

### A5 — Hybrid-mode density: COMPOSABLE via server.json `_meta`

**Reframe**, not just a choice. Density isn't an operator-declared
`[[tenants]]` table separate from the rest of the substrate — it's a
**composition property** on top of ADR-0026 (`[inputs.*]`) and ADR-0027
(matchmaker). The substrate-as-kernel framing already does this for
capability composition; tenancy is the next dimension on the same
mechanism.

**How it works:**

1. **An input's `server.json` declares its tenancy default.** The
   `_meta.art.cloister/v1` block (per `cloister-spec/mcp-tool/v1`)
   gains a `tenancy` field:

   ```jsonc
   {
     "_meta": {
       "art.cloister/v1": {
         "tenancy": {
           "default_mode": "external",          // co-located | external | per-tenant
           "trusted_tier": false,               // hint for hybrid co-location
           "shares_workerd_with": null          // explicit co-tenancy edges
         }
       }
     }
   }
   ```

2. **Operator includes via `[inputs.*]` with optional override.**

   ```toml
   [inputs.mache]
   ref = "github://agentic-research/mache@<SHA>"
   # No tenancy override → uses server.json default ("external" for mache; Go-native)

   [inputs.notme]
   ref = "github://agentic-research/notme@<SHA>"
   tenancy.mode = "co-located"        # override server.json default
   tenancy.workerd_id = "cloister-router"
   ```

3. **Lockfile caches per ADR-0026.** `cluster.lock.toml` carries the
   resolved tenancy declaration (post-override) with a content-pinned
   digest of the source `server.json`. Operator gets git-shaped review
   of tenancy bumps — exactly the same flow as input version bumps.

4. **Substrate emits workerd config from the resolved declarations.**
   The matchmaker (ADR-0027) walks resolved tenancy declarations
   alongside `provides`/`requires` capability graph; the workerd-config
   emitter generates one workerd per distinct `workerd_id`.

This makes the "how many tenants share a workerd" question answerable
**per-deployment via composition** rather than via a separate static
declaration. The composition substrate (ADR-0026 + ADR-0027) already
solves the "how do operators include things with version pins +
override" pattern; tenancy is just one more thing those mechanisms
declare.

What this rules out: a separate `[[tenants]]` table in cluster.toml
(replaced by `[inputs.*].tenancy.*` overrides + server.json defaults);
hardcoded density rules in the substrate (substrate enforces declared
boundaries, doesn't gate-keep them).

### Cross-cutting amendment: doc state-of-the-aspiration

Per session feedback, every reference in this ADR to current
implementation behavior is also tagged with the **goal state** the
substrate is converging toward. The amendment's A1–A5 sections are
goal-state by construction; the rest of the ADR keeps its 2026-06-21
"Proposed" status until the implementation epic
(`cloister-f289c8`) lands at least one tenant in production.

## Tracking

- **Epic:** `cloister-f289c8` (cred-iso/v2 disposition tracker,
  reframed 2026-06-21 from "nono-proxy credential-injection layer"
  to "multi-workerd substrate, vault first").
- **Co-locate decisions stay open:**
  `cloister-db99cd` (notme), `cloister-18f456` (mache) — both
  become "which tenants share which workerd" questions under the
  hybrid model.
- **Substrate-property lint extension:** `cloister-ac30e7` gains
  the new workerd-boundary property when this ADR's implementation
  lands.
- **Threat-model §13 update:** required before the first multi-
  workerd deployment.

## References

- ADR-0007 — Interlace substrate (per-actor lease + attestation
  semantics; per-tenant workerd is a natural extension of per-actor
  trust).
- ADR-0013 — Slice-grant enforcement (the inner ring this ADR
  preserves; the outer ring this ADR adds).
- ADR-0021 — Per-bundle vault DO instances (the seam this ADR
  builds atop).
- ADR-0024 — `cloister/credential-isolation/v1` capability (the
  first concrete migration target).
- `cloister-f289c8` — cred-iso/v2 disposition; reframed by this ADR
  as the implementation epic.
- ADR-0034 — True multi-tenant access spec (downstream — scopes the
  per-tenant access surface across rosary/mache/notme that THIS
  ADR's multi-workerd substrate enables).
- Istio AppProtocol — the labeling pattern adopted for cross-tenant
  edges. See `istio.io/docs/ops/configuration/traffic-management/protocol-selection`.
