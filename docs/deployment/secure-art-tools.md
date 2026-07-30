# Secure ART tool operation

This page is the operator story for running ART's core tool surfaces
through cloister's single `/mcp` face.

The goal is simple: clients talk to cloister; cloister mediates auth,
receipts, registry discovery, and bundle routing; individual tools stay
behind the router as cluster-tier bundles or explicitly configured
upstreams.

## Current state

| Tool | Cloister status | MCP surface | Notes |
|---|---|---|---|
| `mache` | Default cluster-tier bundle | `mache_*` | Declared in `cluster.toml`; routed by `mcpProxy` through `MACHE_MCP` service binding or `MACHE_MCP_URL` fallback. |
| `rosary` / `rsry` | Default cluster-tier bundle | `rsry_*` | Declared in `cluster.toml`; routed by `mcpProxy` through `ROSARY_BUNDLE` service binding or `ROSARY_MCP_URL` fallback. |

`mache` and `rosary` are therefore the current secure-ops scope. They
are part of the default cloister cluster topology today, and they should
work through the same external `/mcp` face a client or tunnel uses.

## Security boundary

In production, secure operation means every external `POST /mcp` request
enters through `McpEdgeRoute` and passes the Interlace lease gate when
`INTERLACE_ROOT_PUBKEY` is set. Transport reachability is not
authorization.

That distinction matters for tunnels:

- Direct HTTP, CF Tunnel, WARP, Tailscale, and OpenAI Secure MCP Tunnel
  are ways to make cloister reachable.
- Service bindings and UDS bridge traffic are ways for cloister-router to
  reach sibling bundles after the external request has already entered
  the router.
- None of those transports replace the Signet/Interlace lease envelope
  that authorizes production tool calls.

For local development, leaving `INTERLACE_ROOT_PUBKEY` unset keeps the
lease gate off at deployment-binding granularity. That is useful for
smoke tests and tunnel POCs, but it is not the production security
posture.

## Verify mache and rosary

Start the cluster topology using the path appropriate for your host,
then inspect the unified tool list:

```sh
curl -s -X POST http://localhost:8787/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | jq -r '.result.tools[].name' \
  | rg '^(mache_|rsry_)'
```

Expected:

- At least one `mache_*` tool appears.
- At least one `rsry_*` tool appears.

If `mache_*` is missing, check the `mache` bundle, the `MACHE_MCP`
service binding, and `MACHE_MCP_URL`. If `rsry_*` is missing, check the
`rosary` bundle, the `ROSARY_BUNDLE` service binding, and
`ROSARY_MCP_URL`.

The safe smoke calls are read-oriented:

```sh
curl -s -X POST http://localhost:8787/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"mache_get_overview","arguments":{}}}' \
  | jq

curl -s -X POST http://localhost:8787/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"rsry_status","arguments":{}}}' \
  | jq
```

When leases are enabled, send the same requests with the Signet headers
minted for the calling peer. A transport tunnel may carry those bytes,
but it does not mint or validate them by itself.

## Non-dev proof harness

For a local proof with the lease gate on, use the proof-only notme
worker fixture. It implements the service-binding endpoint cloister
expects, `GET /internal/ca-bundle`, and returns a signed JSON
`CABundle` for the deterministic test root.

```sh
CLUSTER_DEV_DIR_NOTME_IDENTITY="$PWD/test/fixtures/notme-ca-bundle-proof" \
CLUSTER_DEV_INTERLACE_ROOT_PUBKEY='ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ=' \
node scripts/cluster-dev.mjs
```

Then send signed requests with `test/helpers/signed-request.ts` using
`CERT_ADMIN_B64`. Expected proof results:

- Signed `tools/list` returns `200` and includes `mache_get_overview`
  and `rsry_status`.
- Signed `tools/call` for `mache_get_overview` returns `200`.
- Signed `tools/call` for `rsry_status` returns `200`.
- Unsigned `tools/list` returns `401` with `missing_authorization`.

This proves cloister's production lease path is active. It does not
prove the real notme minting UX; the full notme worker still needs to
serve the same JSON CA-bundle contract on `/internal/ca-bundle`.

## Deferred tools

`lectio` is intentionally out of scope for this runbook. Adding it as a
future memory bundle needs a separate intake for packaging, endpoint
shape, credential handling, write posture, storage, and tenant isolation.
Do not treat a tunnel or shared token as production authorization; any
future bundle must preserve the same cloister lease boundary described
above.

## Related work

- `cloister-31a988` tracks this secure ART tools operation story.
- `cloister-31c844` proves the existing `mache` and `rosary` paths.
- `cloister-22a5ca` tracks ADR-0037 for secure MCP ingress transports
  and lease bridges.
