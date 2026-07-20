# `scripts/` — build, codegen, smoke + lint scripts

Helper scripts invoked by [`Taskfile.yml`](../Taskfile.yml) targets.
Most run as `node scripts/<name>.mjs`; a handful are `bash` (`*.sh`).
Almost all of them are invoked by a Task target rather than directly by
a human — Taskfile is the entry point.

## Codegen — manifest → typed TS, schema → JSON

| Script | Task | Pipeline |
|--------|------|----------|
| `build-manifest.mjs` | `task manifest` | Consumer's `cloister.capnp` → `capnp eval -o json` → typed `src/generated/manifest.ts`. Per [ADR-0004](../docs/adr/0004-capnp-manifest.md). |
| `toml-to-cluster.mjs` | `task cluster:toml` | `cluster.toml` → validated (`ClusterSchema`) → typed `src/generated/cluster.ts`. ADR-0025 bidi pipeline; reverse leg is `cluster-to-toml.mjs`. Supersedes the retired capnp→ts `build-cluster.mjs` (cloister-ab8f21). |
| `build-tool-schemas.mjs` | `task build` (pre-step) | `src/tool-schemas/*.ts` (zod) → JSON Schema → typed TS module. Closes `cloister-7ca96c` manifest↔handler drift. |
| `emit-compose.mjs` | `task cluster:emit` | `src/generated/cluster.ts` → `cluster.compose.yaml`. Docker/podman/nerdctl-compatible. |
| `emit-workerd-config.mjs` | inside `task image` | Stitches `dist/config.capnp` against wrangler's content-hashed wasm filenames so `workerd serve` resolves the bundled module. |

## OCI image build

The `apk:*` / `image:*` task targets shell out to `melange` + `apko`
directly (see [`Taskfile.yml`](../Taskfile.yml) `apk:`, `image:`,
`image:load`, `image:check`). The scripts here support those:

| Script | Task | Purpose |
|--------|------|---------|
| `import-image.mjs` | `task registry:import <tarball>` | Imports a `task image` tarball into the running cluster's BlobStore + `TrustStore.registry_tags`. Per `cloister-cabd57` Phase 1. |

## Cluster dev / orchestration

| Script | Task | Purpose |
|--------|------|---------|
| `cluster-dev.mjs` | `task cluster:dev` | Mac-native launcher: spawns child workerds/maches/rsry's per the cluster manifest, wires UDS sockets in `/tmp/cloister-dev/run/`. No containers. |

(`task cluster:up` / `cluster:down` use `docker compose` against the
emitted `cluster.compose.yaml` — no script wrapper needed.)

## Smoke + integration

| Script | Task | Purpose |
|--------|------|---------|
| `e2e-smoke.sh` | `task smoke` | End-to-end probe: `curl → cloister :8787 → leyline :8384`. Dev mode (no notme-proxy / no bridge cert). |
| `integration-test.sh` | `task integration` | Tier-1 matrix: builds + smokes the 5 sibling OCI images (cloister, notme, mache, rosary, ley-line-open) then `task cluster:up`. Per `cloister-1b1124`. |
| `stub-companion.mjs` | `task companion:stub` | Local-dev mock of cloister-companion's HTTP face per ADR-0005 + `cloister-5183bc`. |
| `smoke-leyline-stub.mjs` | `task smoke:leyline-stub` | Wire-end-to-end: production codec → real HTTP socket → stub-companion → real HTTP → production codec. |
| `verify-wire-roundtrip.mjs` | `task wire:verify-roundtrip` | Direction-2 cross-substrate proof: our encoder → capnp CLI → our decoder. Pairs with `test/wire/cross-check.test.ts`. |
| `gen-wire-fixtures.mjs` | `task wire:fixtures` | Regenerates `test/wire/fixtures/canonical.ts` from `wire/cross-check-fixtures.capnp`. |
| `sync-rsry-tools.mjs` | (manual) | Fetches `tools/list` from a running rsry MCP server, emits a paste-ready capnp fragment for the rosary backend's tools list. |

## Benchmarks (opt-in)

| Script | Task | Purpose |
|--------|------|---------|
| `bench-cold-start.mjs` | `task bench:cold-start` | External wall-clock probe: spawn → first 200 on `/health`. Outside vitest because the pool starts the worker on demand. |

(The other `task bench:*` targets use vitest's bench mode against
`test/perf/*.ts`; no script wrapper.)

## Lint helpers

| Script | Task | Purpose |
|--------|------|---------|
| `lint-mermaid.mjs` | `task mermaid:lint` | Catches undeclared edge references + style-block typos in mermaid blocks across markdown. Light-weight; not a full parser. |
| `lint-paths.mjs` | `task lint:paths` | Drift lint for paths shared across `apko.yaml` + `config.capnp` + DO storage. Closes `cloister-7c12cc` P2. |
| `lint-timing-invariants.mjs` | `task lint:timing` | Drift lint for security-affecting timing constants (`MAX_CLOCK_SKEW_MS`, bundle refresh, nonce eviction, retry backoff). Silently-insecure regression class. Per `cloister-7ea4c4` P1. |

## OS sidecar (legacy)

| Script | Task / binding | Purpose |
|--------|----------------|---------|
| `kek-helper.mjs` | bound as `KEK_HELPER` service binding (legacy) | **Superseded 2026-05-13 by [`rs/crates/sign/`](../rs/crates/sign/) `leyline-sign-helper` Rust binary** (ADR-0019, PR #1 + PR #2). Retained for golden-vector parity tests during the migration window. New deployments should start the Rust helper via `task helper:start`. |

## See also

- [`Taskfile.yml`](../Taskfile.yml) — the dispatcher.
- [ADR-0001](../docs/adr/0001-workerd-mcp-gateway.md) — substrate choice
  (workerd) that drives most of the build pipeline shape.
- [ADR-0014](../docs/adr/0014-pluggable-kek-source.md) — KEK-source
  design rationale.
- [ADR-0019](../docs/adr/0019-sign-only-helper-protocol.md) — sign-only
  trust-anchor-helper protocol (the Rust binary that replaced
  `kek-helper.mjs`).
