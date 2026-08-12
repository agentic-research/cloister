# cloister

Cloister runs an AI coding tool with access only to the folders and services you
choose.

You list the tools you want in `cluster.toml`. Cloister gives your coding tool
one local address for reaching them, and blocks everything else at the operating
system.

It works with Claude Code, Codex, and anything else that speaks MCP.

## Install

You need Node.js 22 or newer, Rust, and [Task](https://taskfile.dev).

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

Credentials work two ways. **Custody** vaults your API key — the tool never sees
it, cloister makes the call and returns the result. **Audit** lets a Claude
subscription through and records what it did, because a subscription token
cannot be vaulted. Set `ANTHROPIC_API_KEY` for custody; see
[docs/RUNNING.md](docs/RUNNING.md) for audit.

## Serve your tools to an editor

```sh
cloister dev serve       # http://localhost:8787/mcp
```

Point any MCP client at that URL. Every tool in `cluster.toml` is there.

## What a run leaves behind

A run writes `.harness-skills.json` in the first repo you named: which skills
loaded, their fingerprints, and whether they matched `cluster.toml`.

It does not yet record every file, process, or network attempt. The operating
system still blocks them, and your tool reports the failure its own way. A
recorder is tracked as `cloister-879a5a`. The docs will not claim that coverage
before the runtime can prove it.

## Three things that will bite you

**The allow-list was built by hitting errors.** It covers `git` and Claude Code.
A tool needing something else will fail — and on macOS that can look like a
developer-tools install prompt rather than "permission denied".

**Isolation differs by platform.** macOS uses Seatbelt, Linux uses Landlock.
What each can enforce is not the same, and the differences are written down
rather than smoothed over. See
[docs/security/threat-model.md](docs/security/threat-model.md).

**Local databases are not encrypted at rest.** Beads, trust state, and blob
digests sit in plain SQLite files wherever you point the runtime. Vault
ciphertexts inside those files are encrypted; the rest is not. Don't put
production-sensitive data in a dev install.

## How it fits together

Cloister routes. It does not execute.

Its router and built-in tools run on `workerd`. External tools are reached as
native processes, OCI services, UDS peers, or HTTP services.

For isolated execution, cloister signs a request and hands it to
[ley-line-open](https://github.com/agentic-research/ley-line-open), which owns
the sandbox: rootfs, confinement, lifecycle, receipts. Cloister never starts a
microVM itself.

Identity, credential vaulting, and the signed audit trail sit below the tool
layer, so a new tool inherits them without asking.

## What it is not

**Not an MCP server.** MCP is the most visible thing it serves, not what it is.
Other protocols plug into the same router.

**Not Kubernetes.** You bring a container runtime. Cloister gives you the
manifest and the wiring.

**Not a sandbox you can forget about.** It blocks what it says it blocks, on the
platforms it says, and the gaps are written down.

## The rest of the family

| Repo | Role |
|---|---|
| cloister | Edge router — this repo |
| [ley-line-open](https://github.com/agentic-research/ley-line-open) | Execution, confinement, content addressing |
| [notme](https://github.com/agentic-research/notme) | Identity authority |
| rosary | Orchestration and work tracking |
| mache | Code intelligence |
| signet | Key exchange |

## Where to go next

- **Set it up** — [GETTING-STARTED.md](GETTING-STARTED.md)
- **Run a coding tool, in full** — [docs/RUNNING.md](docs/RUNNING.md)
- **How it works inside** — [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **What it defends, and what it doesn't** —
  [docs/security/load-bearing-claims.md](docs/security/load-bearing-claims.md)
  and [docs/security/threat-model.md](docs/security/threat-model.md)
- **Why things are the way they are** — [docs/adr/](docs/adr/), with a
  [generated index](docs/adr/INDEX.md). Start at 0001 → 0002 → 0007 → 0011.
- **Every doc** — [docs/README.md](docs/README.md)

## Development

```sh
task lint      # ~2s gate — run before every commit
task test      # workerd integration, real DOs
task verify    # strict CI gate
```

Three ways to start the server locally — `task dev` (hot reload),
`task serve:local` (raw workerd), `task cluster:dev` (native topology). Same
code, different hosts. [GETTING-STARTED.md](GETTING-STARTED.md) has the details
and the one macOS path caveat.

Contributions: read [CLAUDE.md](CLAUDE.md) first. It is short, and it is the
house style.
