# First-party Cloister CLI

**Status:** Approved direction; awaiting review of this written specification
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

This design makes the CLI the product boundary now. Native krun and nono code
remain in Cloister for this phase and may move to ley-line-open (LLO) later.

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
7. Leave clear seams for moving krun and nono into LLO later without coupling
   the immediate CLI repair to that migration.

## Non-goals

- Rewriting the JavaScript CLI in Rust.
- Moving krun or nono into LLO in this change.
- Replacing the `krunvm` process interface with direct libkrun calls in this
  change.
- Making LLO's filesystem capability responsible for creating virtual
  machines.
- Turning repository-only generators, linters, benchmarks, or migrations into
  public CLI commands.

## Ownership and directory layout

The target layout is:

```text
bin/
  cloister.mjs                  dependency-free installed entrypoint
cli/
  index.mjs                     command routing and global options
  commands/                     user-facing command implementations
  lib/                          shared CLI, launch, output, and helper code
rs/crates/
  host-runtime/                 native krun runtime
  harness-sandbox/              native nono helper, moved from tools/
src/harness-shim/               shipped workerd shim, moved from tools/
scripts/                        code generation, lint, migration, and benchmarks
tools/                          experiments that normal Cloister commands never run
```

`bin/cloister.mjs` is intentionally small. It uses only Node built-ins, handles
the dependency-free install path, and then loads `cli/index.mjs` for normal
commands. This matters on a fresh checkout: the installer must be runnable
before Chalk, smol-toml, or any other package has been installed.

The CLI must not import from `scripts/` or `tools/`. A source check will enforce
that rule. Code used by both a repository check and the product belongs in a
neutral product module; the check may import the product module, never the
other way around.

`scripts/` and `tools/` do not have to be empty. Their boundary is whether a
normal `cloister` command imports, executes, or requires the file.

## Installation commands

### `cloister install`

The dependency-free entrypoint owns installation from a source checkout:

1. verify Node and pnpm are available;
2. install the exact dependencies in `pnpm-lock.yaml`;
3. build the required nono confinement helper and copy it into the CLI's
   `libexec` directory;
4. create or update the CLI link in `CLOISTER_BIN_DIR` (default
   `~/.local/bin`);
5. run `cloister --help` through the installed link as a smoke check;
6. explain how to add the destination to `PATH` when needed.

The default helper directory is `~/.local/libexec/cloister`. It can be changed
with `CLOISTER_LIBEXEC_DIR`. The CLI records no absolute helper path in shared
configuration; it resolves the per-machine install directory at launch.

The nono helper is required because `cloister run` is confined by default. If
it is missing, `cloister run` points to `cloister install`. It never falls back
to an unconfined run.

It is idempotent and refuses to overwrite an unrelated regular file.

`task install` becomes only:

```yaml
cmds:
  - node bin/cloister.mjs install
```

### `cloister runtime install`

The native microVM path remains optional. Its setup command is
`cloister runtime install`, never a Taskfile instruction.

For the current source distribution it builds the optional host-runtime Cargo
crate and places its executable in the same CLI-owned `libexec` location. The
CLI reports exactly which helper is ready. A future release may install a
signed, digest-pinned platform binary instead; that changes the installer
backend, not the public command.

When a runtime helper is missing, any `cloister runtime ...` command prints:

```text
The native runtime is not installed.
Run: cloister runtime install
```

It must not mention `task runtime:build`.

The explicit `CLOISTER_HOST_RUNTIME_BIN` override remains available for
development and testing. An invalid explicit path is an error and never falls
back silently.

## Taskfile contract

Operator-facing tasks are aliases onto public commands:

| Task | Command |
| --- | --- |
| `task install` | `node bin/cloister.mjs install` |
| `task init` | `cloister init` |
| `task add` | `cloister add` |
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
human-readable output by default. `--json` returns the versioned Rust status
object without styling or commentary.

The JavaScript CLI translates known native error types into direct next steps.
Unknown errors retain the full native cause and exit non-zero; the CLI must not
hide diagnostic detail.

### Read-only storage status

`cloister runtime storage status` must not create a directory, mount a volume,
create a lock file, or mutate runtime state.

The Rust status model becomes version 2 and gains an explicit state. Capacity
fields are `null` when no mounted filesystem exists; zero would falsely claim
that a zero-byte volume was inspected.

```json
{
  "schema": "cloister/krunvm-status/v2",
  "state": "notInitialized",
  "storageVolume": "/Volumes/krunvm",
  "totalBytes": null,
  "usedBytes": null,
  "availableBytes": null,
  "reserveBytes": null,
  "canAcquire": false,
  "trackedVms": 0,
  "runningVms": 0
}
```

Reporting `notInitialized` is a successful status query and exits 0. Human
output says:

```text
MicroVM storage is not initialized.
Run: cloister runtime storage init
```

When the mount exists but no Cloister state file exists, status reports an
initialized empty store with measured capacity and zero tracked VMs. It may
take a shared lock only when the lock already exists; it may not create the
mount, lock, or state merely to answer a question.

`cloister runtime storage init` remains the only command that creates and
attaches the storage volume.

## Native helper boundary

Keeping native helpers behind the JavaScript CLI is deliberate:

- JavaScript owns argument parsing, readable errors, color, installation, and
  command consistency.
- Rust owns kernel confinement, filesystem locking, storage accounting, and VM
  lifecycle details.
- Native helpers return structured results and typed failures where the CLI
  needs to choose a user-facing next step.

The native programs are Cloister product code, so they live under `rs/crates/`,
not `tools/`. The workerd harness shim is also product code and moves under
`src/`.

## Future LLO seams

The future move to LLO is split by responsibility:

1. `ley-line-open-cb3453` owns the portable filesystem capability: signed head,
   digest, generation, allowed operations, and transport. The existing bead is
   cross-linked to this design.
2. `ley-line-open-36b957` owns research into the relationship between that
   filesystem surface and nono confinement.
3. `cloister-e6bbd6` tracks the missing Cloister-side interface definition and
   related ADR scope corrections. Its interface bead must be completed before
   LLO's reference implementation can target a stable consumer contract.
4. A later Cloister implementation bead will adapt the LLO capability to
   workerd and libkrun/virtio-fs after both contracts exist.
5. Replacing `Command::new("krunvm")` with direct libkrun integration is a
   separate Cloister runtime bead. VM creation is not part of LLO's filesystem
   capability contract.

The immediate CLI work does not depend on these future items. Its directories
and helper boundary are chosen so that replacing a helper implementation later
does not change user commands.

## Migration sequence

The work should land as bounded, sequential changes because the files overlap:

1. **CLI home and output context** — add `bin/` and `cli/`, move command modules,
   add global color handling, update `package.json`, and color `skills list`.
2. **Task delegation and runtime-free shell removal** — make operator tasks call
   the CLI and complete `cloister-de4c78` without changing native behavior.
3. **Runtime status and install UX** — add `cloister runtime install`, make
   status read-only, add human and JSON output, and remove Taskfile guidance.
4. **Native helper relocation** — move the nono helper from `tools/` to
   `rs/crates/` and the shipped shim under `src/`; update builds and tests.
5. **Boundary rail** — reject CLI imports/execution from `scripts/` or `tools/`
   and reject operator Taskfile entries that bypass the CLI.

Each step must leave `cloister --help`, `task install`, and the focused command
tests usable. Moves use `git mv` so history remains traceable.

## Tests

Implementation follows test-first development. Required behavior includes:

- fresh checkout can run the dependency-free install entrypoint;
- the installed link runs `cloister --help`;
- global color flags work before and after a command and stop at `--`;
- `NO_COLOR`, non-terminal output, and `--json` contain no ANSI escapes;
- `skills list` groups and colors every state while preserving text labels and
  exit codes;
- Taskfile operator tasks invoke the CLI and do not invoke product scripts;
- no CLI module imports or executes a path under `scripts/` or `tools/`;
- missing native helper points to `cloister runtime install`;
- invalid explicit helper path fails without fallback;
- storage status on a nonexistent path performs no write and reports
  `notInitialized` with exit 0;
- storage status on an initialized empty path reports zero tracked VMs;
- existing storage, GC, runtime-selection, and confinement tests continue to
  pass after relocation.

The generated CLI reference remains derived from the command declaration and
documents global options once rather than repeating them for every command.

## Completion criteria

This design is implemented when:

- the installed executable is `bin/cloister.mjs`;
- normal `cloister` execution has no dependency on `scripts/` or `tools/`;
- operator Taskfile entries delegate to public CLI commands;
- global color controls and the skill-state presentation follow this contract;
- runtime status is read-only and useful before initialization;
- missing native components point only to first-party commands;
- native product helpers no longer live under `tools/`;
- focused tests and the repository verification gate pass;
- the future LLO and direct-libkrun work is tracked separately and cross-linked.
