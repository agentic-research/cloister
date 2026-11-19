---
title: "ADR-0074: The graph is derived from rendered output; cluster.toml holds intent"
status: Proposed
date: 2026-11-18
tags: [cluster-toml, importer, terraform, opentofu, cloud-run, knative, facts, connections, authority, dx]
tracking-bead: cloister-ca2582
relates_to:
  - 0025-bidi-toml-pipeline.md
  - 0069-declared-connections.md
  - 0070-placements-and-channel-strength.md
  - 0072-placements-are-realizers.md
  - 0073-resource-facts-are-imported-never-granted.md
---

# ADR-0074: The graph is derived from rendered output; cluster.toml holds intent

Tracking bead: `cloister-ca2582`. Builds on
[ADR-0073](0073-resource-facts-are-imported-never-granted.md).

## Context

Most people who try cloister already have infrastructure that works. They did
not come looking for a new place to describe it. So the first thing cloister
asks of them cannot be "write your system down again in our format". It has to
be useful on what they already have, and ask for more only where that buys
something.

Picture a monorepo with many services that call each other. Nobody wrote the
graph down. It is implied: one service's environment holds another's address,
and an IAM row says who may invoke whom. The services are deployed to a cloud
by Terraform, and the same services are wanted on a local Kubernetes cluster
for development.

Two things are wanted from cloister:

1. **Make it runnable locally.** Each service needs the right configuration
   for where it runs. Mostly that is addresses: a service that calls a cloud
   URL in production must call an in-cluster name locally.
2. **Make sure it does what was intended.** Who calls whom, on what port and
   protocol, and who is allowed to.

Today both start from `cluster.toml`, and `cluster.toml` is written by hand.
The operator restates every service as a bundle and every edge as a
connection, from manifests exported out of a running cluster. That is three
problems:

- It is a second copy of what the deployment tool already knows, so it drifts.
- It needs a live cluster to export from.
- It asks the operator to discover the implied graph by reading env vars,
  which is the work a tool should do.

ADR-0073 already settled how cloister may read someone else's infrastructure:
from a rendered document, as facts, never as authority. Since then the
readers have grown to the point where the graph can be read out:

- `inspect --terraform` reads Cloud Run services and jobs, what each is
  started with, and what each dials, from a rendered plan. It names the env
  var an edge comes from even when the values are withheld as sensitive.
- `cluster k8s` reads the addresses in a Kubernetes or Knative manifest's
  containers and holds them to the declared connections.
- `inspect` compares a hand-written `cluster.toml`'s connections with the
  edges a plan implies.

What is undecided is what `cluster.toml` is *for* once the graph can be read.

## Decision

### 1. Rendered output is the only input. Cloister parses no template

Cloister reads what a tool renders: `terraform show -json`, a rendered
Kubernetes manifest. It does not read HCL, Helm charts, or any template, and
it runs no tool. This is ADR-0073 §2 and ADR-0070 §2, restated because it is
what makes the rest tractable: a rendered document has one shape per tool,
with values resolved and sensitivity marked. A template has as many shapes as
there are authors.

A plan is preferred to a state. A plan can be produced offline, before
anything exists, and its `configuration` section records which resource a
value is taken from. That is how an edge is found when the address is not
known until apply.

### 2. The graph is derived: nodes and edges are facts

- A **node** is a workload the rendered output describes: a Cloud Run service
  or job, a Kubernetes Deployment with its Service, a Knative Service.
- An **edge** is found two ways, both exact: a string the workload is started
  with holds another node's address, or the configuration says a value is
  taken from another node.
- **Who may call** is read from access rows (an invoker IAM member), and
  **who can reach** from the exposure setting (Cloud Run `ingress`).

All of these are facts in ADR-0073's sense. A derived edge authorizes nothing.

### 3. cluster.toml holds intent, and may stop restating the graph

`cluster.toml` is where the operator says what must be true. It is not where
they copy out what is true.

An operator may still declare bundles and connections by hand, and everything
that works today keeps working. What changes is that they should not have to:

- **A bundle may be drafted from a node.** Name, ports and the workload's
  placement come from the rendered output.
- **A connection may be drafted from an edge.** The operator reviews it and
  commits it. Committing is the act that turns an observation into a
  declaration.
- **Intent is what only the operator knows**: the minimum strength an edge
  must have, that a service must not be reachable from outside, that nothing
  but one caller may reach a datastore.

The draft is a file the operator reads and commits. Nothing derived is ever
adopted on its own. That keeps ADR-0073's rule intact: a loose deployment
cannot grant itself access by being imported.

### 4. The same name is the same thing

A bundle and a derived node are the same workload when they have the same
name, exactly. Nothing else joins them: not an image, not a label, not a
similar name. Two nodes with one name resolve to neither. This is the rule
`inspect` already uses to compare declared connections with derived edges.

It is deliberately strict. A naming convention that differs between the cloud
and the local cluster will show up as "no resource named X", and the answer
is a declared alias on the bundle, added when a real case needs it, not a
looser match.

**Amendment (2026-11-19): the alias, per environment.** The real case came: a
service is `orders` on a developer's cluster and `orders-api-prod` in the
cloud, and the comparison could not be told they are one thing. A placement
row may now say what the bundle is called there:

```toml
[[bundles.placements]]
env = "prod"
kind = "cloudRun"
name = "orders-api-prod"
```

`inspect --env prod` matches a rendered resource to the bundle by that name,
and reports in bundle names. The rule of this section is unchanged: a name
still means one thing, and nothing is matched by likeness. What changed is
that the name is the one the operator stated for that environment.

- It is per environment because that is where names differ. Without `--env`
  there is no one name to take, and the report says so instead of picking.
- Within one environment a name means one bundle. Two bundles that would go
  by the same name there are refused when `cluster.toml` is read.
- It is for forwarded placements. A constructed one is named by cloister,
  after the bundle.
- It does not rename what cloister writes. A lowered manifest still names
  its objects after the bundle.

### 5. Checking comes before drafting, and drafting before lowering

In order, each useful without the next:

1. **Check.** Compare a hand-written `cluster.toml` with the derived graph:
   each declared connection is evidenced or unknown, each derived edge is
   declared or undeclared, and workloads with no bundle are listed. *Built.*
2. **Draft.** Write a `cluster.toml` from the derived graph for the operator
   to review. *Built: `inspect --terraform <file> --draft --env <name>` prints
   one. It is never written to disk, and an existing `cluster.toml` is not
   read. Its header lists what the inputs did not show.*
3. **Lower.** From the declared graph, write each workload's configuration
   for a placement: the addresses it should dial there. This is the env
   lowering ADR-0070 lists as not built, and it is what "runnable locally"
   needs. *Built for Kubernetes: `cluster lower`. See §7.*

### 6. A placement that is only checked is still a placement

ADR-0070 already sorts placements into two kinds. A **constructed** placement
is one cloister builds and starts (`microvm`, `workerd`). A **forwarded**
placement is one cloister does not own: it reads what the operator rendered
and checks the edges.

Today a connection end must be placed `microvm`, `kubernetes` or `knative`.
That list is written out in code, and `cloudRun` is not on it, so the
production side of a Cloud Run deployment cannot be declared at all. Adding
`cloudRun` to the list would fix one provider and repeat the problem for the
next. The rule is stated on the kind of placement instead:

1. **Any forwarded placement may be a connection end.** It is checked and not
   lowered, the way `knative` is (ADR-0070 §2 amendment).
2. **Its strength is `none` unless something cloister writes enforces it.**
   For `kubernetes` that is the `NetworkPolicy`, so it is `policy`. A
   connection that demands more than its ends provide fails the build.
3. **What checks it is whichever reader has evidence.** A rendered manifest
   for Kubernetes and Knative. A rendered plan for anything a provider mapping
   describes (ADR-0073).
4. **A provider mapping declares the placement kind its workloads satisfy.**
   The mapping already says which resource types are workloads and what they
   dial. It also names the kind. A new provider is then a new mapping file: no
   change to cloister's code and none to the schema. A kind that is neither
   built in nor declared by a loaded mapping is still refused by name.

`kubernetes` and `knative` stay named in code. Cloister parses those manifests
itself, and they are a format, not a vendor.

*Partly built.* Points 1 to 3 are built: every forwarded kind may be a
connection end, with strength `none` unless an emitter enforces it. Of point
4, the mapping now declares the placement kind its workloads satisfy
(`report.bundle.placement`), and that is what a draft writes. The list of
kinds is still closed in code: a mapping may only name a forwarded kind
cloister already knows, so a new provider still needs one line there.

When a forwarded placement gains enforcement, its strength is whatever
ADR-0070 §3 says for it. For Cloud Run that is `policy`, from the invoker IAM
row plus the ingress setting. Both are read today. Neither is compared with
intent yet.

### 7. cluster.toml is what every placement is lowered from

Most people have one description of their system: the one their deployment
tool renders. Running it somewhere else means writing it again by hand, for
Kubernetes or for Docker, and working out which parts change. That is the
struggle this section is for, and it is not specific to any one cloud.

There are two ways to build that. One is a converter per pair: plan to
Kubernetes, plan to Knative, plan to a microVM, each re-deriving the workload
from the plan. The other is one description in the middle that every placement
is lowered from. `cluster.toml` is already that description for the microVM
placement. This section makes it so for all of them:

```
rendered plan ──draft──▶ cluster.toml ──lower──▶ kubernetes manifest
                          (a bundle)  ──lower──▶ (knative, microvm: same bundle)
```

- **Drafting** (`inspect --draft`) reads the plan and writes the bundle.
- **Lowering** (`cluster lower`) reads only `cluster.toml`. It works the same
  on a hand-written file as on a drafted one, and a new placement is a new
  emitter over the same bundle, with nothing to re-derive.

#### What a bundle had to gain

A bundle already held an image, an entry point, arguments and a list of
`name = value` env rows. Three things had nowhere to go. All three are
appended fields; nothing existing changes meaning.

**An env row takes its value from exactly one of three places:**

| Field | Meaning | Same in every placement? |
|---|---|---|
| `value` | A literal. | Yes. |
| `connection` (and `path`) | The address of one of this bundle's connections, with optional text appended. | No. A cluster DNS name on Kubernetes, a route on Knative, a socket in a microVM. The bundle holds the binding and each emitter writes the address. |
| `secret` (and `secretKey`) | A reference to a named secret. | The reference, yes. The value is never in the file. |

A row that sets more than one is refused, and so is a `connection` that names
no connection the bundle declares.

**`runs`** says whether a bundle runs until stopped (`service`, the default)
or to completion (`job`). An emitter picks the object from it. A job may not
expose a port: nothing can depend on reaching something that exits.

#### What the draft does with a plan

Everything a workload is started with is sorted by what it is:

| In the plan | In the draft |
|---|---|
| Image, command, args | The bundle's image, entry point, args. |
| An env value that is a constant in the configuration | An env row with `value`. |
| An env value taken from another workload | An env row with `connection`. |
| An env value from a secret reference | An env row with `secret`. |
| An env value taken from a variable, or anything else unresolved | **Not drafted.** Named at the top of the draft, with where it comes from. |

**Env is read from the plan's configuration, not its planned values.** A
provider may mark a whole env block sensitive because one variable in it is.
The planned values are then withheld, all of them. The configuration still
says, per variable, whether the value is a constant, taken from another
resource, or taken from a variable. Only a constant is copied, and only for a
field the provider's schema does not mark sensitive
([ADR-0073](0073-resource-facts-are-imported-never-granted.md) amendment). A
state document has no configuration, so its env is not drafted.

#### What lowering does

`cloister cluster lower --env <name>` writes, for each bundle placed
`kubernetes` or `knative` in that environment, the manifest its placement row
names: a Deployment and a Service, a Job, or a Knative Service. A `connection` row becomes
`<scheme>://<bundle>.<bundle>.svc.cluster.local:<port>` plus its path. A
`secret` row becomes a `secretKeyRef`, and the manifest says which Secret to
create.

**This changes a rule.** ADR-0070 §2 says cloister owns only the edges of a
forwarded workload, never its spec. That stays true for a manifest the
operator renders. Where there is none, cloister may write one **as a file for
the operator to read, edit and commit, when asked to**. It never applies one,
and it never overwrites one: a manifest that exists is left alone, whoever
wrote it.

**What it writes is checked like anything else.** The lowered manifests are
ordinary input to `cluster k8s`, which holds the addresses in them to the
declared connections and writes the NetworkPolicies. An address that did not
match a declared connection would fail there, by the rule an operator's
manifest is held to.

**Who may call it is translated, not copied.** In a plan that is an access
row: a principal with an invoker role. Locally it is a declared connection,
which `cluster k8s` turns into a NetworkPolicy. A caller that authenticates
with a cloud identity token will still fail locally: that is in the
application, and no manifest changes it.

#### A port is listened on, and it is dialled

A bundle's port had one number. That is two different facts that happen to be
equal most of the time: the number the workload **listens** on, and the number
a peer **dials**. Whatever sits in front of the workload decides the second. A
Knative Service is dialled on 80 whatever its container binds. A Kubernetes
Service maps a `port` to a `targetPort`.

So a bundle's port is the number the workload listens on, and a placement row
may say what it is dialled on there:

```toml
[[bundles.ports]]
name = "http"
port = 8080              # what the workload listens on, everywhere

[[bundles.placements]]
env = "local"
kind = "knative"
manifest = "payments.yaml"

[[bundles.placements.ports]]
name = "http"
port = 80                # what a peer dials in this placement
```

A port with no row is dialled on its own number, so every existing file means
what it meant. A row is allowed only on a forwarded placement: on a
constructed one nothing sits in front of the workload. Every check that is
about what a peer dials uses the dialled number: the address `cluster k8s`
holds to a connection, the Service port, the Knative rule that it is 80. The
NetworkPolicy uses the listened number, because it selects pods.

**The same row says whether the port can be reached from outside there.** A
service that is public in production is usually internal on a developer's
cluster. `expose` on the bundle's port is one word for every placement, so
that could not be said: a port drafted `edge` from a public deployment was
refused by the local Kubernetes step. A placement row may now set `expose`
for that placement only:

```toml
[[bundles.ports]]
name = "http"
port = 8080
expose = "edge"          # as deployed: reachable from outside

[[bundles.placements]]
env = "local"
kind = "kubernetes"
manifest = "payments.yaml"

[[bundles.placements.ports]]
name = "http"
expose = "cluster"       # on this cluster: internal
```

A row may set the number, the exposure, or both. It may not open a port the
bundle keeps to itself (`expose = "none"`): a placement narrows or widens how
a reachable port is reached, and does not make one. `inspect --env <name>`
compares the plan with the port as that environment's placement declares it.
`inspect --draft --local <env>` writes the row when the plan says a service
can be reached from outside.

This is what the Knative emitter needed. The same bundle lowers to a
Deployment and Service (`port: 80, targetPort: 8080` when a row says so) or to
a Knative Service (`containerPort: 8080`, dialled on 80). `inspect --draft
--local <env> --local-kind knative` writes the row for each port.

#### What it does not do

- **A secret binding is not lowered to a microVM.** `runtime plan` refuses a
  `secret` row by name. A launch plan carries no secret, and the credential
  path into a guest is the vault (confinement/v1 §5).

  *Amended 2026-11-19: a `connection` row is lowered.* This list used to say
  neither binding was, because writing an address into a guest was thought to
  need a change to LLO's plan contract. It does not. confinement/v1 §6
  already presents a dial grant on the guest's loopback at the grant's
  `guestPort`, and says a workload learns that address from its
  configuration. The launch plan already carries env. So the row is set to
  `<scheme>://127.0.0.1:<guestPort>` plus its path, with the port taken from
  the same pass that builds the grant. A protocol with no URL form is
  refused, and the refusal says where the channel is presented.
- **An address into another network is refused.** `kubernetes` and `knative`
  share a cluster network, so a bundle on one may be bound to a connection
  into the other (a job is a Kubernetes Job wherever it runs, and may call a
  Knative Service). A target placed anywhere else needs LLO's broker.
- **A path the plan appends to an address is not read** (`"${uri}/sweep"`).
  The configuration lists what a value references, not the text around it.
  The draft says so for each such row, and `path` is where to put it back.
- A probe, a resource limit, a volume, a service account: not in the bundle,
  so not written.
- The Kubernetes lowering is run on a real cluster in CI (`lowered-kind`):
  a declared caller reaches the server, a declared Job completes, and an
  undeclared pod is refused. The Knative lowering is too (`lowered-knative`), on a
  cluster with Knative Serving and Kourier: the Service has no outside route,
  a kubernetes pod reaches it over HTTP, its pod reaches a kubernetes
  Service, and an undeclared pod is refused there.

## Consequences

- **One source of truth for what exists.** The deployment tool's rendered
  output. `cluster.toml` stops being a second copy that drifts.
- **No live cluster is needed** to see the graph. An offline plan is enough.
- **The readers become load-bearing.** A resource type the mapping does not
  read is a node the graph does not have. The report already lists skipped
  types; a draft must say what it could not see, or an operator will take a
  partial graph for the whole one.
- **An address that arrives by a secret is invisible.** A value that comes
  from a secret reference, a mounted file, or a config service is not in the
  rendered output. Such an edge has to be declared by hand. The check reports
  it as unknown, never as absent.
- **Strict naming will bite.** Section 4 trades convenience for never joining
  the wrong two things.
- **cluster.toml gets smaller, and what remains is the part worth reviewing.**

## What exists today

| | State |
|---|---|
| Read a rendered Terraform plan or state | built (ADR-0073) |
| Cloud Run services and jobs, their containers, env, args and ports | built |
| Edges from addresses and from configuration references | built for Cloud Run |
| `ingress` beside a port's `expose` | built (`inspect --terraform --dir`) |
| Access rows (invoker) | read; not compared with intent |
| Addresses in Kubernetes and Knative manifests, held to declared connections | built (`cluster k8s`) |
| §5.1 Check a hand-written `cluster.toml` against the derived graph | built (`inspect --terraform --dir`) |
| §5.2 Draft a `cluster.toml` | built (`inspect --terraform --draft --env`) |
| §7 A bundle carries what a workload is started with: env as literal, connection binding or secret reference; `runs` | built |
| §7 Draft fills it from a plan (`inspect --draft`, `--local`) | built |
| §5.3, §7 Lower a bundle to a Kubernetes manifest (`cluster lower`) | built; applied to a kind cluster in CI (`task smoke:lowered-kind`) |
| §7 A port's dialled number and `expose` per placement (`[[bundles.placements.ports]]`) | built |
| §7 Lower a bundle to a Knative Service | built; applied to a kind cluster with Knative in CI (`task smoke:lowered-knative`) |
| §7 Lower a connection binding to a microVM | built (`runtime plan`): the address the grant presents in the guest, `127.0.0.1:<guestPort>`. Not run on a live microVM in CI |
| §7 Lower a secret binding to a microVM | refused: a launch plan carries no secret, and the credential path into a guest is the vault |
| §4 A bundle's name per environment (`[[bundles.placements]] name`) | built: used by `inspect --env` |
| §6 Any forwarded placement as a checked connection end | built |
| §6 A mapping names the placement kind its workloads satisfy | built; the list of kinds is still closed in code |
| Nodes from Kubernetes resources declared in Terraform | built (a mapping; ADR-0073 amendment 2026-11-19) |
| Edges that arrive by a secret reference (`value_source`) | not read |

## Open questions

- **Aliases.** When the cloud name and the local name differ, where is the
  alias declared, and is it per placement?
- **What a draft does with an existing file.** Merge, or only ever write a
  new file beside it? Section 3 says the operator commits; it does not say how
  a re-draft meets hand edits.
- **Protocols per placement.** The number a port is dialled on is now per
  placement (§7). The scheme is not: a Cloud Run service is reached over
  `https` on 443 by its URL, and `https` to a Knative Service is refused
  today.
- **Reachability as intent: settled for what exists.** `expose` on a port is
  where an operator says "internal only" once. It is held to Knative's route
  visibility when a manifest is checked (ADR-0070 amendment), and compared
  with the plan's own setting by `inspect` (Cloud Run's `ingress`): evidenced,
  unknown, or `contradicted`. A provider mapping names the setting and sorts
  its values into "cluster" and "edge" (`report.bundle.exposure`), so the
  comparison names no provider. A draft takes `expose` from it, and a
  placement row may set `expose` for one placement (§7), so a service that is
  public in production can be declared internal on a local cluster.
- **Sub-files.** Whether `cluster.toml` may include other files, so a large
  graph's connections live apart. Not decided here.

## Out of scope

- Applying anything. Cloister still runs no deployment tool.
- Reading templates, in any language.
- Deciding what enforcement Knative gets (ADR-0070 §2 amendment leaves it
  open).
