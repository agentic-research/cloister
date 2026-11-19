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

1. **Holding a wire under compose.** Decided for sockets in §5 and for a
   target reached over HTTP in §6.
2. **Writing a wire as a connection.** Today a bundle that is not placed
   cannot be a connection end, and a wire cannot ask for a `minStrength`. One
   vocabulary would let the gateway's own edges demand a strength like any
   other. §7 makes it possible, with no schema change. The gateway's own
   wires are not rewritten there.
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
| the wire's binding is shared by several tenants of a `perTenant` target | `none`: the source is handed the bundle's declared socket, which no tenant's instance binds |
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
- A wire to a target reached over HTTP is not covered here. §6 is.
- A socket path that is relative, directly under `/`, or in a directory whose
  name compose's mount syntax would misread is refused, naming the bundle.

**Tenants.** A `perTenant` bundle runs one container per tenant. Each binds
the bundle's socket file in a directory of the tenant's own,
`<dir>/<tenant>/<file>`, handed to it as `TENANT_SOCKET`; the tenant used to
be a tag in the file name, in one directory every instance mounted. A wire
whose binding is one tenant's is judged against that tenant's directory, so
it can be `capability`, and one tenant's instance has no path to another's
socket. A tenant name that cannot be a directory name is refused.

**Checked against running containers.** `task smoke:compose-hold` emits
`test/e2e/compose-hold/cluster.toml`, starts it, and has every bundle try
every wired socket. A declared caller connects. Where the graph says
`capability`, a bundle with no wire gets `FileNotFoundError`: the path is not
in its container. Where the graph says `none` and names a bundle, that bundle
connects. Each tenant's instance tries the other's socket and finds no such
path. The run fails if it saw no refusal, no named entry, or fewer than two
tenants. It is a CI
job and one of the jobs `ci-ok` needs.

**What moved.** In this repository: rosary's socket, to
`/run/cloister-uds/rosary/rosary.sock`; the two tenants of
`recipes/multi-tenant-smoke`, to a directory each. The volume is no longer
named `cloister-uds`; each is named for its directory. The companion's socket
did not move, because its image declares that path.

### 6. Amendment (2026-11-19): a network is the grant, and ports publish on loopback

Decided, with the operator's go-ahead to publish on loopback by default.

**The rule.** A wire to a bundle with no socket is carried over HTTP to the
target's service name. `emit-compose` gives each such pair of bundles a
bridge network of its own and attaches the two ends to it. Two callers of
one target get a network each, so they do not reach each other. A service on
no such network gets one to itself. No service is left on compose's
`default` network, which every service used to share.

**Published ports.** A port published on every interface is reachable from
every container through the host's address, whatever network that container
is on, which would undo the networks. So every port is published on
`127.0.0.1`. This is also what `cluster up` already does for an `edge` port.
An operator who wants a port on the LAN says so in a compose overlay. Which
ports are published at all is ADR-0069's `expose`: only one declared `edge`
(ADR-0069 §2, amendment of the same date).
`init --port` rewrites the host half of that entry, builds the text it looks
for from the emitter's own function, and now fails if it finds none; it used
to replace nothing and report success.

**What a wire's strength then is.** For a wire carried over HTTP:

| | Strength |
|---|---|
| only its two ends are on the network | `capability` |
| a container shares the network namespace of an end, and so is on the network too | `none`, and that container is named |
| the target runs inside its caller's namespace and is reached at 127.0.0.1 | `none`: who else reaches it depends on the address it listens on, which compose does not constrain |
| the address compose hands the source is one nothing answers at (the target is one container per tenant, or is inside another bundle's namespace) | `none` |

**What this does not claim.**

- A network joins its two ends both ways. The target can reach its caller's
  ports too. The graph says so on every such edge.
- One bundle, mache, is placed in the gateway's namespace by name. That rule
  is older than this ADR. It is now stated in one function
  (`namespaceHost`), which the emitter and the graph both read, and it is the
  reason neither HTTP wire in this repository's own cluster is held: mache is
  reached at loopback, and being in the gateway's namespace puts it on the
  network the gateway shares with notme-identity. Moving mache onto a network
  of its own would hold both. It changes the address mache listens on, which
  the microVM placement also reads, so it is not done here.

**What this takes away.** A bundle that reached another over HTTP with no
wire between them no longer can. That is the point, and it is the change an
existing cluster is most likely to notice.

**Checked against running containers.** `task smoke:compose-hold` adds an
HTTP target. Its declared callers get a page. Every other container is
refused three ways: by the target's name, at each address the target's
container has, and through the host's address at the published port, which
fails for the callers as well. The host itself reaches the published port on
loopback. The container the graph names as sharing a caller's namespace gets
the page.

### 7. Amendment (2026-11-19): a connection between two compose bundles is lowered

`compose` became a placement kind (ADR-0070 §2, amendment of the same date),
and a connection ending at a compose bundle was refused by name. It is now
lowered, the way a wire over HTTP is (§6), because it is the same statement:

- The connection gets a network of its two ends, to the target's service
  name and the number of the port the connection names. A wire and a
  connection between one pair of bundles share the one network.
- An env row bound to the connection is set to its address,
  `<scheme>://<target>:<port>` plus the row's `path`, for a protocol with a
  URL form. For one without (a database wire), the row is refused, saying
  where the target is reached, and the network is still attached.
- Its strength is read from the network plan: `capability` when only its two
  ends are on the network, `none` when a container shares the namespace of an
  end. A `minStrength` it does not meet fails the build, naming that
  container. The kind-level check ADR-0070 §3 makes for other placements is
  skipped for this pair, because for compose a strength is a fact about the
  edge and not about the kind.

So an edge of the compose cluster can now be written in the vocabulary every
other placement uses, and can ask for a strength. That is what §4.2 wanted.

Refused, by name:

- A connection declared for any env but `compose` between compose bundles.
  One compose file is written, for one env; without this the row would be
  accepted and lowered by nothing.
- A connection with an end compose does not run: an edge across two
  placements needs a broker that nothing lowers yet.
- A connection to a bundle with no name of its own on any network: the one
  inside the gateway's namespace, and a `perTenant` bundle.
- An env row that takes its value from a secret. Compose has no secret store
  cloister writes to, and the emitter used to write such a row as an empty
  value.

**Not done.** The gateway's own edges are still `[[wires]]`. A wire also names
the binding the gateway's Worker reads, and several rails check wires against
bindings and tenant dispatch, so rewriting them is its own change. A
connection carries TCP to a named port; an edge to a Unix socket is still a
wire.

**Checked against running containers.** `task smoke:compose-hold` adds a
connection that asks for `capability`, with an env row bound to it. The
variable is read inside the container and holds the address; the container
gets a page there; no other container has a route; and the port, declared
`cluster`, is not on the host.

## Consequences

- The system cloister runs as appears in its own graph. When this was
  written that graph was four edges, all `none`, which was the honest reading
  and was not visible. Since §5 it is five: three sockets held, two HTTP
  targets not, for the reason in §6.
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
| Holding a wire to an HTTP target under compose | implemented (§6), checked against running containers in CI |
| Holding this repository's own two HTTP wires | not done: mache shares the gateway's namespace (§6) |
| Keeping tenant instances out of each other's sockets | implemented (§5), checked against running containers in CI |
| A connection between two compose bundles | implemented (§7), checked against running containers in CI |
| The gateway's own wires written as connections | not done (§7) |
| A strength for workerd | not decided (§4.3) |
