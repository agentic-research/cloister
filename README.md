# cloister

Cloister lets you run an AI coding tool with access only to the folders and
services you choose. It works with Claude Code and other tools that support
MCP, the common protocol used by AI tools.

You describe the tools you want in `cluster.toml`. Cloister gives your coding
tool one local address for reaching them and records what was available during
the run. The same file drives local development and the generated deployment
files.

```sh
task install             # dependencies, the `cloister` command, and current runtime support
cloister dev bootstrap   # one-time local setup
cloister dev serve       # your bundled tools at http://localhost:8787/mcp
```

Point your coding tool at that URL and every declared tool is available there.

## Run a coding tool inside cloister

```sh
task install                 # installs dependencies and adds `cloister` to your PATH
cloister dev bootstrap       # one-time local setup
export ANTHROPIC_API_KEY=…   # a Claude subscription cannot be used inside the sandbox
cloister run --harness claude-code --repo /abs/path/to/repo
```

The command can read and change the repository you name. Other repositories,
SSH keys, cloud credentials, and the public internet are blocked by the
operating system. See [Running a coding tool](docs/RUNNING.md) for setup details
and current limitations.

## Add a local skill

Today, `cloister run` reads `cluster.toml` from the Cloister checkout. From that
checkout, add any skill from your Claude Code skills folder:

```sh
mkdir -p ~/.claude/skills/repo-summary
printf '%s\n' '# Repo summary' '' 'Read the repository and summarize its current state.' \
  > ~/.claude/skills/repo-summary/SKILL.md

cloister skills list --dir . --state-dir ~/.claude
cloister skills pin repo-summary --dir . --state-dir ~/.claude --write
cloister cluster generate --dir .
cloister run --harness claude-code --repo /abs/path/to/repo
```

`skills list` shows the skills Cloister found and whether each one has been
approved for this cluster. States that need attention come first and are
colored when output goes to a terminal. Use global `--no-color`,
`--color never`, or `NO_COLOR=1` for plain output.

`skills pin repo-summary --write` records a fingerprint of only that skill in
`cluster.toml`. If the skill changes later, Cloister reports the change instead
of silently trusting the new version. With no skill name, `skills pin` selects
every skill it finds.

`cloister cluster generate` regenerates every committed deployment file from
`cluster.toml`. Edit `cluster.toml`; do not hand-edit its generated outputs.

### Work Board

`pr-board` is the agent skill for answering “what needs me?” Its current
fingerprint is declared in this reference cluster. If you install skills from
the agents repository, verify the link with `readlink ~/.claude/skills/pr-board`
before pinning it in a different cluster.

The agents repository's `work-board/` folder is different: it is a local visual
app, not a skill or an MCP server. Run its refresh and web server on the host, where
your authenticated `gh` command and network are available. If a confined agent
needs to read the resulting board, refresh `data/board.json` first, then name
the Work Board folder as an additional `--repo`. Live GitHub refresh is blocked
inside the current confined run unless you deliberately provide a GitHub-facing
tool through Cloister.

## What a run records

`cloister run --dry-run` shows which folders would be writable, which local
connections would be allowed, and which paths would be blocked. It does not
start the coding tool.

A real run writes `.harness-skills.json` in the first repository you named.
That file lists the skills that were loaded, their fingerprints, and whether
they matched `cluster.toml`.

Cloister does not yet record every attempted file, environment-variable,
process, or network access. The operating system still blocks access that was
not allowed, and the coding tool will show that failure in its own error
output. A dedicated recorder is tracked as `cloister-879a5a`; the documentation
will not claim that coverage before the runtime can prove it. See
[Running a coding tool](docs/RUNNING.md) for the other records a run creates.

**Before you try it, two things that will bite you:**

- **You need an API key, not a Claude subscription.** A subscription signs in
  through the macOS keychain, and the sandbox blocks keychain access on purpose,
  so the tool would just report "not logged in". Set `ANTHROPIC_API_KEY`.
- **The list of what a tool is allowed to reach was built by hitting errors.**
  It covers `git` and Claude Code. A tool that needs something else will fail,
  and on macOS that can show up as a developer-tools install prompt rather than
  a clear "permission denied".

Neither is a bug we forgot about — the first is a deliberate consequence of
blocking the keychain, the second is honest about how far this has been
exercised. Full walkthrough and the rest of the rough edges:
[`docs/RUNNING.md`](docs/RUNNING.md).

## Why you'd care

- **Your tools never see your secrets.** Give a tool access to an API
  key or token without handing it the secret — cloister keeps it in a
  locked box, makes the call for the tool, and hands back only the
  result. A leaky or compromised tool has nothing to leak.
- **State-changing work can leave verifiable evidence.** Authenticated
  requests advance a hash chain, and the shipped phase-one
  state-boundary path emits signed Interlace receipts. Fail-closed peer
  enforcement is still an operator cutover.
- **One declared shape, multiple runtimes.** `cluster.toml` can be
  lowered to local `workerd`, native-process, OCI, and Cloudflare paths.
  Those paths are not identical security boundaries; the documentation
  calls out the differences.

## How it works

Under the hood, Cloister runs its router and built-in tenants on
`workerd`. External tools can currently be reached as native processes,
OCI services, UDS peers, or HTTP services. On macOS, the experimental
host runtime can instead start a digest-pinned external tool in a
separate krunvm microVM; that path is explicit and does not silently
fall back to a host process. Identity, the "tools never see secrets"
credential isolation, and the signed audit trail live in the *substrate*
— not bolted onto each tool. Anything HTTP-shaped plugs into the same
route table without touching the substrate; MCP servers are just the
first tenants. Full detail, the manifest contract
([`cloister.capnp`](cloister.capnp)), and the ADRs are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

The shape, for the curious:

```mermaid
graph TB
    Client["external client<br/>(MCP / curl / browser /<br/>another cluster's bundle)"]

    subgraph host ["Host runtime — workerd router and tenants;<br/>optional krunvm boundary for external tools on macOS"]
        subgraph hyp ["Hypervisor layer — cloister-router bundle"]
            ROUTER["Router<br/>declarative EdgeRoute table<br/>(from cloister.capnp)"]
            MCP["MCP face<br/>/mcp (JSON-RPC / Streamable HTTP)"]
            IDENT["/identity/*<br/>(Interlace lease verification,<br/>per ADR-0007)"]
            WK[".well-known/<br/>interlace/index.json<br/>(capability discovery)"]
            HLT["/health"]
        end

        subgraph state ["Cluster state"]
            DO["BeadStore DO<br/>(per-repo SQLite)"]
            TRUST["TrustStore DO<br/>(singleton, per ADR-0012)<br/>peer_lease_counters,<br/>peer_attestations"]
            BLOB[("BlobStore DO<br/>(singleton, per ADR-0003)<br/>content-addressed bytes")]
            VAULT[("CredentialVault DO<br/>(singleton, per ADR-0013)<br/>HKDF+AES-GCM envelope,<br/>allowedSubs gate")]
        end

        subgraph siblings ["Sibling bundles (intra-cluster — service bindings, unforgeable)"]
            NOTME["notme-identity<br/>SigningAuthority master,<br/>born-in-CF, never leaves"]
            COMP["cloister-companion<br/>(Rust sidecar — IPC seam,<br/>per ADR-0005 amendment)"]
            HELPER["leyline-sign-helper<br/>(Rust host binary — sign-only,<br/>per ADR-0019)"]
        end
    end

    EXT["external services<br/>(rosary / mache / LLO / signet —<br/>NOT bundles; reached via httpForward)"]

    Client -->|HTTPS| ROUTER
    ROUTER --> MCP
    ROUTER --> IDENT
    ROUTER --> WK
    ROUTER --> HLT
    MCP -->|state writes| DO
    MCP -->|state writes| TRUST
    MCP -->|canonical bytes| BLOB
    MCP -->|credential reads| VAULT
    VAULT -.->|"KEK_HELPER fetch"| HELPER
    IDENT -->|svc binding| NOTME
    MCP -->|svc binding| COMP
    COMP -.->|"leyline-net wire<br/>(real network)"| EXT

    style hyp fill:#dde7ff,color:#000
    style state fill:#fff5e1,color:#000
    style siblings fill:#fff5e1,color:#000
    style EXT fill:#f5f5f5,color:#000
```

## Quickstart — start the server and point a tool at it

Five-minute three-terminal smoke. For the full walkthrough (toolchain,
ports, auth setup, plugin install), see
[GETTING-STARTED.md](GETTING-STARTED.md).

```bash
# Terminal 1 — ley-line-open daemon (for lsp_* + reparse/enrich/status)
leyline daemon --mcp-port 8384

# Terminal 2 — cloister
task install && cloister dev bootstrap
cloister dev serve                                # → http://localhost:8787

# Terminal 3 — notme (optional, for /identity/*)
cd ../notme/worker && wrangler dev --port 8788
```

Smoke test:

```bash
curl -s -X POST http://localhost:8787/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}' \
  | jq '.result.tools[].name'
```

Wire Claude Code:

```jsonc
{
  "mcpServers": {
    "cloister": { "transport": "http", "url": "http://localhost:8787/mcp" }
  }
}
```

Client-specific wiring (Cursor, raw curl, auth, common failure modes)
is in [docs/integration/mcp-client.md](docs/integration/mcp-client.md).

### Experimental: run an external tool in krunvm

The current compatibility provider shells out to `krunvm` and Buildah. It is a
useful bridge, but it is experimental and is not the future LLO execution API.
On macOS it can run a lockfile-pinned external OCI artifact behind a microVM
boundary:

```sh
cloister runtime install
cloister runtime storage init --yes
cloister runtime plan mache --workspace "$PWD" --output /tmp/mache-plan.json
cloister runtime doctor
cloister runtime run /tmp/mache-plan.json
```

The storage initializer creates one grow-on-demand, project-local,
case-sensitive sparsebundle with a 3 GiB logical ceiling by default.
The runtime reuses a VM only when its versioned persistent-restriction
digest matches, verifies the exact OCI source after creation, and
refuses new acquisition when the configured reserve would be crossed.

```sh
cloister runtime storage status
cloister runtime storage gc --print
cloister runtime storage gc --yes  # explicit mutation
```

GC protects running, active, still-referenced, and unknown state. It
uses `krunvm delete` and Buildah's own prune command with explicit
storage roots; it does not delete layer directories. Binary acquisition
still requires explicit operator consent, and the current microVM path
is coarse process/tool isolation—not the proposed per-operation
LLO/FUSE capability escalation.

## What cloister is NOT

So you can decide whether to keep reading, here's what cloister
*explicitly isn't*:

- **Not an MCP server.** MCP is the most visible tenant today, but
  cloister is a substrate (edge router + bundle host + auth
  middleware). The identity-format-shifting bridge (OIDC / WebFinger /
  NIP-05) at `/.well-known/*` is another tenant; adding further tenants
  (gRPC, WebSocket, anything HTTP-shaped) plugs into the same
  `EdgeRoute` table without touching the substrate
  (per [ADR-0002](docs/adr/0002-edge-router-protocol-agnostic-backends.md)).
- **Not Kubernetes.** cloister's cluster shape (`cluster.toml` →
  multi-container pod) targets containerd / podman / nerdctl / kubelet,
  but it doesn't replace them. You bring your container runtime;
  cloister provides the manifest + the wiring. The operator surface
  is TOML (`cluster.toml` at the repo root, see
  [ADR-0025](docs/adr/0025-bidi-toml-pipeline.md)); capnp remains the
  substrate schema authority.
- **Not a service mesh.** No Envoy sidecar per service. The lease
  middleware lives in cloister-router itself — one gate at the cluster
  edge, not N gates at N sidecars.
- **Not a database.** Durable Objects hold bead/trust/blob/vault state,
  but they're an integration point, not the system of record. Replicas
  + multi-region storage are an ADR-0010 follow-on.
- **Not a build tool.** apko / melange build the OCI images; cloister
  consumes those artifacts via the manifest. The container ecosystem
  is BYO.
- **Not a replacement for Cloudflare Workers.** workerd runs on CF
  Workers identically; cloister cluster-in-a-pod is for self-hosters
  who don't want a CF account. Same code, different host.

## Load-bearing claims

Five security properties cloister publishes are defended by running
code + tests + cross-implementation byte-equality. The full prose with
status, test pointers, and honest caveats is at
[docs/security/load-bearing-claims.md](docs/security/load-bearing-claims.md);
the gate at [docs/security/threat-model.md](docs/security/threat-model.md)
is where the test-vs-claim accounting lives.

Each row is a one-line summary; the [full doc](docs/security/load-bearing-claims.md) carries the prose, test pointers, and honest caveats.

| Claim | Where it lives | Status |
|---|---|---|
| **§13.2 "silence is evidence" — request side**: every authenticated request advances a hash-chained counter. | [ADR-0007](docs/adr/0007-interlace-substrate.md); [`src/storage/peer-lease-counters.ts`](src/storage/peer-lease-counters.ts) | Shipped 0.1.0. |
| **§13.2 "silence is evidence" — response side**: every state-boundary write advances an attestation chain (Interlace 0.2.0 receipts). | [ADR-0007](docs/adr/0007-interlace-substrate.md); [`interlace-spec/0.2.0-draft/RECEIPTS.md`](interlace-spec/0.2.0-draft/RECEIPTS.md) | Phase 1 shipped 2026-05-12 (emit-but-don't-enforce). Phase 2 cutover (peers fail-closed) is operator action. |
| **§9.4.b constant-time 404** — the disclosure endpoint can't be used as a peer-enumeration oracle. | [`src/routes/disclosure.ts`](src/routes/disclosure.ts) + `TrustStore.peerHasChain` | Bench-pinned ([`docs/perf/2026-05-10-disclosure-endpoint.md`](docs/perf/2026-05-10-disclosure-endpoint.md)). Pre-fix delta 17×; post-fix 60µs inside workerd's quantization floor. **CLOSED** (re-verified 2026-05-12 by oracle-friend). |
| **Slice-grant via V8 isolate + service-binding-as-syscall** — a compromised tool bundle cannot exfiltrate credentials outside its `allowedSubs`. Plaintext credential bytes never cross the RPC boundary. | [ADR-0013](docs/adr/0013-slice-grant-enforcement.md); [`src/vault-store.ts`](src/vault-store.ts) | Prompt-injection demo at [`test/security/prompt-injection.test.ts`](test/security/prompt-injection.test.ts) (19 cases). Per-bundle DO design (ADR-0021) Proposed not Implemented. |
| **Trust-anchor-helper sign-only protocol** — `leyline-sign-helper` holds master_sk; only `POST /sign` exposes signing; key bytes never leave the helper. | [ADR-0019](docs/adr/0019-sign-only-helper-protocol.md); LLO's `rs/ll-open/sign/` (pulled via git dep in [`rs/crates/cas/Cargo.toml`](rs/crates/cas/Cargo.toml), bead `cloister-8f4d3f`) | 5-cycle adversarial review 2026-05-12 closed 6 of 7 §15 invariants; supervisor binary-attestation deferred. LLO's `rs/ll-open/sign/tests/host_adversarial.rs` (5 tests). |
| **Substrate overhead bounded + measured** — lease pipeline <1ms p50 / 1ms p99 / 3ms p99 (post-batching). 85% of cost is DO RPCs. | [`docs/perf/2026-05-10-lease-pipeline.md`](docs/perf/2026-05-10-lease-pipeline.md) | Bench-pinned; reproduce via `task bench:lease`. |

The wire protocol is **documented standalone** at
[`interlace-spec/0.1.0/`](interlace-spec/0.1.0/README.md) — formal CDDL
schemas, 27 deterministic test vectors. The Python reference impl
passes the same vectors as cloister's TypeScript runtime; that's the
cross-check mechanism. The spec exists for cloister's rigor, not as a
campaign to standardize externally.

## How it's shaped

**At the hypervisor layer** (per
[ADR-0011](docs/adr/0011-hypervisor-bundle-boundary.md) — code is
hypervisor-layer if it mediates between bundles, multi-bundle blast
radius if compromised, singleton per cluster):

- **Routing** — `Router` + `EdgeRoute` dispatch over `/mcp`, `/health`,
  `/identity/*`, `/.well-known/*`, `/interlace/peers/{fp}`.
- **Lease verification** — verify Signet ephemeral certs against the
  pinned master + freshly-fetched epoch bundle. Bundles see only the
  verified cert + resolved scope.
- **Capability distribution** — credential reads gate through the
  `CredentialVault` DO; per-credential `allowedSubs` glob lists filter
  against the caller's identity. Enforcement is **V8 isolate +
  service-binding-as-syscall** (ADR-0013), not signed slice tokens.
- **State-boundary attestation** — bead writes go through the cross-DO
  orchestrator at
  [`src/routes/bead-create-orchestrator.ts`](src/routes/bead-create-orchestrator.ts)
  per ADR-0012's four-step handoff.

**At the bundle layer**: HTTP-shaped tenants registered in
`cloister.capnp` (today: `bead_*`, `rsry_*`, `mache_*`, `lsp_*`,
lifecycle, the identity bridge). Sibling bundles reach cloister-router
via UDS service bindings — the full cluster bundle map (tier +
transport + purpose) is
[`docs/reference/bundle-topology.md`](docs/reference/bundle-topology.md).

**Multi-tenant deployments** — operators declare `[[bundles]]` with
`perTenant = true` paired with a `[[routes]] kind = "tenantDispatch"`
entry to scope bundles per-tenant. Lint Invariants 7–9 enforce the
chain `tenantDispatch row.binding → wire → bundle ← input.workerdId`
at `task lint` time. The substrate-property model is documented in
[`docs/reference/tenancy-model.md`](docs/reference/tenancy-model.md);
the smallest demonstration is at
[`recipes/multi-tenant-smoke/`](recipes/multi-tenant-smoke/).

**Bead substrate migration** — `BEAD_STORAGE_BACKEND` env var routes
the `bead_create` orchestrator between cloister's BeadStore DO
(default `"do"`) and rsry's `rsry_bead_create` via the rosary bundle
(`"rsry"`). Per [ADR-0033](docs/adr/0033-bd-substrate-binding.md) D5
amendment + cloister-c8b907 — both paths preserve the §13.4 audit
chain via the `bead_id` column on TrustStore's `peer_attestations`.

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the runtime
model + component map + sequence diagrams.

## Three ways to start the server

Three local paths, same code:

```bash
task dev            # Path A — wrangler dev hot-reload, easiest
task serve:local    # Path B — workerd serve dist/config.capnp (no CF account)
task cluster:dev    # Path C — mac-native cluster topology with UDS bindings
```

Path B is closest to the production OCI image and writes to `/data/do`
by default (matches the apko image's mount point). Create the dir
once on Linux: `sudo mkdir -p /data/do && sudo chown "$USER" /data/do`.
**On macOS or any host where `/data` isn't writable**, set
`CLOISTER_DO_PATH` to a writable absolute path before `task build:local --force` —
per [ADR-0023](docs/adr/0023-host-path-resolution.md). Path A
(`task dev`) uses `.wrangler/state/` (already in `.gitignore`) and
needs no setup. Full walkthrough:
[GETTING-STARTED.md](GETTING-STARTED.md).

> **⚠️ DO SQLite is unencrypted at rest.** Whichever path you pick
> (`/data/do`, `.wrangler/state/`, `$XDG_DATA_HOME/cloister/do` via
> `CLOISTER_DO_PATH`, or `$HOME/.cache/cloister-dev/do/` for
> `cluster:dev`), the DO SQLite databases — beads, trust state,
> blob digests, vault ciphertext metadata — live on disk in plaintext
> SQLite files. The vault ciphertexts *inside* those files ARE
> AES-GCM-encrypted (per ADR-0013/0014); the bead/trust/blob tables
> are not. Don't drop production-sensitive data into a dev install;
> if you need on-disk encryption-at-rest of the SQLite files
> themselves, that's an open follow-on (no ADR yet — file one if you
> need it).

## Tasks

```bash
task lint           # tsc + worker tests + plugin tests + lint:* — ~10s
task verify         # lint + wire roundtrip + leyline-stub smoke
task smoke          # spins up leyline + cloister, exercises full chain
task test           # vitest in real workerd (real DOs, real SQLite)
task manifest       # cloister.capnp → src/generated/manifest.ts
task build:local    # bundle for workerd (depends on `manifest`)
task dev            # wrangler dev hot-reload
task serve:local    # workerd serve dist/config.capnp
task helper:start   # leyline-sign-helper foreground on 127.0.0.1:8786
task apk            # build APK via melange (signed)
task image          # compose distroless OCI image via apko
task image:check    # validate melange.yaml + apko.yaml without a real build
task bench:lease    # opt-in perf bench (or :dispatch / :trust-store / :disclosure / :cold-start / :all)
```

Full task surface: `task --list-all`.

## Hardening + plugin

- **`ALLOWED_ORIGINS`** — CORS allowlist (env var, comma-separated).
  Default is wildcard echo for dev. Set to e.g.
  `http://localhost:*,https://app.example.com` for prod. Supports a
  trailing `:*` port wildcard per entry; no general globs.
- **`VAULT_KEK_SOURCE`** — picks where the vault DO resolves its
  envelope-encryption KEK from. Schemes: `keychain://`,
  `apple-password://`, `keyring://`, `op://`, `secret-tool://`,
  `file://`, `env://`, `http(s)://`. See
  [ADR-0014](docs/adr/0014-pluggable-kek-source.md) +
  [GETTING-STARTED §9](GETTING-STARTED.md#vault-kek--keep-it-out-of-plaintext-bindings).
- **`LEYLINE_SIGN_CALLER_TOKENS`** + `--require-auth` —
  trust-anchor-helper auth (production deploys MUST set; ADR-0019).
  Additional helper env vars frozen in ADR-0019 reqs 14–18:
  `LEYLINE_SIGN_RESOLVE_ALLOW`, `LEYLINE_SIGN_SIGN_ALLOW`,
  `LEYLINE_SIGN_OP_BIN`, `LEYLINE_SIGN_SECURITY_BIN`,
  `LEYLINE_SIGN_RESOLVE_TTL_MS`, `LEYLINE_SIGN_RESOLVE_CACHE_MAX`.
- **`BEAD_STORAGE_BACKEND`** — routes the `bead_create` orchestrator's
  Step 2 between cloister's BeadStore DurableObject (`"do"`, default)
  and rsry's `rsry_bead_create` MCP tool via the rosary bundle
  (`"rsry"`). Per
  [ADR-0033](docs/adr/0033-bd-substrate-binding.md) D5 amendment +
  `cloister-c8b907`. Both paths preserve the §13.4 audit chain via the
  `bead_id` link on `peer_attestations`. Unknown / unset values fall
  back to `"do"` with a one-shot structured log event
  (`event: "bead_create.legacy_backend"`); operators opt into the new
  backend explicitly.
- **Container** — `task image` produces a distroless OCI image
  (`cloister.tar`), workerd + bundle only, no shell/pkgmgr, runs as
  uid `65532`. Mount `/data` for DO SQLite persistence.

**Claude Code plugin.** Keeping `lsp_*` results fresh during long
editing sessions is [ley-line-open's
`leyline-stale-sync`](https://github.com/agentic-research/ley-line-open/tree/main/wrappers/claude-code),
not cloister's. It registers a `PostToolUse` hook that fires `reparse`
at the LLO daemon directly. Cloister shipped a `cloister-stale-sync`
variant until 2026-07-27; it was retired because LLO owns the parse /
LSP surface (ADR-0035) and running both double-fires `reparse` on
every edit.

## Ecosystem

| Service                                                      | Runtime              | Role                                          |
| ------------------------------------------------------------ | -------------------- | --------------------------------------------- |
| cloister                                                     | workerd / CF Workers | Edge router (this repo)                       |
| [notme](https://github.com/agentic-research/notme)           | workerd / CF Workers | Identity authority + UDS-front for daemons    |
| [ley-line-open](https://github.com/agentic-research/ley-line-open) | Rust daemon    | Tree-sitter parse + LSP enrichment + MCP HTTP |
| rosary                                                       | Rust binary          | Orchestration, bead tracking, dispatch        |
| mache                                                        | Go binary            | Code intelligence FUSE                        |
| signet                                                       | Go binary            | Key exchange                                  |

For the secure operator path that serves ART tools through cloister's
single `/mcp` face, see
[`docs/deployment/secure-art-tools.md`](docs/deployment/secure-art-tools.md).

## Where to go next

- **Operator setup** — [GETTING-STARTED.md](GETTING-STARTED.md) (install, run, wire upstreams, plugin)
- **Substrate description** — [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (runtime model, sequence diagrams, bindings, component map)
- **All `docs/`** — [docs/README.md](docs/README.md) (orientation map for the 8 subdirs)
- **Architectural decisions** — [docs/adr/](docs/adr/), with a generated,
  always-current [index + status](docs/adr/INDEX.md) (derived from each ADR's
  frontmatter, CI-gated — never hand-maintained). Start with **0001 → 0002 →
  0007 → 0011** for the core mental model.
