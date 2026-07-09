# Authoring a `server.json` for cloister

This is the **server author's** side of integration: how you describe an
MCP server so cloister can consume it as an input and route its tools.
(The client side — how a client connects to cloister's `/mcp` face — is
[`mcp-client.md`](mcp-client.md).)

A `server.json` is the standard [MCP registry](https://github.com/modelcontextprotocol/registry)
document that describes an MCP server: its name, version, and how to
reach it. cloister reads that document when you `cloister add` the server
as an input. If you want cloister to split your tool catalog into
several backends (one per tool group), you opt in with a small
cloister-specific block under `_meta`.

**TL;DR:**
- A plain `server.json` works — cloister resolves it to **one** backend
  and warns you it did so.
- Add `_meta."art.cloister/v1".groups[]` to partition your tools into
  **N** backends, one per group.
- The wire schema (exhaustive field rules) lives in
  [`leyline-schema-spec/mcp-tool/v1/`](https://github.com/agentic-research/ley-line-open/blob/main/rs/ll-core/schema-spec/mcp-tool/v1/README.md);
  this page is the how-to.

---

## 1. The minimum viable `server.json`

The standard MCP fields describe *what the server is* and *how to reach
it*. Here is rosary's (abridged) — a real one in this ecosystem, at the
root of the [rosary](https://github.com/agentic-research/rosary) repo:

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": "io.github.agentic-research/rosary",
  "title": "rosary",
  "description": "Agent orchestration and bead work-tracking, exposed as MCP over stdio and Streamable HTTP.",
  "version": "0.3.0",
  "repository": { "url": "https://github.com/agentic-research/rosary", "source": "github" },
  "remotes": [
    {
      "type": "streamable-http",
      "url": "http://localhost:{port}/mcp",
      "variables": { "port": { "default": "8383" } }
    }
  ]
}
```

That is enough for cloister to consume the server. What it is **not**
enough for is *fine-grained routing*: with no cloister block, all of the
server's tools land in a single coarse backend (see §4).

> **Vendor `_meta` is yours to use.** rosary also ships
> `_meta."io.github.agentic-research.rosary/transports"` and
> `.../tools` — its own reverse-DNS namespace for launch commands and a
> tool inventory. cloister ignores those; it only reads the
> `art.cloister/v1` key. The two coexist under `_meta` without conflict.

---

## 2. Opt into tool-group composition

To tell cloister how to partition your tools, add **one** block under
`_meta`, keyed `art.cloister/v1`:

```json
{
  "_meta": {
    "art.cloister/v1": {
      "groups": [
        {
          "name": "beads",
          "advertisedPrefix": "rsry_bead_",
          "upstreamNames": ["rsry_bead_create", "rsry_bead_search", "rsry_bead_close"]
        },
        {
          "name": "dispatch",
          "advertisedPrefix": "rsry_",
          "upstreamNames": ["rsry_dispatch", "rsry_scan", "rsry_run_once"]
        }
      ]
    }
  }
}
```

**Each group becomes exactly one cloister backend.** Two groups → two
backend declarations in the generated manifest.

| Group field | Required? | Becomes | Meaning |
|---|---|---|---|
| `name` | **yes** (non-empty, unique in this file) | backend identifier | What operators see in `cloister.capnp`, logs, disclosure output. Keep it short and descriptive. |
| `upstreamNames` | **yes** (non-empty list) | the backend's `claims` | The **explicit, closed** list of upstream tool names this backend owns. |
| `advertisedPrefix` | no (default `""`) | `handlesPrefix` | Prefix cloister uses to route + advertise. Empty = bare-name advertisement. |

Three rules worth internalizing:

1. **Partitioning is closed by design.** cloister does **no** inference —
   no prefix scanning, no description parsing. A tool is in a group
   only if you name it in that group's `upstreamNames`. Tools you don't
   list are not bound to any backend by this block.
2. **Empty `upstreamNames` is invalid** (a no-op group). If you want to
   opt in but declare no groups, ship `groups: []` — but prefer just
   omitting the block (§4).
3. **Don't double-prefix.** If every `upstreamNames` entry already
   starts with `advertisedPrefix`, cloister advertises them verbatim
   rather than re-prefixing. So `advertisedPrefix: "rsry_bead_"` over
   `["rsry_bead_create", ...]` advertises `rsry_bead_create`, not
   `rsry_bead_rsry_bead_create`.

---

## 3. (Optional) declare default tenancy

If your server has an opinion about *how it should be deployed*, add a
`tenancy` block alongside `groups`. The operator's
`cluster.toml [inputs.<name>].tenancy.*` **overrides** whatever you
declare — this is a default, not a mandate.

```json
"art.cloister/v1": {
  "groups": [ /* ... */ ],
  "tenancy": {
    "default_mode": "external",
    "trusted_tier": false,
    "shares_workerd_with": []
  }
}
```

- `default_mode`: `"co-located"` (share a workerd process — the default),
  `"external"` (own process/container, reached over a wire — the right
  answer for Go-native / non-V8 servers like rosary), or `"per-tenant"`
  (own process per tenant, strongest isolation).
- `trusted_tier`: `true` only if the server may carry hypervisor-layer
  bindings. Defaults to `false`; the substrate fails closed.
- `shares_workerd_with`: names of other inputs this one must co-locate
  with.

Full semantics: [`leyline-schema-spec/mcp-tool/v1/wire/meta-groups.md`](https://github.com/agentic-research/ley-line-open/blob/main/rs/ll-core/schema-spec/mcp-tool/v1/wire/meta-groups.md).
The framing is ADR-0030 §A5 (composable tenancy).

---

## 4. What happens without the block (the fallback)

A `server.json` with **no** `art.cloister/v1` block is **not** an error.
The resolver falls back to a single coarse backend and emits a build
warning so you know you're getting one backend, not N:

```
resolve-inputs: input <name>: no _meta.art.cloister/v1 — using
single-backend fallback. For multi-group servers, ask the maintainer
to add _meta.
```

This is exactly where **rosary sits today**: its `server.json` has the
standard fields + its own vendor `_meta`, but not yet an
`art.cloister/v1` block — so `cloister add rosary` yields one backend
and logs the warning above. Adding the block from §2 is how you upgrade
rosary from one coarse backend to per-group backends.

---

## 5. The full loop — from `server.json` to routed tools

```
your server.json  ──cloister add──▶  [inputs.<name>] in cluster.toml
                                             │
                                        task cluster:resolve
                                             │  (fetch + hash + parse _meta)
                                             ▼
                                     cluster.lock.toml  (pinned sha256 + generated_backends)
                                             │
                                        task manifest
                                             ▼
                              backends in src/generated/manifest.ts + cloister.capnp
```

### Add it

```sh
# github (whole repo — resolves the root server.json)
cloister add github://agentic-research/rosary@main --name rosary

# github shorthand (io.github.org/ sugar rewrites to github://)
cloister add io.github.org/agentic-research/rosary@main --name rosary

# a local file (absolute path)
cloister add file:///abs/path/to/server.json --name rosary
```

`cloister add` appends an `[inputs.rosary]` block to `cluster.toml`,
resolves it (fetches the `server.json`, hashes it, parses
`_meta.art.cloister/v1`), and writes the pin + derived backends into
`cluster.lock.toml`. Then run `task manifest` to regenerate the typed
manifest.

### The `[inputs.<name>]` block it produces

```toml
[inputs.rosary]
ref            = "io.github.org/agentic-research/rosary@main"
version        = "0.3.0"
urlBinding     = "ROSARY_MCP_URL"    # env-var the backend reads for its upstream URL
serviceBinding = "ROSARY_BUNDLE"     # service binding the backend proxies through
```

### Dev-loop override: `from`

While iterating on a `server.json` locally, add a `from` key. It wins
over `ref`, so the resolver reads your working copy instead of the
pinned remote — no re-publish needed between edits:

```toml
[inputs.rosary]
ref  = "io.github.org/agentic-research/rosary@main"
from = "file:///Users/you/remotes/art/rosary/server.json"
```

> If `from` points at a local file, `task lint`'s lockfile-drift check
> re-pins when that file changes — the same "re-pin after upstream
> edit" loop you see for other local-file inputs.

---

## 6. Reference

- **Wire schema (exhaustive field rules + constraint matrix):**
  [`leyline-schema-spec/mcp-tool/v1/wire/meta-groups.md`](https://github.com/agentic-research/ley-line-open/blob/main/rs/ll-core/schema-spec/mcp-tool/v1/wire/meta-groups.md)
- **Spec proper + the synthetic multi-group vector:**
  [`leyline-schema-spec/mcp-tool/v1/README.md`](https://github.com/agentic-research/ley-line-open/blob/main/rs/ll-core/schema-spec/mcp-tool/v1/README.md)
- **Why `_meta` reverse-DNS is the extension surface:** ADR-0026,
  [`adr/0026-tool-composition-model.md`](../adr/0026-tool-composition-model.md)
- **Running the resulting tools securely through cloister:**
  [`deployment/secure-art-tools.md`](../deployment/secure-art-tools.md)
- **Client side (connecting to `/mcp`):** [`mcp-client.md`](mcp-client.md)
