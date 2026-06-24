# rsry-mcp

The `rsry_*` tools surface [rosary](https://github.com/agentic-research/rosary)
— the bead substrate's MCP server. rosary exposes bead orchestration
(`rsry_bead_create`, `rsry_bead_search`, `rsry_bead_close`,
`rsry_bead_comment`, …), agent dispatch (`rsry_dispatch`,
`rsry_dispatch_record`), workspace lifecycle, decade + thread topology,
and pipeline queries. Cloister advertises ~35 of these under the
`rsry_` prefix; with `dynamicTools = true` the full upstream catalog
flows through.

Per [ADR-0033](../adr/0033-bd-substrate-binding.md): rsry IS the MCP
server; `bd` (the dolt-sql-server-backed bead tracker) is the storage
layer rsry consumes underneath. Cloister talks to rsry; rsry talks to
bd's Dolt. The MySQL wire stays inside rosary's bundle.

## Wire (current as of 2026-06-24; see [`cloister.capnp`](../../cloister.capnp) for source of truth)

```capnp
( name          = "rsry",
  handlesPrefix = "rsry_",
  kind = (mcpProxy = (
    urlBinding      = "ROSARY_MCP_URL",
    serviceBinding  = "ROSARY_BUNDLE",
    tools           = [],          # empty + dynamicTools=true → full rsry catalog
    dynamicTools    = true,
    stripPrefix     = "",          # rsry's own names are already rsry_*
    requiresSession = false,
    claims          = [ ... ~35 rsry_* tools ... ],
  )),
),
```

`dynamicTools = true` means cloister fetches `tools/list` from rosary
at request time and caches with TTL (default 60s). The static
`claims` list is the operator-declared subset — used by ADR-0006
Derived-schema verification + lint:bundle-isolation to guarantee
those specific tools always surface even if `tools/list` fails.

`stripPrefix = ""` because rosary's own tools are already named
`rsry_*` — no rewrite needed at the proxy boundary.

`requiresSession = false` — rosary's MCP server (currently the
Rust-side `mcp` mode at `/run/cloister-uds/rosary.sock`) is
stateless per request; no `Mcp-Session-Id` lifecycle.

## Required bindings

| Binding | Kind | Where | Purpose |
|---|---|---|---|
| `ROSARY_BUNDLE` | service binding to the `rosary` bundle | [`cluster.toml [[wires]]`](../../cluster.toml), emitted into [`config.capnp`](../../config.capnp) | Production path — workerd `Fetcher` to the rosary bundle's `mcp --ipc-socket /run/cloister-uds/rosary.sock` endpoint via the notme-proxy UDS forwarder |
| `ROSARY_MCP_URL` | `text = "http://localhost:8383/mcp"` | [`wrangler.toml`](../../wrangler.toml) | Local-dev fallback for `wrangler dev` (no compose, no UDS forwarder) |

Per [CLAUDE.md](../../CLAUDE.md): "config.capnp wins locally
(workerd-native shape); wrangler.toml's URL vars win on CF prod."

No vault slice today. Phase 1 of ADR-0033 ships unauthenticated on
the wire — rosary's UDS is filesystem-ACL'd inside the cluster, same
posture as mache + llo. Phase 2 (deferred) adds bearer-token auth via
vault per ADR-0024 cred-iso/v1 when a deployment shape needs
cross-tenant rosary consumption.

## Version pin

`rosary:0.2.0` per
[`cluster.compose.yaml`](../../cluster.compose.yaml) (service
`rosary`). The compose service binds the UDS socket inside
`/run/cloister-uds/` shared via volume between the rosary container
and the cloister-router container.

## Upstream project

- Repo: [github.com/agentic-research/rosary](https://github.com/agentic-research/rosary)
- Process: `rsry mcp --ipc-socket /run/cloister-uds/rosary.sock`
- Transport: MCP Streamable HTTP over Unix domain socket
- Storage substrate: bd-managed Dolt at `.beads/dolt/cloister/`
  (per ADR-0033). rosary reads via MySQL when bd's dolt sql-server
  is up; falls back to embedded Dolt otherwise.

## Auth

Phase 1 (today): no auth on the rsry wire. Same posture as mache +
llo — UDS filesystem ACL is the perimeter, cluster-internal trust is
sufficient. The gate stays on cloister's `/mcp` endpoint where lease
verification + scope checks run per ADR-0007.

Phase 2 (deferred): bearer-token auth mediated by vault per ADR-0024.
Token in `Authorization: Bearer <token>` header, injected by Vault DO,
opaque to cloister, rotatable at deploy boundary. Required for any
deployment shape where rosary's UDS becomes cross-tenant or
externally-reachable.

## Coexistence with `bead_*` (cloister's BeadStore DO)

Today cloister has TWO bead substrates:

- `bead_*` tools → cloister's own BeadStore DurableObject (`binding =
  BEAD_STORE`, `kind = durableObject`). DO SQLite tables; not
  Dolt-backed; not visible to bd or `git`-cloned consumers.
- `rsry_*` tools → rosary bundle → bd's Dolt at `.beads/dolt/cloister/`
  (this page). Travels with the repo via `bd dolt push/pull`.

Per [ADR-0033 D5](../adr/0033-bd-substrate-binding.md#d5--cloisters-own-beads-bead_store-do-vs-rsrybd-doltcoexist-decide-later): coexist intentionally. Operators choose per repo
which is canonical for new beads. Migration of BeadStore DO contents
to bd-managed Dolt is a separate ADR (BeadStore RPC carries
trust-mediation semantics per ADR-0012 that the bd backend doesn't
model yet).

## Cross-references

- [ADR-0033](../adr/0033-bd-substrate-binding.md) — the substrate binding decision
- [ADR-0004](../adr/0004-capnp-manifest.md) — the manifest schema
- [ADR-0006](../adr/0006-derived-tool-schemas.md) — dynamicTools passthrough + TTL cache + Derived schema verification
- [ADR-0011](../adr/0011-hypervisor-bundle-boundary.md) — why rosary is **cluster-tier** (removable without breaking the cluster)
- [ADR-0013](../adr/0013-slice-grant-enforcement.md) — V8 isolate + service-binding-as-syscall is what keeps cross-bundle access safe
- [ADR-0015](../adr/0015-mcp-spec-alignment.md) — `mcpProxy` as the spec-aligned form of `httpForward`
- [ADR-0024](../adr/0024-credential-isolation-capability.md) — cred-iso/v1 (the bearer-token Phase 2 hook)
- Tracking bead `cloister-9d19e3` — ADR-0033 design
- Tracking bead `cloister-c2bd47` — implementation
