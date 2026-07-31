# Running a harness in cloister

`cloister run` executes a coding harness confined to the repositories you name.
Everything else — other repos, `~/.ssh`, the network — is denied by the kernel.

This page is written to be followed. Where a step has not been verified
end-to-end, it says so rather than implying it has.

---

## What you get

```
cloister run --harness claude-code --repo /abs/path/to/repo
```

| | |
|---|---|
| the repos you name | read + write |
| every other repo | `EPERM` |
| `~/.ssh`, `~/.aws`, `~/.config/gcloud`, shell history, `~/.npmrc` | `EPERM` |
| outbound network | `PermissionError [Errno 1]` — denied before a packet leaves |
| `127.0.0.1` → cloister | reachable; the only egress, which is what makes cloister the route tools arrive by |

Confinement is **inherited by descendants**. Verified three levels deep across a
language boundary — a shell spawning a shell spawning python:

```
[d0] sh      granted repo:      REPO-FILE
[d1] sh      ungranted sibling: Operation not permitted
[d2] python  ~/.ssh:            Operation not permitted
[d2] python  egress:            PermissionError [Errno 1]
```

So a skill's bash spawning python spawning `curl` is bounded by the same policy.
A `skills.sh` that pulls from the internet simply fails.

Multiple repos: `--repo` repeats. The first is the primary and becomes the
harness's working directory.

```
cloister run --harness claude-code --repo /abs/api --repo /abs/shared
```

---

## Getting `cloister` on your PATH

`cloister` is not on your PATH until you put it there. `which cloister` returning
nothing is the expected starting state, not a broken install.

```sh
cd /path/to/cloister
task install                 # installs deps, then symlinks into ~/.local/bin
cloister --help
```

Override the destination with `CLOISTER_BIN_DIR` if `~/.local/bin` is not on your
PATH. `task uninstall` removes it, and refuses if the target is not a symlink
into this checkout.

Deliberately a task rather than `pnpm link --global`: that is a package-manager
incantation that mutates the machine, and installing cloister is cloister's to
own. The symlink points INTO the checkout, so it follows the branch you are on —
re-run `task install` if you move the checkout.

Without installing, every command below works as `node scripts/cloister-cli.mjs …`
from the repo root.

**You run `cloister` from anywhere** — it is `--repo` that says which tree the
harness is confined to, not your working directory. That is the whole point:

```sh
cd ~/anywhere
cloister run --harness claude-code --repo ~/github/art/ley-line-open
```

---

## Prerequisites

**1. An API key — not your subscription.**

```sh
export ANTHROPIC_API_KEY=sk-ant-…
```

This is the one thing most likely to surprise you, and it is **by construction,
not an oversight**. Claude Code authenticates a Max/Pro subscription through the
macOS Keychain, and a confined process cannot reach the Keychain:

- granting the keychain *file* changes nothing — access is mediated by
  `securityd` over mach/XPC, not by reading the file;
- nono exposes no mach/XPC grant;
- `deny_keychains_macos` is in nono's **default** profile, inherited by every
  agent profile it ships.

Two independent lines of reasoning land in the same place: Anthropic's seat
token is harness-bound by policy, and the sandbox denies keychains by design.

With a key set, cloister uses the **custody lane**: the key is vaulted and
injected at the proxy, and never enters the harness's environment. Without one,
the run launches and the harness reports *"Not logged in"* — cloister warns
about this before minting anything.

**2. One-time bootstrap.**

```sh
task dev:bootstrap      # writes .env.local (gitignored) with the vault KEK
```

`cloister run` checks for `.env.local` **before minting**, so a missing
bootstrap fails with a named error and leaves nothing behind. That ordering is
deliberate: minting is the security-relevant step, and a half-bootstrapped tree
with a stray credential is worse than a clean refusal.

This is a prerequisite for **`cloister run` only**. `task lint`, `task test` and
`task verify` do not need it and must never need it — a gate that required a
local credential to run would be a gate contributors could not run.

**3. Ports 8787 and 8799 free.** A run starts cloister on `:8787` and the lease
shim on `:8799`. Nothing checks these are free first — see *Known gaps*.

**4. Companion Workers (optional).** A run may declare service bindings to other
Workers — cloister's own `wrangler.toml` binds `env.NOTME` to `notme-bot`. A
service binding only connects to another `wrangler dev` running locally, so
without one the run prints:

```
env.NOTME (notme-bot)   Worker   local [not connected]
```

That reads as a broken binding; it means nothing local is running that Worker.
Point cloister at the checkout and the run starts it for you:

```sh
export CLOISTER_WORKER_DIR_NOTME_BOT=~/remotes/art/notme/worker
```

The env-var name derives from the service name
(`CLOISTER_WORKER_DIR_<SERVICE>`, uppercased, non-alphanumerics to `_`), and the
SET of companions comes from the `[[services]]` entries wrangler.toml already
declares — adding a binding needs no second list. Only the machine-specific
*path* is an env knob, deliberately: ADR-0026 bans committed local paths because
they silently win over the declared `ref`.

Unset is not fatal — it costs only the routes that binding serves. For
`cloister run` that is `/identity/*` and the notme-sourced CA bundle; a dev run
uses `DEV_CA_MASTER` as its authority and touches neither.

**5. The confinement binary.** Built automatically on first run
(`tools/harness-sandbox`, ~4 min cold). Or ahead of time:

```sh
task harness:sandbox:build
```

---

## Try it without launching anything

```sh
cloister run --harness claude-code --repo /abs/repo --dry-run
```

Prints the boundary — workspaces, egress, what is denied — and mints nothing,
writes nothing, launches nothing.

```sh
cloister run --harness claude-code --repo /abs/repo --setup-only
```

Mints the ephemeral dev identity and writes `.dev.vars`, without launching. Both
are useful for checking your setup before a demo.

---

## Skills

Skills reach the harness through `~/.claude/skills`, which is inside the granted
state dir. They are **declared and digest-verified** (ADR-0061), and a run
reports what it saw:

```
harness:dev — skills: 56 UNDECLARED · <root>/.harness-skills.json
```

One line on stdout; the full picture — every skill, its digest, verified vs
undeclared — goes to the receipt file, because a wall of names on every run is
how a real warning becomes scrollback.

```sh
cloister skills list                 # pinned / unpinned / undeclared / CHANGED
cloister skills pin                  # prints declarations to paste
cloister skills pin --write          # appends them to cluster.toml
```

`pin` prints by default and does not edit your manifest. Pinning says *"I have
looked at these bytes and I vouch for them"*, and a command that rewrote the
manifest silently would turn vouching into a keystroke — the reflex after a
failed verification is to re-run it.

**What verification does and does not give you.** It is checked at **load**: you
know what was present when the run started, and a substituted skill fails the
run. It is not continuous — see *Known gaps*.

---

## Owning your own cluster

Cloister's own `cluster.toml` is the reference topology. Your tools belong in a
cluster you own:

```sh
cloister init --recipe agent-cluster --out ~/my-cluster
cd ~/my-cluster
task up          # or: cloister cluster up --dir .
task down        # volumes preserved — DO SQLite state lives there
```

The scaffold ships a `Taskfile.yml` whose every task delegates to the CLI, so a
cluster you own behaves exactly like the reference one.

---

## Known gaps

Stated because a demo that hits one of these unprepared is worse than one that
avoids it.

**The full launch path is verified.** A real run mints, brings up cloister on
`:8787` and the shim on `:8799`, verifies the §7 confinement commitment, launches
the harness kernel-confined, and emits `cloister/credential-isolation/v1`
receipts with a real `peerFp` — including a 200 through the vault proxy with NO
API key set, via passthrough.

That run also surfaced a bug `claude doctor` could not: the harness creates a
per-uid runtime dir at `/tmp/claude-<uid>` using a FIXED path, so redirecting
`TMPDIR` does not cover it and dropping the blanket `/tmp` grant produced
`EPERM: mkdir '/tmp/claude-501'`. Now granted as that one directory, so the
cross-run channel a blanket `/tmp` opens stays closed.

**The grant list was discovered by hitting errors** (`cloister-cd30a6`). `git`
works — that took `/var`, `/etc`, `~/.config/git`, `~/.gitconfig` and
`~/.gitignore_global`, each found when something failed. The list is complete
only up to what has been exercised: `claude doctor` and `git`. A tool that needs
something else will fail, and on macOS the failure may be a **developer-tools
install dialog** rather than a clear denial.

**Skills are verified at load, not continuously.** The skills directory stays
writable because nono's grants are a union — a read grant does not narrow a
writable parent — so a skill substituted mid-run is caught on the *next* run.
Relocating the skills tree behind a symlink closes this; see ADR-0061.

**Ports ARE checked now, fail-closed.** A run refuses to start if 8787, 8799 or
a companion's port (8810+) is held, and names how to find and clear the holder.

This is not tidiness. `wrangler dev` does not fail on a busy port — it moves to
the next free one. So a leaked cloister on 8787 meant the next run bound 8788
while the health check polled 8787 and got a healthy 200 **from the stale
server**: the run reported success while the shim talked to an old build. Five
leaks accumulated that way during testing (8787–8791).

The leak itself is fixed too — each run owns its process group, so teardown
takes `task → wrangler → workerd` with it instead of only the leader.

**No subscription auth**, as above. Custody lane only.

**A run receipt was public for a while.** `.harness-skills.json` records which
skills a run saw. It is gitignored, but it was committed before the ignore
existed — and .gitignore does nothing to a file git already tracks — so one
copy, carrying a home path and 56 skill names, reached this public repo. It is
untracked now and a gate rail (`no-ignored-tracked.test.mjs`) cross-checks the
ignore list against the index so the next one fails CI instead of shipping.
History was deliberately left alone: skill names are not credentials, and
rewriting a public repo breaks every clone.

---

## See also

- [`docs/reference/cli.md`](reference/cli.md) — every command, derived from one declaration
- [ADR-0060](adr/0060-harness-selector-is-not-the-executable.md) — why a target's selector is not its executable
- [ADR-0061](adr/0061-skills-declared-and-verified.md) — skills declared and digest-verified, and what that does not claim
- [ADR-0042](adr/0042-turnkey-harness-dev-run.md) — the turnkey local run this packages
