# Wire — `_meta.art.cloister/v1.groups[]`

The detailed field schema for the `groups[]` array carried under an
MCP `server.json`'s `_meta.art.cloister/v1` block. The synthetic
fixture in `vectors/example-multi-group.json` exercises the three
structural shapes v1 covers (prefixed-many, bare-name, prefixed-
single). A second implementation is conformant when its emitted block
satisfies the field schema below; byte-matching the fixture is useful
for resolver-test parity, but real MCP servers are expected to carry
their own group layouts, not a copy of the fixture.

The load-bearing property: **partitioning is closed by design**. Each
group's `upstreamNames` is an explicit, server-author-declared list of
upstream MCP tool names. The resolver does no inference, no prefix
matching, no description parsing. If a tool is not named in any group's
`upstreamNames`, this `_meta` block does not cover it.

## Top-level shape

```
_meta.art.cloister/v1 = {
  groups: Group[]
}

Group = {
  name:             string                // REQUIRED
  upstreamNames:    string[]              // REQUIRED, non-empty
  advertisedPrefix: string                // OPTIONAL, default ""
}
```

Exactly one field is defined under `_meta.art.cloister/v1` in v1:
`groups`. The `groups` array itself MAY be empty — an empty `groups: []`
means "this server author opted in but declared no groups." It is
semantically equivalent to omitting `_meta.art.cloister/v1` entirely
(the resolver falls back per the README §Heuristic fallback). Authors
SHOULD omit the block rather than ship an empty array.

## Per-field semantics

### `name` — REQUIRED

| Aspect | Rule |
|---|---|
| Type | string |
| Required | yes |
| Empty allowed | no |
| Uniqueness | unique within the `groups[]` array of this `server.json` |
| Becomes | the backend identifier in the generated cloister manifest |

The `name` is the operator-facing handle for the backend the resolver
emits from this group. Operators see it in `cloister.capnp` /
`cluster.capnp` after `task cluster:expand` resolves; in logs; in the
disclosure endpoint output. Pick a short, descriptive name that reads
well in those contexts — e.g. `prefixed-many`, `bare`, `prefixed-
single` in the synthetic fixture; a real server might use names like
`lsp`, `lifecycle`, `search`, scoped to that server's domain.

Conformance: two groups in the same `server.json` with the same `name`
is a spec violation. The resolver SHOULD fail the build with a clear
error rather than silently picking one.

### `upstreamNames` — REQUIRED, non-empty

| Aspect | Rule |
|---|---|
| Type | array of strings |
| Required | yes |
| Empty allowed | no — empty `upstreamNames` means "no claim", which is meaningless |
| Element constraint | each entry SHOULD match a tool name in the MCP server's `tools/list` response |
| Becomes | the `claims` field on the emitted backend declaration (P1 schema slot) |

The explicit list of upstream tool names this group claims. The
resolver writes this list verbatim into the backend's `claims` field
(P1, `cloister-8ede3f`); the routing layer uses it to direct
`tools/call` invocations.

Empty `upstreamNames` is a spec violation. A group that claims no
tools is a no-op backend; the resolver SHOULD fail the build.

The resolver does NOT validate at build time that every entry exists
in the upstream `tools/list` — at build time the upstream may not be
reachable. Drift between `upstreamNames` and the real `tools/list` is
the server author's problem; routing for an unbacked claim fails at
runtime with a normal "tool not found" error from upstream.

### `advertisedPrefix` — OPTIONAL

| Aspect | Rule |
|---|---|
| Type | string |
| Required | no |
| Default | `""` (empty string — bare-name advertisement) |
| Becomes | the `handlesPrefix` field on the emitted backend declaration |

How cloister advertises this group's tools on its public face, and the
prefix used for routing decisions.

**Don't-double-prefix semantics** (interlocks with P1,
`cloister-8ede3f`): if every entry in `upstreamNames` already begins
with `advertisedPrefix`, cloister MUST advertise the upstream names
verbatim (no second copy of the prefix). The intent is operator-
expectation match: when a server author writes `advertisedPrefix:
"lsp_"` alongside `upstreamNames: ["lsp_hover", ...]`, cloister
advertises `lsp_hover` (not `lsp_lsp_hover`).

When `advertisedPrefix` is the empty string (the default), tools are
advertised bare — by their `upstreamNames` entry verbatim. This is the
right choice when the server's tool names already carry semantic
meaning operators want to see directly (e.g. `foo`, `bar`, `baz` in
the fixture's `bare` group, or names like `status`/`enrich`/`reparse`
in a real lifecycle-style group).

## Worked examples

These mirror the three groups in `vectors/example-multi-group.json`.
Real MCP servers will pick names that fit their domain (a code-
intelligence server might use `lsp`/`lifecycle`/`sheaf`, a database
server might use `query`/`schema`/`admin`); the structural shapes the
spec needs to cover are the same.

### Example 1 — prefixed group (fixture `prefixed-many`)

```json
{
  "name": "prefixed-many",
  "advertisedPrefix": "pre_",
  "upstreamNames": ["pre_alpha", "pre_beta", "pre_gamma", "pre_delta", "pre_epsilon"]
}
```

Resolver behavior:

- Emits one backend with `name = "prefixed-many"`,
  `handlesPrefix = "pre_"`, `claims = ["pre_alpha", "pre_beta",
  "pre_gamma", "pre_delta", "pre_epsilon"]`.
- Advertises five tools to the public face: `pre_alpha`, `pre_beta`,
  `pre_gamma`, `pre_delta`, `pre_epsilon` — verbatim, because every
  claim already starts with `"pre_"`.

### Example 2 — bare-name group (fixture `bare`)

```json
{
  "name": "bare",
  "advertisedPrefix": "",
  "upstreamNames": ["foo", "bar", "baz"]
}
```

Resolver behavior:

- Emits one backend with `name = "bare"`, `handlesPrefix = ""`,
  `claims = ["foo", "bar", "baz"]`.
- Advertises three tools to the public face: `foo`, `bar`, `baz` —
  bare names, no prefix.

`advertisedPrefix` MAY be omitted entirely here; the default `""`
applies. The fixture spells out `"advertisedPrefix": ""` explicitly
to make the bare-name intent reviewer-visible.

### Example 3 — single-claim group (fixture `prefixed-single`)

```json
{
  "name": "prefixed-single",
  "advertisedPrefix": "solo_",
  "upstreamNames": ["solo_only"]
}
```

Resolver behavior:

- Emits one backend with `name = "prefixed-single"`,
  `handlesPrefix = "solo_"`, `claims = ["solo_only"]`.
- Advertises one tool: `solo_only` (verbatim — the single claim
  already starts with `"solo_"`).

Single-claim groups are legal. They exist when a server author wants
the per-backend split (separate identity in the manifest, separate
operator-facing identifier) even though only one tool is involved.

## Constraint matrix

| Constraint | Violation behavior |
|---|---|
| `name` missing | spec violation; resolver SHOULD fail build |
| `name` empty string | spec violation; resolver SHOULD fail build |
| `name` duplicated within `groups[]` | spec violation; resolver SHOULD fail build |
| `upstreamNames` missing | spec violation; resolver SHOULD fail build |
| `upstreamNames` empty array | spec violation; resolver SHOULD fail build |
| `upstreamNames` entry not in upstream `tools/list` | NOT validated at build time; runtime "tool not found" |
| `advertisedPrefix` missing | OK; defaults to `""` |
| `advertisedPrefix` empty string | OK; bare-name advertisement |
| Unknown field on group object | NOT an error in v1; consumers MAY warn |
| Unknown field on `_meta.art.cloister/v1` | NOT an error in v1; consumers MAY warn |
| `groups: []` (opted in, no groups) | NOT an error; behaviorally equivalent to omitting the block (see README §Heuristic fallback) |

## Heuristic fallback (cross-reference)

When `_meta.art.cloister/v1` is **absent** from a `server.json`, the
resolver (P3, `cloister-cb7263`) MUST fall back to a documented single-
backend default and emit a build-time warning. The fallback's exact
shape — how `name`, `handlesPrefix`, and `claims` get populated in the
no-hint case — is owned by P3's bead; this spec only commits that the
fallback exists, that it warns, and that it does NOT fail the build.

MCP server authors who care about how their tool catalog gets
partitioned into cloister backends MUST opt in by adding a
`_meta.art.cloister/v1.groups` block. Authors who don't care can ship
without the block and accept the fallback's single-backend shape.

## Conformance

A `_meta.art.cloister/v1` block is conformant on this wire when:

- The block parses as JSON.
- Every group has non-empty `name` and non-empty `upstreamNames`.
- `name` is unique within `groups[]`.

The synthetic fixture (`vectors/example-multi-group.json`) byte-
matches itself modulo cosmetic whitespace; resolver tests use it to
pin the field-shape contract. Real MCP servers are NOT expected to
byte-match the fixture — they're expected to satisfy the per-field
schema above with their own group layout.

Whitespace tolerance: JSON-significant whitespace (between tokens) is
not load-bearing. Field order within an object SHOULD follow the
fixture for reviewer-readability, but JSON object key order is not
byte-significant for spec conformance — consumers MUST tolerate any
key order.
