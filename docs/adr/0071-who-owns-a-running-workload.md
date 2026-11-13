---
title: "ADR-0071: Who owns a running workload — one owner, declared lifecycle"
status: Accepted (2026-11-11)
date: 2026-11-10
tags: [lifecycle, supervision, readiness, stop, restart, microvm, llo-boundary, prior-art]
tracking-bead: cloister-035224
relates_to:
  - 0035-cloister-llo-boundary.md
  - 0044-compute-isolation-substrate.md
  - 0049-cloister-host-runtime.md
  - 0069-declared-connections.md
  - 0070-placements-and-channel-strength.md
---

# ADR-0071: Who owns a running workload

Tracking bead: `cloister-035224`. Evidence: the review of the first
`cloister cluster up` (`cloister-991e65`), and the LLO beads named below.

## Context

`cloister cluster up` starts each microVM bundle from `cluster.toml`
(ADR-0070). Its first review found that the normal path worked and that
several ordinary ways of stopping it left microVMs running with nothing
supervising them:

- a second Ctrl-C during teardown;
- closing the terminal;
- killing `up` itself;
- stopping while a VM was still booting.

Eleven such VMs were found on a development machine, some ten hours old. The
same review found that "ready" meant only "the socket file exists". A service
that failed 30 seconds later had already been reported as ready.

None of this is new. The container ecosystem met each problem and settled on
an answer. This ADR records which answers cloister takes, and which side of
the cloister/LLO boundary (ADR-0035) each one lands on. It follows the rule
ADR-0070 §2 set for workload specs: read what is already declared, and add no
field for it.

## Prior art

| Problem | Settled answer | Source |
|---|---|---|
| Who owns a container when the manager dies | A separate per-container process. containerd starts a shim for each one and talks to it over a socket address, so the container does not depend on the daemon staying alive. Docker's live restore relies on this to keep containers running while the daemon is down. | [containerd runtime v2](https://github.com/containerd/containerd/blob/main/docs/runtime-v2.md), [Docker live restore](https://docs.docker.com/engine/daemon/live-restore/) |
| Passing the command | `process.args` is an array of strings with `execvp` argv semantics. Nothing parses it as a command line. | [OCI runtime spec, config.md](https://github.com/opencontainers/runtime-spec/blob/main/config.md) |
| "Started" is not "ready" | A declared health check. A dependent waits on `condition: service_healthy`. Kubernetes has startup and readiness probes. | [Compose spec: `depends_on`, `healthcheck`](https://github.com/compose-spec/compose-spec/blob/main/spec.md), [Kubernetes pod lifecycle](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/) |
| Stopping | A stop signal, a declared grace period, then SIGKILL. Compose's `stop_grace_period` defaults to 10 seconds. Kubernetes has `terminationGracePeriodSeconds`. | same two |
| A workload that exits | A declared restart policy: `restart:` in Compose, `restartPolicy` in Kubernetes. | same two |

## Decision

### 1. A running workload has exactly one owner, and it is on the LLO side

The owner is the process that started the VM. It:
- holds the VM's lifetime;
- records its exit;
- can be asked to stop it.

For a microVM that is LLO's worker supervision, not cloister's Node CLI and
not the terminal. Two consequences follow:

- **A worker never outlives its supervisor silently.** When the embedding
  process dies, the worker stops the VM (`ley-line-open-f963e6`). Stopping a
  run that is still booting stops it; it does not report "nothing to stop".
- **Cloister does not grow a supervisor.** `cluster up` is a foreground
  convenience: everything it started stops when it stops, on every exit path
  it can observe. Surviving a restart of the manager, reattaching to a running
  VM, and keeping logs and exit records all belong to an LLO owner in the role
  of containerd's shim. They are out of scope for `up`.

### 2. Arguments and environment reach the workload as data

Cloister hands LLO an argv array and an environment map. Nothing between the
declaration and `execve` parses them as text. A tier that cannot deliver an
argument byte for byte refuses it by name, before start
(`ley-line-open-d4b07f`: a double quote in argv is altered today because argv
crosses the kernel command line).

### 3. Readiness is declared, and "bound" is not "ready"

There are three states, and `up` reports them by name:

| State | Meaning | Where it comes from |
|---|---|---|
| started | the run was accepted | the host runtime |
| bound | every declared port's channel exists | the channel directory (what `up` checks today) |
| healthy | the workload answers | the bundle's declared health check |

A dependent starts when its target is **healthy**, where a health check is
declared. The declaration already exists in two places, and cloister reads
it:
- For a constructed bundle: ADR-0069's `[bundles.<name>.health]` (a port
  name, plus a path for HTTP).
- For a forwarded bundle: the probes in the operator's own manifest.

Where none is declared, "bound" is all cloister knows. `up` says "bound", not
"ready".

### 4. Stop is a signal, a declared grace period, then a kill

- The grace period comes from what is declared:
  `terminationGracePeriodSeconds` or `stop_grace_period` in a forwarded spec.
- For a constructed microVM, LLO owns the default and enforces the
  escalation, because only the owner can kill the VM.
- Cloister adds no grace-period field. It does not invent a timeout in the
  CLI.

Until LLO enforces one, `up` waits for a stop it asked for. A repeated signal
kills the host runtimes, and `up` then says plainly that the VMs may still be
running.

### 5. A workload that exits is restarted only if a policy is declared

- **Forwarded placements** keep their own `restartPolicy`. Cloister does not
  restart anything it did not construct.
- **Constructed microVMs:** today any exit ends `cluster up` non-zero, because
  the running cluster no longer matches the declaration. Restarting needs a
  declared policy and an owner that outlives the workload (§1). Both arrive
  with the LLO owner, not before.

### 6. A wall-clock ceiling is not a lifecycle policy

- LLO requires a wall-clock ceiling on every run. Cloister sends 15 minutes.
- A run stopped at its ceiling is reported as that (exit status 124), never
  as a workload failure.
- A service needs "runs until stopped", which LLO cannot express yet
  (`ley-line-open-e6b1bb`). Cloister does not fake it with a large number.

## What exists today

| Rule | State |
|---|---|
| §1 foreground `up` stops everything on every observable exit path | built: `cluster up` (#287, `cloister-991e65`) |
| §1 host TCP for `expose = "edge"` lives and dies with `up` | built (`cloister-991e65`): each edge port is reserved before anything starts, relays once its bundle is bound, and is closed before the runs stop. If `up` is killed, the OS closes the listeners; tested with real processes for SIGINT and `kill -9`. The relay is interim; replaced by LLO's publish channel (`ley-line-open-797917`, `cloister-79bdeb`). |
| §1 worker stops with its supervisor; stop during boot | not built (`ley-line-open-f963e6`) |
| §2 argv delivered exactly | built: LLO v0.30.0 delivers argv and environment byte for byte (ley-line-open-d4b07f). Cloister lowers a bundle's declared env into the plan (cloister-2af426) and refuses an empty name, "=" or NUL in a name, NUL in a value, and a duplicate name, by bundle and name, before start. |
| §3 `up` distinguishes bound from healthy; health gates dependents | partly: `up` reports "bound", never "ready" (#287). Health checks and gating are not built. |
| §4 declared grace period and enforced escalation | not built |
| §5 restart policy | not built. Any exit ends `up`. |
| §6 ceiling stop reported distinctly | built (#287): the host runtime exits 124 and `up` names the ceiling. No guest output is printed for it (#289). "No ceiling" is not built (`ley-line-open-e6b1bb`). |

## Rails to ship with the implementation

- A test with real processes and real signals for each stop path in §1.
  Fakes hid all four of the failures above.
- A request-level test that cloister's execution request passes LLO's own
  validation. One exists as of `cloister-991e65`.
- `up` output never says "ready" for a bundle whose health was not checked.

## Out of scope

- A cloister daemon. Durable ownership is LLO's.
- Log shipping and retention. Guest output reaches cloister through LLO's
  execution result (`cloister-edec62`). Since LLO v0.29.0 the host runtime
  prints a FAILED run's stdout/stderr tails, labelled untrusted, and `up`
  shows them under the bundle's prefix. It prints nothing for a ceiling stop
  (§6), which is not a workload failure. Nothing is stored,
  shipped, or kept beyond that one report.
- Restart back-off tuning, rolling updates, autoscaling. A forwarded
  placement already has these; a constructed one does not need them yet.
