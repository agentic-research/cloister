# Getting started with cloister

This is the hands-on path: install, run, smoke-test, wire upstreams, install
the Claude Code plugin, verify the full chain. About 5–10 minutes if you
already have node + pnpm; longer if you also need to spin up `ley-line-open`
or `notme`.

For the *why* and *how it's shaped*, read [README.md](README.md) →
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) →
[ADR-0001](docs/adr/0001-workerd-mcp-gateway.md) →
[ADR-0002](docs/adr/0002-edge-router-protocol-agnostic-backends.md).

## 1. Prerequisites

| Tool       | Why                                              |
| ---------- | ------------------------------------------------ |
| `node 18+` | runs the worker bundle (via wrangler) and the CC plugin's hook script |
| `pnpm 10`  | package manager (locked in `package.json`)       |
| `task`     | optional, runs Taskfile.yml entries              |

Optional, only needed if you want the relevant backends working:

| Tool                          | Enables                                                   |
| ----------------------------- | --------------------------------------------------------- |
| `ley-line-open` daemon        | `lsp_*` + `reparse` / `enrich` / `status` MCP tools       |
| `notme` worker                | `/identity/*` proxy (JWT, passkeys, agent certs)          |
| `rosary` MCP HTTP             | `rsry_*` orchestration, bead, and dispatch tools           |
| `workerd` binary              | running directly without wrangler / Cloudflare account    |
| `libkrunfw` (macOS arm64, `brew install libkrunfw`) | the guest kernel for the microVM tier (path D) |

## 2. Install + bootstrap

```sh
git clone https://github.com/agentic-research/cloister
cd cloister
pnpm install
task dev:bootstrap    # generates .env.local with DEV_VAULT_KEK (gitignored)
```

The bootstrap step is one-time and idempotent. It writes a per-user
dev KEK to `.env.local` per [ADR-0014 v2](docs/adr/0014-pluggable-kek-source.md);
without it `task dev` will refuse to start (the vault DO requires
`VAULT_KEK_SOURCE` to resolve to real key material — no plaintext
fallback in committed config). The file stays out of git.

Run the test suite to confirm everything compiles:

```sh
task lint            # tsc + worker tests + plugin tests (fast — ≤2s)
task verify          # lint + external-process harnesses (slower, CI gate)
```

Tests don't read `.env.local` — `vitest.config.ts` wires its own
`KEK_HELPER` stub. So you can run `task lint` without bootstrap; only
`task dev` / `task serve:local` need it.

`lint` is the inner-loop gate; `verify` adds:
- `wire:verify-roundtrip` — substrate equivalence vs the capnp CLI (requires `capnp` on PATH)
- `smoke:leyline-stub` — production codec ↔ real HTTP socket ↔ stub-companion (spawns Node)

If you don't have `task`:

```sh
pnpm exec tsc --noEmit
pnpm exec vitest run                    # workerd integration tests
node --test hooks/test/*.test.mjs       # CC plugin tests
```

## 3. Run a coding tool inside cloister

This is probably why you are here, so it comes before the server details.

```sh
task install     # puts `cloister` on your PATH (~/.local/bin)
cloister run --harness claude-code --repo /abs/path/to/your/repo
```

The tool can read and write the repos you name. Everything else — your other
repos, your SSH keys, your cloud credentials, the network — is refused by the
operating system, not by asking the tool nicely. Anything the tool starts is
covered by the same rules, so a script that shells out to Python that shells out
to `curl` still cannot reach the network.

Look before you leap:

```sh
cloister run --harness claude-code --repo /abs/path/to/repo --dry-run
```

That prints exactly what will be reachable and starts nothing.

One thing to know up front: **this needs an API key, not a Claude subscription.**
A subscription signs in through the macOS keychain, and the sandbox blocks
keychain access on purpose — so the tool would just report "not logged in".

```sh
export ANTHROPIC_API_KEY=sk-ant-…
```

Full walkthrough, including what is still rough: [docs/RUNNING.md](docs/RUNNING.md).

## 4. Run cloister locally

Three equivalent paths — same code, different launcher.

### Path A — `wrangler dev` (hot reload, easiest, single process)

```sh
task dev             # → http://localhost:8787
```

### Path B — `workerd serve` (no Cloudflare account, matches the apko image)

```sh
task build:local     # bundles src/ → dist/index.js + dist/config.capnp
task serve:local     # workerd serve dist/config.capnp --experimental
```

**Where DO SQLite lands:** Path B writes to `/data/do` by default
(matches the apko image's mount point per `apko.yaml:50`). On Linux
hosts, create the directory once: `sudo mkdir -p /data/do && sudo
chown "$USER" /data/do`.

**macOS — or any host where `/data` isn't writable:** export
`CLOISTER_DO_PATH` to a user-writable location before `task build:local`:

```sh
mkdir -p "$HOME/.local/share/cloister/do"
export CLOISTER_DO_PATH="$HOME/.local/share/cloister/do"
task build:local --force    # `--force` because env-var changes don't invalidate the cache
task serve:local
```

The `emit-workerd-config` step prints the resolved path on every
build (`do-storage path = ... (via CLOISTER_DO_PATH)`) so you always
know where workerd is writing. Default behavior is unchanged for the
OCI image and Linux hosts that have `/data/do` set up. Per
[ADR-0023](docs/adr/0023-host-path-resolution.md).

Path A (`task dev`, wrangler) uses `.wrangler/state/` instead — no
setup, no env-var needed. Pick Path A for fastest local iteration;
pick Path B (with `CLOISTER_DO_PATH` on macOS) when you want the
workerd-direct path closer to the OCI image's runtime shape.

**OCI image path (third option for macOS, mirrors production):**
`task image:run` composes the full build → load → retag → docker run
pipeline so `/data/do` lives inside the container's writable
filesystem. One command:

```sh
task image:run                   # build + load + run, foreground
task image:run -- -d             # extra `docker run` args after `--`
task image:run -- --name dev     # name the container
```

This is the closest local approximation to how cloister runs in
production. Use it when you specifically want to validate the OCI
image path; for most dev iteration, `CLOISTER_DO_PATH` + Path B is
faster.

> **⚠️ DO SQLite is unencrypted at rest.** Whichever path you pick
> (`/data/do`, `.wrangler/state/`, `$CLOISTER_DO_PATH`, or
> `$HOME/.cache/cloister-dev/do/` for `cluster:dev`), the DO SQLite
> databases — beads, trust state, blob digests, vault ciphertext
> metadata — live on disk in plaintext SQLite files. The vault
> ciphertexts *inside* those files ARE AES-GCM-encrypted (per
> ADR-0013/0014); the bead/trust/blob tables are not. Don't drop
> production-sensitive data into a dev install. On-disk
> encryption-at-rest of the SQLite files themselves is an open
> follow-on (no ADR yet — file one if you need it).

### Path C — `task cluster:dev` (full cluster topology, mac-native)

Per [cluster.toml](cluster.toml), spawns cloister-router **plus**
sibling bundles (notme-identity, mache, rosary) as native processes
with UDS sockets in `/tmp/cloister-dev/run/`. Missing binaries are
skipped with hints — you can dev cloister-router alone if mache/rosary
aren't built. See
[docs/deployment/cluster-in-a-pod.md](docs/deployment/cluster-in-a-pod.md).

```sh
CLUSTER_DEV_DRY_RUN=1 task cluster:dev   # preview the launch plan
task cluster:dev                          # spawn it
```

All three paths bind cloister-router on `:8787`. Storage paths differ
slightly (`wrangler` uses `.wrangler/state/...`, `workerd` uses
`/data/do` per `config.capnp`, `cluster:dev` uses
`$HOME/.cache/cloister-dev/do/`); the DO API is identical.

### Optional path D — a workload in a microVM (macOS arm64)

This path runs one workload inside its own microVM, separate from the local
Cloister router. It is not required for Wrangler, direct `workerd`, or the
native-process cluster path.

```sh
brew install libkrunfw       # the guest kernel; the VMM itself ships with LLO
cloister runtime install     # installs LLO's digest-pinned leyline-krun-worker
cloister runtime doctor      # expect "microVM: available"
cloister runtime run /absolute/plan.json
```

`runtime install` fetches `leyline-krun-worker` from the pinned ley-line-open
release, verifies it against `schema-bridge.lock.json`, and creates the
content-addressed store under `~/.local/state/cloister/` (`cas/` for root
filesystems, `run/` for per-run state, cleaned after each run). There is no
separate storage step. `cloister runtime run` waits for the guest: a workload
that exits non-zero is reported as a run failure (exit 1), not a launch refusal.

**What runs today, and what does not yet.** The microVM tier runs a plan whose
root filesystem is in the store, addressed by `blake3-256:` digest. An OCI
image gets there through LLO's importer:

```sh
cloister runtime import --layout /path/to/oci-layout --image sha256:<index-or-manifest-digest>
# prints LLO's import record; "rootfs" is the plan's blake3-256 artifact digest
```

The input is an OCI image *layout* (`oci-layout` plus `blobs/sha256`), pinned by
digest. A docker store is not a layout, and tags are refused. Produce one with
`skopeo copy docker://…@sha256:… oci:DIR` or `docker buildx … --output
type=oci`. The importer verifies every blob, selects the host's Linux platform,
and refuses what rootfs manifest v1 cannot express: symlinks (use `--symlinks
resolve` to copy in-image targets; dangling links still fail), and device
nodes. One known gap: an entrypoint at the rootfs root (`/hello`, common in
scratch images) exits 127 on LLO v0.27.0 unless a workspace is mounted
(ley-line-open-fe130c). Entrypoints under a directory (`/bin/…`) run. On
v0.28.0 a root entrypoint (`/orders`) has been seen running.

For a bundle in `cluster.toml`, import with `--bundle`. It imports the image the
lock pins (`[inputs.<bundle>.oci] digest`; `--image` may be omitted, and must
match if given) and records the result beside the pin:

```sh
cloister runtime import --bundle dolt --dir <cluster-dir> --layout <oci-layout-dir>
# cluster.lock.toml: [inputs.dolt.oci] rootfs = "blake3-256:…"
```

`cloister runtime plan` and `cluster up` run that recorded rootfs, never the
`sha256:` image. A microvm bundle whose lock has no rootfs, or whose rootfs is
not in the store, is refused, and the refusal prints the `runtime import`
command to run. `cluster resolve` keeps a recorded rootfs while the image digest
is unchanged, and drops it when the image moves.

**From `cluster.toml` to running microVMs.**

```sh
cloister cluster up --env local --dir <cluster-dir>
```

This starts every bundle placed `microvm` in the env. A connection's target
starts before its source, and a cycle is refused. Each bundle counts as bound
once every socket it binds exists. That means a dependent can be granted its
channel. Health is not checked, so it is not called ready ([ADR-0071](docs/adr/0071-who-owns-a-running-workload.md) §3), and
the workload may not be listening yet. Since LLO v0.29.0 a serve channel holds
a connection that arrives before the workload listens, for up to 10 s, instead
of closing it; a client that connects later than that still retries. Sockets live in a fresh owner-only directory under
`/private/tmp` (macOS's real `/tmp`: libkrun refused a socket path through the
`/tmp` symlink). Each exposed port's `unix://` path is printed, and the
directory is removed on exit.

`up` stays in the foreground. Ctrl-C (or SIGTERM, SIGHUP, SIGQUIT) stops every
run in reverse order: the host runtime cancels its run through LLO, which kills
the worker's process group. If `up` is killed with `kill -9`, each host runtime
sees its stdin close and stops its run. A second signal while stopping reports
progress, and a third SIGKILLs the host runtimes. Their krun workers can then
outlive them until ley-line-open-f963e6. If
any run ends on its own, the rest are stopped and `up` exits non-zero, naming
the bundle and its status. Kubernetes-placed bundles are skipped with a pointer
to `cluster k8s`. Every run is also stopped at its wall-clock ceiling, which is
15 minutes for now; a service cannot yet ask for "no ceiling"
(ley-line-open-e6b1bb). The host runtime exits 124 for that stop, and `up`
reports it as the ceiling, not as a workload failure. A worked example from a
clean checkout is
[`tools/dolt-grpc-demo/microvm/`](tools/dolt-grpc-demo/microvm/README.md).

A plan carrying `fs.allow`, credentials, or `port.bind` is refused by name
("authority mapping … is not implemented") rather than run with its grants
silently dropped. Mapping them onto LLO's confinement manifest is tracked on
`cloister-991e65`.

The one grant the tier does map is confinement/v1 §6, `unixSocket.allow`.
Each entry is a host UNIX socket path, a mode (empty = connect, `bind` =
serve), and optionally a `guestPort`. With a guestPort, an unmodified workload
sees the channel as TCP on `127.0.0.1:<guestPort>`. For example, Dolt
`sql-server` with a `bind` grant on 3306 is reachable from the host as
`mysql --socket=<path>`. Since LLO v0.29.0 every guest has a bounded tmpfs
`/tmp`, so a rootfs no longer needs to ship one.

You don't write these grants by hand. Declare ports and connections in
`cluster.toml`, and `cloister runtime plan` derives the grants for a `microvm`
bundle:

```toml
# inside the `dolt` [[bundles]] entry (an external bundle, executionMode = "microvm")
[[bundles.ports]]
name = "mysql"
port = 3306
appProtocol = "art.mysql"
expose = "cluster"

[[connections]]
from = "orders"
name = "orders-db"
appProtocol = "art.mysql"

[[connections.targets]]
env = "local"
bundle = "dolt"
port = "mysql"
```

```sh
cloister runtime plan orders --workspace /tmp/ws --env local --channel-dir /tmp/cloister-host-runtime/ch
```

Each exposed port becomes a `bind` grant on `<channel-dir>/<bundle>.<port>.sock`
with `guestPort` set to the port. Each connection becomes a connect grant on the
target's socket, so the `dolt` plan binds the same path the `orders` plan
connects to, and the two plans join without a broker. `--env` (default `local`)
picks which target row is used. `--channel-dir` (default
`/tmp/cloister-host-runtime/ch`) must be a canonical absolute path short enough
that every socket path fits in 103 bytes, with no trailing slash. You don't
need to create it: before a launch, the host runtime creates any missing parent
directory of a `bind` grant's socket with mode 0700. LLO refuses to start a
guest whose bind directory is missing. A parent that exists but is not a
directory (a symlink included) is refused.

`runtime plan` validates `cluster.toml` with the same pipeline as
`task cluster:toml`, so a typo'd key or a duplicate bundle fails here too. An
exposed port or a connection is allowed only on an external
`executionMode = "microvm"` bundle (a port with `expose = "none"` is allowed
anywhere), and such a bundle's name must be a DNS label. §6 grants can't be
written by hand under `confinement`; they come only from ports and connections.

Apart from those declared channels, the guest has no network at all. There is
no virtual NIC, UDP is denied, and undeclared loopback ports are refused. That
is the isolation property this tier exists for.

### Editing the cluster shape

Add a bundle, change a wire, tweak storage paths? Edit
[`cluster.toml`](cluster.toml) at the repo root, then run:

```sh
task cluster:toml                          # parse + render cluster.ts + re-canonicalize cluster.toml
```

That single verb does the full operator workflow: parses your edit,
validates it against `ClusterSchema`, regenerates
`src/generated/cluster.ts`, then rewrites `cluster.toml` in canonical
form (alphabetical key order within tables, integer
normalization like `httpPort = 9_999`, bundle-group placement). Commit
both files.

Two ancillary tasks for non-routine cases:

```sh
task cluster:toml:roundtrip                          # drift gate — task verify runs this
task cluster:toml:export -- --write cluster.toml     # reverse-only (rare — when you edited cluster.ts directly)
```

`cluster.toml` is the operator surface ([ADR-0025](docs/adr/0025-bidi-toml-pipeline.md));
`cluster.capnp` + `manifest/cluster.capnp` remain the substrate
schema authority. `src/generated/cluster.ts` is a derived artifact
(committed for review-time visibility; regenerated whenever
cluster.toml changes). The TOML reader fail-fasts on schema or
semantic violations — garbage in, error out.

## 5. Smoke tests

Always works (no upstreams required):

```sh
# Liveness + backend snapshot
curl -s http://localhost:8787/health | jq

# List the MCP tools cloister exposes (bead_* + lsp_* + lifecycle)
curl -s -X POST http://localhost:8787/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}' \
  | jq '.result.tools[].name'

# Create + list a bead (uses the BEAD_STORE Durable Object — no network)
curl -s -X POST http://localhost:8787/mcp \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc":"2.0","id":1,"method":"tools/call",
    "params":{"name":"bead_create","arguments":{"repo":"/tmp/demo","title":"hello"}}
  }' | jq
```

You should see ~31 tools: 6 `bead_*`, 5 `lsp_*`, 3 lifecycle (`reparse`,
`enrich`, `status`), plus the mache tool family (dynamic — count varies
with the mache build, typically 17 `mache_*` tools). Mache requires
its sibling binary to be reachable at `MACHE_MCP_URL` (default
`http://localhost:7532/mcp`); without it the `mache_*` family is
absent from the list and other tools still work.

## 6. Wire upstreams (only what you need)

### a) `ley-line-open` — for `lsp_*` and `reparse` / `enrich` / `status`

Start the daemon on whatever port matches `LLO_MCP_URL` in
`wrangler.toml` / `config.capnp` (default `8384`):

```sh
leyline daemon --mcp-port 8384
```

Verify cloister can reach it:

```sh
curl -s -X POST http://localhost:8787/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"status","arguments":{}}}' | jq
```

Expect `{"phase":"ready",...}`. If you see
`-32603 "LLO unreachable"` the daemon isn't up; if you see
`"LLO_MCP_URL not configured"` your env didn't pick up the binding.

### b) `notme` — for `/identity/*`

```sh
cd ../notme/worker
wrangler dev --port 8788
```

Then from cloister:

```sh
curl -s http://localhost:8787/identity/health | jq
```

If notme isn't running, `/identity/*` returns 503 — the rest of cloister
keeps working.

### c) Production wiring — not yet constructible

> **This section described a topology that cannot currently be built.**
> Corrected 2026-07-28 (`cloister-af3d5d`, `ley-line-open-6569de`). It
> previously said to point `LLO_MCP_URL` at `notme-proxy` and "make sure
> notme-proxy is forwarding to your daemon's UDS socket". There is no such
> socket to forward to.

The intent stands: cloister should reach `ley-line-open` **through**
`notme-proxy`, which presents an attested bridge cert, so no Worker ever
holds a credential. `notme-proxy` is declared as a bundle
(`[[bundles]] name = "notme-proxy"`) and wired as `COMPANION` in
`cluster.toml`.

What blocks it: `notme-proxy`'s companion role dials `AF_UNIX`, and the
`ley-line-open` daemon serves MCP over **TCP only** (`--mcp-port` /
`--mcp-bind`). Its Unix socket carries LLO's line-delimited JSON **ops**
protocol, not MCP — so there is nothing MCP-shaped for the companion to
dial. Tracked as `ley-line-open-6569de`.

Until that lands, cloister reaches the daemon over loopback TCP. Note what
that costs: with the daemon's ADR-0022 token gate disabled there is no
identity on the hop, and with no identity there is nothing for scope to
bind to — so `task smoke` verifies **dispatch**, not authorization. Do not
read a green smoke as evidence the trust surface works.

See [ADR-0002](docs/adr/0002-edge-router-protocol-agnostic-backends.md#capability-boundary).

## 7. Install the CC plugin (optional but recommended)

Keeping `lsp_*` fresh during long Claude Code sessions is handled by
**ley-line-open's** `leyline-stale-sync`, not by cloister. It auto-fires
`reparse` on every Edit/Write/MultiEdit/NotebookEdit, talking to the LLO
daemon directly:

```sh
# In a Claude Code session:
claude plugin add ~/path/to/ley-line-open/wrappers/claude-code
```

See
[wrappers/claude-code/README.md](https://github.com/agentic-research/ley-line-open/tree/main/wrappers/claude-code)
for the plugin contract and configuration.

> Cloister shipped its own `cloister-stale-sync` (routing `reparse`
> through cloister at `:8787`) until 2026-07-27. It was retired:
> ley-line-open owns the parse / LSP surface per ADR-0035, and installing
> both plugins double-fires `reparse` on every edit.

## 8. Verify the full chain

The fast path: `task smoke` spins up leyline + cloister on private ports,
exercises the full chain, and tears everything down. Use this in CI or
whenever you want a single-command "is the chain wired?" check.

```sh
task smoke
```

The script (`scripts/e2e-smoke.sh`) is dev-mode — it talks to leyline
directly rather than going through `notme-proxy`, since notme-proxy
requires a real bridge cert pair. From cloister's perspective the
behavior is identical; only the transport differs.

If you'd rather drive it manually with `leyline daemon --mcp-port 8384`
and cloister running:

```sh
# 1. Edit a file (any way you like)
echo 'fn main() {}' > /tmp/demo/main.rs

# 2. Trigger reparse (the plugin does this automatically on Edit/Write)
curl -s -X POST http://localhost:8787/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"reparse","arguments":{"source":"/tmp/demo/main.rs"}}}'

# 3. Now lsp_hover sees the new content
curl -s -X POST http://localhost:8787/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call",
       "params":{"name":"lsp_hover","arguments":{"file":"/tmp/demo/main.rs","line":0,"col":3}}}'
```

If the second call returns `fn main()` info, the chain
`CC → cloister → LLO` is wired correctly.

## 9. Ship it as a container

```sh
task apk:keygen   # one-time — generate the melange signing key
task image        # melange build → apko compose → cloister.tar
docker load < cloister.tar
docker run -p 8787:8787 -v $(pwd)/data:/data cloister:latest
```

`task image:check` parses `melange.yaml` + `apko.yaml` end-to-end without
running a real build — handy in CI. The output image is distroless: workerd
+ the cloister bundle, runs as uid `65532`, no shell, no pkgmgr. See
[docs/ARCHITECTURE.md#packaging-melange--apko](docs/ARCHITECTURE.md#packaging-melange--apko)
for the layout.

## 10. Hardening for prod

When you move past local dev, set:

```sh
# Comma-separated; supports a single :* port glob per entry. Disallowed
# origins get the "null" sentinel back, which browsers refuse.
ALLOWED_ORIGINS="https://app.example.com,http://localhost:*"
```

**Activate the Interlace lease gate** (ADR-0007). The lease pipeline
runs when `INTERLACE_ROOT_PUBKEY` is set; unset (the default) leaves
cloister in dev-mode where `/mcp` accepts unauthenticated requests.
Wrangler uses `.dev.vars` for local-dev overrides:

```sh
# .dev.vars (gitignored by default; create if you don't have one)
INTERLACE_ROOT_PUBKEY=<base64-of-master-pubkey>
INTERLACE_MASTER_PUBKEY=<same>
INTERLACE_DISCLOSURE_HMAC_KEY=<random-hmac-key>
# Interlace 0.2.0 receipts (optional Phase 1 emit; Phase 2 cutover is operator action)
RECEIPT_SIGNING_KEY=<base64-of-receipt-signer-64-byte-keypair>
RECEIPT_EPOCH=1
```

> **Why `.dev.vars` and not `.env.local`?** wrangler's `[vars]` block
> in `wrangler.toml` is overridden by `.dev.vars`; `.env.local` only
> feeds the shell-sourced KEK path (`VAULT_KEK_SOURCE` / `DEV_VAULT_KEK`,
> per `task dev:bootstrap`). Setting `INTERLACE_ROOT_PUBKEY` in
> `.env.local` does NOT activate the lease gate — wrangler's dev
> runtime doesn't auto-thread shell env to declared `[vars]`. This
> was the discovery in
> [`docs/launch/PRE-LAUNCH-VERIFICATION.md`](docs/archive/launch/PRE-LAUNCH-VERIFICATION.md)
> (cloister-e14804, fixed by wiring the activation vars into
> `wrangler.toml [vars]` with empty defaults).

Production deploys use `wrangler secret put <NAME>` instead of
`.dev.vars`. With the gate active, `POST /mcp` requires a Signet lease
cert; bundles like notme issue them.

**Optional — opt into the rsry/bd bead substrate** (cloister-c8b907):

```sh
# wrangler.toml [vars] or .dev.vars
BEAD_STORAGE_BACKEND="rsry"
```

When unset / empty / unknown, defaults to `"do"` — the legacy
BeadStore DurableObject path. Setting `"rsry"` routes Step 2 of the
bead_create orchestrator through rsry's `rsry_bead_create` MCP tool
via the ROSARY_BUNDLE service binding. Both paths preserve the §13.4
audit chain via the bead_id link on `peer_attestations` (sub-bead 1).
The structured log event `bead_create.legacy_backend` fires once per
isolate cold-start when on the legacy path; grep for it in CF Workers
Logs / wrangler tail to know which deployments are still on `"do"`.
Default flip is tracked under `cloister-f34f7b`. See
[ADR-0033](docs/adr/0033-bd-substrate-binding.md) D5 amendment for the
full migration shape.

**Other prod knobs:**
- mount `/data` as a persistent volume for the DO SQLite files (the
  apko image expects `/data/do` writable; the local self-host workflow
  in Path B above mkdirs this)
- run the `leyline-sign-helper` (`task helper:start` or the systemd /
  launchd unit at LLO's `rs/ll-open/sign/supervisor/`) with
  `LEYLINE_SIGN_CALLER_TOKENS` populated + `--require-auth` (templates
  pass the flag; ADR-0019 + threat-model §15)
- terminate TLS at a reverse proxy (cloister speaks HTTP at the
  workerd boundary; TLS is upstream of the substrate)

### Vault KEK — never in committed config

The credential vault DO derives its envelope-encryption KEK from a
secret resolved at boot. Per [ADR-0014 v2](docs/adr/0014-pluggable-kek-source.md)
(amendment 2026-05-12, `cloister-125199`), `VAULT_KEK_SOURCE` MUST be
a non-empty URL spec — empty/unset throws at vault-DO construction.
The legacy `VAULT_KEK_SECRET` plaintext text binding has been deleted.

For **local dev**: `task dev:bootstrap` writes a per-user KEK to
`.env.local` (gitignored) with `VAULT_KEK_SOURCE=env://DEV_VAULT_KEK`.
That's it — no Keychain setup needed, no sidecar to run. The future
v2b amendment will tighten `env://` to require an age-encrypted carrier;
for now plain hex bytes in `.env.local` is the dev path.

For **self-host / production**, the vault DO supports these schemes:

| Scheme | Where the KEK lives |
|---|---|
| `env://NAME` (today) | a workerd text/secret binding. v2b will require age-encrypted carrier. |
| `file:///path/to/file` | a directory mounted via a `disk` service binding (`KEK_DISK`) |
| `keychain://service-name` | macOS Keychain — via the `leyline-sign-helper` Rust binary (LLO's `rs/ll-open/sign/`, ADR-0019). |
| `secret-tool://service-name` | Linux libsecret (Secret Service) — same `keyring` crate backend as `keychain://`. |
| `keyring://service/account` | Explicit-form keyring URI (both halves in the URI). Use when `KEYCHAIN_ACCOUNT` is not the right account selector. |
| `op://vault/item/field` | 1Password — via the `op` CLI. Requires `LEYLINE_SIGN_OP_BIN` env var pointing to an absolute path of the `op` binary (e.g. `/opt/1Password/bin/op`). |
| `apple-password://server/account` | Apple Passwords — via macOS `security` CLI. Requires `LEYLINE_SIGN_SECURITY_BIN` (typically `/usr/bin/security`). macOS-only. |
| `http(s)://helper/...` | any HTTP-reachable helper bound as `KEK_HELPER` (legacy / off-host helpers) |

> **Migration complete (2026-05-18 — Phase F):** the legacy
> `scripts/kek-helper.mjs` JS sidecar is superseded by the
> `leyline-sign-helper` Rust binary per
> [ADR-0019](docs/adr/0019-sign-only-helper-protocol.md). The Rust
> helper performs Ed25519 signing host-side and returns only
> signatures, never key bytes — closing the heap-isolation gap
> [ADR-0018](docs/adr/0018-notme-co-location.md) requires. Tracking
> beads `cloister-99165e` (binary build) + `cloister-993bef` (kek-helper
> migration) shipped via PR #1 and PR #2; Phase F (script deletion)
> landed 2026-05-18.

The macOS-Keychain self-host flow:

```sh
# 1. Stash a high-entropy KEK in your login keychain (one-time setup).
security add-generic-password \
  -a cloister -s com.cloister/kek \
  -w "$(openssl rand -hex 32)"

# 2. Start the leyline-sign-helper Rust binary (separate process —
#    workerd is a sandboxed V8 isolate with no `child_process`).
task helper:start    # binds 127.0.0.1:8786 by default

# 3. Tell cloister to use it. Wire KEK_HELPER as a service binding
#    in config.capnp / wrangler.toml pointed at the helper port,
#    and set:
export VAULT_KEK_SOURCE="keychain://com.cloister/kek"

# 4. Launch.
task dev
```

The helper refuses to bind to anything but loopback and enforces
bearer-token auth via `LEYLINE_SIGN_CALLER_TOKENS`; under
`--require-auth` (production-default) it refuses to start without
tokens configured. **Don't expose the helper remotely.**

Since `cloister-2a0faa` (2026-05-13) the helper supports up to six
keystore schemes, split across two Cargo features per the inline
adversarial cycle (threat-model §17.1):

- **Default `host` feature** (`task rs:sign:helper` default build):
  `keychain://`, `secret-tool://`, `keyring://service/account`,
  `file://`. Direct `keyring = "3"` crate dep; no `nono`; no sigstore
  / aws-lc-rs / landlock closure. `cargo tree --features
  leyline-sign/host` ≈ 245 lines.
- **Opt-in `host-extras` feature** (`cargo build --features
  host,host-extras`): additionally enables `op://vault/item/field` and
  `apple-password://server/account`. Pulls in `nono = "0.54"` for URI
  validators; the subprocess dispatch stays cloister-side with
  absolute-path pinning + `env_clear` allow-list. Operators MUST pin
  `LEYLINE_SIGN_OP_BIN` / `LEYLINE_SIGN_SECURITY_BIN` to absolute
  paths; the shim refuses unset/missing paths with a structured 404 to
  avoid PATH-hijack vectors. `cargo tree --features "leyline-sign/host
  leyline-sign/host-extras"` ≈ 559 lines.

`file://` stays in cloister's own reader (binary-safe + multi-CRLF
trim per the legacy `kek-helper.mjs` golden vector preserved for
parity) under both features.

The helper additionally supports a per-caller URL allow-list for
`POST /sign` via `LEYLINE_SIGN_SIGN_ALLOW=<caller>=<prefix>[,<prefix>...][;...]`.
See ADR-0019 §"Normative requirements" #14 for the grammar + worked
examples. Production deploys should pass `--require-sign-allow`.

**Round-trip dogfood check** (proves Keychain → helper → bytes works
end-to-end on your machine):

```sh
NAME="cloister-kek-test-$(date +%s)"
KEK_HEX="$(openssl rand -hex 32)"
security add-generic-password -a cloister -s "$NAME" -w "$KEK_HEX"
task helper:start > /tmp/leyline-sign-helper.log 2>&1 &
sleep 1
RESOLVED="$(curl -s "http://127.0.0.1:8786/resolve?url=keychain://$NAME")"
[ "$RESOLVED" = "$KEK_HEX" ] && echo "OK: round-trip $RESOLVED" || echo "FAIL"
kill %1 2>/dev/null
security delete-generic-password -a cloister -s "$NAME"
```

Validated end-to-end on macOS 2026-05-11 (cloister-268a01) against the
JS sidecar, and re-validated 2026-05-13 against the Rust helper
(cloister-2a0faa). If you see `FAIL`, check
`/tmp/leyline-sign-helper.log` — usually means the helper didn't bind
(port in use) or the `security` CLI isn't on PATH.

For OCI / Cloudflare deployments where "Keychain" isn't a thing,
use `env://NAME` populated via `wrangler secret put` (for CF Workers)
or a docker secret mounted into the container env (for the apko
image) — the file/keychain backends are explicitly for bare-metal
self-host. The legacy plaintext `VAULT_KEK_SECRET` text binding is
gone per ADR-0014 v2; production paths use the URL-spec resolver
end-to-end.

### Off-platform peers (CF Tunnel / WARP)

Cloister doesn't run a userspace WireGuard daemon — workerd has no kernel
access and the distroless apko image runs unprivileged. Off-platform
peers (laptops, IoT, agents in another constellation, self-hosted
services behind NAT) reach cloister through Cloudflare's edge: the peer
runs `cloudflared` (server-shaped) or `WARP` (client-shaped — literally
WireGuard managed by Cloudflare), CF anycast handles the rendezvous, and
Interlace `.well-known/interlace/index.json` (per ADR-0007) negotiates
identity on top.

See [`docs/deployment/off-platform-peers.md`](docs/deployment/off-platform-peers.md)
for the full deployment pattern, including a commented `cloudflared`
sidecar slot in `apko.yaml` for self-hosted deployments that want
CF Tunnel egress baked into the image.

## 11. What just happened — anatomy of an authenticated `bead_create`

You've installed it, run it, hit `/health`, and the smoke test
`bead_create` round-tripped. Worth a minute to look at what the
substrate actually does on that one call — because the §13.2 "silence
is evidence" invariant cloister publishes only holds if all the parts
below show up.

When `INTERLACE_ROOT_PUBKEY` is set (production-mode) and an MCP
client `POST /mcp` with a `tools/call bead_create` for repo
`/r/example`:

```
client POST /mcp ─→ McpEdgeRoute.handlePost
                        │
                        ├─ lease-middleware.ts: verifyAndUpsertLease
                        │     ↳ header parse → wasm32 cert chain verify
                        │       → Ed25519 sig → scope → seen_nonces
                        │       → TrustStore.verifyLeaseAndAdvanceChain
                        │           (one atomic transaction;
                        │            peer_lease_counters chain advances)
                        │
                        ├─ McpEdgeRoute.callTool(req, env, lease, nowMs)
                        │     ↳ tool_name == "bead_create" →
                        │       runBeadCreateOrchestrator(req, env, lease)
                        │           ↳ src/storage/bead-canonical.ts
                        │               → canonical bytes
                        │           ↳ BlobStore.put(bytes) → digest
                        │           ↳ Step 2: bedStorageBackend(env) ─→
                        │              "do"   → BeadStore.bead_create({digest, ...})    (default; cloister-c8b907)
                        │              "rsry" → rsry's rsry_bead_create via ROSARY_BUNDLE
                        │           ↳ TrustStore.applyAttestation({
                        │               peerFingerprint, contentHash=digest,
                        │               contentType="bead/v1", cert, sig,
                        │               prevSelfRef, prevPeerRef, nowMs,
                        │               beadId  ← from Step 2's response (cloister-dea77c)
                        │             })
                        │             ↳ on failure: pending_attestations
                        │                queue; drainPendingRetries retries
                        │
                        └─ JSON-RPC result back to client
```

A few things to notice:

1. **The counter chain advances on every authenticated call.** Read
   tools too. That's what makes "silence is evidence" — a request
   that the disclosure endpoint can't show in the counter chain is
   cryptographic proof cloister admitted it off-record. See
   [ADR-0007](docs/adr/0007-interlace-substrate.md).

2. **The attestation chain advances on every state-boundary write.**
   The `bead_create` orchestrator is the production path that
   actually writes attestation rows; pre-`cloister-492c08`,
   attestation lived only in test scaffolding. See the smoke at
   [`test/security/disclosure-attestation-smoke.test.ts`](test/security/disclosure-attestation-smoke.test.ts).

3. **Verify it yourself.** After running the smoke `bead_create`,
   `GET /interlace/peers/<actor_fp>` returns the JSONL stream with a
   `header` line, a `counter` row for the lease-counter advance, AND
   an `attestation` row whose `content_hash` matches the BlobStore
   digest of the canonical bytes. A third party with the cluster's
   master pubkey can independently reconstruct the chain.

4. **Dev mode (no `INTERLACE_ROOT_PUBKEY`) skips ALL of this.** That's
   intentional — auth-off means no peer fingerprint, no attestation,
   no §13.2 promise to defend. The deployment-binding presence is
   the gate; production MUST have the binding set.

If any of those steps don't show up when you exercise the gate-on
path, that's a bug. The threat model
[`docs/security/threat-model.md`](docs/security/threat-model.md) is
the contract; the disclosure endpoint is how a peer or auditor
verifies cloister kept it.

## 12. Reference — adding a new MCP-fronted service

This and §12 are reference material, not part of the setup walkthrough
above. Skip until you actually want to extend the route table.

---



Cloister's route table is declared in [`cloister.capnp`](cloister.capnp) at
the repo root; per ADR-0004, this is the source of truth. To add a service
(`rsry_*`, `mache_*`, `crumb_*`, …):

1. Decide the *kind*. Four real options:
   - **`durableObject`** — local DO-backed, like `bead_*`
   - **`httpForward`** — HTTP MCP server reachable via a URL env var (how
     `lsp_*`, `reparse|enrich|status`, and `mache_*` work today). Speaks
     JSON-RPC over HTTP. Two flavors via spec flags:
     - `dynamicTools = true` (ADR-0006) auto-derives the catalog from the
       upstream's `tools/list` and caches it for 60s. Used by `mache_*` —
       no hand-written schemas. Pair with `stripPrefix` to namespace bare
       upstream names (e.g. `get_overview` → `mache_get_overview`).
     - `requiresSession = true` performs the MCP Streamable HTTP
       `initialize` handshake and propagates `Mcp-Session-Id` on every
       request. Required for `mark3labs/mcp-go` upstreams (mache, rsry).
       Leave false for genuinely stateless upstreams (LLO daemon).
   - **`serviceBinding`** — another workerd Worker exposed as a `Fetcher`
   - **`leylineNet`** — capnp ToolCall/ToolResult over loopback HTTP to
     `cloister-companion`; companion handles the network hop with full
     leyline-net wire (signed Manifest + AEAD + handshake). Use when the
     upstream is on a different host or wants stateful authenticated
     sessions. Requires a running cloister-companion. See ADR-0005.
2. Add a backend entry inside the `/mcp` route's `mcp.backends` list:

   ```capnp
   # httpForward — Asserted catalog, stateless upstream (LLO shape)
   ( name          = "lsp",
     handlesPrefix = "lsp_",
     kind = (httpForward = (
       urlBinding = "LLO_MCP_URL",
       tools = [
         (name = "lsp_hover",
          description = "...",
          inputSchemaJson = "{\"type\":\"object\",\"properties\":...}"),
       ],
     )),
   ),

   # httpForward — Derived catalog with session-id (mache shape, ADR-0006)
   ( name          = "mache",
     handlesPrefix = "mache_",
     kind = (httpForward = (
       urlBinding      = "MACHE_MCP_URL",
       tools           = [],         # empty ⇒ fully Derived from upstream
       dynamicTools    = true,
       stripPrefix     = "mache_",   # bare names on wire, prefixed on advertise
       requiresSession = true,       # mark3labs/mcp-go session-id handshake
     )),
   ),

   # leylineNet — for backends fronted by cloister-companion
   ( name          = "rosary",
     handlesPrefix = "rsry_",
     kind = (leylineNet = (
       companionUrlBinding = "COMPANION_URL",
       upstreamId          = "rosary",
       tools = [...],
     )),
   ),
   ```

3. If the binding (`ROSARY_MCP_URL` or `COMPANION_URL`) isn't already in
   `wrangler.toml` + `config.capnp` + `src/types.ts`, add it.
4. Run `task manifest` (or just `task lint` — it depends on `manifest`).
   Build-time validators catch:
   - duplicate route paths
   - duplicate backend prefixes
   - duplicate tool names across backends
   - tools whose names don't start with their backend's prefix
   - malformed `inputSchemaJson`
5. Tests: the integration suite in `test/mcp.test.ts` already exercises the
   `tools/list` aggregation, so a new backend appears automatically. Add
   per-backend tests in `test/manifest/` if the wire-shape needs explicit
   coverage.

Empty `handlesPrefix` is allowed and means "exact-match against the
advertised tool names" — used today for `reparse | enrich | status` which
have no shared prefix on the upstream LLO daemon.

## 13. Reference — adding a new HTTP route (not MCP)

Implement `EdgeRoute` in `src/routes/`, register it in
`src/manifest/runtime.ts` if you want it manifest-driven, or for a
one-off path tweak just declare it in `cloister.capnp` under one of the
existing route kinds (`health`, `httpProxy`, `serviceBindingProxy`).

## 14. Where to go from here

Three directions, depending on what you came for.

**If you want to understand why the substrate is shaped this way** —
the ADR sequence reads as one argument:
[ADR-0001](docs/adr/0001-workerd-mcp-gateway.md) (why workerd at all) →
[ADR-0002](docs/adr/0002-edge-router-protocol-agnostic-backends.md)
(edge router, not MCP gateway; workerd's service bindings replace
Istio-style mTLS) →
[ADR-0004](docs/adr/0004-capnp-manifest.md) (capnp as the
registration format) →
[ADR-0007](docs/adr/0007-interlace-substrate.md) (Signet leases +
attestation chains + `.well-known/` discovery) →
[ADR-0011](docs/adr/0011-hypervisor-bundle-boundary.md) +
[ADR-0012](docs/adr/0012-truststore-vs-beadstore.md) (which DO sits
where) →
[ADR-0013](docs/adr/0013-slice-grant-enforcement.md) (V8 isolate +
service-binding-as-syscall is the slice-grant enforcement).
[ADR-0003](docs/adr/0003-content-addressed-bead-store.md) +
[ADR-0009](docs/adr/0009-compute-substrate-portability.md) round
out the storage + deployment shape.

**If you're building against the wire** —
[`interlace-spec/0.1.0/`](interlace-spec/0.1.0/README.md) is the
vendor-neutral protocol spec with test vectors + a Python reference
implementation. If your impl reaches the same digests as the
conformance suite, you're conformant; if it diverges, see
[threat-model §7.7](docs/security/threat-model.md) for the
"silently-wrong" failure modes implementors hit.

**If you want to wire a client to it** —
[`docs/integration/mcp-client.md`](docs/integration/mcp-client.md) is the
one-stop reference: which URL to point each MCP client at (Claude Code,
Cursor, raw curl), the auth model when `INTERLACE_ROOT_PUBKEY` is set,
and the most common failure modes with fixes.

**If you're operating it** —
[`docs/deployment/cluster-in-a-pod.md`](docs/deployment/cluster-in-a-pod.md)
covers the three deployment targets (`task cluster:dev` mac-native,
nerdctl/podman/docker compose, k8s deferred);
[`docs/security/threat-model.md`](docs/security/threat-model.md) is
what this surface defends against and where the open gaps are; the
[`docs/perf/`](docs/perf/) docs have measured per-step latency on
each substrate seam (lease pipeline, tools-call dispatch, TrustStore
under contention, disclosure endpoint, cold-start) so you know the
overhead bound before deploying.
