# Recipe: `oss-launch-minimal`

The smallest cluster that demonstrates the substrate-as-MCP-proxy
pattern. Two bundles, two MCP backends, no identity surface.

## What's included

| Bundle           | Tier        | Why it's here                                        |
| ---------------- | ----------- | ---------------------------------------------------- |
| `cloister-router` | hypervisor  | Gateway + DO state (BeadStore, TrustStore, BlobStore) |
| `mache`          | cluster     | Code intelligence (`mache_*` MCP tools, dynamic)     |

MCP backends advertised on `/mcp`:

- `bead_*` — DO-backed BeadStore. Lets you exercise the full Durable
  Object dispatch path without any external service.
- `mache_*` — proxied through `mcpProxy` with `dynamicTools = true`.
  This is the canonical demonstration of cloister-as-MCP-Proxy-Server
  (ADR-0015).

## What's NOT included

- No `notme-identity` bundle, no `actor.fingerprint` — Interlace
  discovery is off, lease verification is permissive. **Do not deploy
  this recipe to the public internet without first wiring identity.**
- No `rosary` orchestrator — `rsry_*` tools are NOT advertised.
- No `lsp_*` / `reparse` / `enrich` / `status` from leyline LLO.
- No `/.well-known/identity-bridge`, no `/v2/*` OCI registry, no
  selective-disclosure endpoint, no MCP Registry surface.
- No companion / leyline-net wires.

## When to pick it

- You want to read the cloister codebase top-down and need a working
  cluster that fits in your head.
- You're demoing cloister to someone who doesn't care about identity yet.
- You're benchmarking the gateway → DO dispatch path in isolation.

For the full identity story (notme + companion + signing surface), see
[`agent-cluster`](../agent-cluster/README.md).

For the full ART development surface (bead + mache + lsp + lifecycle +
identity), see [`rosary-dev`](../rosary-dev/README.md).

## Next steps after `cloister init --recipe oss-launch-minimal`

```sh
cd <out>
task dev:bootstrap   # one-time — generates DEV_VAULT_KEK + .env.local
task dev             # wrangler dev on :8787 (override via --port at init time)
# or the bundle topology:
task cluster:up      # compose against cluster.compose.yaml
```
