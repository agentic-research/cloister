# ADR-0027 — Substrate-as-kernel: capability matchmaker (n-dimensional builder)

- **Status:** Proposed (2026-05-18)
- **Tracking bead:** `cloister-1b59a2` (substrate-as-kernel framing — formalized here)
- **Pairs with:**
  - ADR-0024 (cloister/credential-isolation/v1 — first capability spec)
  - ADR-0026 (tool composition model — schema seam + resolver)
  - ADR-0013 (slice-grant enforcement — the existing capability the matchmaker first generalizes)
  - ADR-0021 (per-bundle vault DO — the binding-layer seam capabilities use)
  - `cloister-cf7a3b` (ADR-0026 implementation arc — Phase 4 IS the matchmaker)

## Context

Cloister today knows about a finite enumerated set of compositions:
manifest `routes[]` (six kinds: health / mcp / disclosure / wellKnown* /
caBundle / vaultProxy / ociRegistry), manifest `bundles[]` (hypervisor
vs cluster tier), manifest `wires[]` (uds vs leylineNet). Each new
substrate concept means a new top-level array in `cloister.capnp` and
a hard-coded branch in `runtime.ts`.

This is the **two-dimensional anti-pattern**: cloister has to know in
advance every kind of thing operators might want to compose. Adding a
new tool category — agent definitions, skills, OCI images, build
pipelines, code-intelligence backends — means a cloister-side schema
change.

What operators actually want is to compose **N heterogeneous tool
ecosystems** into one cluster. The tools each live in their own
dimension (mache = code-intelligence; openclaw = build pipeline;
codex = LLM-runtime; rosary = work-orchestration; notme = identity).
The substrate's job is the matchmaker, not the catalog.

Phase 1a + 1b of ADR-0026 (cloister-cf7a3b) shipped the *data shape*
for n-dim composition: `[inputs.*]` blocks in `cluster.toml`, each
carrying `provides[]` (capabilities it implements) and `requires[]`
(capabilities it consumes), with content-addressed digests in
`cluster.lock.toml`. **What's missing is the matchmaker that walks
the provides/requires graph and binds inputs to consumers.** That's
this ADR.

## Decision

**Adopt a capability-typed matchmaker as the substrate's composition
primitive.** Cloister stops being the catalog of valid composition
kinds; it becomes the algorithm that connects capability studs to
capability anti-studs across N heterogeneous inputs.

### Three substrate-level mechanisms (not new types)

1. **Capability spec registration** — a directory at
   `cloister-spec/<reverse-dns-name>/v<n>/` IS the registration. Drop
   it in, cloister picks it up. The dir contains `README.md` (the
   spec), `wire/` (interface docs), optional `vectors/` (conformance),
   optional `ref-impl-<lang>/`. Same shape as cred-iso/v1 today.
2. **Capability handler registration** — `src/capabilities/<name>/`
   exports a known interface (`handle(req, env)`, `compose(deps)`,
   `verify(claim)`). Loader discovers by directory naming. No central
   enum.
3. **Wiring composition** — `cloister.capnp` route/binding declarations
   name capabilities by `name@version`. The matchmaker walks the
   declared `[inputs.*]` from `cluster.toml`, collects every `provides`,
   resolves every consumer's `requires`, errors on unsatisfied
   requirements or on multiple-providers ambiguity.

### Capability ref shape

Reverse-DNS + version: `cloister/credential-isolation/v1`,
`cloister/mcp-tool/v1`, `cloister/skill/v1`,
`cloister/code-intelligence/v1`. The leading namespace is
substrate-namespaced (`cloister/...`) for first-party caps; third-party
caps use their own DNS root (`io.github.org/...`).

Versioning is major-only — `v1`, `v2` — matching the existing pattern
(`cred-iso/v1`, `interlace-spec/0.1.0/`). Breaking changes mean a new
directory + a new ref; v1 stays around indefinitely for back-compat.

### The matchmaker algorithm

```
input:  cluster.toml [inputs.*] blocks + cluster.lock.toml digests
        + cloister.capnp route/binding declarations
        + cloister-spec/<*>/v<n>/ available specs
output: a wired manifest the runtime can instantiate
        — OR — a precise error naming the unsatisfied requirement

Step 1 — collect all provides:
  providers = {}
  for input in inputs:
    for cap in input.provides:
      providers[cap].append(input)

Step 2 — resolve every requires:
  bindings = {}
  for input in inputs:
    for cap in input.requires:
      if cap not in providers:
        ERR("input '{input.name}' requires '{cap}' but no input provides it")
      if len(providers[cap]) > 1:
        ERR("input '{input.name}' requires '{cap}'; ambiguous: {providers[cap]}")
        # ambiguity-break candidate: explicit `bindings.<cap> = <input-name>` overrides
      bindings[(input, cap)] = providers[cap][0]

Step 3 — resolve route/binding declarations:
  for route in cloister.capnp.routes:
    if route.kind has a capability-typed variant:
      bind route → providers[route.capability]

Step 4 — topological check (no cycles in the require graph):
  for cycle in detect_cycles(bindings):
    ERR("cycle in capability graph: {cycle}")

Step 5 — emit wired manifest:
  for input in topo_sort(inputs):
    compose(input, bindings)
```

### Each tool brings its own dimension

A new tool kind = a new capability spec dir + a new handler dir. The
substrate's matchmaker doesn't change. Concretely, what shipping a
new "code-intelligence" capability looks like:

1. Author drops `cloister-spec/cloister/code-intelligence/v1/` with
   `README.md`, `wire/{discovery,query}.md`, optional vectors.
2. Author drops `src/capabilities/code-intelligence/v1/handler.ts`
   exporting `{ register, dispatch, verify }`.
3. Operators that want mache add `[inputs.mache]` with
   `provides = ["cloister/code-intelligence/v1"]` to their cluster.toml.
4. Operators that want openclaw add `[inputs.openclaw]` with
   `requires = ["cloister/code-intelligence/v1"]`.
5. `task cluster:resolve && task cluster:wire` — matchmaker glues
   openclaw to mache; runtime composition follows.

No core cloister edits. Each new dimension lands as drop-in dirs.

## Rationale

### Why capability-typed (not kind-typed)

The lego-blocks anti-pattern is `kind: "mcp-server" | "agent-def" |
"skill" | "oci-image"` — a single tool can only live in one kind,
adding a kind means cloister-side code change. The capability frame
lets one input live in MULTIPLE dimensions
(`provides: ["mcp-tool/v1", "bead-store/v1"]`) without modeling
contortion, and new dimensions land as spec dirs without core edits.

### Why "n-dimensional" is accurate

The build is **literally a directed acyclic graph** where:

- Nodes = inputs
- Edges = `provides` (out) / `requires` (in)
- Edge type = capability id
- "Compose" = topological resolution + per-edge binding

Each capability is a *dimension*. Inputs live in multiple dimensions
simultaneously. The matchmaker walks all dimensions in one pass.
There's no upper bound on dimension count.

### Why sheaf-on-lattice is the federation extension

ADR-0027 is the SINGLE-CLUSTER matchmaker. The user/org-hierarchy
federation problem (the sheaf-on-lattice math from the same design
conversation) is the **multi-cluster** generalization: each scope in
the org lattice is a node, each scope hosts its own matchmaker, the
gluing axiom says provides/requires resolve consistently across
overlapping scopes. That's a separate ADR (likely paired with the L2
addressability ADR being authored elsewhere). This ADR specifies the
within-a-scope semantics; the federation ADR specifies the
across-scope semantics.

### Why first-party caps live under `cloister/...`

Reverse-DNS namespacing matches what MCP's `_meta` extension surface
adopts (per ADR-0026). First-party caps use the substrate's name as
the DNS root; third-party caps use their own. Operators can grep
their `cluster.toml` for `cloister/...` to find substrate-versioned
capability dependencies vs third-party.

### Why directory-shaped registration (not central manifest)

A central capability registry creates a focal-point edit conflict —
every new capability touches one file. Directory-shaped registration
(drop `cloister-spec/<name>/v<n>/` + `src/capabilities/<name>/`)
means each capability is a clean self-contained PR. Same pattern as
k8s CRDs (you don't edit the API server when you add a CRD).

## Implementation arc

This ADR's scope is the **matchmaker spec + runtime**. The companion
ADR-0026 ships the data layer (cluster.toml `[inputs.*]` + lockfile).
Together:

| Phase | ADR | What |
|---|---|---|
| 1a | 0026 | `[inputs.*]` schema in cluster.toml + bidi pipeline (shipped, PR #62) |
| 1b | 0026 | file:// + https:// resolver + cluster.lock.toml (shipped, PR #63) |
| 2  | 0026 | Registry resolver (`io.github.org/repo` via ADR-0016) |
| 3  | 0026 | Signature verification (Interlace receipts) |
| **4a** | **0027** | **Capability spec discovery — `cloister-spec/<name>/v<n>/` loader** |
| **4b** | **0027** | **Matchmaker — provides/requires DAG walk, topo-sort, binding emit** |
| **4c** | **0027** | **Handler dispatch — `src/capabilities/<name>/` loader, runtime composition** |
| 4d | 0027 | First-party capability re-shape: cred-iso/v1, mcp-tool/v1, identity/v1 expressed AS capabilities (proof the framing fits the substrate that exists today) |

Phase 4d is the load-bearing proof. If cred-iso/v1 (today: bespoke
`vaultProxyServices` array in cloister.capnp + custom handler) can
be expressed as a capability under this framing without losing any
of its guarantees, the framing IS the substrate. If it can't, this
ADR is wrong about something and we patch the ADR before shipping
Phase 4d.

## Capability spec template

A minimum-viable capability spec dir:

```
cloister-spec/<rev-dns-name>/v<n>/
├── README.md              — what this capability IS; load-bearing properties
├── wire/                  — interface docs (one .md per surface)
│   ├── discovery.md       — how a consumer finds the provider
│   ├── invocation.md      — request/response shape
│   └── error-responses.md — error shapes + invariants
├── vectors/               — conformance vectors (optional, for cross-impl)
│   └── *.json
├── ref-impl-py/           — Python ref impl (optional)
└── CONFORMANCE.md         — how a second impl proves it speaks v<n>
```

Cred-iso/v1's existing layout matches this; the template is just
codifying what cred-iso/v1 already did. Phase 4a's loader walks
`cloister-spec/**/v*/README.md` to enumerate available caps.

## Handler interface

```ts
// src/capabilities/<name>/handler.ts
export interface CapabilityHandler<TConfig, TBindings> {
  /** Capability ref this handler implements (e.g. "cloister/skill/v1"). */
  readonly cap: string;

  /** Validate the input's config block against the spec. */
  parseConfig(raw: unknown): TConfig;

  /** Compose: given resolved bindings (other inputs that satisfy our requires),
   *  return whatever the runtime needs to instantiate this capability. */
  compose(config: TConfig, bindings: TBindings): RuntimeContribution;

  /** Optional: signature verification beyond the substrate's default. */
  verify?(claim: unknown): boolean;
}
```

`RuntimeContribution` is the discriminated union of what handlers can
add to the runtime — routes, bindings, env vars, container specs, etc.
The shape is intentionally substrate-side (the matchmaker doesn't know
what a handler will contribute until it asks).

## Alternatives considered

- **Keep hand-coded composition forever.** Rejected: every new tool
  category is a cloister-side schema edit + handler edit; the substrate
  becomes a catalog of every kind it ever supported.
- **Generic plugin system with JS-loaded handlers.** Rejected: runtime
  loading is a security hazard (workerd sandbox) + a deployment burden
  (where does the JS come from?). Compile-time registration via dir
  discovery is simpler + safer.
- **Smithy / WIT / Protobuf as the capability description language.**
  Rejected: cloister already has capnp as the substrate-IDL backbone
  (ADR-0004). Capability specs are markdown + JSON vectors, not a
  generated-code-first approach. The wire is what conforms; the
  description is how you read what conforms.
- **Use existing JSON-Schema / OpenAPI for capability shapes.**
  Considered, deferred: today cred-iso/v1's wire/* docs use plain
  prose + struct definitions. Migrating to a machine-readable format
  is a separate decision; the matchmaker doesn't care about the
  schema language, only the `provides`/`requires` graph edges.

## Consequences

**Positive:**

- Each new tool category is a drop-in spec dir + handler dir; no core
  edits.
- One input can live in N dimensions (`provides: [..., ..., ...]`).
- Operators read `cluster.toml` to see what's composed; the matchmaker
  explains itself by tracing the bind decisions.
- ADR-0024 (cred-iso/v1) becomes the first reference impl of the
  pattern, not a one-off. Phase 4d proves the framing.
- The sheaf-on-lattice federation extension lands cleanly on top —
  same matchmaker per scope, sheaf-gluing across scopes.

**Negative:**

- New abstraction layer to learn. Operators must read both the
  `[inputs.*]` block and the `cloister-spec/...` README for each
  capability.
- Multiple-providers ambiguity needs a tiebreaker (explicit
  `[bindings] cap = "input-name"` override per cluster). Not in
  Phase 4b — added when the first ambiguity surfaces in real ops.
- Capability versioning ratchet: adding `v2` doesn't auto-deprecate
  `v1`. Operators with `requires: ["cap/v1"]` keep working; they
  upgrade explicitly. Documentation must cover the upgrade pattern.

## Coordinated with

- `cloister-1b59a2` — substrate-as-kernel framing (this ADR formalizes)
- `cloister-cf7a3b` — ADR-0026 implementation arc; Phase 4a-4d
  IS this ADR's implementation
- `cloister-d9347e` — LSP tool ownership migration to ley-line-open
  becomes a Phase 4d demo target (LSP tools as `cloister/lsp-tool/v1`)
- Future federation ADR (paired with L2 addressability ADR being
  authored elsewhere) — sheaf-on-lattice extension across scopes

## Status

Proposed. Tracked by `cloister-1b59a2`. Implementation phases roll
into the existing `cloister-cf7a3b` arc — Phase 4a-4d are the
matchmaker pieces, sequenced AFTER Phases 1-3 (data + resolver +
verification) land.
