---
title: "ADR-0017: scripts/emit-workerd-config.mjs — build-time generator for workerd module declarations"
status: Accepted (2026-05-11)
date: 2026-05-11
tags: [build, workerd, wrangler, wasm, modules, tooling]
relates_to:
  - 0001-workerd-mcp-gateway.md
  - 0009-compute-substrate-portability.md
bead: cloister-7b1af5
---

## Context

cloister is an ES-module worker: `src/index.ts` exports the Worker via
`export default { fetch }` plus a set of Durable Object classes
(`BeadStore`, `TrustStore`, `BlobStore`, `CredentialVault`). The same
bundle runs on Cloudflare Workers in production and on `workerd serve
dist/config.capnp` locally (per ADR-0001) and inside the OCI image
(per ADR-0009 Phase 1). The wire shape is identical across both
runtimes; what differs is the *deployment artifact*:

- Cloudflare reads `wrangler.toml` and pushes the bundle directly.
- Local workerd / the OCI image reads a `config.capnp` that names every
  module embedded in the worker (`modules = [ ( name = ..., esModule
  = embed "...", ), ... ]`).

cloister has at least one `.wasm` dependency — the leyline-sign
cert-chain verifier compiled from Rust (LLO `rs/ll-open/sign/`, pulled
via the git dep in `rs/crates/cas/Cargo.toml`), imported by
`src/wire/signet-verify.ts` as `import wasmModule from
"../../leyline_sign.wasm"`. wrangler bundles that import per the
`[[rules]] type = "CompiledWasm"` rule in `wrangler.toml`, and the
output filename is **content-hashed** (e.g.
`307bfb3530eb650fd1b9f57a2a5fc062c7ea578d-leyline_sign.wasm`). The
hash changes whenever the wasm source changes.

That filename has to land in `config.capnp` as a `modules` entry
before workerd will boot the bundle. The source-of-truth
`config.capnp` at the repo root holds a worker-only baseline; the
content-hashed wasm names cannot be committed there because they
drift with every Rust source change.

A small build-time generator —
[`scripts/emit-workerd-config.mjs`](../../scripts/emit-workerd-config.mjs) —
copies the template into `dist/`, injects one `wasm = embed "..."`
entry per `*.wasm` file wrangler emitted, and rewrites `dist/`-
prefixed embed paths to be dist-relative. `task build:local` invokes
it after `wrangler deploy --dry-run --outdir dist`. The generator is
~120 lines, no external dependencies.

The "why does this generator exist?" question keeps surfacing in
review and in subsequent work (most recently cloister-273533, which
attempted to replace it with a wrangler-native binding shape and
discovered the substitution is structurally infeasible). This ADR
captures the constraint for the next reviewer.

## Decision

Keep the build-time generator. Document the ES-module-worker
constraint that forces it to exist. Harden its emission against
template drift (see Consequences).

The generator is the *only* path that satisfies every constraint
simultaneously:

1. cloister stays an ES-module worker (required for `export default
   { fetch }` + exported DO classes; required by ADR-0011 §"bundle
   shape" and ADR-0013's V8-isolate-as-syscall framing).
2. wasm modules are bundled by wrangler with content-hashed names
   (the only supported wasm-loading pattern for ES-module workers —
   see Alternatives below).
3. `workerd serve dist/config.capnp` boots without a kernel-managed
   module loader (workerd has no module-glob; every embedded module
   must be named explicitly in the capnp config).

## Alternatives considered

### Switch to wrangler's `[[wasm_modules]]` binding shape

wrangler's `[wasm_modules]` table — `BINDING = "path/to/file.wasm"`
— is the pattern documented for declaring wasm globals from
`wrangler.toml`. If it worked, the generator would be unnecessary:
the wasm binding would land in `wrangler.toml` and propagate to
`config.capnp` via the same mechanism as `BEAD_STORE` and `NOTME`.

**Rejected** because the substitution is structurally closed at three
layers — empirically confirmed in `cloister-273533`:

1. **wrangler CLI**: invoking wrangler against `[wasm_modules]
   BINDING = "..."` on an ES-module worker produces:
   ```
   ✘ ERROR  You cannot configure [wasm_modules] with an ES module
            worker. Instead, import the .wasm module directly in
            your code
   ```
   The CLI explicitly redirects ES-module workers to the
   `[[rules]] type = "CompiledWasm"` pattern cloister already uses.
2. **Cloudflare docs (wrangler 3.x / 4.x configuration
   reference)**: `[wasm_modules]` is documented as a service-worker
   binding retained for backward compatibility. ES-module workers
   are directed to `[[rules]]` with `CompiledWasm`.
3. **workerd capnp schema**: `node_modules/.pnpm/workerd@*/workerd.capnp`
   declares the `wasmModule @7 :Data` binding with the annotation
   `# Only supported when using Service Workers syntax.` The
   constraint is schema-level, not just CLI-level. workerd refuses
   the binding for module-format workers at the manifest-parse step.

Each of the three layers independently blocks the substitution.

### Switch cloister to service-worker syntax

Drop `export default { fetch }`. Replace with `addEventListener("fetch",
...)`. Move the DO classes out of `src/index.ts` (service-worker
syntax doesn't support exported DO classes — the workerd capnp would
need a different declaration shape entirely).

**Rejected** because:

1. Service-worker syntax loses the ADR-0011 / ADR-0013 substrate
   shape (exported DO classes are how the V8-isolate-as-syscall
   model is expressed in code; switching means rewriting both ADRs'
   implementation surface).
2. wrangler's compatibility-flag features (`nodejs_compat`,
   `compatibility_date`) are tuned for module workers; service-
   worker syntax surfaces a different feature subset.
3. Every existing route, every test, every test fixture would need
   refactoring against a different export shape. Disproportionate
   cost to avoid a 120-line generator.

### Pin a stable wasm filename via esbuild / wrangler config

Configure wrangler (or the underlying esbuild) to skip content-
hashing for `.wasm` outputs. If the filename were stable
(`leyline_sign.wasm` always), `config.capnp` could hard-code the
name and the generator would be unnecessary.

**Rejected** because:

1. wrangler 3.x / 4.x does not expose the esbuild output-filename
   knob through its config surface. There is no `[[rules]]` field or
   `[build]` option that pins wasm filenames. wrangler-built bundles
   delegate to a vendored esbuild whose `entryNames` / `assetNames`
   are not configurable through wrangler's public schema.
2. The content-hashed filename is a cache-busting feature — it
   guarantees clients fetching the wasm asset see the right version
   when the Rust source changes. Pinning the name regresses that.
3. The generator at 120 lines is cheaper than vendoring esbuild
   ourselves to override wrangler's bundling.

### Load wasm at runtime via `fetch()` + `WebAssembly.compile`

Drop `[[rules]] type = "CompiledWasm"` entirely. Serve the wasm as a
static asset (workerd `disk` service) and have `signet-verify.ts`
fetch it at boot, then `WebAssembly.compile(bytes)`. Removes the
bundling step → removes the content-hash → removes the generator.

**Rejected** because:

1. `WebAssembly.compile` on a fetched buffer is meaningfully slower
   than the wrangler-bundled `CompiledWasm` path. Cold-start cost is
   non-trivial for a hot-path verifier (`signet-verify` runs on
   every lease-gated request).
2. The asset would need to be served from a workerd `disk` service
   binding or fetched from a separate origin — both add deployment
   complexity that the current import-style bundling avoids.
3. cloister-273533 surfaced this option and noted it as "larger
   refactor" — the right path if wasm-fetch performance ever
   improves substantially, but not motivated by the generator's
   maintenance burden alone.

## Consequences

**Positive:**

- One small build-time step. ~120 lines. Zero external dependencies
  (just `node:fs` + `node:path`). Runs in <50ms on a warm cache.
- The generator failure modes are loud and obvious. Missing `dist/`,
  zero wasm files, or template drift each produce a clear error
  message and `exit 1` — no silent miscompilation.
- Hardening (cloister-7b1af5) replaces the original regex-based
  modules-block matcher with a bracket-balanced parser. The parser
  is robust against template whitespace changes, added comments,
  and reformatting that would silently break the regex.
- The script header now documents the constraint inline. A future
  reviewer asking "why does this exist?" gets the answer at the top
  of the file with a pointer to this ADR + cloister-273533.

**Negative / risks:**

- The generator is a separate emission path from the
  `task manifest` capnp-to-TS pipeline. It writes to `dist/`
  alongside the wrangler bundle, but it is not the manifest
  compiler. A reader navigating "where does this output come from?"
  has to know to look at `Taskfile.yml :: build:local` and find
  *two* steps (wrangler + generator), not one.
  - Mitigation: the header comment in
    `scripts/emit-workerd-config.mjs` is explicit, and the
    `task build:local` task description references both steps.
- The generator's bracket-balanced parser handles the template's
  current shape, including capnp line comments (`#`) and string
  literals. A future template change that introduces unusual
  constructs (block comments, raw strings) would need the parser
  extended. The script fails loud rather than mis-emitting in this
  case — `locateModulesArray` returns null and the script `exit 1`s
  with a drift message — so the failure mode is recoverable.
- The constraint chain (wrangler CLI → CF docs → workerd schema) is
  upstream-controlled. If a future workerd release relaxes the
  service-worker-only annotation on `wasmModule`, the generator
  could potentially be retired. Until then, the dependency on the
  workerd schema annotation is implicit in this ADR's reasoning.

**Cost:**

- One file (`scripts/emit-workerd-config.mjs`, ~125 lines including
  header).
- One `task build:local` step.
- One ADR (this one).

## Cross-references

- [ADR-0001](0001-workerd-mcp-gateway.md) — workerd-as-gateway
  framing; the substrate this generator targets.
- [ADR-0009](0009-compute-substrate-portability.md) — Phase 1 OCI +
  workerd deployment. The generator is the build-step that produces
  the in-image `config.capnp`.
- [ADR-0011](0011-hypervisor-bundle-boundary.md) / [ADR-0013](0013-slice-grant-enforcement.md)
  — the V8-isolate-as-syscall reasoning that requires ES-module
  worker shape (which in turn forces the generator's existence).
- `cloister-273533` — empirical investigation that confirmed
  `[[wasm_modules]]` is structurally infeasible for ES-module
  workers. Closed as "scope-blocked by upstream constraint";
  follow-ups split into a generator-hardening bead (this one) and a
  documentation bead (also this one).
- `cloister-7b1af5` — the bead this ADR ships under. Pairs the
  bracket-balanced parser refactor with the documentation step.

## What this ADR does NOT decide

- **Whether to migrate off `[[rules]] type = "CompiledWasm"` in the
  future.** A future runtime change (workerd relaxing the
  service-worker-only constraint on `wasmModule`, or wrangler
  exposing a stable wasm-filename knob) would open up alternatives.
  Re-open this ADR if either lands.
- **Whether to fold the generator into a richer build pipeline.**
  cloister has separate generators for cluster compose
  (`scripts/emit-compose.mjs`), tool schemas
  (`scripts/build-tool-schemas.mjs`), and the cloister manifest
  (`scripts/build-manifest.mjs`). A future ADR could consolidate
  them under a single build orchestrator; the present ADR scopes
  only to keeping `emit-workerd-config.mjs` correct.
- **The exact bracket-balanced parser implementation.** The
  contract is "find `modules = [ ... ]` robustly"; the parser
  details can evolve.
