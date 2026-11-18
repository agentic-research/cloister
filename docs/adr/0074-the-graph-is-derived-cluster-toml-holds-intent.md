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

### 7. Lowering writes a workload, and says what it could not carry

Most people have one description of their system: the one their deployment
tool renders. Running it somewhere else means writing it again by hand, for
Kubernetes or for Docker, and working out which parts change. That is the
struggle this section is for, and it is not specific to any one cloud.

`cloister cluster lower --terraform <plan> --from <env> --to <env> --out <dir>`
writes a `cluster.toml` and one Kubernetes manifest per workload. A workload
that runs until stopped becomes a Deployment and a Service. One that runs to
completion becomes a Job.

Everything a workload is started with is sorted into one of three kinds, and
each manifest says at the top which is which:

| Kind | What happens | Example |
|---|---|---|
| **Carried** | Written as the plan has it. | The image, args, command, an env value that is a constant in the configuration. |
| **Rewritten** | Different in every placement, so written for this one. | An env value taken from another workload: its address. It becomes that workload's in-cluster name. |
| **Not derivable** | Not written. Named, with where it comes from. | A value taken from a variable. The contents of a secret. |

A secret reference is the one mixed case. The reference is carried, as a
`secretKeyRef` to a Secret of the same name. The value is not in a plan and is
never written, so the manifest says which Secret to create.

**This changes a rule.** ADR-0070 §2 says cloister owns only the edges of a
forwarded workload, never its spec. That stays true for a manifest the
operator renders. Here there is no such manifest, and writing one is the
point. So: cloister may write a workload's spec **as a file for the operator
to read, edit and commit, when asked to**. It never applies one, and it never
edits one it did not write. `--out` must be new or empty, so a second run
cannot replace an edited file.

**What it writes is checked like anything else.** The lowered manifests are
ordinary input to `cluster k8s`, which holds the addresses in them to the
declared connections and writes the NetworkPolicies. A rewritten address that
did not match a declared connection would fail there, by the same rule an
operator's manifest is held to.

**Env is read from the plan's configuration, not its planned values.** A
provider may mark a whole env block sensitive because one variable in it is.
The planned values are then withheld, all of them. The configuration still
says, per variable, whether the value is a constant, taken from another
resource, or taken from a variable. Only a constant is copied, and only for a
field the provider's schema does not mark sensitive
([ADR-0073](0073-resource-facts-are-imported-never-granted.md) amendment). A
state document has no configuration, so lowering needs a plan.

**Who may call it is translated, not copied.** In the plan that is an access
row: a principal with an invoker role. Locally it is a declared connection,
which `cluster k8s` turns into a NetworkPolicy. Each manifest states both. A
caller that authenticates with a cloud identity token will still fail
locally: that is in the application, and no manifest changes it.

What it does not do:

- An address that the plan builds by appending a path (`"${uri}/sweep"`) is
  rewritten to the bare address. The configuration lists what a value
  references, not the text around it. Each rewritten variable says so.
- It lowers to plain Kubernetes only. Knative and microVM are not written.
- A probe, a resource limit, a volume, a service account: not read, not
  written.
- It has not been run against a live cluster.

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
| §5.2 Draft a `cluster.toml` | built (`inspect --terraform --draft --env`) |
| §5.3 Lower a plan to local Kubernetes manifests (`cluster lower`), §7 | built; not yet run against a live cluster |
| §7 Lower to Knative, or to a microVM | not built |
| §6 Any forwarded placement as a checked connection end | built |
| §6 A mapping names the placement kind its workloads satisfy | built; the list of kinds is still closed in code |
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
