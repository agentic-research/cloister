# Recipe: `multi-tenant-smoke`

The smallest cluster that demonstrates ADR-0030 §A2 multi-tenant
dispatch — SNI + path-prefix routing through cloister-router to per-
tenant workerds, with byte-equivalent 404 across every "did not
dispatch" path per threat-model §13.7.1 / §13.7.6.

## Operator surface

Edit `cluster.toml` — the operator-readable declaration of bundles,
wires, storage, and routes. Per ADR-0031 the `cluster.toml` is the
source-of-truth operator surface; `cloister.capnp` is the runtime
artifact the workerd substrate consumes, regenerated via
`task emit:cloister-capnp` on every edit.

## What's included

| Bundle           | Tier        | Why it's here                              |
| ---------------- | ----------- | ------------------------------------------ |
| `cloister-router` | hypervisor  | Multi-tenant dispatcher (no `/mcp` route)  |
| `alice-tenant`   | cluster     | Receives SNI-matched requests (`alice.cluster.example`) |
| `bob-tenant`     | cluster     | Receives path-prefix-matched requests (`/t/bob`)        |

Routes advertised by `cloister-router`:

- `/health` — substrate liveness probe.
- `/` — `tenantDispatch` catch-all that routes by SNI (Map lookup,
  O(1)) or path-prefix (full-walk no-early-break, constant-time WRT
  row position per `cloister-92e846`).

The router does NOT serve `/mcp` directly — every tenant workerd
serves its own routes (this is the substrate-as-shell pattern; ADR-0030
§A1 isolates each tenant in its own workerd process).

## What this demonstrates

- **Cross-tenant 404 byte-equivalence** (`cloister-92e846` / §13.7.1):
  `curl https://no.such.tenant.example/` returns the SAME 256-byte
  constant-time 404 as `curl https://alice.cluster.example/` when alice
  isn't wired. No tenant-existence oracle.
- **Path-prefix routing** (§13.7.6(b)): `curl https://router/t/bob/foo`
  is dispatched to bob's workerd with `/foo` (prefix stripped).
- **SNI routing**: `curl --resolve alice.cluster.example:8787:127.0.0.1
  https://alice.cluster.example/anything` reaches alice's workerd
  unchanged.
- **Unwired-binding throttle** (`cloister-9339c0` / §13.7.6(d)):
  repeated probes against a tenant whose binding the operator declared
  but didn't wire emit AT MOST ONE structured log line per binding,
  regardless of probe volume. No log-channel enumeration vector.

## Scaffolding

```sh
task init -- --recipe multi-tenant-smoke --out my-cluster
cd my-cluster
# Edit `cluster.toml` to swap the placeholder tenant images for real
# tenant workerds. Then:
task emit:cloister-capnp   # regenerates cloister.capnp from cluster.toml
task manifest              # regenerates src/generated/manifest.ts
task cluster:emit          # produces cluster.compose.yaml
task cluster:up            # boots the multi-bundle compose stack
```

## Cross-references

- [ADR-0030](../../docs/adr/0030-multi-workerd-tenant-isolation.md) — multi-workerd tenant isolation
- [ADR-0031](../../docs/adr/0031-cloister-capnp-as-build-artifact.md) — `cloister.capnp` as build artifact
- [`docs/security/threat-model.md`](../../docs/security/threat-model.md) §13.7 — per-tenant security properties
- [`docs/reference/backend-kinds.md`](../../docs/reference/backend-kinds.md) — wire formats per backend
- [`docs/reference/bundle-topology.md`](../../docs/reference/bundle-topology.md) — hypervisor vs cluster tier
- Tracking beads: `cloister-0f144c` (router-table tests), `cloister-92e846` (cycle parent — adversarial 2026-06-22), `cloister-9339c0` (unwired-binding warn redaction)
