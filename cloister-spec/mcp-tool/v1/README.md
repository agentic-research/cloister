# `cloister/mcp-tool/v1` — server.json `_meta` extension for tool-group composition

**Status:** Draft (2026-05-19, P2 of the LLO-enablement arc; paired with
ADR-0026 in cloister and tracked under `cloister-cb0a47`)
**Audience:** MCP server authors who want a single upstream server to
land as multiple cloister-side backends (one per tool group), and the
substrate-side resolver / second-implementation authors who consume the
contract. The fixture in `vectors/example-multi-group.json` is a
**synthetic test vector** exercising the three structural shapes v1
needs to cover (prefixed-many, bare-name, prefixed-single); a
conformant `_meta.art.cloister/v1` block follows the field schema in
`wire/meta-groups.md` regardless of which real tools it claims.
Ley-line-open is one downstream consumer of this extension point, not
its source of truth.

**Non-goals:** v1 does NOT cover dynamic tool discovery (`tools/list`
diffs at runtime), per-group transport overrides, per-group credential
scoping, weighted load balancing across groups, or runtime re-grouping.
Those are v2+ surfaces. v1 is the static, build-time partitioning of an
MCP server's tool catalog into named groups that compose into separate
cloister backends.

## What this capability is

A **routing-hint vocabulary** an MCP server author opts into to tell
cloister how to derive backend declarations from their `tools/list`. It
lives inside the `_meta` field of an MCP `server.json` document under
the reverse-DNS key `art.cloister/v1`, per the MCP spec's namespacing
convention.

The single load-bearing property this v1 publishes:

1. **Closed-by-design partitioning.** Each group's `upstreamNames` is
   an **explicit, closed list** of MCP tool names. The resolver does
   not infer membership from prefixes or descriptions; it only honors
   what the server author named. Empty `upstreamNames` is invalid
   (a no-op group). Tools not appearing in any group's `upstreamNames`
   are NOT covered by this `_meta` block — the resolver's behavior for
   them is governed by §Heuristic fallback below.

Three secondary properties:

2. **One group → one backend.** A `[inputs.<name>]` block in
   `cluster.toml` that resolves an `server.json` carrying N groups
   produces N backend declarations in the generated `cloister.capnp` /
   `cluster.capnp` manifest — one per group, with `name`,
   `handlesPrefix`, and `claims` derived from the group fields.
3. **Advertisement is server-author-controlled.** `advertisedPrefix`
   tells cloister how to surface the group on the public face. The
   "don't double-prefix" semantics (P1, `cloister-8ede3f`) ensure that
   if every `upstreamNames` entry already starts with
   `advertisedPrefix`, cloister advertises them verbatim rather than
   re-prefixing.
4. **Errata stay v1, breaking changes get v2.** Field renames,
   semantic changes, or new required fields move to
   `cloister-spec/mcp-tool/v2/` and a new manifest capability name
   (`cloister/mcp-tool/v2`). Within v1, clarifications that don't
   change byte stability of the canonical vector are errata; they
   update the README/wire docs but leave `vectors/` byte-stable.

## Relationship to other specs

```
                          server.json (MCP Registry)
                                  ▲
                                  │ extends via _meta.art.cloister/v1
                                  │
                       cloister-spec/mcp-tool/v1
                                  ▲
                                  │ consumes
                                  │
                ┌─────────────────┴─────────────────┐
                │                                   │
   P1: HttpForwardBackend.claims               P3: resolver
   (cloister-8ede3f, schema slot)              (cloister-cb7263, codepath)
```

This v1 **CONSUMES**:

- **MCP `server.json` schema 2025-12-11** — the surrounding document
  shape (top-level `name`, `version`, `description`, `_meta`). This v1
  does NOT re-specify those fields; it only specifies what lives under
  `_meta.art.cloister/v1`.
- **ADR-0026 §"Where the `_meta` extension lives"** — the framing for
  why reverse-DNS namespacing under `_meta` is the right surface for
  cloister-specific hints.

This v1 **DEFINES** (new content not in either upstream):

- The `groups[]` array shape under `_meta.art.cloister/v1`.
- Per-group fields: `name`, `advertisedPrefix`, `upstreamNames`.
- The required-vs-optional matrix.
- The contract that one group becomes one backend declaration.

This v1 is **CONSUMED BY**:

- **P1 — `HttpForwardBackend.claims` field** (`cloister-8ede3f`,
  parallel) — the schema slot on the cloister side that the resolver
  populates from `upstreamNames`. P1 lands the manifest field; this
  spec defines what the resolver writes into it.
- **P3 — resolver** (`cloister-cb7263`, downstream) — the code that
  reads a resolved `server.json`, walks `_meta.art.cloister/v1.groups`,
  and emits the N backend declarations into the generated manifest.
- **P4 — LLO `server.json`** (downstream) — the first real MCP server
  to ship a `_meta.art.cloister/v1` block. LLO's block MUST be a valid
  `_meta.art.cloister/v1` per `wire/meta-groups.md`; the concrete tool
  names + group layout are LLO's, not this spec's. The fixture under
  `vectors/example-multi-group.json` is a generic synthetic example,
  not a copy of what LLO ships.

## Document map

- `README.md` (this file) — the spec proper.
- `wire/meta-groups.md` — the per-field schema for `groups[]`, with
  worked examples and the constraint matrix.
- `vectors/example-multi-group.json` — a synthetic multi-group fixture
  exercising the three structural shapes (prefixed-many, bare-name,
  prefixed-single). Used in resolver tests; not specific to any real
  MCP server. Real `_meta.art.cloister/v1` blocks are conformant when
  they satisfy the wire schema, not when they byte-match this file.

A ref-impl + CONFORMANCE.md can land later if a second implementation
surfaces; v1 ships with the spec + the canonical vector only.

## The `_meta.art.cloister/v1` shape (summary; see `wire/meta-groups.md`)

A conformant MCP `server.json` opts in by adding a single block under
`_meta`. The synthetic fixture (`vectors/example-multi-group.json`)
shows the three structural cases:

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": "io.example/multi-group-fixture",
  "version": "0.0.0",
  "description": "Synthetic test fixture exercising cloister-spec/mcp-tool/v1.",
  "_meta": {
    "art.cloister/v1": {
      "groups": [
        {
          "name": "prefixed-many",
          "advertisedPrefix": "pre_",
          "upstreamNames": ["pre_alpha", "pre_beta", "pre_gamma", "pre_delta", "pre_epsilon"]
        },
        {
          "name": "bare",
          "advertisedPrefix": "",
          "upstreamNames": ["foo", "bar", "baz"]
        },
        {
          "name": "prefixed-single",
          "advertisedPrefix": "solo_",
          "upstreamNames": ["solo_only"]
        }
      ]
    }
  }
}
```

Each `group` produces exactly one backend declaration:

| Group field | Becomes backend field | Semantics |
|---|---|---|
| `name` | backend identifier (operator-facing) | Unique-within-server.json, kebab-or-snake-case. |
| `advertisedPrefix` | `handlesPrefix` | Prefix cloister uses for routing AND advertisement. Default empty string (bare-name advertisement). Don't-double-prefix semantics per P1 (`cloister-8ede3f`). |
| `upstreamNames` | `claims` | The explicit list of upstream tool names this backend owns. Populated into P1's new schema field verbatim. |

The closed-by-design property: groups are **explicit**. The resolver
does not derive group membership by scanning prefixes, parsing
descriptions, or any other heuristic — it only honors `upstreamNames`.
If a tool exists in the upstream `tools/list` but appears in no
group's `upstreamNames`, this `_meta` block does not bind it to any
backend; whether the resolver covers it at all depends on §Heuristic
fallback.

## Required vs optional in v1

Spec REQUIRED fields per group:

- **`name`** — non-empty string, unique within the
  `_meta.art.cloister/v1.groups[]` array of this `server.json`.
  Becomes the backend identifier; operators see this in the generated
  manifest.
- **`upstreamNames`** — non-empty list of strings. Each entry MUST
  match a tool name appearing in the MCP server's upstream
  `tools/list` response. The resolver does not validate this at
  build time (the upstream may not be reachable then); runtime drift
  between this list and the actual `tools/list` is the server
  author's problem, not the resolver's.

Spec OPTIONAL fields per group:

- **`advertisedPrefix`** — string. Defaults to `""` (the empty string,
  bare-name advertisement). When non-empty, cloister advertises this
  group's tools under this prefix on the public face. Per P1, if every
  `upstreamNames` entry already begins with `advertisedPrefix`,
  cloister advertises the upstream names verbatim (no double-prefix).

No other fields are defined in v1. The `_meta.art.cloister/v1` object
itself has exactly one field: `groups[]`. Unknown fields under
`_meta.art.cloister/v1` (or unknown fields inside a group object) are
NOT errors today, but consumers MAY warn — v2 may give them meaning.

## Heuristic fallback (cross-reference)

When a `server.json` has **no** `_meta.art.cloister/v1` block, the
resolver (P3, `cloister-cb7263`) MUST fall back to a documented
single-backend default and emit a build-time warning. The shape of
that fallback — how exactly the resolver populates `claims` and
`handlesPrefix` in the absence of group hints — is owned by P3.
This spec only commits that:

1. The fallback exists (a `server.json` without `_meta.art.cloister/v1`
   is NOT a build error; it just yields a coarser backend).
2. The fallback emits a documented warning so the MCP server author
   knows they're getting one backend, not N, and can opt into groups
   if they want finer-grained composition.

MCP server authors who care about how their tools are partitioned into
backends MUST opt in by adding a `_meta.art.cloister/v1.groups` block.
Authors who don't care can ship `server.json` without the block and
accept the fallback's single-backend shape.

## Versioning

This is v1. Errata-only changes (README/wire-doc wording fixes that do
NOT change the byte sequence of `vectors/example-multi-group.json`
modulo cosmetic whitespace) stay in this directory; the README gains
an errata entry. Breaking changes — adding required fields, renaming
fields, changing the closed-list semantics — require a new directory
(`cloister-spec/mcp-tool/v2/`) and a new manifest capability name
(`cloister/mcp-tool/v2`). The wire schema (`wire/meta-groups.md`) plus
the synthetic vector are the load-bearing truth; prose bends to match.

## Errata + clarifications

(None yet — this is the initial draft.)

## Tracking

- ADR: `docs/adr/0026-tool-composition-model.md` (origin of the
  `_meta.art.cloister/v1` extension point).
- ADR: `docs/adr/0027-substrate-as-kernel-capability-matchmaker.md`
  (capability-spec-dir-as-registration framing).
- ADR: `docs/adr/0028-capability-scheme.md` (lane discipline; this
  spec lives in lane 3).
- Bead: `cloister-cb0a47` (this spec dir; P2 of LLO-enablement arc).
- Coordinated with: `cloister-8ede3f` (P1, schema slot the resolver
  fills), `cloister-cb7263` (P3, the resolver).
- Crosswalk row: `cloister-spec/_capability-mapping.md` §4.
