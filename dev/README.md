# `dev/`: things a contributor runs

Local launchers, smoke and integration tests, benchmarks, and the git hooks.

These files are repository plumbing.
They are not the installed product interface,
and normal `cloister` commands must not depend on them at runtime.
The first-party command lives under [`cli/`](../cli/) with its entry point at
[`bin/cloister.mjs`](../bin/cloister.mjs).

[`Taskfile.yml`](../Taskfile.yml) names the task that runs each file here.
Find a file's task by searching the Taskfile for its path.

Tests for these files are in [`dev/test/`](test/).

## Where the rest went

`scripts/` used to hold everything that was not the worker. It is split by
what a file is for:

| Directory | Holds |
|---|---|
| [`cli/`](../cli/) | The `cloister` command and its tests ([`cli/test/`](../cli/test/)) |
| [`lint/`](../lint/) | The rails `task lint` runs, and their tests |
| [`gen/`](../gen/) | Code generators and build steps, and their tests |
| `dev/` | This directory |

Nothing in `lint/`, `gen/` or `dev/` forwards to `cli/`. A file that only
re-exports product code is refused by `lint/test/gate-integrity.test.mjs`.

After pulling this change, run `task install-hooks` once: the pre-push hook
moved from `scripts/git-hooks/` to `dev/git-hooks/`, and an existing clone's
hook is a symlink to the old path.
