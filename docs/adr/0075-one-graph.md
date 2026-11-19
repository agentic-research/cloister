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

- **A wire under compose is `none`.** The reason is the one in Context. It is
  stated per target: the shared socket volume for a target with a socket, the
  shared network for a target with an HTTP port.
- **An edge no emitter joins is `none`**, and names the missing emitter. A
  connection across two placements that cannot be joined is the case today.
- **An edge below its `minStrength` is marked.** `cluster k8s` already refuses
  one when it lowers; the graph shows it without lowering.

The claim that a wire is `none` is a claim about the compose emitter, so a
test holds the two together: it reads the committed `cluster.compose.yaml`
and fails when a container no longer mounts the shared volume. That is the
moment the strength changes, and the test says so.

### 4. What this ADR does not decide

Three things follow, and each changes something an operator runs, so each
needs its own decision:

1. **Holding a wire under compose.** A socket per edge, in a directory
   mounted only into its two ends, would make a wire `capability`: holding
   the mount is the grant. It moves every declared socket path, and the
   backends bind those paths. A network per edge is the same change for a
   target reached over HTTP.
2. **Writing a wire as a connection.** Today a bundle that is not placed
   cannot be a connection end, and a wire cannot ask for a `minStrength`. One
   vocabulary would let the gateway's own edges demand a strength like any
   other. It is a schema change.
3. **Crediting workerd.** ADR-0013 makes a service binding the only way one
   Worker reaches another, and ADR-0070 §3 names `capability` as what a
   workerd placement is meant to deliver. `strengthOf("workerd")` is still
   `none`, because no emitter lowers a connection to a binding and checks it.
   Until one does, the rule in §3 keeps it `none`.

## Consequences

- The system cloister runs as appears in its own graph. Today that graph is
  four edges, all `none`, which is the honest reading and was not visible.
- A reader can no longer take "declared" for "enforced". The command says
  which is which.
- Nothing an operator runs changes. No socket moves and no schema field is
  added.
- The first item in §4 is now a visible gap with a test pointing at it.

## Status

| Part | State |
|---|---|
| `cloister cluster graph`, connections and wires together | implemented |
| Strength and reason for a wire under compose | implemented, tied to the emitter by a test |
| Holding a wire under compose | not decided (§4.1) |
| One vocabulary for an edge | not decided (§4.2) |
| A strength for workerd | not decided (§4.3) |
