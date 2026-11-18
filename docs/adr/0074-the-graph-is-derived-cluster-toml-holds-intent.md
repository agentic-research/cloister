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

### 5. Checking comes before drafting, and drafting before lowering

In order, each useful without the next:

1. **Check.** Compare a hand-written `cluster.toml` with the derived graph:
   each declared connection is evidenced or unknown, each derived edge is
   declared or undeclared, and workloads with no bundle are listed. *Built.*
2. **Draft.** Write a `cluster.toml` from the derived graph for the operator
   to review. *Not built.*
3. **Lower.** From the declared graph, write each workload's configuration
   for a placement: the addresses it should dial there. This is the env
   lowering ADR-0070 lists as not built, and it is what "runnable locally"
   needs. *Not built.*

### 6. A placement that is only checked is still a placement

A connection end must today be placed `microvm`, `kubernetes` or `knative`.
A bundle placed `cloudRun` cannot be a connection end, so the production side
of a Cloud Run deployment cannot be declared at all.

`cloudRun` should become a connection end that is checked and not lowered,
the way `knative` is (ADR-0070 §2 amendment): its strength stays `none` until
something enforces it, so a connection that demands more fails the build. The
check for it is the plan comparison in step 1 above. *Not built; proposed
here.*

When Cloud Run is lowered, its strength is what ADR-0070 §3 already says:
`policy`, from the invoker IAM row plus the ingress setting. Both are read
today. Neither is compared with intent yet.

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
| Access rows (invoker) and `ingress` | read; not compared with intent |
| Addresses in Kubernetes and Knative manifests, held to declared connections | built (`cluster k8s`) |
| §5.1 Check a hand-written `cluster.toml` against the derived graph | built (`inspect --terraform --dir`) |
| §5.2 Draft a `cluster.toml` | not built |
| §5.3 Lower addresses per placement | not built |
| §6 `cloudRun` as a checked connection end | not built |
| Nodes from Kubernetes resources declared in Terraform | not built |
| Edges that arrive by a secret reference (`value_source`) | not read |

## Open questions

- **Aliases.** When the cloud name and the local name differ, where is the
  alias declared, and is it per placement?
- **What a draft does with an existing file.** Merge, or only ever write a
  new file beside it? Section 3 says the operator commits; it does not say how
  a re-draft meets hand edits.
- **Ports and protocols.** A Cloud Run service is reached on 443 by its URL
  and listens on a container port. A Knative Service is reached on 80. A
  connection declares one port by name. Whether a bundle's port is per
  placement is not settled, and `https` to a Knative Service is refused today.
- **Reachability as intent.** How an operator says "internal only" once, so it
  is checked against Cloud Run's `ingress` in one placement and Knative's
  route visibility in another.
- **Sub-files.** Whether `cluster.toml` may include other files, so a large
  graph's connections live apart. Not decided here.

## Out of scope

- Applying anything. Cloister still runs no deployment tool.
- Reading templates, in any language.
- Deciding what enforcement Knative gets (ADR-0070 §2 amendment leaves it
  open).
