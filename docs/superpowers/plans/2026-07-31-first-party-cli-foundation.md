# First-party Cloister CLI Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a clean checkout install and run Cloister through one first-party CLI, with `cluster.toml` as the configuration source, consistent color controls, an honestly labeled compatibility runtime, and read-only runtime status.

**Architecture:** `bin/cloister.mjs` is a dependency-free bootstrap and the installed executable. Normal commands route into `cli/`; user-facing implementation and shared launch code live there. The compatibility installer builds the current native+nono and krunvm helpers once, copies them into a machine-local libexec directory, records their digests and maturity, and normal commands use only those installed artifacts. `task` is a convenience alias onto the CLI and is never spawned by the CLI. Cluster generators are product libraries called by both the CLI and repository-only checks. LLO remains the owner of the future neutral RunSpec/lifecycle and replaces the compatibility provider through the same Cloister-side client seam.

**Tech Stack:** Node.js 20+ ESM, Chalk 5, smol-toml, tsx ESM API, Go Task, node:test, Rust 2021, serde/serde_json, nono, krunvm compatibility adapter, Docker, GitHub Actions.

## Global Constraints

- Preserve the dependency direction approved in the design: Rosary uses Cloister; Cloister consumes LLO; LLO does not know about harness names, beads, auth plans, or repository paths.
- This plan implements only the LLO-independent foundation. Do not invent a Cloister-local RunSpec. `ley-line-open-d7abd6` must publish the generated execution API before `cloister-903b5f` adopts it.
- Keep `main` usable after every commit. The clean-checkout smoke remains `task install`, `cloister --help`, `cloister skills list`, and `cloister run --harness claude-code --repo /absolute/path --dry-run`.
- `cluster.toml` is the operator-authored source. `src/generated/cluster.ts`, `cloister.capnp`, and `cluster.compose.yaml` are projections.
- Normal CLI execution must never spawn `task`, import or execute `scripts/`, or execute a path under `tools/`.
- The one temporary exception is the compatibility installer: it may compile sources under `tools/harness-sandbox` and `rs/crates/host-runtime`, but it must copy the resulting binaries to libexec. A later run must not depend on either build directory.
- Never fall back from a missing or invalid provider to an unconfined run. Point to `cloister runtime install`.
- Runtime provider selection is deterministic. An explicit invalid development override is an error; a binary discovered incidentally on `PATH` is not selected.
- Human output may use color, but text labels carry the meaning. JSON, pipes in `auto` mode, `NO_COLOR`, and `--color never` contain no ANSI escapes.
- Runtime status is observational: no directory creation, mount, lock-file creation, state write, acquisition, repair, or preparation.
- Preserve the already-landed dependency security floors: PostCSS resolves to at least 8.5.18 and sharp to at least 0.35.3. Keep `scripts/test/dependency-security.test.mjs` green.
- Do not stage or delete `.fastembed_cache/` or any other user-local untracked state.
- Before every commit, inspect `git status --short` and stage only the files listed for that task. Do not use a broad directory add when unrelated user changes are present.
- The local `task lint` ambient-secret problem is tracked separately as `cloister-003091`. Until it lands, run the final full gate in a clean worktree or the clean install image; do not delete or rewrite the user's `.dev.vars` or `.env.local` to make a test pass.

---

### Task 0: Correct the runtime ownership record before moving code

**Bead:** `cloister-e6bbd6`

**Files:**
- Modify: `docs/adr/0049-cloister-host-runtime.md`
- Modify: `docs/adr/0035-cloister-llo-boundary.md` only where it links to ADR-0049's superseded ownership
- Modify: `docs/superpowers/specs/2026-07-31-first-party-cli-design.md`

- [ ] **Step 1: Mark ADR-0049's ownership decision as superseded**

Keep the useful composition evidence, but replace the statement that the
generic runtime "is cloister's, not LLO's." Record the corrected ownership:

```text
LLO owns neutral RunSpec/lifecycle, native+nono, libkrun+nono,
capability-scoped Graph workspaces, and execution receipts.

Cloister owns harness policy, auth/audit selection, cluster configuration,
human-facing CLI output, and receipt linkage.
```

Identify `rs/crates/host-runtime` and `tools/harness-sandbox` as experimental
compatibility migration sources, not the target architecture. State that this
phase packages them so `main` works and then retires them after generated LLO
client adoption.

- [ ] **Step 2: Run documentation checks**

```sh
node scripts/lint-doc-links.mjs
git diff --check
```

Expected: both pass and no current ADR claims Cloister owns a parallel generic
execution substrate.

- [ ] **Step 3: Commit the ownership correction**

```sh
git add docs/adr/0049-cloister-host-runtime.md docs/adr/0035-cloister-llo-boundary.md docs/superpowers/specs/2026-07-31-first-party-cli-design.md
git commit -m "[cloister-e6bbd6] docs(runtime): correct execution ownership"
```

### Task 1: Move the installed command into a product-owned tree

**Bead:** `cloister-8d5910`

**Files:**
- Create: `bin/cloister.mjs`
- Create: `cli/index.mjs`
- Move: `scripts/cli-surface.mjs` → `cli/surface.mjs`
- Move: `scripts/cli-init.mjs` → `cli/commands/init.mjs`
- Move: `scripts/cli-add.mjs` → `cli/commands/add.mjs`
- Move: `scripts/pull-inputs.mjs` → `cli/commands/artifacts-pull.mjs`
- Move: `scripts/emit-host-launch-plan.mjs` → `cli/commands/runtime-plan.mjs`
- Move: `scripts/init-krun-storage.mjs` → `cli/commands/runtime-storage-init.mjs`
- Move: `scripts/cli-run.mjs` → `cli/commands/run.mjs`
- Move: `scripts/cli-skills.mjs` → `cli/commands/skills.mjs`
- Move: `scripts/cli-cluster.mjs` → `cli/commands/cluster.mjs`
- Move: `scripts/host-runtime-cli.mjs` → `cli/lib/runtime/compatibility-client.mjs`
- Move: `scripts/harness-targets.mjs` → `cli/lib/harness/targets.mjs`
- Move: `scripts/lib/harness/launch.mjs` → `cli/lib/harness/launch.mjs`
- Move: `scripts/lib/harness/types.mjs` → `cli/lib/harness/types.mjs`
- Move: `scripts/lib/harness/node-shims.d.ts` → `cli/lib/harness/node-shims.d.ts`
- Move: `scripts/lib/harness/tsconfig.json` → `cli/lib/harness/tsconfig.json`
- Move: `scripts/lib/canonical-path.mjs` → `cli/lib/canonical-path.mjs`
- Move: `scripts/lib/oci-artifact.mjs` → `cli/lib/oci-artifact.mjs`
- Move: `scripts/lib/operator-consent.mjs` → `cli/lib/operator-consent.mjs`
- Modify: `package.json`
- Modify: `scripts/cloister-cli.mjs`
- Modify: `scripts/harness-dev.mjs`
- Modify: command wrappers under `scripts/`
- Modify: affected imports under `scripts/test/`, `test/`, and `scripts/`
- Test: `scripts/test/cloister-cli.test.mjs`
- Test: `scripts/test/cli-surface.test.mjs`
- Test: `scripts/test/cli-run.test.mjs`

**Interfaces:**

```js
// bin/cloister.mjs
export async function run(argv = process.argv.slice(2), io = process);

// cli/index.mjs
export async function main(argv, context = {});
```

`bin/cloister.mjs` uses Node built-ins only and dynamically imports
`../cli/index.mjs` for normal commands. Command modules export `main(argv,
deps)` and have no top-level `process.exit` when imported.

- [ ] **Step 1: Write the failing package-entry and import-boundary assertions**

In `scripts/test/cloister-cli.test.mjs`, assert:

```js
assert.equal(PACKAGE.bin.cloister, "./bin/cloister.mjs");
assert.match(readFileSync(resolve(REPO_ROOT, "bin/cloister.mjs"), "utf8"), /\.\.\/cli\/index\.mjs/);
```

In `scripts/test/cli-surface.test.mjs`, import from `../../cli/surface.mjs` and
read `cli/index.mjs` when checking dispatch coverage.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```sh
pnpm exec tsx --test scripts/test/cloister-cli.test.mjs scripts/test/cli-surface.test.mjs
```

Expected: failure because `package.json` still names
`./scripts/cloister-cli.mjs` and `bin/cloister.mjs` does not exist.

- [ ] **Step 3: Move modules mechanically before changing behavior**

Use `git mv` for the files listed above. Fix relative imports so product modules
resolve only other product modules or package dependencies. Keep tiny wrappers
at old script paths only where repository checks still invoke those paths. A
wrapper must re-export the product module and call its exported `main` only on
direct invocation; it must contain no product logic.

The old package dispatcher becomes a compatibility wrapper:

```js
#!/usr/bin/env node
import { run } from "../bin/cloister.mjs";
process.exitCode = await run();
```

- [ ] **Step 4: Add the dependency-free executable**

Implement `bin/cloister.mjs` with built-ins only:

```js
#!/usr/bin/env node
export async function run(argv = process.argv.slice(2), io = process) {
  try {
    const { main } = await import("../cli/index.mjs");
    return await main(argv, { stdout: io.stdout, stderr: io.stderr, env: io.env });
  } catch (error) {
    io.stderr.write(`cloister: ${error.message}\n`);
    return 2;
  }
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exitCode = await run();
}
```

Use `pathToFileURL(process.argv[1]).href` in the real implementation so paths
with spaces and platform separators are handled correctly.
Set the executable bit on `bin/cloister.mjs` and assert it in the install test;
the package `bin` field does not repair source-checkout file modes by itself.

- [ ] **Step 5: Preserve the current command behavior through `cli/index.mjs`**

Port the existing dispatch table without adding aliases or changing exit codes.
Keep lazy imports for command groups. A bare command group and `--help` remain
side-effect-free.

- [ ] **Step 6: Run the CLI and launch-pipeline tests**

Run:

```sh
pnpm exec tsx --test scripts/test/cloister-cli.test.mjs scripts/test/cli-surface.test.mjs scripts/test/cli-run.test.mjs scripts/test/harness-targets.test.mjs scripts/test/confinement-shape.test.mjs
task lint:harness-types
node bin/cloister.mjs --help
```

Expected: all pass; help is byte-for-byte equivalent except source-path comments.

- [ ] **Step 7: Commit the product-tree move**

```sh
git add bin cli package.json scripts test Taskfile.yml
git commit -m "[cloister-8d5910] refactor(cli): move the installed command into the product tree"
```

### Task 2: Put `cluster.toml` generation and resolution behind the CLI

**Bead:** `cloister-fb1ac7`

**Files:**
- Move: `scripts/toml-to-cluster.mjs` → `cli/lib/cluster/toml-to-cluster.mjs`
- Move: `scripts/cluster-to-toml.mjs` → `cli/lib/cluster/cluster-to-toml.mjs`
- Move: `scripts/resolve-inputs.mjs` → `cli/lib/cluster/resolve-inputs.mjs`
- Move: `scripts/emit-cloister-capnp.mjs` → `cli/lib/cluster/emit-cloister-capnp.mjs`
- Move: `scripts/emit-compose.mjs` → `cli/lib/cluster/emit-compose.mjs`
- Move: `scripts/write-generated.mjs` → `cli/lib/atomic-write.mjs`
- Create: `cli/lib/cluster/generate.mjs`
- Modify: `cli/commands/cluster.mjs`
- Modify: `cli/commands/add.mjs`
- Modify: `cli/surface.mjs`
- Create/modify: compatibility wrappers at the six old script paths
- Modify: `scripts/gen-cli-docs.mjs`
- Modify: `Taskfile.yml`
- Modify: `scripts/test/cluster-toml-roundtrip.test.mjs`
- Modify: `scripts/test/resolve-inputs.test.mjs`
- Modify: `scripts/test/emit-cloister-capnp.test.mjs`
- Modify: `scripts/test/emit-compose.test.mjs`
- Modify: `scripts/test/cli-cluster.test.mjs`
- Modify: `test/integration/recipe-multi-tenant-instantiate.test.ts`

**Interfaces:**

```js
export async function generateClusterArtifacts({ root, check = false, env = process.env });
// -> { root, cluster, files: { toml, clusterTs, capnp, compose }, changed: string[] }

export async function resolveClusterInputs({ root, fetchImpl = fetch, log, errLog });
// -> { lockfilePath, resolvedCount }
```

`generateClusterArtifacts` computes every body before it writes any file and
uses `writeGeneratedFile` for each destination. It reads `cluster.toml` once,
validates once, and passes that object to all renderers. It does not import the
newly written `cluster.ts` back into Node.

- [ ] **Step 1: Write failing CLI generation tests**

Extend `scripts/test/cli-cluster.test.mjs` with a temporary cluster fixture and
assert:

```js
const result = await main(["generate", "--dir", root], deps);
assert.equal(result, 0);
assert.equal(readFileSync(join(root, "cluster.toml"), "utf8"), canonicalToml);
assert.ok(existsSync(join(root, "src/generated/cluster.ts")));
assert.ok(existsSync(join(root, "cloister.capnp")));
assert.ok(existsSync(join(root, "cluster.compose.yaml")));
```

Add a second run and assert all four outputs are byte-identical. Add `--check`
coverage that exits 1 on drift and writes nothing.

- [ ] **Step 2: Run the cluster tests and verify RED**

```sh
pnpm exec tsx --test scripts/test/cli-cluster.test.mjs scripts/test/cluster-toml-roundtrip.test.mjs
```

Expected: `generate` is not a recognized cluster subcommand.

- [ ] **Step 3: Move the pure generator implementations and export their CLI bodies**

Retain the existing pure exports (`parseTomlToCluster`, `renderClusterTs`,
`clusterToToml`, `buildLockfile`, `emitCloisterCapnp`, `emitCompose`). Replace
module-level repository roots and `process.exit` calls with arguments and typed
errors. Old script files become wrappers/re-exports; product code never imports
them.

Where a repository-only reverse export must load TypeScript on Node 20, use the
tsx API rather than assuming the process was started with a loader:

```js
import { tsImport } from "tsx/esm/api";
const mod = await tsImport(pathToFileURL(sourcePath).href, { parentURL: import.meta.url });
```

- [ ] **Step 4: Implement the one forward generation transaction**

`generateClusterArtifacts` performs:

```text
cluster.toml
  -> parseTomlToCluster + ClusterSchema validation
  -> renderClusterTs
  -> clusterToToml
  -> emitCloisterCapnp (with cluster.lock.toml when present)
  -> emitCompose (with lockfile OCI metadata when present)
  -> atomic writes, or comparisons only under --check
```

Failures name the input file and leave every prior destination intact.

- [ ] **Step 5: Add public commands and plain help**

Add:

```text
cloister cluster generate [--dir <path>] [--check]
cloister cluster resolve [--dir <path>]
```

Change skill pin guidance from `task cluster:toml` to
`cloister cluster generate`.

- [ ] **Step 6: Make the cluster Task aliases call the CLI**

Change these operator tasks to invoke `node bin/cloister.mjs`:

```yaml
cluster:toml:      node bin/cloister.mjs cluster generate --dir .
cluster:emit:      node bin/cloister.mjs cluster generate --dir .
cluster:resolve:   node bin/cloister.mjs cluster resolve --dir .
cluster:up:        node bin/cloister.mjs cluster up --dir .
cluster:down:      node bin/cloister.mjs cluster down --dir .
```

Repository drift tasks may import product renderers or run public `--check`;
they may not recreate the forward pipeline in shell.

- [ ] **Step 7: Run generation, drift, and source-of-truth tests**

```sh
pnpm exec tsx --test scripts/test/cli-cluster.test.mjs scripts/test/cluster-toml-roundtrip.test.mjs scripts/test/resolve-inputs.test.mjs scripts/test/emit-cloister-capnp.test.mjs scripts/test/emit-compose.test.mjs
node bin/cloister.mjs cluster generate --check --dir .
task test:cluster-toml
task test:emit-cloister-capnp
```

Expected: all pass and `git diff --exit-code -- cluster.toml src/generated/cluster.ts cloister.capnp cluster.compose.yaml` is clean.

- [ ] **Step 8: Commit first-party cluster generation**

```sh
git add bin cli scripts test Taskfile.yml cluster.toml src/generated/cluster.ts cloister.capnp cluster.compose.yaml docs/reference/cli.md
git commit -m "[cloister-fb1ac7] feat(cluster): generate declared artifacts through the CLI"
```

### Task 3: Make installation dependency-free and install a named compatibility provider

**Beads:** `cloister-fb1a73`, `cloister-8d8cb3`

**Files:**
- Modify: `bin/cloister.mjs`
- Create: `cli/commands/install.mjs`
- Create: `cli/commands/runtime.mjs`
- Create: `cli/lib/install-layout.mjs`
- Create: `cli/lib/runtime/provider-record.mjs`
- Create: `cli/lib/runtime/install-compatibility.mjs`
- Modify: `cli/index.mjs`
- Modify: `cli/surface.mjs`
- Modify: `cli/lib/runtime/compatibility-client.mjs`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `Taskfile.yml`
- Modify: `scripts/test/install.test.mjs`
- Modify: `scripts/test/cloister-cli.test.mjs`
- Test: `scripts/test/runtime-provider.test.mjs`

**Interfaces:**

```js
export function resolveInstallLayout({ env, home, checkoutRoot });
// -> { binDir, cliLink, libexecDir, providerRecord, nativeHelper, hostRuntime }

export async function installCompatibilityProvider({ root, layout, spawn, platform });
// -> RuntimeProviderRecord

export function readProviderRecord(layout);
export function resolveProviderArtifact(record, kind);
```

Provider record v1:

```json
{
  "schema": "cloister/runtime-provider/v1",
  "provider": "compatibility",
  "maturity": "experimental",
  "transport": "subprocess",
  "apiVersion": "cloister/compatibility-runtime/v1",
  "backends": ["nativeNonoCompatibility", "krunvmCompatibility"],
  "artifacts": {
    "nativeHelper": { "file": "cloister-harness", "sha256": "..." },
    "hostRuntime": { "file": "cloister-host-runtime", "sha256": "..." }
  }
}
```

Paths in the record are relative to its libexec directory. Every read verifies
the digest before execution.

- [ ] **Step 1: Strengthen the fresh-project test and verify RED**

Update `PROJECT_FILES` in `scripts/test/install.test.mjs` to include `bin/` and
`cli/`. Assert that `Taskfile.yml`'s `install` body is exactly a call to
`node bin/cloister.mjs install`, not a dependency plus shell-owned symlink.

Provide fake `pnpm` and `cargo` programs. The cargo fake writes both expected
binaries so the test exercises copy, digest, provider record, link, help, skill
list, cluster generation, and dry-run without compiling Rust.

Run:

```sh
pnpm exec tsx --test scripts/test/install.test.mjs
```

Expected: failure because `bin/cloister.mjs` has no bootstrap install path and
Task still owns the symlink.

- [ ] **Step 2: Special-case install before importing dependencies**

In `bin/cloister.mjs`, inspect only the first argument with built-ins. For
`install`, verify Node >=20 and execute the pinned package manager from
`package.json`:

```text
pnpm install --frozen-lockfile
```

Only after it succeeds, dynamically import `cli/commands/install.mjs`. For all
other commands, dynamically import `cli/index.mjs` as in Task 1.

Move `tsx` from `devDependencies` to `dependencies`: cluster generation calls
`tsx/esm/api` on Node 20, so it is runtime product code, not a test-only tool.
Keep Chalk and smol-toml as direct dependencies.

- [ ] **Step 3: Implement the compatibility provider installer**

Use exact Cargo invocations:

```text
cargo build --release --manifest-path tools/harness-sandbox/Cargo.toml
cargo build --release --manifest-path rs/Cargo.toml -p cloister-host-runtime
```

Copy, do not symlink:

```text
tools/harness-sandbox/target/release/cloister-harness
  -> $CLOISTER_LIBEXEC_DIR/cloister-harness
rs/target/release/cloister-host-runtime
  -> $CLOISTER_LIBEXEC_DIR/cloister-host-runtime
```

Default `CLOISTER_LIBEXEC_DIR` to `~/.local/libexec/cloister`. Write files via a
temporary sibling and rename. Set executable permissions. Compute SHA-256 after
copy. Write the provider record last so a partial install is never selected.

- [ ] **Step 4: Complete `cloister install`, `cloister uninstall`, and `cloister runtime install`**

`cloister install` runs, in order:

1. `cloister cluster generate --dir <checkout>`;
2. `installCompatibilityProvider`;
3. an idempotent symlink from `$CLOISTER_BIN_DIR/cloister` to `bin/cloister.mjs`;
4. the installed link with `--help`;
5. the installed link with a confined-run dry-run against the checkout;
6. a PATH hint when `$CLOISTER_BIN_DIR` is absent from PATH.

It refuses to overwrite an unrelated regular file. `cloister uninstall`
removes only a symlink resolving to this checkout and leaves libexec intact
unless the user explicitly asks for runtime repair/removal in a future command.

`cloister runtime install` performs only step 2.

- [ ] **Step 5: Resolve normal runtime commands only through the provider record**

`compatibility-client.mjs` stops probing `rs/target` and PATH. It selects:

1. `CLOISTER_HOST_RUNTIME_BIN`, only when explicitly set and executable;
2. the digest-verified `hostRuntime` in the provider record;
3. otherwise a `RuntimeNotInstalledError` rendered as:

```text
The execution runtime is not installed.
Run: cloister runtime install
```

The explicit override retains experimental status and never falls back.

- [ ] **Step 6: Make Task install/runtime aliases thin**

```yaml
install:        node bin/cloister.mjs install
uninstall:      node bin/cloister.mjs uninstall
runtime:build:  node bin/cloister.mjs runtime install
```

Remove `deps: [deps:node]` and the Task-owned symlink shell body from `install`.

- [ ] **Step 7: Run focused installer/provider tests**

```sh
pnpm exec tsx --test scripts/test/install.test.mjs scripts/test/runtime-provider.test.mjs scripts/test/cloister-cli.test.mjs
node bin/cloister.mjs runtime doctor --help
```

Expected: tests pass; no missing-provider message mentions Task or a source-tree
build target.

- [ ] **Step 8: Commit installation and provider packaging**

```sh
git add bin cli package.json pnpm-lock.yaml Taskfile.yml scripts/test
git commit -m "[cloister-fb1a73] feat(install): bootstrap and package the compatibility runtime"
```

### Task 4: Remove `task dev` and `tools/` from the normal run path

**Bead:** `cloister-8d5910`

**Files:**
- Create: `cli/commands/dev.mjs`
- Move: `scripts/dev-bootstrap.mjs` → `cli/lib/dev/bootstrap.mjs`
- Move/refactor: `scripts/config-source-check.mjs` → `cli/lib/dev/config-sources.mjs`
- Create: `cli/lib/dev/router.mjs`
- Modify: `cli/lib/harness/launch.mjs`
- Modify: `cli/lib/harness/types.mjs`
- Modify: `cli/commands/run.mjs`
- Move: `tools/harness-shim/` → `src/harness-shim/`
- Modify: `cli/index.mjs`
- Modify: `cli/surface.mjs`
- Modify: `Taskfile.yml`
- Modify: `test/routes/vault-proxy-lease-gate.test.ts`
- Modify: `test/routes/vault-proxy-dev-mode.test.ts`
- Move: `test/tools/harness-shim-lease-signer.test.ts` → `test/harness-shim/lease-signer.test.ts`
- Modify: `scripts/test/config-source-check.test.mjs`
- Modify: `scripts/test/cli-run.test.mjs`
- Modify: `scripts/test/cli-surface.test.mjs`
- Test: `scripts/test/cli-runtime-boundary.test.mjs`

**Interfaces:**

```js
export function loadLocalEnv(root, baseEnv = process.env);
export function assertConfigSourcesSafe(root);
export function startLocalRouter({ root, env, spawn });
// -> ChildProcess in its own process group

export async function bootstrapLocalDev({ root, env, fetchImpl, spawnSync, output });
```

- [ ] **Step 1: Write a failing executable-boundary test**

Create `scripts/test/cli-runtime-boundary.test.mjs`. Strip comments, inspect
product source, and assert:

```js
assert.doesNotMatch(launchSource, /spawn\(["']task["']/);
assert.doesNotMatch(launchSource, /tools\/harness-shim/);
assert.doesNotMatch(launchSource, /tools\/harness-sandbox\/target/);
```

Also exercise `launchSession` with an injected `spawn` and assert the router
call is:

```js
["pnpm", ["exec", "wrangler", "dev"]]
```

not `task dev`.

- [ ] **Step 2: Run the boundary test and verify RED**

```sh
pnpm exec tsx --test scripts/test/cli-runtime-boundary.test.mjs
```

Expected: all three source assertions fail on the current launch pipeline.

- [ ] **Step 3: Implement the first-party local router launcher**

Move the pure dotenv/config-source functions into `cli/lib/dev/`. Add
`loadLocalEnv` to merge `.env.local` into a child environment without shell
sourcing. Run the same shadow/conflict check before spawning.

`startLocalRouter` executes:

```text
pnpm exec wrangler dev
```

with `cwd: root`, the resolved environment, inherited stdio, and its own process
group. `launchSession` calls this function directly; it never spawns a CLI
subprocess or Task.

- [ ] **Step 4: Resolve the installed native helper before minting**

Replace the build-on-first-run branch in `resolveSandbox` with
`resolveProviderArtifact(record, "nativeHelper")`. Verify its SHA-256 and return
a `PreconditionError` before minting when absent or changed:

```text
The execution runtime is not installed or failed its digest check.
Run: cloister runtime install
```

Keep `CLOISTER_HARNESS_BIN` as an explicit development override with the same
fail-without-fallback behavior as the host-runtime override.

- [ ] **Step 5: Move the harness shim into shipped source**

Move the TypeScript shim and its local typecheck config under
`src/harness-shim/`. Update `launchSession` to execute:

```text
node --import tsx src/harness-shim/index.ts
```

Update all tests and Task typecheck paths. Normal execution no longer names a
path below `tools/`.

- [ ] **Step 6: Add first-party dev commands and Task aliases**

Add:

```text
cloister dev bootstrap [--dir <checkout>]
cloister dev serve [--dir <checkout>]
```

Make `task dev:bootstrap` and `task dev` call those commands. Change the missing
`.env.local` guidance to `cloister dev bootstrap`.

Make the harness aliases call the same run command:

```yaml
harness:dev:       node bin/cloister.mjs run --repo "$PWD" {{.CLI_ARGS}}
harness:dev:setup: node bin/cloister.mjs run --repo "$PWD" --setup-only {{.CLI_ARGS}}
```

Accept `--target` as a deprecated spelling of `--harness` only on this migration
path, print the replacement once, and keep everything after `--` verbatim.

- [ ] **Step 7: Run the launch and shim tests**

```sh
pnpm exec tsx --test scripts/test/cli-runtime-boundary.test.mjs scripts/test/cli-run.test.mjs scripts/test/config-source-check.test.mjs scripts/test/harness-targets.test.mjs scripts/test/confinement-shape.test.mjs
pnpm exec vitest run test/harness-shim/lease-signer.test.ts test/routes/vault-proxy-lease-gate.test.ts test/routes/vault-proxy-dev-mode.test.ts
task lint:harness-types
task lint:shim
```

Expected: all pass; source assertions prove the CLI does not execute `task` or
normal-runtime paths under `tools/`.

- [ ] **Step 8: Commit the first-party launch path**

```sh
git add cli src/harness-shim scripts test Taskfile.yml
git commit -m "[cloister-8d5910] refactor(run): remove Task and tools from normal execution"
```

### Task 5: Add one global output context and color the skills survey

**Bead:** `cloister-8d5910`

**Files:**
- Create: `cli/lib/global-options.mjs`
- Create: `cli/lib/output.mjs`
- Modify: `cli/index.mjs`
- Modify: `cli/surface.mjs`
- Modify: `cli/commands/skills.mjs`
- Modify: user-facing command modules under `cli/commands/`
- Modify: `scripts/gen-cli-docs.mjs`
- Modify: `docs/reference/cli.md` (generated)
- Create: `scripts/test/cli-output.test.mjs`
- Create: `scripts/test/cli-skills.test.mjs`
- Modify: `scripts/test/cloister-cli.test.mjs`
- Modify: `scripts/test/cli-surface.test.mjs`
- Modify: `Taskfile.yml`

**Interfaces:**

```js
export function parseGlobalOptions(argv, env = process.env);
// -> { argv, colorMode: "auto" | "always" | "never", explicitColor: boolean }

export function createOutputContext({ stdout, stderr, env, colorMode, json = false });
// -> { log, error, style, colorEnabled, json }

export function classifySkill(skill);
export function sortSkillsForDisplay(survey);
export function renderSkillsList(survey, { output, skillsDir });
```

- [ ] **Step 1: Write failing global-option tests**

Cover all of these exact vectors in `scripts/test/cli-output.test.mjs`:

```js
["--color", "never", "skills", "list"]
["skills", "--color", "always", "list"]
["skills", "list", "--no-color"]
["run", "--repo", repo, "--", "--color", "always"]
```

The first three remove only Cloister's global flags. The fourth leaves both
tokens after `--` untouched. Invalid/missing `--color` values exit 2 with the
accepted values.

Test output with TTY and non-TTY stream doubles, `NO_COLOR=1`,
`FORCE_COLOR=1`, explicit `always`, explicit `never`, and `json: true`. Assert
ANSI with `/\x1b\[/` only where allowed.

- [ ] **Step 2: Run output tests and verify RED**

```sh
pnpm exec tsx --test scripts/test/cli-output.test.mjs
```

Expected: modules do not exist.

- [ ] **Step 3: Implement global option extraction and Chalk context**

Scan only tokens before the first `--`. Support `--color auto|always|never` and
`--no-color`. Explicit `always` overrides `NO_COLOR`; explicit `never` always
wins. In auto mode, a non-TTY or `NO_COLOR` disables style. When no CLI color
option is present, preserve Chalk-compatible `FORCE_COLOR` levels.

Instantiate `new Chalk({ level })` inside the output context; do not mutate the
process-global Chalk instance. `cli/surface.mjs` remains plain data and never
imports Chalk.

- [ ] **Step 4: Write failing skill-order/render tests**

Create a 24-row survey with unsorted names in all four states. Assert display
groups and style calls in this order:

```text
CHANGED    bold red
unpinned   yellow
undeclared dim
pinned     green
```

Names sort alphabetically within each group. Digests are dim. At 21+ rows the
same summary appears before and after; at 20 rows it appears only after.
Changed rows still return exit 1 with color disabled.

- [ ] **Step 5: Implement skill classification and rendering**

Keep `surveySkills` and the TOML append-only pin behavior unchanged. Add pure
classification/sort/render helpers. Replace both `task cluster:toml` follow-up
messages with `cloister cluster generate`.

- [ ] **Step 6: Thread the output context through commands**

Pass one context from `cli/index.mjs`. Human renderers use it. Existing
machine-readable commands set `json: true` before rendering; never style JSON.
Do not add `skills list --json` in this phase.

- [ ] **Step 7: Regenerate docs and run focused tests**

```sh
node scripts/gen-cli-docs.mjs
pnpm exec tsx --test scripts/test/cli-output.test.mjs scripts/test/cli-skills.test.mjs scripts/test/cloister-cli.test.mjs scripts/test/cli-surface.test.mjs
node bin/cloister.mjs --color never skills list
NO_COLOR=1 node bin/cloister.mjs skills list
task cli:docs:check
```

- [ ] **Step 8: Commit output and skill DX**

```sh
git add cli scripts/test scripts/gen-cli-docs.mjs docs/reference/cli.md Taskfile.yml
git commit -m "[cloister-8d5910] feat(cli): add global color and readable skill states"
```

### Task 6: Make compatibility storage status neutral and strictly read-only

**Bead:** `cloister-8d8cb3`

**Files:**
- Modify: `rs/crates/host-runtime/src/krunvm.rs`
- Modify: `rs/crates/host-runtime/src/main.rs`
- Modify: `rs/crates/host-runtime/tests/cli.rs`
- Create: `rs/crates/host-runtime/tests/status_read_only.rs`
- Modify: `cli/lib/runtime/compatibility-client.mjs`
- Modify: `cli/commands/runtime.mjs`
- Modify: `cli/surface.mjs`
- Modify: `scripts/test/cloister-cli.test.mjs`
- Test: `scripts/test/runtime-status.test.mjs`

**Rust interfaces:**

```rust
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStorageStatus {
    pub schema: &'static str,
    pub provider: &'static str,
    pub maturity: &'static str,
    pub state: StorageState,
    pub backend: &'static str,
    pub storage_volume: String,
    pub capacity: Option<StorageCapacity>,
    pub tracked_runs: usize,
    pub running_runs: usize,
}

pub fn status(&self) -> Result<RuntimeStorageStatus, RuntimeError>;
```

Schema is `cloister/runtime-storage-status/v1`; compatibility provider values
are `compatibility`, `experimental`, and `krunvmCompatibility`.

- [ ] **Step 1: Write the read-only Rust tests**

`status_read_only.rs` must cover:

1. a nonexistent nested storage path returns `notPrepared`, `capacity: null`,
   and exit success;
2. the nested path, lock file, and state file still do not exist afterward;
3. an existing empty directory returns `prepared`, measured capacity, and zero
   tracked/running runs;
4. an existing state file reports counts without modifying its metadata or
   contents.

- [ ] **Step 2: Run Rust tests and verify RED**

```sh
cargo test --manifest-path rs/Cargo.toml -p cloister-host-runtime --test status_read_only
```

Expected: the nonexistent path fails because `StateLock::acquire` calls
`create_dir_all` and opens a create-enabled lock file.

- [ ] **Step 3: Split observational reads from mutating locks**

Keep `StateLock::acquire` for launch and GC. `status()` must first use
`try_exists`/metadata. If absent, return `notPrepared` immediately. If present,
read the atomically replaced state file and call `statvfs`; do not create or
open the lock file. Atomic state replacement already prevents partial JSON
reads, so status does not need an exclusive lock.

Rename public fields from VM-specific terms to run-neutral terms. Keep the
private persisted krunvm schema unchanged for compatibility.

- [ ] **Step 4: Add structured compatibility-client calls**

Add:

```js
export function runCompatibilityJson(args, { env, spawnSync });
```

Capture stdout/stderr, parse stdout exactly once, and return a typed result.
Never infer state from stderr text. Unknown failures retain command, provider,
status, signal, stderr, and the spawn error.

- [ ] **Step 5: Render human and JSON status**

`cloister runtime storage status --json` writes the versioned object and no
commentary. Human `notPrepared` output is:

```text
Runtime storage is not prepared.
Provider: compatibility (experimental)
Backend: krunvm compatibility
Run: cloister runtime storage init
```

Exit 0. Prepared output reports capacity and tracked/running run counts.

`runtime doctor` reports provider, maturity, transport, backends, digest status,
and storage state. It does not imply libkrun embedding or LLO receipts.

- [ ] **Step 6: Run Rust and JavaScript status tests**

```sh
cargo test --manifest-path rs/Cargo.toml -p cloister-host-runtime
pnpm exec tsx --test scripts/test/runtime-status.test.mjs scripts/test/cloister-cli.test.mjs
```

- [ ] **Step 7: Commit read-only neutral status**

```sh
git add rs/crates/host-runtime cli scripts/test
git commit -m "[cloister-8d8cb3] fix(runtime): make storage status read-only and neutral"
```

### Task 7: Finish Task delegation and add a permanent product-boundary rail

**Beads:** `cloister-8d5910`, `cloister-fb1ac7`

**Files:**
- Modify: `Taskfile.yml`
- Create: `scripts/test/cli-boundary.test.mjs`
- Modify: `scripts/test/cli-surface.test.mjs`
- Modify: `scripts/test/gate-integrity.test.mjs`
- Modify: `scripts/README.md`
- Modify: `cli/commands/artifacts-pull.mjs`
- Modify: `cli/index.mjs`

**Operator task allowlist:**

```text
install
uninstall
dev:bootstrap
dev
init
add
inputs:pull
cluster:toml
cluster:emit
cluster:resolve
cluster:up
cluster:down
harness:dev
harness:dev:setup
runtime:plan
runtime:build
runtime:doctor
runtime:run
runtime:storage:init
runtime:storage:status
runtime:storage:gc
```

- [ ] **Step 1: Write the failing Taskfile delegation test**

Extract each named YAML task body by indentation. Assert it contains
`bin/cloister.mjs` and contains neither `scripts/` nor `tools/`. Keep developer
checks, generators' drift checks, migrations, and benchmarks outside this
allowlist.

Run:

```sh
pnpm exec tsx --test scripts/test/cli-boundary.test.mjs
```

Expected: RED on `init`, `add`, `inputs:pull`, runtime plan/storage, and any
remaining direct script task.

- [ ] **Step 2: Delegate the remaining aliases**

Map every allowlisted task to the public command. Preserve `CLI_ARGS` and safe
defaults. In particular:

```yaml
init:                   node bin/cloister.mjs init {{.CLI_ARGS | default "--help"}}
add:                    node bin/cloister.mjs add {{.CLI_ARGS | default "--help"}}
inputs:pull:            node bin/cloister.mjs artifacts pull {{.CLI_ARGS}}
runtime:plan:           node bin/cloister.mjs runtime plan {{.CLI_ARGS | default "--help"}}
runtime:doctor:         node bin/cloister.mjs runtime doctor {{.CLI_ARGS}}
runtime:run:            node bin/cloister.mjs runtime run {{.CLI_ARGS}}
runtime:storage:init:   node bin/cloister.mjs runtime storage init {{.CLI_ARGS | default "--help"}}
runtime:storage:status: node bin/cloister.mjs runtime storage status {{.CLI_ARGS}}
runtime:storage:gc:     node bin/cloister.mjs runtime storage gc {{.CLI_ARGS | default "--print"}}
```

Remove runtime build dependencies that silently mutate before `doctor` or
`status`; those commands report readiness through the provider record.

- [ ] **Step 3: Add the product-source rail**

Recursively scan `bin/` and `cli/`, stripping comments before assertions:

- no static/dynamic import resolves into `scripts/` or `tools/`;
- no spawn/exec program is `task`;
- no spawned argument names a file below `scripts/`;
- no normal command names a file below `tools/`;
- only `cli/lib/runtime/install-compatibility.mjs` may contain the literal
  `tools/harness-sandbox`, and only in Cargo build/source-copy arguments;
- the compatibility client does not contain the literal `krunvm`; only the
  installed Rust provider may invoke that program during this phase.

Add `cli-boundary.test.mjs`, `cli-output.test.mjs`, `cli-skills.test.mjs`,
`runtime-provider.test.mjs`, and `runtime-status.test.mjs` to
`test:lint-scripts`. Update gate-integrity expectations so a newly added test
cannot be silently omitted.

- [ ] **Step 4: Run boundary and Taskfile tests**

```sh
pnpm exec tsx --test scripts/test/cli-boundary.test.mjs scripts/test/cli-surface.test.mjs scripts/test/gate-integrity.test.mjs
task test:lint-scripts
```

- [ ] **Step 5: Commit delegation and rails**

```sh
git add Taskfile.yml cli scripts/test scripts/README.md
git commit -m "[cloister-8d5910] refactor(task): delegate operator flows to the CLI"
```

### Task 8: Validate a real clean install and confinement boundary in a Linux image

**Bead:** `cloister-fb1a73`

**Files:**
- Create: `.dockerignore`
- Create: `test/install-image/Dockerfile`
- Modify: `tools/harness-sandbox/test/cloister-harness-binary.test.mjs`
- Modify: `Taskfile.yml`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Make the binary conformance test selectable by installed path**

Read:

```js
const BIN = process.env.CLOISTER_HARNESS_BIN ?? sourceTreeDefault;
const REQUIRE = process.env.CLOISTER_REQUIRE_CONFINEMENT === "1";
```

Add a non-skipped prerequisite assertion when `REQUIRE` is true. If the host
cannot apply Landlock/nono, fail with the existing named probe reason instead of
turning the whole image green through skips.

- [ ] **Step 2: Add a clean Docker context**

`.dockerignore` excludes at least:

```text
.git
node_modules
.pnpm-store
.task
.wrangler
.env.local
.dev.vars
.fastembed_cache
dist
rs/target
tools/*/target
cloister*.tar
```

The Dockerfile uses `node:20-bookworm`, copies the Rust 1.95 toolchain from
`rust:1.95-bookworm`, and copies the Task 3.49.1 binary from
`ghcr.io/go-task/task:3.49.1`. Install only the OS build prerequisites needed by
the two Rust compatibility binaries (`build-essential`, `pkg-config`,
`libdbus-1-dev`, `git`, and CA certificates).

- [ ] **Step 3: Make the image execute the real onboarding path**

Inside the image:

```text
test ! -e node_modules
corepack enable
corepack prepare pnpm@10.30.3 --activate
task install
$CLOISTER_BIN_DIR/cloister --help
$CLOISTER_BIN_DIR/cloister skills list --dir /workspace
$CLOISTER_BIN_DIR/cloister cluster generate --check --dir /workspace
$CLOISTER_BIN_DIR/cloister run --harness claude-code --repo /workspace --dry-run
CLOISTER_HARNESS_BIN=$CLOISTER_LIBEXEC_DIR/cloister-harness \
  CLOISTER_REQUIRE_CONFINEMENT=1 \
  node --test tools/harness-sandbox/test/cloister-harness-binary.test.mjs
```

Before the install, assert Chalk, smol-toml, and tsx are absent. After the real
frozen install, import all three by package name. This is the undeclared-direct-
dependency regression check that the current source-node_modules shim cannot
provide.

- [ ] **Step 4: Add the image task and verify locally**

```yaml
test:install:image:
  cmds:
    - docker build --file test/install-image/Dockerfile --tag cloister-install-test:local .
```

Run:

```sh
task test:install:image
```

Expected: build succeeds from a context containing no dependency/build caches;
the installed confinement test either passes or fails with one named kernel
prerequisite. It must not skip silently.

- [ ] **Step 5: Add a dedicated CI job**

Add `install-image` to `.github/workflows/ci.yml`, after checkout only, with a
15-minute timeout and `task test:install:image`. Use the existing SHA-pinned
checkout and setup-task actions. Keep the job separate from the fast lint job so
Docker layer/build time does not hide unit-test feedback.

- [ ] **Step 6: Commit the clean-image gate**

```sh
git add .dockerignore test/install-image tools/harness-sandbox/test Taskfile.yml .github/workflows/ci.yml
git commit -m "[cloister-fb1a73] test(install): prove onboarding in a clean Linux image"
```

### Task 9: Tune onboarding and runtime maturity language, then verify the branch

**Beads:** `cloister-8d5910`, `cloister-8d8cb3`, `cloister-fb1a73`, `cloister-fb1ac7`

**Files:**
- Modify: `README.md`
- Modify: `docs/RUNNING.md`
- Modify: `cli/surface.mjs`
- Modify: `docs/reference/cli.md` (generated)
- Modify: `scripts/README.md`
- Modify: `src/harness-shim/README.md`
- Modify: `docs/reference/bundle-topology.md` only if a link needs correction; preserve its current work-board boundary
- Modify: `docs/superpowers/specs/2026-07-31-first-party-cli-design.md`

- [ ] **Step 1: Rewrite the first screen of README around the installed CLI**

The first runnable block is:

```sh
git clone https://github.com/agentic-research/cloister.git
cd cloister
task install
cloister --help
cloister run --harness claude-code --repo /absolute/path --dry-run
```

Explain in plain language that Task is needed only for the source-checkout
install shortcut; the installed product is `cloister`.

- [ ] **Step 2: Show arbitrary-skill adoption through first-party commands**

Keep the existing arbitrary `SKILL.md` example, then use only:

```sh
cloister skills list --dir . --state-dir ~/.claude
cloister skills pin --dir . --state-dir ~/.claude --write
cloister cluster generate --dir .
```

Explain `CHANGED`, unpinned, undeclared, and pinned without assuming the reader
knows "digest", "manifest", or "projection". Introduce the fingerprint term
only after the plain explanation.

- [ ] **Step 3: Describe the recorder honestly**

Add a short "What Cloister records" section explaining:

- the dry-run boundary;
- `.harness-skills.json` and each loaded skill's fingerprint/state;
- runtime/provider identity and future receipt linkage;
- current denials are visible to the coding tool and tests, but Cloister does
  not yet record every attempted file, environment-variable, or network access.

Do not imply VM-host confidentiality, continuous skill verification, complete
access-attempt recording, or finished LLO receipts.

- [ ] **Step 4: Replace internal Task/runtime instructions**

README, RUNNING, help, and errors use:

```text
cloister dev bootstrap
cloister runtime install
cloister runtime doctor
cloister runtime storage init|status|gc
cloister cluster generate|resolve
```

Label both current backends:

- `native+nono compatibility` — experimental subprocess adapter;
- `krunvm compatibility` — experimental external `krunvm` adapter.

State that LLO will own the native+nono and libkrun+nono implementation and the
neutral execution receipts. This is a migration statement, not a claim that
those LLO surfaces already ship.

- [ ] **Step 5: Preserve the work-board decision**

Verify `docs/reference/bundle-topology.md` still says
`agents/work-board` is a separate local UI, has no MCP/server contract, and is
therefore not a Cloister bundle today. Do not add it to `cluster.toml` merely
because it can be served beside Cloister.

- [ ] **Step 6: Regenerate CLI reference and run documentation checks**

```sh
node scripts/gen-cli-docs.mjs
task cli:docs:check
node scripts/lint-doc-links.mjs
git diff --check
```

- [ ] **Step 7: Run the focused final verification**

```sh
pnpm exec tsx --test scripts/test/install.test.mjs scripts/test/cli-boundary.test.mjs scripts/test/cli-output.test.mjs scripts/test/cli-skills.test.mjs scripts/test/runtime-provider.test.mjs scripts/test/runtime-status.test.mjs scripts/test/cloister-cli.test.mjs scripts/test/cli-surface.test.mjs scripts/test/cli-run.test.mjs scripts/test/cli-cluster.test.mjs
cargo test --manifest-path rs/Cargo.toml -p cloister-host-runtime
node bin/cloister.mjs cluster generate --check --dir .
task test:install:image
```

Then run the repository gate from a clean worktree/image so local ignored secret
files cannot influence it:

```sh
task lint
```

Expected: all focused tests, image validation, and the full lint gate pass;
`git diff --check` is clean; only the known user-local `.fastembed_cache/`
remains untracked in the original checkout.

- [ ] **Step 8: Commit documentation and final generated output**

```sh
git add README.md docs/RUNNING.md docs/reference/cli.md docs/reference/bundle-topology.md docs/superpowers/specs/2026-07-31-first-party-cli-design.md cli/surface.mjs scripts/README.md src/harness-shim/README.md
git commit -m "[cloister-8d5910] docs(onboarding): explain the first-party CLI in plain language"
```

- [ ] **Step 9: Record implementation evidence without closing beads**

Comment the relevant Cloister beads with commit hashes, focused test commands,
the clean-image result, and any remaining platform limitation. Leave them open
for the reconciler, per this repository's AGENTS.md.

The next plan is `cloister-903b5f`, written only after
`ley-line-open-d7abd6` publishes the pinned neutral schema, generated TypeScript
client, lifecycle error model, and provider conformance vectors.
