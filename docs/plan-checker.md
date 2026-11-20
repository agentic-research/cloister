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

Download `cloister-plan.mjs` and `cloister-plan.mjs.sha256` from a
[`plan-checker/v*` release](https://github.com/agentic-research/cloister/releases),
and check one against the other:

```sh
sha256sum --check cloister-plan.mjs.sha256
```

That file is the whole checker. Run it with `node`, from anywhere.

Or build it from a checkout:

```sh
task plan:bundle        # writes dist/cloister-plan.mjs
```

Either way, it is the same code as `cloister inspect`. A test runs every
sample plan in this repository through both, and requires the same output.

## Try it on the sample

The sample is a rendered plan for a small Kubernetes app: a `server`, a
`caller` that dials it, and a `probe` job that does too. It is
`test/fixtures/terraform/kubernetes-plan.show.json`, rendered from
`kubernetes-plan.tf` beside it.

```sh
cp test/fixtures/terraform/kubernetes-plan.show.json plan.json

# Draft the file.
node cloister-plan.mjs --terraform plan.json --draft --env prod --name sample > cluster.toml

# Check the plan against it. Both calls are evidenced.
node cloister-plan.mjs --terraform plan.json --env prod --dir .
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
node cloister-plan.mjs --terraform plan.json --draft --env prod > cluster.toml
```

Keep `plan.json` out of git: a rendered plan can hold values from your
configuration, and the checker refuses a plan git tracks. Read the draft
before you rely on it. Where the plan does not say something, the draft says
so instead of guessing.

What it reads today: Google (Cloud Run and the like), Cloudflare and
Kubernetes resources, and `wrangler.toml` with `--wrangler`.

## In CI

`--fail-on` turns findings into an exit code: 3 when a finding of a kind you
name is reported, 0 when none is. 1 means the check could not run, and 2 that
it was called wrongly. It needs a `cluster.toml`, because with nothing
declared nothing could be undeclared.

```sh
node cloister-plan.mjs --terraform plan.json --env prod --dir . --fail-on undeclared,contradicted
```

In a GitHub workflow, the action does the download, the digest check and the
job summary:

```yaml
- run: terraform show -json plan.out > "$RUNNER_TEMP/plan.json"
- uses: agentic-research/cloister/actions/plan-check@plan-checker/v0.1.0
  with:
    plan: ${{ runner.temp }}/plan.json
    dir: infra          # where cluster.toml is
    env: prod
    # fail-on: undeclared,contradicted   (the default)
```

The result is the job's status and its summary. It comments on nothing. Pin a
`plan-checker/v*` tag: the action downloads that tag's release, and refuses
any other ref.

## Then what

The `cluster.toml` you leave with is the file the rest of cloister runs from.
It can lower that file to Kubernetes manifests with NetworkPolicies, run it as
a local cluster, or show every edge and what holds it. None of that is needed
to check a plan. When you want it, start at the [README](../README.md).
