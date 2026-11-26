# Check a Terraform plan

This page covers one job: point cloister at a Terraform plan, see which of
your services call which, and find out where the plan and your own
description of that disagree. It needs Node 22 and one file. Nothing else
from cloister is installed.

## What it does

From the JSON of a rendered plan (`terraform show -json`), the checker:

- **drafts** a `cluster.toml`: the services the plan creates, and who calls
  whom, read from addresses in their environment, Kubernetes services, and
  the like;
- **checks** the plan against a `cluster.toml`, and reports each call as
  `evidenced` (declared, and the plan shows it), `undeclared` (the plan makes
  it, the file does not say it may), `contradicted` or `unknown`.

It reads the plan and writes nothing but what you redirect. It never reads a
secret's value: where an address is kept in a secret, it reports where, not
what.

## Get it

Download `cloister.mjs` and `cloister.mjs.sha256` from a
[`cli/v*` release](https://github.com/agentic-research/cloister/releases),
and check one against the other:

```sh
sha256sum --check cloister.mjs.sha256
```

That file is the cloister CLI, built to need nothing but Node. Run it with
`node`, from anywhere. It runs the commands that read nothing from a cloister
checkout, the plan checker (`inspect`) first among them, and says so by name
for the others; `node cloister.mjs --help` lists which.

Or build it from a checkout:

```sh
task bundle        # writes dist/cloister.mjs
```

Either way, it is the same code as the `cloister` command. A test runs every
sample plan in this repository through both, and requires the same output.

## Try it on the sample

The sample is a rendered plan for a small Kubernetes app: a `server`, a
`caller` that dials it, and a `probe` job that does too. It is
`test/fixtures/terraform/kubernetes-plan.show.json`, rendered from
`kubernetes-plan.tf` beside it.

```sh
cp test/fixtures/terraform/kubernetes-plan.show.json plan.json

# Draft the file.
node cloister.mjs inspect --terraform plan.json --draft --env prod --name sample > cluster.toml

# Check the plan against it. Both calls are evidenced.
node cloister.mjs inspect --terraform plan.json --env prod --dir .
```

Now take `probe`'s connection out of `cluster.toml`: the `[[connections]]`
block with `from = "probe"`, and the `[[bundles.external.env]]` row in
`probe` that names it. Check again:

```
Findings:
  evidenced   caller → server (connection "server", env prod): env SERVER_URL
  undeclared  probe dials server (Kubernetes deployments; env SERVER_URL), and cluster.toml declares no such connection
```

That second line is the point: the plan makes a call nobody declared.

## On your own plan

```sh
terraform plan -out plan.out
terraform show -json plan.out > plan.json
node cloister.mjs inspect --terraform plan.json --draft --env prod > cluster.toml
```

Keep `plan.json` out of git: a rendered plan can hold values from your
configuration, and the checker refuses a plan git tracks. Read the draft
before you rely on it. Where the plan does not say something, the draft says
so instead of guessing.

What it reads today: Google (Cloud Run and the like), Cloudflare and
Kubernetes resources (the provider's typed resources, and Deployments,
StatefulSets, DaemonSets, Jobs, Services, Namespaces and Knative Services
written as `kubernetes_manifest`), and `wrangler.toml` with `--wrangler`. Anything else
is named on the report's "Not read" line.

A bundle is one container. A Cloud Run or Knative service with a sidecar is
drafted from the container that serves (the only one allowed a port), and the
draft names the sidecar. A Kubernetes pod of several containers is not
drafted, since Kubernetes does not say which one serves.

## Kinds cloister does not ship

A custom resource cloister has no schema for (an operator's own, or a
vendor's) is read once your checkout supplies two things:

- **The CRD**, as your cluster has it (`kubectl get crd <name> -o yaml`, or
  the vendor's release file). Each path an entry reads is checked against it.
- **An entry** that says what the kind means, in a mapping file. A CRD gives a
  kind's shape, not its meaning, so the entry says that it is a workload, and
  where its pod template is. `podTemplate` reads the template as a
  Deployment's is:

  ```json
  { "types": { "kubernetes_manifest example.com/v1 Widget": {
    "name": "metadata.name",
    "read": ["metadata.namespace"],
    "podTemplate": "spec.template",
    "report": { "section": "Widgets", "show": ["metadata.namespace"],
      "bundle": { "placement": "kubernetes", "container": { "list": "containers" },
        "image": { "list": "containers", "value": "image" } } }
  } } }
  ```

Name both in `cluster.toml`, so CI and a local run check the same way:

```toml
[inspect]
mappings = ["deploy/inspect.mapping.json"]

[[inspect.crds]]
file = "deploy/crds/widgets.yaml"                 # every environment

[[inspect.crds]]
env = "prod"                                      # only where the plan describes prod
file = "deploy/crds/prod/widgets.yaml"
replaces = ["example.com/v1 Widget"]              # in prod, instead of the row above
```

A row that defines a kind something else already defines must list that kind
in `replaces`. That covers cloister's own projection of a kind (a Knative
Service, say) and, for a row naming an environment, a row for every
environment. An overlap a row does not list is refused, and so is a listed
kind with nothing to replace: nothing is decided by precedence. When cloister
ships an entry for the kind, that entry is checked against the CRD that
replaced its schema, and a path the CRD lacks refuses the run. Paths are
relative to `cluster.toml` and inside the checkout.

`--crd <file>` and `--mapping <file>` add files for one run, and `--draft`
takes them this way. A file a flag adds may only add kinds. The report starts
with what the checkout's files checked: each kind, its schema, what that
replaced, and the entry that read it.

## In CI

`--fail-on` turns findings into an exit code: 3 when a finding of a kind you
name is reported, 0 when none is. 1 means the check could not run, and 2 that
it was called wrongly. It needs a `cluster.toml`, because with nothing
declared nothing could be undeclared.

```sh
node cloister.mjs inspect --terraform plan.json --env prod --dir . --fail-on undeclared,contradicted
```

`--json` prints the report in a published format: `InspectReport` in
[`schema/cli.schema.json`](../schema/cli.schema.json), with a
`formatVersion`. A minor version only adds fields; refuse a major version you
do not know. Each finding names its kind, what it is about (`subject`) and
what it rests on (`basis`).

In a GitHub workflow, the action does the download, the digest check and the
job summary:

```yaml
- run: terraform show -json plan.out > "$RUNNER_TEMP/plan.json"
- uses: agentic-research/cloister/actions/plan-check@cli/v0.1.0
  with:
    plan: ${{ runner.temp }}/plan.json
    dir: infra          # where cluster.toml is
    env: prod
    # fail-on: undeclared,contradicted   (the default)
```

The result is the job's status and its summary. It comments on nothing. Pin a
`cli/v*` tag: the action downloads that tag's release, and refuses
any other ref.

## Then what

The `cluster.toml` you leave with is the file the rest of cloister runs from.
It can lower that file to Kubernetes manifests with NetworkPolicies, run it as
a local cluster, or show every edge and what holds it. None of that is needed
to check a plan. When you want it, start at the [README](../README.md).
