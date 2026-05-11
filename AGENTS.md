# AGENTS.md — agent dispatch + persona guide for cloister

This file is loaded when an agent is dispatched to work on a cloister
bead. It complements [CLAUDE.md](CLAUDE.md) (which is the project memory
for any Claude session); this file is specifically about working
*through the rsry bead pipeline*.

## Personas relevant to cloister

| Agent | When dispatched |
|---|---|
| `dev-agent` | Default for `feature` and `task` issue types. Implements; commits; comments. |
| `scoping-agent` | Reads the bead description first; if scope is unclear, narrows or splits before implementing. Best for beads that touch >2 files or cross subsystem boundaries. |
| `architect-agent` | Owns `design` issue type. Drafts ADRs, decomposes them into implementation beads, files dependency edges. Does not implement. |
| `staging-agent` | Owns `review` issue type. Adversarial reviewer. Does not modify code; files findings as comments or sub-beads. |
| `pm-agent` | Strategic / cross-repo. Surfaces overlap, abandoned experiments, scope creep. Read-only by default. |
| `janitor-agent` | Cleanup. Dead-session detection, worktree garbage, stale branch sweep. Cluster-level concerns. |

The bead's `owner` field assigns the agent. `rsry_bead_create` infers
from `issue_type` if `owner` is omitted.

## Active decade

`interlace-substrate` is the current workstream. Run
`rsry_thread_list --decade interlace-substrate` to see threads:

| Thread | Purpose |
|---|---|
| `adrs` | Decision documents (ADR-0007/0008/0009/0010/0011/0012) |
| `identity-lease` | notme lease minter, WASM verifier, lease middleware, leyline-sign wasm32 emit. **Substrate shipped 2026-05-09** (cloister-bd7770 / -9d49eb). Wiring into `mcp.ts` is `cloister-b89fdb`. |
| `discovery` | `.well-known/interlace/` + capabilities surface |
| `attestation` | `peer_attestations` in **TrustStore** (per ADR-0012; was BeadStore-resident before the 2026-05-09 correction). Cross-DO writes use ADR-0003 content-addressed handoff. Gated on `cloister-960f68` (BlobStore Phase 1 hardening). |
| `deployment` | CF Tunnel / WARP off-platform story; "cluster in a pod" via workerd v8 proc-iso (`cloister-be0607`, ADR-0009 implementation) |
| `oss-prep` | CLAUDE.md / AGENTS.md / CI workflows / README+ARCH sync; ll-open 0.2.0 sync (`cloister-bd8c41`) |
| `vault` | Lift `notme/vault/` → `cloister/vault/` (AGPL-3) + cross-repo notme cleanup |
| `audit` | (now empty — audit findings folded into surface threads for parallelizability) |

## What changed 2026-05-09 — start your map here

If you're a fresh agent, read these first; they are the corrections
that supersede earlier in-flight assumptions:

- **TrustStore is a separate DO** from BeadStore. Singleton per cluster
  at `idFromName("cluster")`; hypervisor-layer per ADR-0011's three-
  criterion test. Bead state stays in BeadStore (per-repo). See ADR-0012.
- **Cross-DO writes use content-addressed handoff** (ADR-0003 phase 1).
  Workerd ACID is per-DO; `bead_create → BlobStore → BeadStore →
  TrustStore` walks four steps, but BlobStore is idempotent so failure
  recovery is well-defined. The bolded ADR-0007:154 "same SQL transaction"
  rule is replaced by this multi-step but recoverable pattern.
- **Lease middleware substrate is real and wired**. `verifyAndUpsertLease`
  runs the full pipeline (header parse → wasm32 cert verify → claims
  required → epoch + window → Web Crypto Ed25519 sig → scope →
  TrustStore RPC). Wired into `McpEdgeRoute.handlePost` per
  `cloister-b89fdb` (closed). Active when `INTERLACE_ROOT_PUBKEY` is
  set; skipped in dev/test when unset (deployment-binding granularity,
  NOT per-request bypass).
- **CredentialVault is wired** as a hypervisor-tier singleton DO
  (`env.VAULT_STORE`) per ADR-0013 (slice-grant enforcement via V8
  isolate + service-binding-as-syscall). Envelope encryption + per-
  credential `allowedSubs` glob enforcement; plaintext credential bytes
  never cross the RPC boundary. Library lifted from notme/vault
  (cloister-9ad9eb); DO wrapper at `src/vault-store.ts`. Open: in-
  cluster bundle identity propagation (gated on the first workerd-
  bundle Worker — see `cloister-ac30e7`).
- **`leyline-sign` lives at `rs/crates/sign/`** (AGPL-3, NOTICE references
  the upstream). The lift from agentic-research/ley-line happened
  2026-05-08/09; ll-open 0.2.0 has now made the upstream public, so
  attribution path may simplify (`cloister-bd8c41`).
- **Threat model is the contract** for completing the lease/attestation
  arc. See `docs/security/threat-model.md` (math-friend authored,
  `cloister-bd32b1`).

## Bead lifecycle on cloister

1. **Pick up** — `rsry_bead_search` first, `rsry_dispatch` once you've
   confirmed scope.
2. **Implement** in the worktree at `~/.rsry/worktrees/cloister/<bead-id>/`.
   Run `pnpm install` first; export `CLOISTER_SCHEMA_ROOT` if the bead
   touches the manifest schema (see CLAUDE.md "Working in worktrees").
3. **Test** with `task lint` (always) and `task verify` (for substrate
   changes — wire codec edits, schema changes, etc.). Any new cross-DO
   state-mutating sequence requires a fault-injection test per the
   §13.4 audit pattern (`test/security/cross-do-recovery.test.ts`).
4. **Commit** with `[<bead-id>] type(scope): description`. The
   commit-msg hook auto-injects the prefix when `.rsry-bead-id` exists.
5. **Comment** the bead via `rsry_bead_comment` with the commit hash +
   what you did + what you couldn't.
6. **Don't close.** The reconciler verifies and closes — agents leave
   the bead open with a "ready for verify" comment.

## File-overlap rules

`rsry` serializes dispatch when two beads share files. Set `files` and
`test_files` accurately on bead creation — wrong scope = false-negative
overlap = agents collide.

Conventions in this repo:

- `cloister.capnp` is shared by every backend bead; mark it on any
  bead that adds/edits a route.
- `src/manifest/types.ts` is shared by every schema-touching bead.
- `src/manifest/runtime.ts` is shared by route-kind beads.
- `wrangler.toml` and `config.capnp` always travel together (per
  CLAUDE.md "Source-of-truth files").
- `src/generated/manifest.ts` is `.gitignore`'d — don't list it in
  `files`; never commit it.

### Parallel direct-dispatch (Agent tool, bypassing rsry)

When a session agent dispatches sub-agents directly via the `Agent`
tool (not via `rsry_dispatch`), rsry's overlap-serialization engine
**does not apply**. Two sub-agents launched into the same working
checkout can — and have — collided when both touch shared manifest /
schema / type files. Symptom: one agent's `git commit` resets the
other's unstaged working-tree edits; the second agent has to re-apply.

**Rule**: before launching two `Agent` tool calls in parallel, compare
their bead `files` lists. If they intersect on any file in the
"shared by every X bead" conventions above (`cloister.capnp`,
`src/manifest/types.ts`, `src/manifest/runtime.ts`,
`wrangler.toml`/`config.capnp`, threat-model, AGENTS.md, CLAUDE.md,
README.md), use one of these mitigations:

1. **`isolation: "worktree"`** on the `Agent` tool call. The tool
   spins up a temporary git worktree for that agent so its edits
   don't share state with siblings. Cleanest for short-lived
   parallel work.
2. **`rsry_dispatch`** instead of `Agent`. Sets up worktrees under
   `~/.rsry/worktrees/<repo>/<bead-id>/` and uses rsry's dispatch
   serialization. Best when both agents would want full rsry
   bookkeeping (commit-msg hooks, status threading).
3. **Sequential dispatch**. Run the first agent foreground or wait
   for completion before starting the second. Trivially correct
   when the agents are bounded enough that serialization isn't a
   bottleneck.

Concrete instance that bit (2026-05-11): `cloister-c9922f` (identity
bridge) + `cloister-cabd57` (OCI registry) dispatched in parallel
against the main checkout. Both touched
`{cloister.capnp,src/manifest/runtime.ts,src/manifest/types.ts}`. The
OCI agent's mid-flight schema edits got reset when the c9922f agent
committed; OCI had to re-apply. No data loss, no main-branch
breakage, but ~5-10 min of redo time. Both `files` lists declared
the overlap correctly — the gap was bypassing rsry's serialization
by going direct-Agent.

Rule of thumb: **if both bead descriptions declare overlap in their
`files` field, use worktree isolation or sequential dispatch — never
parallel-direct against the same checkout.**

## Failure-mode playbook

| Symptom | Likely cause | Fix |
|---|---|---|
| `task manifest` fails: `Import failed: /cloister/manifest/cloister.capnp` | Worktree dir not named `cloister/`; capnp import path can't resolve | Set `CLOISTER_SCHEMA_ROOT="$(realpath path/to/your/main/cloister/checkout/..)"` (the parent of a `cloister/`-named directory — same default `scripts/build-manifest.mjs` derives), or symlink the worktree to a `cloister/`-named path |
| `task lint` fails: `Cannot find type definition file for '@cloudflare/workers-types'` | Worktree's `node_modules/` not populated | `pnpm install` in the worktree |
| Commit rejected: "commit message must start with [bead-id]" | `.rsry-bead-id` missing or message hand-typed without the prefix | `echo <bead-id> > .rsry-bead-id` then re-commit, or include `[<bead-id>]` in message |
| `cargo test` fails on `axum` / `leyline-cli-lib` | ley-line ↔ ley-line-open Cargo.toml drift (open bead `ley-line-9e6b97`) | Don't `--no-verify`; wait for that bead to land |
| Apko build fails: `task image:check` errors on `melange.yaml` | Schema drift in the apko/melange tooling | `task image:check` shows the parser error; fix the YAML |
| workerd boot: `*** Fatal uncaught kj::Exception: kj/cidr.c++: invalid CIDR; pattern = <X>` | A `network.allow` (or `deny`) entry in `config.capnp` is not a valid CIDR string or the magic tokens `public`/`private`. Common mistake: `["localhost:8788"]` (host:port). | Use `"public"` for "anywhere routable", `"private"` for RFC1918, or a valid CIDR (`"127.0.0.1/32"`). Reachability to a specific upstream is gated by the service binding (its URL), not by the network allowlist. Per `cloister-27ae16`. |
| `task cluster:up` fails fast: cloister image not present | apko appends `-<arch>` to the docker tag, but `cluster.compose.yaml` references `cloister:0.1.0` (no arch). | `docker load < cloister.tar && docker tag cloister:0.1.0-$(uname -m \| sed 's/arm64/aarch64/') cloister:0.1.0`. `task image` echoes the same hint. Per `cloister-280136`. |

## When you find new failure modes

Add a row to the table above. CLAUDE.md is for *what cloister is*;
this file is for *how to make progress without re-learning the same
gotchas*.

## What this file is NOT

- It's not a conduct guide (cloister has no contributors yet beyond
  the author + agents).
- It's not a list of skills or capabilities — those are global,
  configured per-agent in `~/github/jamestexas/agents/` and
  `~/remotes/art/rosary/agents/rules/`.
- It's not a roadmap. The bead store is the roadmap. `rsry_status` +
  `rsry_decade_list` + `rsry_thread_list` are the queries.
