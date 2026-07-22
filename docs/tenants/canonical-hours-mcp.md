# canonical-hours-mcp

canonical-hours' four tools surface [canonical-hours](https://github.com/agentic-research/canonical-hours)
— a scheduled PR/Linear status board built on eve.dev. `get_board`
(read-only) and `trigger_tick` (runs the tick now) mirror the board's
own REST routes; `resolve_addressed_review_threads` and
`dismiss_stale_bot_reviews` are opt-in mutating actions, gated by
canonical-hours' own `agent/lib/action-gate.ts` (canonical-hours-49ba33)
— cloister forwards the call, it does not additionally authorize it.

Unlike mache/llo (which partition their catalog into several named
`_meta.art.cloister/v1.groups[]`), canonical-hours declares **one**
unprefixed group covering all four tools — the resolver-fallback shape
this doc's own onboarding surfaced a real gap in (see "Resolver
requirement" below), not a real partitioning need.

## Wire (current as of canonical-hours-f17ca7; see [`cluster.lock.toml`](../../cluster.lock.toml) `[[generated_backends]]` + [`src/generated/manifest.ts`](../../src/generated/manifest.ts) for source of truth)

```toml
# cluster.toml
[inputs.canonical-hours]
ref        = "file:///path/to/canonical-hours/server.json"  # dev escape hatch; production ref TBD (no GitHub release tag yet)
urlBinding = "CANONICAL_HOURS_MCP_URL"
```

`task cluster:resolve` reads canonical-hours' `server.json`
`_meta.art.cloister/v1.groups[]` (one group, name `canonical-hours`,
empty `advertisedPrefix`) and derives a single `[[generated_backends]]`
row:

```capnp
( name          = "canonical-hours",
  handlesPrefix = "",
  kind = (mcpProxy = (
    urlBinding      = "CANONICAL_HOURS_MCP_URL",
    tools           = [],
    dynamicTools    = true,
    claims          = [ "get_board", "trigger_tick",
                         "resolve_addressed_review_threads",
                         "dismiss_stale_bot_reviews" ],
  )),
),
```

No `serviceBinding` — canonical-hours runs on Node via eve, not a
workerd isolate, so there's no Service binding to give it; it's
reached purely over HTTP via `urlBinding`, same as llo.

## Resolver requirement (the actual gap this onboarding found)

canonical-hours' `server.json` originally declared only
`_meta.art.cloister/v1.tenancy` (external/untrusted, no
`shares_workerd_with`) — no `groups[]`. `scripts/resolve-inputs.mjs`
accepts that (the documented "single-backend fallback," a warning not
an error) and emits a `generated_backends` row with empty
`handlesPrefix` **and** empty `claims`. That row is what the resolver
produces — but `wrangler dev` genuinely refused to boot on it:

```
Uncaught TypeError: manifest: backend "canonical-hours" has
dynamicTools=true but empty handlesPrefix AND empty claims; dynamic
tools require either a non-empty prefix (ADR-0006) or a non-empty
claims set (cloister-8ede3f)
```

Confirmed live (not inferred from reading code) by actually booting
`task cluster:dev` against the fallback-shaped lockfile. The fallback
path is fine for a server whose tools already share a real prefix
(none exists here — `get_board`/`trigger_tick`/… share no prefix); for
a server like canonical-hours, the fallback is structurally
unsatisfiable, and the fix is on the **upstream** side: canonical-hours'
`server.json` now declares one explicit `groups[]` entry with real
`upstreamNames`, same requirement any single-group server has, not
a canonical-hours-specific carve-out.

## Required bindings

| Binding | Kind | Where | Purpose |
|---|---|---|---|
| `CANONICAL_HOURS_MCP_URL` | `text = "http://localhost:2000/mcp"` | [`wrangler.toml`](../../wrangler.toml) | The only reachability path — canonical-hours is `external`/non-workerd per its own `server.json` tenancy, so there is no Service-binding alternative to add later the way mache/rosary have one |

Per [CLAUDE.md](../../CLAUDE.md): "config.capnp wins locally
(workerd-native shape); wrangler.toml's URL vars win on CF prod." —
canonical-hours has no `config.capnp` entry (external-only), so
`wrangler.toml`'s var is the sole source in every environment today.

No vault slice today. canonical-hours' two mutating tools are gated
independently by its own `MCP_ACTION_TOKEN` default-deny check
(canonical-hours-49ba33) — cloister does not (yet) forward any
credential into that gate; a caller reaching canonical-hours' mutating
tools *through* cloister today needs `MCP_ACTION_TOKEN` unset-and-thus-
denied, or wired directly (not via cloister) with the header set.

## Verification (canonical-hours-f17ca7)

Proven live, both directions, via `task cluster:dev` +
`eve dev` (canonical-hours) running simultaneously:

```sh
# tools/list through cloister lists all four canonical-hours tools
curl -s -X POST http://localhost:8787/mcp -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'

# get_board round-trips to the real running canonical-hours instance
curl -s -X POST http://localhost:8787/mcp -d '{"jsonrpc":"2.0","method":"tools/call","id":1,"params":{"name":"get_board","arguments":{}}}'
# → real board JSON (degraded, since the local instance had no real
#   GITHUB_TOKEN/LECTIO_URL — the degradation itself is proof this is
#   canonical-hours' real logic responding, not a stub)

# trigger_tick round-trips too
curl -s -X POST http://localhost:8787/mcp -d '{"jsonrpc":"2.0","method":"tools/call","id":1,"params":{"name":"trigger_tick","arguments":{}}}'
# → {"result":{"content":[{"type":"text","text":"\"tick result: all_clear\""}]}}
```

Both calls were made with the Interlace lease gate temporarily
overridden inactive for the test (`CLUSTER_DEV_INTERLACE_ROOT_PUBKEY=""`,
the supported `cluster-dev.mjs` override — never edited `.env.local`
itself). With the gate genuinely active (a real
`INTERLACE_ROOT_PUBKEY` configured), the same local environment hit a
**separate, real** failure — `notmeBundleFetcher`'s `env.NOTME` service
binding fetch of `/internal/ca-bundle` returns `CaUnavailableError`
even though the same path answers correctly over plain HTTP to
notme-identity's dev port directly. That's a genuine gap in the
service-binding path (or this environment's wrangler/service-binding
wiring), not anything canonical-hours-specific — filed separately
rather than folded into this bead, since it's an auth-pipeline issue
that would reproduce for any tenant once the gate is active, not
something about canonical-hours' wiring.

## Cross-references

- [ADR-0002](../adr/0002-edge-router-protocol-agnostic-backends.md) — protocol-agnostic backend dispatch
- [ADR-0006](../adr/0006-derived-tool-schemas.md) — dynamic tools + the prefix-or-claims requirement this doc's gap exercises
- [ADR-0007](../adr/0007-interlace-substrate.md) / [docs/security/threat-model.md](../security/threat-model.md) — the Interlace lease gate this verification ran with (temporarily) disabled
- `leyline-schema-spec/mcp-tool/v1/wire/meta-groups.md` — the `_meta.art.cloister/v1.groups[]` wire spec canonical-hours' `server.json` now opts into
- Tracking bead `canonical-hours-f17ca7` — this onboarding + the resolver-requirement discovery
