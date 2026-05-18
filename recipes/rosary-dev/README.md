# Recipe: `rosary-dev`

Full ART development cluster. Mirrors the top-level `cluster.compose.yaml`
and `cloister.capnp` checked into the repo root — bead + mache + lsp +
lifecycle + identity. Pick this when you want the same surface
the cloister authors use day-to-day.

## What's included

| Bundle           | Tier        | Why it's here                                                |
| ---------------- | ----------- | ------------------------------------------------------------ |
| `cloister-router` | hypervisor  | Gateway + Durable Object state (BeadStore, TrustStore, BlobStore) |
| `notme-identity` | hypervisor  | Signet master CA, lease cert mint                            |
| `mache`          | cluster     | Code intelligence (`mache_*` MCP tools)                      |
| `rosary`         | cluster     | Bead orchestrator (`rsry_bead_*` MCP tools, agent dispatch)  |

MCP backends advertised on `/mcp`:

- `bead_*` — DO-backed BeadStore (intra-cluster, no external upstream)
- `lsp_*` + `reparse` / `enrich` / `status` — leyline LLO daemon (`LLO_MCP_URL`)
- `mache_*` — mache code intelligence (`MACHE_MCP_URL`, dynamic tools)

Plus the non-MCP tenants:

- `/.well-known/interlace/index.json` — ADR-0007 discovery
- `/interlace/peers/{fp}` — selective-disclosure stream (ADR-0007 §11)
- `/.well-known/identity-bridge` — OIDC + WebFinger + Nostr NIP-05
- `/v2/*` — OCI Distribution Spec registry (read-only Phase 1)
- `/.well-known/mcp-registry/v0.1/*` — MCP Registry surface (ADR-0016)

## What's NOT included

- No companion/leylineNet backends — wires use UDS only.
- No vault-slice bindings — credentials still flow through env vars
  (ADR-0010 enforcement work in flight).
- No off-platform peering / CF-Tunnel wiring.

## When to pick it

- You're hacking on cloister itself.
- You want a working `rsry_bead_*` MCP surface against a real Dolt-backed store.
- You want mache structural search wired into your editor.

For "the smallest cluster that does something useful" pick
[`oss-launch-minimal`](../oss-launch-minimal/README.md) instead.

For the full identity story (notme + companion + signing surface), see
[`agent-cluster`](../agent-cluster/README.md).

## See also

- [`docs/reference/bundle-topology.md`](../../docs/reference/bundle-topology.md) — canonical per-bundle reference (tier + transport + purpose)
- [`docs/reference/backend-kinds.md`](../../docs/reference/backend-kinds.md) — canonical `Backend.kind` enum reference

## Next steps after `cloister init --recipe rosary-dev`

```sh
cd <out>
task dev:bootstrap   # one-time — generates DEV_VAULT_KEK + .env.local
task dev             # wrangler dev on :8787 (override via --port)
# or, for the full bundle topology:
task cluster:up      # docker/nerdctl/podman compose against cluster.compose.yaml
```
