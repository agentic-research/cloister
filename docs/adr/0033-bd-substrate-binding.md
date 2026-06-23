---
title: "ADR-0033: bd as cloister-mediated bead substrate"
status: Proposed (2026-06-23)
date: 2026-06-23
tags: [substrate, beads, mcp, bd, dolt, multi-substrate]
threat_model: docs/security/threat-model.md
relates_to:
  - 0002-edge-router-protocol-agnostic-backends.md
  - 0009-compute-substrate-portability.md
  - 0013-slice-grant-enforcement.md
  - 0015-mcp-spec-alignment.md
  - 0021-per-bundle-vault-instances.md
  - 0023-host-path-resolution.md
  - 0024-credential-isolation-capability.md
  - 0030-multi-workerd-tenant-isolation.md
---

## Context

Cloister's own beads currently live in `.beads/dolt/cloister/` — an
embedded Dolt store consumed by the `rsry` MCP server when an operator
(or Claude Code session) invokes bead operations. The substrate
itself does not consume beads at runtime; the embedded store is a
development-time artifact mounted via `rsry`'s out-of-band CLI/MCP
surface.

Two trends make this insufficient for the trajectory the substrate is
on:

1. **Cloister-Worker can't reach `.beads/dolt/cloister/`.** When the
   substrate hosts in-cluster tool bundles (the ADR-0030 multi-tenant
   direction, the `cloister-f289c8` epic; the ADR-0024 cred-iso/v1
   service consumers), those bundles run inside a workerd isolate
   with no filesystem and no process-spawn primitive. They can't
   embed Dolt, they can't shell to `rsry`, they can't even read the
   raw `.beads/` directory. Today they don't need to — but the moment
   an in-cluster bundle wants to call `bead_create` or `bead_search`,
   it has no path.

2. **Concurrent writers break embedded Dolt.** The substrate's
   forward direction (rosary parallel dispatch, multi-session Claude
   Code, in-cluster bundles as concurrent consumers) needs concurrent
   writers to one shared bead store per repo. Embedded Dolt is
   single-writer by construction.

A separate trend in the broader ecosystem — `bd`, an issue tracker
built on `dolt sql-server` socket mode — solves both problems out of
the box. bd exposes an **MCP server** as its primary integration
surface, runs a `dolt sql-server` over a Unix domain socket
(concurrent writers, sandbox-friendly per its README), and stores
its bead data in `refs/dolt/data` so a fresh `git clone` + `bd dolt
pull` brings the beads with the repo.

**Cloister can adopt bd as an external substrate using the manifest
machinery cloister already ships** — `mcpProxy` backend kind
(ADR-0002 + ADR-0015) + service-binding-as-syscall (ADR-0013) +
credential isolation v1 (ADR-0024). No new wire format, no MySQL
client in workerd, no new substrate-mediation primitive. bd becomes
one more declarative `mcpProxy` upstream, sitting alongside `mache`
and `ley-line-open` in the substrate's existing pattern.

This ADR ratifies bd as cloister's bead substrate, declares the
binding shape, and scopes the migration of cloister's own bead store.

This ADR **does not depend on rosary** adopting bd. rosary's
substrate decisions are theirs; cloister's adoption of bd as an
mcpProxy backend is orthogonal. Cloister could ship the full binding
with rosary continuing to use embedded Dolt against the SAME
`.beads/` directory (or a different one), or rosary could later flip
to bd-managed without any cloister changes.

## Decision

### D1 — bd is consumed as an external `mcpProxy` backend

bd's MCP server is the integration surface. Cloister adds a new
`mcpProxy` backend declaration pointing at the bd MCP endpoint:

```capnp
( name = "beads",
  handlesPrefix = "bd_",
  kind = (
    mcpProxy = (
      urlBinding = "BD_MCP_URL",
      tools = [],
      dynamicTools = true,
      serviceBinding = "BD_MCP",
      claims = [
        "bd_create", "bd_search", "bd_update", "bd_ready",
        "bd_dep",    "bd_prime",  "bd_remember"
      ]
    )
  )
)
```

This is **structurally identical** to the existing `mache` + `lsp_*`
backends (`src/generated/manifest.ts:129-141`). No schema extension
required; no new variant on `Backend.kind`.

The `claims` list is the operator's pre-declared surface (per the
ADR-0006 derived-tools discipline). `dynamicTools=true` allows bd to
extend its tool set without a substrate redeploy — cloister proxies
`tools/list` and aggregates.

### D2 — bd MCP server runs as a cluster bundle (sidecar)

bd is added to `cluster.toml` as a new `[[bundles]]` entry with
`kind = external`, mirroring mache + rosary + ley-line-open + notme:

```toml
[[bundles]]
name = "beads"
description = "bd issue substrate — concurrent-writer dolt sql-server + MCP"
holdsCredential = [ ]                      # see D4 for auth
hypervisorRationale = ""                    # cluster-tier (sandboxed)
kind = "external"
tier = "cluster"
workerdServiceName = ""

  [bundles.external]
  args = [ "mcp", "--listen-uds", "/run/cloister-uds/bd.sock" ]
  env = [ ]
  httpPort = 0                              # UDS-only
  image = "bd:0.x.0"                        # pin per `task verify`'s lint:cargo-pins shape
  ipcSocket = "/run/cloister-uds/bd.sock"
```

The cloister-router → bd wire is a **UDS service binding** per
ADR-0023 host-path resolution. The MCP traffic goes through
`notme-proxy`'s UDS forwarder (same pattern as `rosary` and
`mache`), so workerd's HTTP fetch reaches a Unix socket without
needing a TCP loopback hop.

Storage: bd's Dolt directory lives on the bundle's container volume,
mounted from `.beads/dolt/cloister/` on the host so a `git pull`
brings new bead history with the repo (per bd's `refs/dolt/data`
storage model).

### D3 — Wire: HTTP MCP over UDS, not MySQL

Cloister-Worker speaks **HTTP MCP** to bd via the mcpProxy. workerd
does not get a MySQL client. bd's internal Dolt sql-server is
consumed only by bd itself (and other socket-mode consumers if any —
e.g. rosary, if it later flips); cloister sees only the MCP layer.

Rationale:

- The MCP wire format already works in workerd (`mcpProxy` ships).
- Adding a MySQL client to workerd means either (a) raw TCP via
  `connect()` from `cloudflare:sockets` with a hand-rolled MySQL
  binary protocol implementation, or (b) a sidecar HTTP-to-MySQL
  proxy with an extra hop. Both add substrate complexity for no gain
  over the MCP shape bd already exposes.
- MCP is the AGENT-facing surface; we want agents talking to agents,
  not to SQL. SQL access is appropriate for operator workflows
  (`bd dolt sql`), not for in-cluster bundle requests.

This decision **does not preclude** a future TCP/MySQL substrate
binding for a different use case (e.g. analytics querying bead
history at SQL granularity). If that need surfaces, a sibling ADR
adds a `sqlServer` backend kind; bd's MCP binding here is independent.

### D4 — Auth: shared-secret token (LLO ADR-0022 precedent)

bd's MCP server runs UDS-only inside the cluster trust boundary, so
the threat model matches LLO's `ley-line-open daemon` precedent:

- Same-user processes on the same host CAN reach the socket. The
  filesystem ACL on `/run/cloister-uds/` is the perimeter.
- DNS rebinding doesn't apply (no TCP).
- Within the cluster, every bundle that can resolve the bind name
  can connect.

Per LLO's ADR-0022 (cloister-side equivalent decision: cloister-side
mcpProxy auth for LLO), the wire carries a **shared-secret bearer
token** in an `Authorization: Bearer <token>` header. The token is:

- Provisioned in the cloister vault as a service credential under
  `cloister/credential-isolation/v1` (ADR-0024)
- Injected by the Vault DO into the mcpProxy backend request at
  dispatch time (ADR-0013 slice-grant: plaintext never crosses the
  RPC boundary)
- Rotated by re-provisioning at the bd-bundle deploy boundary

bd's auth verifier is bd's responsibility; cloister provides the
credential. The vault entry is declared in cluster.toml `[vault]`:

```toml
[vault.services.bd]
upstream_base_url = "http+uds:///run/cloister-uds/bd.sock/mcp"
default_allowed_subs = [ "sha256:<cloister-router-fp>" ]
rate_limit_per_minute = 600
[vault.services.bd.injection]
authorizationBearer = {}
```

Per ADR-0024, the credential is opaque to cloister; vault holds the
token, injects it, never logs it. The bundle `holdsCredential = [
"BD_TOKEN" ]` declaration appears in `cluster.toml` and is enforced
by `lint:bundle-isolation` Inv 2.

### D5 — Cloister's own beads move to bd-managed; rsry keeps reading them

`.beads/dolt/cloister/` becomes bd-managed during the migration:

1. Today: `rsry` writes the embedded Dolt via its own embedded
   client.
2. Migration: `bd backup init` against `.beads/dolt/cloister/`, then
   `bd dolt sql-server --listen-uds /run/cloister-uds/bd.sock` reads
   the same Dolt directory (or a checkpointed copy — see Open
   Question 1).
3. After: `rsry` can KEEP reading via embedded Dolt for the
   single-writer dev path, OR be reconfigured to connect to bd's
   sql-server over the socket (concurrent-writer path). Both work
   against the same store; the decision is rosary's, not cloister's.

The migration is **safe to defer** — cloister's mcpProxy binding to
bd does not require the migration to complete. The `bd_*` tools
work against bd's store; the existing `rsry_*` tools keep working
against `.beads/dolt/cloister/`. Two MCP surfaces coexist until the
operator decides which is canonical for cloister's own beads.

### D6 — Multi-substrate framing

Cloister has been a multi-substrate mediator since ADR-0002 (the
protocol-agnostic backend split). The current substrate set:

| Substrate | Backend kind | Wire | Auth |
|---|---|---|---|
| BeadStore (own) | `durableObject` | DO RPC | cluster-internal |
| TrustStore (own) | `durableObject` | DO RPC | cluster-internal |
| BlobStore (own) | `durableObject` | DO RPC | cluster-internal |
| Vault (own) | `durableObject` | DO RPC | per-bundle slice-grant |
| mache | `mcpProxy` | HTTP MCP | bearer token via vault |
| ley-line-open (lsp) | `mcpProxy` | HTTP MCP | bearer token via vault |
| ley-line-open (lifecycle) | `mcpProxy` | HTTP MCP | bearer token via vault |
| notme-identity | `serviceBinding` | workerd Fetcher | bridge cert |
| rosary | `mcpProxy` | HTTP MCP (UDS) | none today, bearer planned |
| **bd (new)** | `mcpProxy` | HTTP MCP (UDS) | bearer token via vault |

bd slots into the existing pattern. **No new mediation primitive.**
The cloister-Worker's job is unchanged: dispatch MCP `tools/call`
requests across declared backends, mediate the credential injection,
enforce the slice-grant boundary. Adding bd is a manifest change +
a deploy.

This makes "multi-substrate" the explicit framing for the
substrate's positioning: cloister is the **substrate-of-substrates**
— the trust-mediating gateway that lets in-cluster bundles consume
multiple external substrates (bd, mache, llo, notme) without each
bundle owning its own credential, its own wire, or its own auth.

## Consequences

### Manifest changes

1. `cluster.toml`: new `[[bundles]]` entry `name = "beads"`, new
   `[vault.services.bd]` entry, new `[[wires]]` declaring the
   cloister-router → beads service binding.
2. `cloister.capnp` (auto-generated from cluster.toml): new
   `mcpProxy` backend with `handlesPrefix = "bd_"`,
   `urlBinding = "BD_MCP_URL"`, `serviceBinding = "BD_MCP"`,
   `claims = [...]` (D1 list above).
3. `config.capnp` (auto-generated): new `external` service entry for
   `bd-mcp` + new binding entries on the cloister-router Worker.
4. `wrangler.toml`: parallel `BD_MCP_URL` declaration.

### Code changes

5. `src/types.ts`: add `BD_MCP_URL: string;` to `Env`.
6. `src/manifest/runtime.ts`: no changes (mcpProxy already handles
   the new backend).
7. `scripts/emit-compose.mjs`: add bd to the compose topology.

### Test changes

8. `test/integration/`: extend the multi-tenant reality smoke (or
   new file) to exercise `bd_create` → `bd_search` through cloister.
9. `task cluster:test`: add bd to the Phase A image-in-isolation
   smoke matrix (build bd image, `bd mcp --listen-uds <test-sock>`,
   `tools/list` returns the expected `bd_*` surface).

### Threat model

10. New §13.x entry: bd substrate trust boundary. Bullet points:
    - bd MCP server runs INSIDE the cluster trust boundary (UDS,
      filesystem ACL is the perimeter, same as mache/llo).
    - Bearer token mediated by vault per ADR-0024; plaintext stays
      in DO.
    - bd's Dolt storage is content-addressed via `refs/dolt/data` —
      a compromised bd bundle CAN tamper with the bead history but
      CANNOT silently rewrite it (git ref invariants).
    - Cross-tenant: each tenant's bd connection lands in their own
      vault slice per ADR-0021; tenant A cannot read tenant B's bd
      token.

### Substrate-property lint

11. `scripts/lint-bundle-isolation.mjs`: Inv 2 already covers the
    `holdsCredential = [ "BD_TOKEN" ]` declaration. Verify it
    actually trips against a misconfigured `cluster.toml` that wires
    bd without declaring the credential. If not, extend.

### Migration cost

12. Cloister's own beads in `.beads/dolt/cloister/` — no immediate
    migration required. Per D5 the embedded path keeps working;
    operators flip when convenient.
13. Image build: bd's image lands as a new Phase A in
    `cluster:test`. Cold-build time ~30s based on its README
    profile.

### Operational cost

14. One more sidecar bundle in the compose topology — `beads`. RAM
    overhead ~30-50MB resident (Dolt + bd CLI). Acceptable.
15. UDS socket file at `/run/cloister-uds/bd.sock` — same pattern
    as rosary + mache. No new infra.

## What this is NOT

- **NOT a rosary substrate decision.** rosary may or may not flip to
  bd internally; this ADR doesn't move that lever. Cloister adopts
  bd as a backend; rosary's internals are unchanged.
- **NOT a deprecation of rsry MCP.** The `rsry_*` tools keep working
  against `.beads/dolt/cloister/`. Two MCP surfaces coexist
  indefinitely. Operators pick the canonical one per-repo.
- **NOT a rewrite of any existing backend.** `mache`, `llo`, `notme`,
  the DOs — all unchanged. bd is purely additive.
- **NOT a MySQL client in workerd.** The wire to bd is HTTP MCP. SQL
  access stays at the operator layer (`bd dolt sql` on the host).
- **NOT a tenant-scoped substrate yet.** This ADR scopes one shared
  bd instance per cluster, matching today's mache + llo shape. Per-
  tenant bd instances (ADR-0030 multi-workerd future) are a
  follow-up — sibling ADR or extension of this one.

## Open questions

1. **Migration sequencing for `.beads/dolt/cloister/`.** Does bd's
   `--listen-uds` against the same on-disk Dolt directory work
   concurrently with embedded `rsry` writes? Or does one have to
   stop the other? bd's README implies its dolt sql-server is the
   single writer when running; `rsry` would need to switch to
   client-mode (connect via MySQL/socket) for concurrent operation.
   Test against a real bd checkout before committing to D5's "both
   coexist" claim.

2. **Tool-name prefix collision.** Today cloister's `bd_*` namespace
   is empty. Confirm bd doesn't reserve names that overlap with
   existing cloister surfaces (`mcp_*`, `lsp_*`, `mache_*`,
   `bead_*`, `rsry_*`). If bd ships a `bead_create` (no prefix), the
   tool-prefix gate (`derived-tool-schemas` per ADR-0006) needs
   handling — likely renaming to `bd_*` at the proxy boundary, which
   the `mcpProxy` backend already supports.

3. **Cross-repo bead access.** bd is per-repo (one Dolt per
   `.beads/` directory). When cloister-Worker wants to query beads
   in another repo (e.g. cloister Worker reading rosary's bead
   history), is that another bd backend declaration, or a single bd
   instance that knows about multiple repos? The README's
   `BEADS_DIR` env var suggests the former (one bd per repo, multiple
   instances if you need multi-repo). Confirm by checking the bd
   feature surface.

4. **Bearer token rotation.** Vault-managed credentials are
   long-lived per ADR-0024's current shape. bd's bearer token would
   benefit from rotation. Hook into the existing rotation mechanism
   (the kek-source URL-spec resolver indirectly provides per-deploy
   freshness) — same path that mache/llo's tokens take today.

5. **bd image authoring.** bd ships as a binary; cloister's compose
   convention is one OCI image per bundle. Either upstream's
   release tarball goes in an apko-built image (preferred), or
   cloister vendors a Dockerfile (acceptable). Defer to the
   implementation bead (`cloister-c2bd47`).

## Tracking

- **Design (this ADR):** cloister-9d19e3
- **Implementation:** cloister-c2bd47
- **Sub-bead (auth-side, if Option B in notme-9da488 picks TLS
  client cert): notme-9da488** — but this ADR's D4 picks bearer
  token, which sidesteps that decision. notme-9da488 becomes "no
  notme work required for the bearer-token shape; close as
  invalid."

## References

- bd README (rosary LLM 2026-06-23 read-out): MCP server,
  `dolt sql-server` socket mode, `refs/dolt/data` storage,
  `BEADS_DIR` per-repo isolation, sandbox-friendly UDS, concurrent
  writers via server mode.
- ADR-0002, ADR-0015: protocol-agnostic backend split + mcpProxy.
- ADR-0013, ADR-0021: slice-grant + per-bundle vault DO instances.
- ADR-0023: host-path resolution (`CLOISTER_DO_PATH`, UDS
  conventions).
- ADR-0024: cloister/credential-isolation/v1 capability — the auth
  path D4 reuses.
- ADR-0030: multi-workerd substrate — sibling direction; this ADR
  composes inside the per-tenant workerd per ADR-0030 §A1.
- LLO ADR-0022: shared-secret bearer token over UDS — the auth
  precedent D4 follows.
