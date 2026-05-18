# Recipe: `agent-cluster`

The full identity-on cloister deployment. cloister-router + notme +
mache + companion, with the well-known discovery surface enabled and
rsry over leyline-net.

## What's included

This recipe's bundles. Per-bundle tier + transport + purpose definitions
live in
[`docs/reference/bundle-topology.md`](../../docs/reference/bundle-topology.md);
this table is the recipe-specific subset + the "why it's here" rationale.

| Bundle           | Tier        | Why it's in this recipe                                      |
| ---------------- | ----------- | ------------------------------------------------------------ |
| `cloister-router` | hypervisor  | Gateway + DO state (BeadStore, TrustStore, BlobStore)        |
| `notme-identity` | hypervisor  | Signet master CA, lease cert mint                            |
| `mache`          | cluster     | Code intelligence (`mache_*` MCP tools, dynamic)             |
| `companion`     | cluster     | leyline-net upstream router (ADR-0005)                       |

MCP backends advertised on `/mcp`:

- `bead_*` — DO-backed BeadStore
- `mache_*` — `mcpProxy` dynamic tools
- `rsry_*` — `leylineNet` wire to `cloister-companion`, which routes
  to the actual `rosary` process. This is the production shape for
  authenticated agent dispatch.

Non-MCP tenants:

- `/.well-known/interlace/index.json` — ADR-0007 discovery
- `/interlace/peers/{fp}` — selective-disclosure stream (ADR-0007 §11)
- `/.well-known/identity-bridge` — OIDC + WebFinger + Nostr NIP-05
- `/.well-known/mcp-registry/v0.1/*` — MCP Registry surface (ADR-0016)
- `/identity/*` — serviceBindingProxy → notme

## What's NOT included

- No `lsp_*` / `reparse` / `enrich` / `status` from leyline LLO.
  Add a `mcpProxy` backend with `urlBinding = "LLO_MCP_URL"` if you
  need editor language-server tooling. The
  [`rosary-dev`](../rosary-dev/README.md) recipe shows the shape.
- No `/v2/*` OCI Distribution registry. Add `kind = (ociRegistry = void)`
  to enable.

## When to pick it

- You want the authenticated agent dispatch path (lease cert minted by
  notme → request signed by Ed25519 cert → cloister verifies and
  upserts attestation rows in TrustStore).
- You're testing the full `peer_attestations` + selective-disclosure
  flow end-to-end.
- You're integrating an external agent platform that expects an OIDC
  discovery doc + JWK Set.

For a smaller starting point with no identity surface, see
[`oss-launch-minimal`](../oss-launch-minimal/README.md).

For full ART development (adds LLO lsp tools on top of this), see
[`rosary-dev`](../rosary-dev/README.md).

## Next steps after `cloister init --recipe agent-cluster`

```sh
cd <out>
task dev:bootstrap   # one-time — generates DEV_VAULT_KEK + .env.local
# Then either:
task dev             # wrangler dev on :8787 (override via --port at init time)
task cluster:up      # full bundle topology via compose
```

## Required environment

The `agent-cluster` recipe references several env / service bindings that
must be set when running outside `task cluster:up`:

- `INTERLACE_MASTER_PUBKEY` — Ed25519 master public key bytes (notme's CA).
- `MACHE_MCP_URL` (or `MACHE_MCP` service binding) — mache upstream.
- `COMPANION_URL` — `http://127.0.0.1:9091` typically; cloister-companion's
  HTTP listener.
- `NOTME` — service binding to notme-identity.
