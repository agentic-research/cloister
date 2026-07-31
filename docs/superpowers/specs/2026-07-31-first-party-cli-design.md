# First-party Cloister CLI

**Status:** Revised after LLO boundary review; awaiting written-spec approval
**Bead:** `cloister-844fb5`
**Date:** 2026-07-31

## Purpose

Cloister's installed command must own the complete user experience. A user may
choose to enter through `task`, but Task must only call the same `cloister`
command they could run directly.

Today that contract is false in several places:

- `package.json` installs `scripts/cloister-cli.mjs` as the executable;
- user-facing command implementations and shared launch code live in
  `scripts/`;
- confinement programs used by normal runs live in `tools/`;
- some Taskfile entries call implementation scripts directly;
- a missing native runtime tells an installed user to run
  `task runtime:build` inside a source checkout;
- `runtime storage status` tries to create `/Volumes/krunvm`, so asking for
  status can fail with a permission error before reporting that storage has not
  been initialized;
- skill status is difficult to scan when the machine has many local skills.

This design makes the CLI Cloister's product boundary and makes
ley-line-open (LLO) the execution boundary. Native process isolation, nono,
libkrun, and the capability-scoped CAS/CDC filesystem are LLO responsibilities,
not temporary new homes inside Cloister. Existing Cloister runtime code is a
migration source until the generated LLO execution API replaces it.

## Goals

1. Put every user-facing command and its shared runtime code under an explicit
   first-party CLI directory.
2. Make Taskfile operator tasks delegate to `cloister` instead of implementing
   behavior or calling implementation scripts.
3. Give every human-readable command consistent color behavior, with one global
   way to turn color off.
4. Make `runtime storage status` read-only and useful before storage exists.
5. Replace source-tree instructions such as `task runtime:build` with
   first-party CLI instructions.
6. Keep machine-readable output stable and free of terminal color codes.
7. Consume LLO's neutral execution API without teaching LLO about Cloister,
   Rosary, coding harnesses, or billing/authentication modes.
8. Keep `cluster.toml` authoritative and regenerate every derived runtime and
   cluster artifact through first-party Cloister commands.

## Non-goals

- Rewriting the JavaScript CLI in Rust.
- Defining LLO's neutral execution schema in the Cloister repository.
- Implementing a new generic native+nono or libkrun+nono backend in Cloister.
- Exposing arbitrary executable paths, host directories, or raw secrets to an
  LLO native, UDS, CLI, or MCP execution surface.
- Turning repository-only generators, linters, benchmarks, or migrations into
  public CLI commands.

## Dependency direction and ownership

The dependency direction is one-way:

```text
Rosary
  -> uses the Cloister CLI or native consumer API

Cloister
  -> owns harness policy, auth, audit mode, receipts presented to users,
     cluster configuration, and the human-facing CLI
  -> consumes the generated LLO execution API

LLO
  -> owns the neutral RunSpec and lifecycle schema
  -> owns native process + nono and libkrun microVM + nono backends
  -> owns capability-scoped CAS/CDC workspaces and execution receipts
```

Rosary never calls LLO directly for a Cloister run. LLO never imports or names
Rosary beads, Claude Code, Max/Pro subscriptions, Cloister harness names, or
Cloister audit modes. Cloister translates its declared policy into a
capability-bound LLO request and translates neutral LLO results into plain,
useful CLI output.

This direction supersedes the ownership proposed by ADR-0049. That ADR must be
amended before implementation: its useful composition model remains, but the
composed native runtime belongs in LLO. Cloister owns the policy adapter and
consumer conformance, not a parallel host-runtime implementation.

## Directory layout

The target layout is:

```text
bin/
  cloister.mjs                  dependency-free installed entrypoint
cli/
  index.mjs                     command routing and global options
  commands/                     user-facing command implementations
  lib/                          output, cluster generation, and LLO client code
src/harness-shim/               shipped workerd shim, moved from tools/
scripts/                        code generation, lint, migration, and benchmarks
tools/                          experiments that normal Cloister commands never run
```

`bin/cloister.mjs` is intentionally small. It uses only Node built-ins, handles
the dependency-free install path, and then loads `cli/index.mjs` for normal
commands. This matters on a fresh checkout: the installer must be runnable
before Chalk, smol-toml, or any other package has been installed.

At the target boundary, the CLI must not import from `scripts/` or `tools/`. It
also must not execute the transitional `tools/harness-sandbox`, invoke
`krunvm`, or use Cloister's current host-runtime. A source check will enforce
that rule once LLO adoption lands; the installer-only compatibility exception
below is allowed before then. Code used by both a repository check and the
product belongs in a neutral product module; the check may import the product
module, never the other way around.

`scripts/` and `tools/` do not have to be empty. Their boundary is whether a
normal `cloister` command imports, executes, or requires the file. Existing
native experiments may remain under `tools/` as historical proofs, but they are
never installed or run by the target product. During migration, the sole
temporary exception is that `cloister install` may build the named compatibility
adapter from its current source location and copy the result to `libexec`;
normal runs execute that installed artifact, not a path inside `tools/`.

## Working-main and maturity contract

The migration must not create a period where `main` describes a future runtime
but cannot run Cloister today. Every landing step must preserve this clean-clone
path:

```text
task install
cloister --help
cloister skills list
cloister run --harness claude-code --repo /absolute/path --dry-run
```

On supported hosts, `task install` must also leave a real confined native run
available. Until LLO publishes the generated execution API and native+nono
provider, Cloister may package its current subprocess-backed implementation as
an **experimental compatibility adapter**. It must fail closed, remain behind
the same first-party CLI, and be replaced in place rather than forcing users to
learn another command.

The current maturity is visible in `cloister runtime doctor`, `--help`, README,
and RUNNING.md:

- `native+nono compatibility` is experimental because Cloister currently
  starts a separate confinement process;
- `krunvm compatibility` is experimental because Cloister shells out to the
  `krunvm` program instead of consuming LLO's libkrun backend;
- kernel denials that have passing tests are described as verified behavior;
- VM-host confidentiality, complete access-attempt recording, and unfinished
  LLO receipt behavior are never implied.

This compatibility allowance is temporary and explicit. It does not change the
target ownership: new generic execution behavior is implemented in LLO, not in
the compatibility adapter.

## Installation commands

### `cloister install`

The dependency-free entrypoint owns installation from a source checkout:

1. verify Node and pnpm are available;
2. install the exact dependencies in `pnpm-lock.yaml`;
3. regenerate and validate derived cluster artifacts from the authoritative
   `cluster.toml`;
4. install the runtime provider required by `cloister run`: the pinned LLO
   native+nono provider when available, otherwise the explicitly experimental
   compatibility adapter;
5. create or update the CLI link in `CLOISTER_BIN_DIR` (default
   `~/.local/bin`);
6. run `cloister --help` and a dry-run through the installed link as smoke
   checks;
7. explain how to add the destination to `PATH` when needed.

The default helper directory is `~/.local/libexec/cloister`. It can be changed
with `CLOISTER_LIBEXEC_DIR`. The CLI records no absolute helper path in shared
configuration; it resolves the per-machine install directory at launch.

An execution provider is required because `cloister run` is confined by
default. If none is installed, `cloister run` points to `cloister install`. It
never falls back to an unconfined run. Installation records the provider's
digest, API version, backend, transport, and maturity so `runtime doctor` can
explain what this machine will actually use.

It is idempotent and refuses to overwrite an unrelated regular file.

`task install` becomes only:

```yaml
cmds:
  - node bin/cloister.mjs install
```

### `cloister runtime install`

`cloister runtime install` installs or repairs the execution provider without
reinstalling the JavaScript dependencies or CLI link. The microVM backend
remains optional; native+nono is enough for a working default installation.

The target path resolves the pinned LLO input from `cluster.toml` and
`cluster.lock.toml`, installs a signed, digest-checked provider, and places only
machine-local launch metadata in the CLI-owned `libexec` directory. During the
transition, the command may build and install the existing Cloister adapter
from source, but it labels that result experimental and never represents it as
the LLO implementation.

Provider selection is deterministic. An explicit development override is used
only when valid and otherwise fails without fallback. Next, a digest-pinned LLO
package is selected only when its resolved metadata advertises the required
execution capability and API version. Until that capability is present, the
installer selects the named compatibility adapter. Merely finding a binary on
`PATH` never changes the selected provider.

When a runtime provider is missing, any `cloister runtime ...` command prints:

```text
The execution runtime is not installed.
Run: cloister runtime install
```

It must not mention `task runtime:build`.

The existing `CLOISTER_HOST_RUNTIME_BIN` override is transitional developer
surface, not part of the stable CLI. While it exists, selecting it prints the
experimental-adapter notice; an invalid explicit path is an error and never
falls back silently. LLO's generated API does not accept an executable path or
host directory as a substitute for a capability-bound request.

## Taskfile contract

Operator-facing tasks are aliases onto public commands:

| Task | Command |
| --- | --- |
| `task install` | `node bin/cloister.mjs install` |
| `task init` | `cloister init` |
| `task add` | `cloister add` |
| `task cluster:toml` | `cloister cluster generate` |
| `task cluster:resolve` | `cloister cluster resolve` |
| `task cluster:up` | `cloister cluster up` |
| `task cluster:down` | `cloister cluster down` |
| `task harness:dev` | `cloister run --repo "$PWD"` plus the supplied CLI arguments |
| `task harness:dev:setup` | `cloister run --repo "$PWD" --setup-only` |
| `task runtime:build` | `cloister runtime install` |
| `task runtime:doctor` | `cloister runtime doctor` |
| `task runtime:run` | `cloister runtime run` |
| `task runtime:storage:init` | `cloister runtime storage init` |
| `task runtime:storage:status` | `cloister runtime storage status` |
| `task runtime:storage:gc` | `cloister runtime storage gc` |

Repository checks may continue to invoke files in `scripts/`; those files are
developer automation, not runtime product code. The distinction is enforced by
a test that classifies operator-facing tasks and rejects direct calls from
those tasks into `scripts/` or `tools/`.

`cloister cluster generate` owns the forward path from `cluster.toml` to
`src/generated/cluster.ts`, canonical `cluster.toml`, and derived
`cloister.capnp`. `cloister cluster resolve` owns the content-addressed
`cluster.lock.toml` update. Task aliases may invoke those commands, but no
operator flow treats generated TypeScript or Cap'n Proto as the source of
truth.

This subsumes the intent of `cloister-de4c78`: launch code must no longer spawn
`task dev`. The CLI starts the required service directly, while the Taskfile
calls the CLI.

## Global output and color contract

Chalk is already a direct dependency and becomes the one color implementation
for CLI output.

The global forms are:

```text
cloister --color auto <command> ...
cloister --color always <command> ...
cloister --color never <command> ...
cloister --no-color <command> ...
NO_COLOR=1 cloister <command> ...
```

Global color flags are accepted before or after the command, up to the `--`
separator that begins arguments for a launched coding tool. `--no-color` is an
alias for `--color never`.

Behavior:

- `auto` is the default and colors only an interactive terminal;
- `NO_COLOR` disables color unless the user explicitly requests
  `--color always`;
- `FORCE_COLOR` retains Chalk's standard behavior when no explicit CLI color
  option is present;
- redirected or piped output contains no color in `auto` mode;
- `--json` output never contains color, regardless of the color setting;
- color adds emphasis but never carries information that is absent from text.

The global option parser removes only recognized global options and passes all
remaining arguments unchanged to the selected command. It stops at `--`, so a
coding tool receives its own color options untouched.

## `cloister skills list`

The command remains complete: it does not hide undeclared skills by default.
Rows are grouped by attention priority and sorted by name within each group:

1. `CHANGED` — bold red;
2. `unpinned` — yellow;
3. `undeclared` — dim, so a large set does not dominate the screen;
4. `pinned` — green.

The text labels remain present with color disabled. For more than 20 skills,
the summary appears before and after the rows so a user can see the overall
state before scrolling. For 20 or fewer, it appears once after the rows. A
changed skill still causes exit status 1; color never changes exit behavior.

The skill digest is dimmed in human output. This phase does not add
`cloister skills list --json`; that can be added separately without changing
the survey data model.

## Runtime command behavior

### Human output and JSON

`cloister runtime doctor` and `cloister runtime storage status` render concise,
human-readable output by default. `--json` returns a versioned, backend-neutral
Cloister projection without styling or commentary. It does not expose a Rust
implementation type or make `krunvm` part of the public contract.

The JavaScript CLI translates generated LLO error codes into direct next steps.
The compatibility adapter translates its current typed failures into the same
internal result, so command renderers do not parse shell error text. Unknown
errors retain the provider, operation, and cause and exit non-zero; the CLI
must not hide diagnostic detail.

### Read-only storage status

`cloister runtime storage status` must not create a directory, mount a volume,
create a lock file, or mutate runtime state.

The public status object is not named after krunvm. Capacity is `null` when no
mounted filesystem or prepared LLO workspace store exists; zero would falsely
claim that a zero-byte store was inspected. During migration the compatibility
adapter emits this same neutral envelope:

```json
{
  "schema": "cloister/runtime-storage-status/v1",
  "provider": "compatibility",
  "maturity": "experimental",
  "state": "notPrepared",
  "backend": "krunvmCompatibility",
  "capacity": null,
  "trackedRuns": 0,
  "runningRuns": 0
}
```

Reporting `notPrepared` is a successful status query and exits 0. Human
output says:

```text
Runtime storage is not prepared.
Run: cloister runtime storage init
```

When the compatibility mount exists but no state file exists, status reports a
prepared empty store with measured capacity and zero tracked runs. It may take
a shared lock only when the lock already exists; it may not create the mount,
lock, or state merely to answer a question.

`cloister runtime storage init` is the only compatibility command that creates
or attaches the current storage volume. In the LLO-backed path, the equivalent
mutating operation is `runtime_prepare`. Neither status path may prepare,
provision, mount, acquire, or repair as a side effect.

## LLO execution contract

LLO owns one neutral, versioned execution schema. Its core request is a
capability-bound `RunSpec` containing:

- a content-addressed artifact reference, entrypoint, and argument vector;
- a workspace grant and arena head;
- `nativeNono` or `krunNono` isolation;
- explicit filesystem, network, and resource grants;
- opaque secret references, never raw secret bytes; and
- a receipt destination.

The lifecycle is:

```text
runtime_prepare
runtime_start
runtime_status
runtime_wait
runtime_cancel
runtime_events
runtime_receipt
```

LLO's schema-bridge source generates the Rust types, JSON Schema, MCP tools, and
TypeScript and Go bindings. Native Rust, UDS, CLI, and MCP transports reach the
same implementation and conform to the same vectors. Cloister consumes the
pinned generated TypeScript/native client; it does not hand-maintain a second
copy of `RunSpec` or the lifecycle errors.

Because `runtime_start` is an execution primitive, every transport—especially
MCP—requires a signed or capability-bound `RunSpec`. It never accepts
"executable path plus host directory." Cloister may accept a human-friendly
repository path, harness name, and tool arguments at its CLI, but it resolves
them into granted content-addressed artifacts, workspace capabilities, and
declared entrypoints before calling LLO.

## Cloister policy adapter and data flow

The JavaScript CLI talks through one `LloExecutionClient` interface. Generated
native and UDS clients are production transports. The subprocess-backed
compatibility adapter implements the same Cloister-side interface only during
migration and always reports its experimental maturity.

A run flows as follows:

1. Cloister reads the authoritative `cluster.toml` plus its resolved lockfile.
2. The selected harness declaration supplies policy, entrypoint identity, auth
   modes, environment scrubbing, and audit behavior.
3. Cloister resolves the requested repository, artifact, skills, network
   access, and secret handles into explicit grants; it does not pass ambient
   host paths or credentials through.
4. Cloister builds and authorizes the neutral `RunSpec` using generated LLO
   types.
5. LLO prepares and starts the selected `nativeNono` or `krunNono` backend and
   serves only the granted LLO Graph workspace. The raw SQLite arena is never
   mounted into the process or guest.
6. Cloister follows status, wait, cancellation, and event streams through the
   same client interface and renders human or JSON output.
7. LLO emits a signed execution receipt binding the `RunSpec` digest, arena
   head, backend, and outcome. Cloister links that receipt to its harness,
   authentication, skill, and audit records. Rosary consumes the Cloister
   result without becoming part of the LLO schema.

Cloister's auth modes remain separate from execution:

- subscription-audit mode resolves the Claude Max/Pro setup token and proxy /
  audit policy without naming either in LLO; and
- API-custody mode resolves a vaulted paid API credential to an opaque secret
  grant without placing the key in the harness environment.

## Error boundary

LLO defines transport-independent lifecycle errors and receipt outcomes in its
neutral schema. Cloister maps those codes to plain explanations and a single
next command. Transport failure, rejected capability, unavailable backend,
unprepared runtime, cancellation, and guest exit remain distinguishable.

The compatibility adapter must map its current Rust and subprocess failures to
those Cloister-side categories. No CLI command may infer a state from stderr
phrasing, and no failure may suggest an internal Taskfile target. A failed
explicit developer override never falls back to another backend.

## Cross-repository seams

The coordinated work is split by ownership:

1. `ley-line-open-d7abd6` defines and pins the neutral execution schema,
   lifecycle, errors, receipts, generated surfaces, and backend contract.
2. `ley-line-open-cb3453` supplies the capability-scoped CAS/CDC Graph and
   portable workspace implementation used by both execution backends.
3. `ley-line-open-36b957` covers the nono relationship and confinement
   composition inside LLO.
4. `cloister-e6bbd6` corrects Cloister ADR ownership and records the consumer
   seam.
5. `cloister-903b5f` defines Cloister's policy-to-`RunSpec` mapping and generated
   client adoption. It does not define an LLO schema.

The LLO-independent landing work remains explicit: `cloister-fb1a73` owns the
clean-image working-main gate, `cloister-fb1ac7` owns first-party
`cluster.toml` regeneration, `cloister-8d5910` owns the CLI/color move, and
`cloister-8d8cb3` owns honest compatibility-provider installation plus
read-only storage readiness.

Direct libkrun embedding is therefore LLO implementation work. Cloister's
corresponding task is removal of its `krunvm` subprocess and conformance against
LLO's `krunNono` backend, not another libkrun implementation.

## Migration sequence

The work lands as bounded, sequential changes because the files overlap and LLO
is being implemented concurrently:

1. **Prove working main in a clean image** — reproduce a fresh clone with no
   `node_modules` or preinstalled Cloister, run `task install`, and smoke-test
   help, skills, cluster generation, dry-run, and the supported confined native
   path. This catches undeclared dependencies such as smol-toml.
2. **CLI home and output context** — add `bin/` and `cli/`, move command modules,
   add global color handling, update `package.json`, and color `skills list`.
3. **First-party configuration and Task delegation** — make operator tasks call
   the CLI, move operator-used generation code behind `cloister cluster
   generate/resolve`, and complete `cloister-de4c78` without changing native
   behavior.
4. **Compatibility runtime UX** — make installation package the current
   fail-closed adapter, make storage status read-only, add neutral human/JSON
   output, remove Taskfile guidance, and label subprocess/krunvm behavior
   experimental in commands and docs.
5. **Generated LLO client adoption** — after `ley-line-open-d7abd6` publishes a
   pinned schema and native+nono provider, map Cloister policy to `RunSpec`, run
   the same public commands through the generated native or UDS client, and
   prove both auth modes and receipt linkage.
6. **Compatibility retirement and boundary rail** — remove normal execution of
   the Cloister helper and `krunvm`, then reject product imports/execution from
   `scripts/` or `tools/`. Genuine development and conformance tasks may still
   run scripts or experimental probes explicitly.

Each step must leave `cloister --help`, `task install`, and the focused command
tests usable. Main never waits for the final LLO backend merely to regain the
working behavior it had before a migration step.

## Tests

Implementation follows test-first development. Required behavior includes:

- a clean Linux image with no repository dependencies can run `task install`;
- the installed link runs `cloister --help`, `cloister skills list`, cluster
  generation, and a dry-run;
- the platform-supported clean-image job proves a real confined native run, or
  fails with one named unavailable prerequisite rather than silently skipping;
- every package imported after bootstrap, including smol-toml and Chalk, is a
  direct declared dependency represented in the frozen lockfile;
- global color flags work before and after a command and stop at `--`;
- `NO_COLOR`, non-terminal output, and `--json` contain no ANSI escapes;
- `skills list` groups and colors every state while preserving text labels and
  exit codes;
- `cluster.toml` regeneration is byte-stable and the drift gate proves its
  generated artifacts came from the committed TOML;
- Taskfile operator tasks invoke the CLI and do not invoke product scripts;
- before LLO adoption, a source rail permits only the named experimental
  compatibility adapter; after adoption, no CLI module imports or executes a
  path under `scripts/` or `tools/`;
- missing execution provider points to `cloister runtime install`;
- invalid explicit compatibility path fails without fallback;
- storage status on a nonexistent path performs no write and reports
  `notPrepared` with exit 0;
- storage status on an initialized empty path reports zero tracked runs;
- runtime doctor and README/RUNNING identify the current provider, transport,
  backend, and experimental behavior without security overclaims;
- existing storage, GC, runtime-selection, and confinement tests continue to
  pass throughout migration.

LLO owns its neutral acceptance fixture. It must deny the raw SQLite arena,
sibling repositories, host credentials, ungranted network access, and child
process escape; allow the granted workspace; survive status/wait/cancel; and
produce a signed receipt binding the `RunSpec` digest, arena head, backend, and
outcome.

Cloister separately proves that `cloister run` reaches LLO natively or over UDS
without repository scripts or krunvm, Claude Max/Pro works in
subscription-audit mode, paid API keys work in custody mode, Rosary and a human
use the same CLI contract, and Taskfile aliases reach that contract.

The generated CLI reference remains derived from the command declaration and
documents global options once rather than repeating them for every command.

## Completion criteria

This design is implemented when:

- the installed executable is `bin/cloister.mjs`;
- a new user can run `task install` from a clean checkout on `main` and receive
  a usable, honestly labeled Cloister rather than a future-only stub;
- normal `cloister` execution has no dependency on `scripts/` or `tools/`;
- operator Taskfile entries delegate to public CLI commands;
- `cluster.toml` remains the operator-authored source and all committed derived
  configuration passes regeneration and drift checks;
- global color controls and the skill-state presentation follow this contract;
- runtime status is read-only and useful before initialization;
- missing native components point only to first-party commands;
- generic execution, nono, libkrun, the LLO Graph workspace, and neutral
  execution receipts are consumed from the pinned LLO API;
- Cloister owns only its harness policy, auth/audit mapping, user-facing output,
  configuration, and receipt linkage at that boundary;
- normal execution no longer shells out to Cloister helpers or krunvm; any
  retained `tools/` programs are explicitly invoked experiments only;
- README and RUNNING.md show the clean install, arbitrary-skill workflow, and
  experimental maturity in plain language;
- focused tests and the repository verification gate pass;
- LLO implementation and Cloister adoption work are separately owned and
  cross-linked.
