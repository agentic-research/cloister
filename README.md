# cloister

Cloister checks that a set of services may only reach what you said they may,
and runs them that way.

You write the intent in one file, `cluster.toml`: what services there are,
which ports they open, and which of them may connect to which. Cloister holds
your existing deployment to that file, and it can run the same services
locally with everything else blocked.

It does the same for an AI coding tool: the tool gets the folders and services
you name, and nothing else.

## Contents

- [What you can do with it](#what-you-can-do-with-it)
- [Start from what you already have](#start-from-what-you-already-have)
- [Install](#install)
- [Run a coding tool inside it](#run-a-coding-tool-inside-it)
- [Serve your tools to an editor](#serve-your-tools-to-an-editor)
- [Describe a cluster](#describe-a-cluster)
- [What a run leaves behind](#what-a-run-leaves-behind)
- [Things that will bite you](#things-that-will-bite-you)
- [How it fits together](#how-it-fits-together)
- [What it is not](#what-it-is-not)
- [The rest of the family](#the-rest-of-the-family)
- [Where to go next](#where-to-go-next)
- [Development](#development)

## What you can do with it

| You have | You want | Command |
|---|---|---|
| A Terraform or OpenTofu plan | To see which service calls which, and who may invoke it | `cloister inspect --terraform` |
| That plan and a `cluster.toml` | To know where the two disagree | `cloister inspect --terraform --dir` |
| Kubernetes or Knative manifests | Each service held to its declared connections, plus network policies | `cloister cluster k8s` |
| A repository and a coding tool | The tool confined to that repository | `cloister run --harness` |
| Tools that speak MCP | One local address for all of them | `cloister dev serve` |

None of these needs the others. Start with the row that matches what you have.

## Start from what you already have

Most people arrive with infrastructure that already works. Cloister reads what
your tools render. It does not read templates, and it does not run your tools.

### A Terraform or OpenTofu plan

```sh
terraform show -json plan.out > plan.json
cloister inspect --terraform plan.json
```

The report lists each service, what it is started with, the other services it
dials, and who may invoke it. A plan is enough: nothing has to be deployed.
When a value is marked sensitive, the report says which environment variable
the edge comes from and does not print the value.

Add `--dir` to compare the plan with a `cluster.toml`:

```sh
cloister inspect --terraform plan.json --dir . --env prod
```

Each declared connection is reported as `evidenced` or `unknown`. An edge the
plan implies with no connection declared for it is reported as `undeclared`.

What it reads today: Cloud Run services and jobs, their IAM invoker rows, and
Cloudflare resources. A resource type it does not read is listed as skipped.
An address that arrives through a secret reference is not in the plan, so that
edge shows as `unknown`. `inspect` reports and never changes anything.

### Kubernetes or Knative manifests

```sh
cloister cluster k8s --env local --out ./out
```

For each service placed on Kubernetes, cloister checks the rendered manifest
against the ports you declared, copies it unchanged, and writes a namespace
with a default-deny `NetworkPolicy` and one policy per declared connection.

It also reads the addresses each container is started with: environment
(through `envFrom`, `valueFrom` and `$(VAR)` references), args and command. An
address that names another service with no declared connection fails the
build.

A Knative Service is checked the same way, and nothing is written for it.

### What is not built yet

You still write `cluster.toml` by hand. Drafting it from a plan is the next
step, and writing each service's addresses for a local cluster comes after
that. [ADR-0074](docs/adr/0074-the-graph-is-derived-cluster-toml-holds-intent.md)
records the direction and what exists.

## Install

You need Node.js 22 or newer, Rust, [Task](https://taskfile.dev), and the
Cap'n Proto compiler with its standard schemas (`brew install capnp` on macOS;
`apt-get install capnproto libcapnp-dev` on Debian/Ubuntu, where the compiler
and the schemas are separate packages). On Linux the install also links
libdbus (`libdbus-1-dev pkg-config`).

```sh
task install             # dependencies + the `cloister` command
cloister dev bootstrap   # one-time local setup
```

## Run a coding tool inside it

```sh
cloister run --harness claude-code --repo /abs/path/to/repo
```

That command can read and write the repository you name. Everything else is
blocked: other repositories, SSH keys, cloud credentials, the open internet.

Add `--dry-run` to see what would be allowed without starting anything.

It works with Claude Code, Codex, and anything else that speaks MCP.

Credentials work two ways. **Custody** vaults your API key: the tool never
sees it, cloister makes the call and returns the result. **Audit** lets a
Claude subscription through and records what it did, because a subscription
token cannot be vaulted. Set `ANTHROPIC_API_KEY` for custody; see
[docs/RUNNING.md](docs/RUNNING.md) for audit.

## Serve your tools to an editor

```sh
cloister dev serve       # http://localhost:8787/mcp
```

Point any MCP client at that URL. Every tool in `cluster.toml` is there.

## Describe a cluster

`cluster.toml` is the one file you edit. A service is a *bundle*. An allowed
edge between two bundles is a *connection*. Where a bundle runs in a given
environment is its *placement*.

```toml
[metadata]
name = "shop"
version = "0.1.0"

[storage]
doStoragePath = "/data/do"

[[bundles]]
name = "orders"
kind = "external"
tier = "cluster"

[bundles.external]
image = "example.com/orders:1"

[[bundles.placements]]
env = "local"
kind = "kubernetes"
manifest = "orders.yaml"

[[bundles]]
name = "payments"
kind = "external"
tier = "cluster"

[bundles.external]
image = "example.com/payments:1"

[[bundles.ports]]
name = "http"
port = 8080
appProtocol = "art.http"
expose = "cluster"

[[bundles.placements]]
env = "local"
kind = "kubernetes"
manifest = "payments.yaml"

[[connections]]
from = "orders"
name = "payments"
appProtocol = "art.http"
minStrength = "policy"

[[connections.targets]]
env = "local"
bundle = "payments"
port = "http"
```

The file has a published schema,
[`schema/cluster.toml.schema.json`](schema/cluster.toml.schema.json), so an
editor can complete and check it as you type. A key the schema does not define
is refused, not dropped.
[docs/reference/cluster-toml-schema.md](docs/reference/cluster-toml-schema.md)
explains how to turn that on.

### Placements

A connection is only as strong as the weaker of its two ends. If you set
`minStrength` and the placements cannot meet it, the build fails.

| Placement | What holds a connection | Strength |
|---|---|---|
| `microvm` | The service has only the sockets it was granted | `capability` |
| `kubernetes` | A `NetworkPolicy` per connection | `policy` |
| `knative` | Checked against the manifest; nothing enforces it | `none` |
| `cloudRun` | Read by `inspect`; cannot be a connection end yet | `none` |
| `workerd` | Service bindings inside the router | not a connection end |

### Commands

```sh
cloister init --recipe <name> --out <dir>   # start from a known-good example
cloister add <ref>                          # add a tool to cluster.toml
cloister cluster generate                   # validate, then write the generated files
cloister cluster up --env local             # start the microVM-placed bundles
cloister cluster k8s --env local --out out  # check and write the Kubernetes side
```

Every command is in [docs/reference/cli.md](docs/reference/cli.md).

## What a run leaves behind

A coding-tool run writes `.harness-skills.json` in the first repo you named:
which skills loaded, their fingerprints, and whether they matched
`cluster.toml`.

It does not yet record every file, process, or network attempt. The operating
system still blocks them, and your tool reports the failure its own way. A
recorder is tracked as `cloister-879a5a`. The docs will not claim that coverage
before the runtime can prove it.

## Things that will bite you

**The allow-list was built by hitting errors.** It covers `git` and Claude Code.
A tool needing something else will fail, and on macOS that can look like a
developer-tools install prompt and not like "permission denied".

**Isolation differs by platform.** macOS uses Seatbelt, Linux uses Landlock.
What each can enforce is not the same, and the differences are written down.
See [docs/security/threat-model.md](docs/security/threat-model.md).

**Local databases are not encrypted at rest.** Beads, trust state, and blob
digests sit in plain SQLite files wherever you point the runtime. Vault
ciphertexts inside those files are encrypted; the rest is not. Don't put
production-sensitive data in a dev install.

**Names must match exactly.** A bundle and a resource in a plan are the same
thing only when they have the same name. A service named differently in the
cloud and locally shows up as not found.

**A checked placement is not an enforced one.** `knative` and `cloudRun` are
read and compared. Nothing cloister writes stops a connection there.

## How it fits together

Cloister declares, checks and routes. It does not own a sandbox.

Its router and built-in tools run on `workerd`. External tools are reached as
native processes, OCI services, UDS peers, or HTTP services.

For isolated execution, cloister writes a signed plan and hands it to
[ley-line-open](https://github.com/agentic-research/ley-line-open), which owns
the sandbox: rootfs, confinement, lifecycle, receipts. `cloister cluster up
--env` starts each microVM-placed bundle that way, in connection order.

For Kubernetes, cloister writes policy and your cluster enforces it. For a
cloud deployment, it reads the rendered plan and reports.

Identity, credential vaulting, and the signed audit trail sit below the tool
layer, so a new tool inherits them without asking.

## What it is not

**Not an MCP server.** MCP is the most visible thing it serves, not what it is.
Other protocols plug into the same router.

**Not a deployment tool.** It runs no `terraform` and no `kubectl`. It reads
what they render, and writes files for you to apply.

**Not a template parser.** It reads a rendered plan or manifest. It does not
read HCL or Helm charts.

**Not a sandbox you can forget about.** It blocks what it says it blocks, on the
platforms it says, and the gaps are written down.

## The rest of the family

| Repo | Role |
|---|---|
| cloister | Declared connections, checks, edge router (this repo) |
| [ley-line-open](https://github.com/agentic-research/ley-line-open) | Execution, confinement, content addressing |
| [notme](https://github.com/agentic-research/notme) | Identity authority |
| [mache](https://github.com/agentic-research/mache) | Code intelligence |
| rosary | Orchestration and work tracking |
| signet | Key exchange |

## Where to go next

- **Set it up**: [GETTING-STARTED.md](GETTING-STARTED.md)
- **Run a coding tool, in full**: [docs/RUNNING.md](docs/RUNNING.md)
- **Every command**: [docs/reference/cli.md](docs/reference/cli.md)
- **The `cluster.toml` schema**:
  [docs/reference/cluster-toml-schema.md](docs/reference/cluster-toml-schema.md)
- **How it works inside**: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **What it defends, and what it doesn't**:
  [docs/security/load-bearing-claims.md](docs/security/load-bearing-claims.md)
  and [docs/security/threat-model.md](docs/security/threat-model.md)
- **Why things are the way they are**: [docs/adr/](docs/adr/), with a
  [generated index](docs/adr/INDEX.md). Start at 0001 → 0002 → 0007 → 0011.
- **Every doc**: [docs/README.md](docs/README.md)

## Development

```sh
task lint      # ~2s gate, run before every commit
task test      # workerd integration, real DOs
task verify    # strict CI gate
```

Three ways to start the server locally: `task dev` (hot reload),
`task serve:local` (raw workerd), `task cluster:dev` (native topology). Same
code, different hosts. [GETTING-STARTED.md](GETTING-STARTED.md) has the details
and the one macOS path caveat.

Where things are:

| Directory | Holds |
|---|---|
| `src/` | The router that runs on `workerd` (tests in `test/`) |
| `cli/` | The `cloister` command (tests in `cli/test/`) |
| `manifest/`, `schema/` | The `cluster.toml` schema and what is published from it |
| `lint/` | The checks `task lint` runs |
| `gen/` | Code generators and build steps |
| `dev/` | Local launchers, smoke tests, benchmarks, git hooks |
| `rs/` | Rust: wasm verifiers and the host runtime |
| `recipes/` | Starter clusters for `cloister init` |

Contributions: read [CLAUDE.md](CLAUDE.md) first. It is short, and it is the
house style.
