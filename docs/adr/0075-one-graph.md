---
title: "ADR-0075: One graph: a wire is an edge, and every edge states what holds it"
status: Proposed
date: 2026-11-19
tags: [cluster-toml, connections, wires, strength, compose, placements, dx]
tracking-bead: cloister-ca2582
relates_to:
  - 0013-slice-grant-enforcement.md
  - 0069-declared-connections.md
  - 0070-placements-and-channel-strength.md
  - 0074-the-graph-is-derived-cluster-toml-holds-intent.md
---

# ADR-0075: One graph: a wire is an edge, and every edge states what holds it

Tracking bead: `cloister-ca2582`. Builds on
[ADR-0070](0070-placements-and-channel-strength.md) and
[ADR-0074](0074-the-graph-is-derived-cluster-toml-holds-intent.md).

## Context

cloister is one idea: you declare which bundle may reach which, and the place
each bundle runs is made to enforce that, at a strength cloister states.

The code does not yet say it as one idea. `cluster.toml` has two ways to
write an edge:

- `[[connections]]` (ADR-0069): from a bundle, to a bundle's port, per
  environment. It has a strength (ADR-0070 §3) and may demand one with
  `minStrength`. `cluster k8s`, `cluster lower` and `inspect` read it.
- `[[wires]]`: a binding on one bundle that reaches another. The gateway's
  own cluster is written this way. `cluster up` reads it, through the compose
  emitter.

They are the same statement. But this repository's own `cluster.toml` has
four wires and no connection, so the graph commands show nothing for the
system cloister itself runs as, and nothing says what holds a wire.

Looking at what does hold one gives the second reason for this ADR. Under
`cluster up`, the compose emitter gives every container the one socket
volume, and that volume holds every bundle's socket. A wire decides the
address its source is handed. It does not stop a bundle with no wire from
opening the same path. A target reached over HTTP is in the same position:
it listens on a network compose shares.

The bundle-isolation rails (Inv 1, 4 and 5) are real, and they are about
something else. They hold the *Worker's* bindings to the wires: what the
gateway's own code can name. They do not bound what a container beside it
can dial. Both facts are true at once, and only the first was written down.

## Decision

### 1. There is one graph

An edge is "this bundle may reach that one". A `[[connections]]` row and a
`[[wires]]` row each declare one. Every command that shows or checks edges
reads both.

`cloister cluster graph --env <name>` prints it: each connection that has a
target in the environment, and each wire. It reads `cluster.toml` only, and
writes and starts nothing.

### 2. Every edge states three things

| | |
|---|---|
| carrier | how the edge is carried where it runs |
| strength | what stops a bundle that is **not** the declared caller: `none`, `policy` or `capability` (ADR-0070 §3) |
| why | the mechanism, or the absence of one, in a sentence |

### 3. A strength is what is written today, never what is meant

ADR-0070 §3 already says a placement is `none` until it is lowered with a
mechanism that enforces something. This ADR applies that rule to wires:

- **A wire under compose was `none` for every target** when this ADR was
  written: one socket volume in every container, and one shared network. §5
  changes the socket half. A target reached over an HTTP port is still
  `none`.
- **An edge no emitter joins is `none`**, and names the missing emitter. A
  connection across two placements that cannot be joined is the case today.
- **An edge below its `minStrength` is marked.** `cluster k8s` already refuses
  one when it lowers; the graph shows it without lowering.

What the graph says about a wire is a claim about the compose emitter, so a
test holds the two together. It first read the committed
`cluster.compose.yaml` and failed when a container stopped mounting the
shared volume. Since §5 it reads every committed compose file, works out
from the `volumes:` lines alone who can open each socket, and requires the
graph to agree.

### 4. What this ADR does not decide

Three things follow, and each changes something an operator runs, so each
needs its own decision:

1. **Holding a wire under compose.** Decided for sockets in §5. A network
   per edge, the same change for a target reached over HTTP, is still open.
2. **Writing a wire as a connection.** Today a bundle that is not placed
   cannot be a connection end, and a wire cannot ask for a `minStrength`. One
   vocabulary would let the gateway's own edges demand a strength like any
   other. It is a schema change.
3. **Crediting workerd.** ADR-0013 makes a service binding the only way one
   Worker reaches another, and ADR-0070 §3 names `capability` as what a
   workerd placement is meant to deliver. `strengthOf("workerd")` is still
   `none`, because no emitter lowers a connection to a binding and checks it.
   Until one does, the rule in §3 keeps it `none`.

### 5. Amendment (2026-11-19): a socket directory is the grant

Decided, with the operator's go-ahead to move socket paths.

**The rule.** `emit-compose` gives each directory that holds an `ipcSocket`
its own tmpfs volume, and mounts it into

- every bundle that binds a socket in that directory, and
- every bundle with a wire to one of those bundles,

and into nothing else. A bundle that binds no socket and has no such wire
mounts no socket volume at all.

**What a wire's strength then is.** For a wire to a bundle with a socket:

| Who mounts the target's socket directory | Strength |
|---|---|
| the target and its declared callers only | `capability` |
| anyone else (it binds its own socket there, or has a wire to another bundle that does) | `none`, and that bundle is named |
| the target is `perTenant` | `none`: every tenant's instance binds in the one directory |
| the source has no container of its own | `none`: there is nothing to mount it into |

So holding is opt-in by path and needs no schema field. A cluster whose
sockets all sit in one directory keeps working and is told, per wire, who
else can open the socket. Putting a bundle's socket in a directory of its own
is what holds it. The emitter and the graph read one function
(`cli/lib/cluster/socket-dirs.mjs`), so they cannot describe different files.

**What §4.1 got wrong.** It said "mounted only into its two ends". The
gateway is workerd and cannot open a Unix socket: the companion opens it on
the gateway's behalf (ADR-0005, ADR-0051). The companion is therefore a
caller of every socket the gateway uses, and that is an edge. It is now
declared as one in this repository's `cluster.toml` (`notme-proxy → rosary`),
which is what puts the directory in the companion's container. An edge the
graph did not show was the reason one volume had to be everywhere.

**What this does not claim.**

- A declared caller that relays requests extends its reach to whoever can
  reach it. The companion opens the socket path a request names. Who can
  reach the companion is the companion's own edge, with its own row.
- A wire to a target reached over HTTP is still `none`.
- Tenant instances of one `perTenant` bundle still share a directory.
- A socket path that is relative, directly under `/`, or in a directory whose
  name compose's mount syntax would misread is refused, naming the bundle.

**Checked against running containers.** `task smoke:compose-hold` emits
`test/e2e/compose-hold/cluster.toml`, starts it, and has every bundle try
every wired socket. A declared caller connects. Where the graph says
`capability`, a bundle with no wire gets `FileNotFoundError`: the path is not
in its container. Where the graph says `none` and names a bundle, that bundle
connects. The run fails if it saw no refusal or no named entry. It is a CI
job and one of the jobs `ci-ok` needs.

**What moved.** In this repository: rosary's socket, to
`/run/cloister-uds/rosary/rosary.sock`; the two tenants of
`recipes/multi-tenant-smoke`, to a directory each. The volume is no longer
named `cloister-uds`; each is named for its directory. The companion's socket
did not move, because its image declares that path.

## Consequences

- The system cloister runs as appears in its own graph. When this was
  written that graph was four edges, all `none`, which was the honest reading
  and was not visible. Since §5 it is five: three sockets held, two HTTP
  targets not.
- A reader can no longer take "declared" for "enforced". The command says
  which is which.
- No schema field is added. Until §5 nothing an operator runs changed. §5
  changes which containers mount which socket directory, and renames the
  volume.

## Status

| Part | State |
|---|---|
| `cloister cluster graph`, connections and wires together | implemented |
| Strength and reason for a wire under compose | implemented, read from every committed compose file by a test |
| Holding a wire to a socket under compose | implemented (§5), checked against running containers in CI |
| Holding a wire to an HTTP target under compose | not decided (§4.1) |
| Keeping tenant instances out of each other's sockets | not built (§5) |
| One vocabulary for an edge | not decided (§4.2) |
| A strength for workerd | not decided (§4.3) |
