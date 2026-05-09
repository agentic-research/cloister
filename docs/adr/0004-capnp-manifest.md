---
title: "ADR-0004: Cap'n Proto manifest for declarative route + backend registration"
status: Accepted
date: 2026-04-29
tags: [architecture, configuration, capnp, schema, composition, packaging]
supersedes_framing: [ADR-0002 §"composition root in src/index.ts"]
---

## Context

Today the gateway's route table is registered in TypeScript:

```ts
// src/index.ts
const ROUTES: readonly EdgeRoute[] = [
  new HealthRoute(),
  new NotmeIdentityRoute(),
  new McpEdgeRoute([
    new BeadToolBackend(),
    new LspToolBackend(),
    new LeylineLifecycleBackend(),
  ]),
];
```

This works for one repo with five backends. It does not scale to the constellation
— multiple consumer repos (`../mache`, `../notme`, `../rosary`, `../signet`, future
others) want to be exposed through cloister, and the registration site is a
compile-time edit in this repo's source, not something a downstream repo can
contribute.

Three forces push the format choice:

1. **workerd already accepts the same `.capnp` schema language.**
   `config.capnp` is the existing runtime config; both files are processed
   by the Cap'n Proto schema language. (Whether workerd's runtime parser
   and the `capnp` CLI used by `task manifest` share parser code is
   unverified and not load-bearing — what matters is that schemas
   accepted by `capnp compile` are accepted by workerd's config loader.)
   Adding a YAML/JSON manifest would mean two parsers, two error formats,
   two schema-evolution stories. Cap'n Proto is the lower-friction
   choice.

2. **The Cap'n Proto ecosystem couples serialization to a capability-based
   RPC system** — interface references in capnp's RPC layer are
   unforgeable capabilities, the same shape workerd's service bindings
   take at runtime. The schema as we use it here has zero `interface`
   declarations, so the relevant capnp property for cloister's manifest
   is its **zero-copy ordinal-keyed wire format**, not capabilities-the-
   RPC-feature. The ecosystem alignment with workerd's capability model
   matters at the language level (one toolchain, one mental model); the
   schema layer doesn't itself express capabilities. See [capnproto.org/rpc.html](https://capnproto.org/rpc.html)
   for where capabilities live; ADR-0002 §"Capability boundary" describes
   how cloister's runtime achieves capability-shaped semantics through
   workerd's service bindings.

3. **`import` statements are native** to capnp. Cross-repo composition
   (each consumer repo shipping its own partial schema, a top-level workspace
   manifest importing them all) is built into the schema language, not bolted on.
   YAML's helm-style chart-of-charts story would have to reinvent this.

The fourth, less-load-bearing benefit: schema-first capnp gives us typed
codegen at build time and zero runtime parsing — the manifest is compiled to
either a binary blob embedded in the worker bundle or a typed TS module
imported by `src/index.ts`. A schema violation crashes the build, not the
gateway.

## Decision

Define a `Cloister.Gateway` schema in `manifest/cloister.capnp`. Each consumer
ships a value of that type at the root of their repo (`<repo>/cloister.capnp`)
declaring routes + backends. A top-level workspace manifest can import many,
concatenate their route lists, and emit one merged binding for the worker.

### Schema shape (illustrative — final lives in `manifest/cloister.capnp`)

```capnp
@0xb1d4f67c8c6e3b5a;

# A complete gateway configuration — one of these per workerd instance.
struct Gateway {
  metadata @0 :Metadata;
  routes   @1 :List(Route);
}

struct Metadata {
  name    @0 :Text;       # "cloister-art", "cloister-mache", etc.
  version @1 :Text;       # semver of the manifest, not of cloister itself
}

struct Route {
  path @0 :Text;          # "/health", "/mcp", "/identity"
  kind :union {
    health              @1 :Void;
    mcp                 @2 :McpRouteSpec;
    serviceBindingProxy @3 :ServiceBindingProxySpec;
    httpProxy           @4 :HttpProxySpec;
  }
}

struct McpRouteSpec {
  backends @0 :List(Backend);
}

struct Backend {
  name        @0 :Text;          # human-friendly id, must be unique within the McpRouteSpec
  handlesPrefix @1 :Text;        # tool-name prefix (e.g. "bead_", "lsp_", "rsry_")
  kind :union {
    durableObject  @2 :DoBackend;
    httpForward    @3 :HttpForwardBackend;
    serviceBinding @4 :ServiceBindingBackend;
    udsForward     @5 :UdsForwardBackend;
  }
}

struct DoBackend {
  binding @0 :Text;        # name of the DurableObjectNamespace binding
  keyArg  @1 :Text;        # which tool arg names the DO instance ("repo")
  tools   @2 :List(McpTool); # advertised tools (tools/list aggregation)
}

struct HttpForwardBackend {
  urlBinding @0 :Text;        # name of the text-var binding holding the URL
  tools      @1 :List(McpTool);
}

struct ServiceBindingBackend {
  binding @0 :Text;            # name of the Fetcher binding
  tools   @1 :List(McpTool);
}

struct ServiceBindingProxySpec {
  binding      @0 :Text;
  upstreamHost @1 :Text;       # "notme-bot"
  stripPrefix  @2 :Text;       # "/identity"
}

struct McpTool {
  name        @0 :Text;
  description @1 :Text;
  inputSchemaJson @2 :Text;    # raw JSON Schema as text — preserved verbatim
}
```

A consumer's `cloister.capnp` looks like:

```capnp
@0x...;
using Cloister = import "/cloister/manifest/cloister.capnp";

const gateway :Cloister.Gateway = (
  metadata = (name = "cloister-art", version = "0.1.0"),
  routes = [
    (path = "/health", kind = (health = void)),
    (path = "/mcp",
     kind = (mcp = (
       backends = [
         (name = "bead",
          handlesPrefix = "bead_",
          kind = (durableObject = (
            binding = "BEAD_STORE",
            keyArg  = "repo",
            tools   = [(name = "bead_create", description = "...", inputSchemaJson = "..."), ...]))),
         (name = "lsp",
          handlesPrefix = "lsp_",
          kind = (httpForward = (urlBinding = "LLO_MCP_URL", tools = [...]))),
       ]
     ))),
    (path = "/identity",
     kind = (serviceBindingProxy = (
       binding = "NOTME", upstreamHost = "notme-bot", stripPrefix = "/identity"
     ))),
  ],
);
```

### Composition (cross-repo)

A top-level workspace can import partial gateways from other repos and
concatenate their route lists:

```capnp
using ArtRoot = import "/cloister/manifest/cloister.capnp";
using Mache   = import "/mache/cloister.capnp";
using Notme   = import "/notme/cloister.capnp";

const composed :ArtRoot.Gateway = (
  metadata = (name = "cloister-constellation", version = "0.1.0"),
  routes = Mache.gateway.routes ++ Notme.gateway.routes ++ [...local routes...],
);
```

**Note (2026-05-09 audit):** stock `capnp eval` does **not** support list
concatenation in const expressions — verified against
[capnproto.org/language.html § Constants](https://capnproto.org/language.html)
and [capnp-tool.html](https://capnproto.org/capnp-tool.html). The
`++` operator above is illustrative; multi-repo composition will be
done by a small TS pre-processor that splices source files before
invoking `capnp compile`. Each consumer repo still owns its slice;
the top-level workspace still owns composition; the join just happens
in TS rather than in capnp's eval.

### Backend-kind registry

Cloister's runtime ships a small registry mapping each capnp backend `kind` to
a TypeScript factory:

```ts
const BACKEND_KINDS = {
  durableObject:  (spec, env) => new GenericDurableObjectBackend(spec, env),
  httpForward:    (spec, env) => new HttpForwardToolBackend(spec, env),
  serviceBinding: (spec, env) => new ServiceBindingToolBackend(spec, env),
  udsForward:     (spec, env) => new UdsForwardToolBackend(spec, env),
} as const;
```

The existing concrete backends (`BeadToolBackend`, `LspToolBackend`,
`LeylineLifecycleBackend`, `NotmeIdentityRoute`) each *generalize* into one of
these kinds:

| Old (concrete)              | New (kind)              |
| --------------------------- | ----------------------- |
| `BeadToolBackend`           | `durableObject` over `BEAD_STORE` |
| `LspToolBackend`            | `httpForward` over `LLO_MCP_URL`  |
| `LeylineLifecycleBackend`   | `httpForward` over `LLO_MCP_URL`  |
| `NotmeIdentityRoute`        | `serviceBindingProxy` over `NOTME` |
| `HealthRoute`               | route kind `health`               |

The TS classes don't go away — they become the *implementations* of those
kinds, parameterized by the spec rather than hard-coded.

### Build pipeline

```
manifest/cloister.capnp           (schema, in-repo)
<repo-root>/cloister.capnp        (the consumer's gateway value)
                ↓
        capnp compile
                ↓
src/generated/manifest.ts         (typed TS module — generated, gitignored)
                ↓
        wrangler build
                ↓
dist/index.js                     (bundle includes the manifest as an import)
```

`src/index.ts`'s `ROUTES` array is replaced by:

```ts
import { manifest } from "./generated/manifest.js";
import { instantiate } from "./manifest/runtime.js";

const router = new Router(instantiate(manifest, env));
```

Schema-validation errors crash `task build`, not the worker.

### Three-tier ergonomics

| Tier | UX | Implementation |
| --- | --- | --- |
| **0 — Zero config** | `cloister --target http://localhost:3000 --listen 8787` proxies one MCP server through cloister. Marketing pitch: *"no-config reverse proxy with v8 isolation, no VM"* | CLI builds an in-memory `Gateway` with one `httpForward` backend; no `.capnp` file required |
| **1 — Single manifest** | drop `cloister.capnp` at repo root, `task dev` | the path described above |
| **2 — Composed** | top-level workspace `cloister.capnp` imports per-repo partials | capnp `import` + list concatenation |

## Consequences

**Positive:**

- One schema language for runtime config (`config.capnp`) AND manifest
  (`cloister.capnp`). One parser, one error format, one evolution story.
- Cross-repo composition is native via capnp `import`. Each consumer owns its
  manifest slice; the top-level workspace owns composition.
- Schema-first: typed TS codegen, zero runtime parsing, build-time validation.
  A duplicate tool prefix or unknown backend kind crashes `task build`, not
  the deployed worker.
- "No-config reverse proxy" pitch is real: Tier 0 needs zero files. Tier 1
  is one `.capnp`. Tier 2 unlocks the constellation. Each tier is a strict
  superset of the previous, so users grow into it.
- The TS classes (`BeadToolBackend` etc.) become *kinds* parameterized by
  spec, not bespoke registrations. Adding a new MCP-fronted service in the
  constellation becomes "drop a `cloister.capnp` in the repo," not "PR
  cloister to register your backend."
- Marketing-shaped: capability-language for a capability-shaped runtime is
  honest, not branding.

**Negative / risks:**

- Capnp tooling in the TS ecosystem is thinner than yaml/json. We need a
  reliable capnp → TS codegen step (`capnpc-ts` or hand-rolled). Mitigated by
  the fact that workerd already requires the capnp toolchain for `config.capnp`.
- Schema evolution becomes a real obligation. Adding a new field is fine
  (capnp's add-only rules); removing or renumbering one is not. Document the
  rules in this ADR's schema file as comments.
- The "list concatenation in const expressions" capnp feature was originally
  hedged here as "real but not well-known." 2026-05-09 audit verified
  against [capnproto.org/language.html](https://capnproto.org/language.html)
  + [capnp-tool.html](https://capnproto.org/capnp-tool.html): **no such
  operator exists in stock capnp**. Multi-repo composition uses a small
  TS pre-processor that merges multiple `Gateway` values before codegen,
  run by the build step. The TS pre-processor is the plan; the capnp-eval
  approach is not feasible.
- The migration from current `src/index.ts` registration to the manifest is
  a one-shot rewrite — no per-feature flag. Mitigated by keeping the current
  TS classes as the kind implementations; the manifest only changes the
  *registration*, not the runtime semantics.

**Out of scope for this ADR:**

- The actual schema file (final shape lives in `manifest/cloister.capnp` once
  Phase 1 lands)
- Tier-0 CLI (`cloister --target ...`) — covered by a follow-up bead
- Tier-2 workspace composition (this ADR commits to the *pattern*; the
  specific workspace tool comes after Tier 1 ships and we have ≥2 consumers)
- A `cloister.capnp` for `../mache`, `../notme`, etc. — those live in those
  repos and are owned by their maintainers

## Work items

A new bead will track this. Sliced as:

- [ ] Land the schema in `manifest/cloister.capnp`
- [ ] Set up capnp → TS codegen step (`task manifest`)
- [ ] Implement the four generic backends (`durableObject`, `httpForward`,
      `serviceBinding`, `udsForward`) — refactoring the existing concrete
      ones to be parameterized by spec
- [ ] `instantiate(manifest, env): EdgeRoute[]` runtime — the registry
- [ ] Migrate `src/index.ts` to read the generated manifest
- [ ] Add `cloister.capnp` to this repo's root with the current ART config
- [ ] Substrate-equivalence test: same manifest → same `ROUTES` output
      (regression net for the migration)
- [ ] Tier-0 CLI wrapper (`cloister --target <url>`) as a follow-up bead
- [ ] Document the manifest schema + writing-your-own walkthrough in
      `GETTING-STARTED.md`

## See also

- [ADR-0001](0001-workerd-mcp-gateway.md) — workerd choice; capnp is already
  the runtime config language there
- [ADR-0002](0002-edge-router-protocol-agnostic-backends.md) — the
  EdgeRoute + ToolBackend abstractions this manifest expresses
- [ADR-0003](0003-content-addressed-bead-store.md) — substrate-free storage;
  orthogonal to this ADR (the manifest expresses backend wiring, not the
  storage layer underneath)
- [ADR-0005](0005-internal-wire-leyline-net.md) — adds a `leylineNet` backend
  kind to the kind union defined here; introduces a third capnp file
  (`wire/cloister.capnp`) for the cloister↔companion seam
- [../../config.capnp](../../config.capnp) — runtime config (the *other*
  capnp file in this repo); this ADR's manifest is a sibling to it
