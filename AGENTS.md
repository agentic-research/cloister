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
| `adrs` | Decision documents (ADR-0007/0008/0009/0010) |
| `identity-lease` | notme lease minter, WASM verifier, lease middleware, leyline-sign wasm32 emit, audit-finding correctives |
| `discovery` | `.well-known/interlace/` + capabilities surface |
| `attestation` | `peer_attestations` table + selective disclosure endpoint |
| `deployment` | CF Tunnel / WARP off-platform story |
| `oss-prep` | CLAUDE.md / AGENTS.md / CI workflows / README+ARCH sync |
| `vault` | Lift `notme/vault/` → `cloister/vault/` (AGPL-3) + cross-repo notme cleanup |
| `audit` | (now empty — audit findings folded into surface threads for parallelizability) |

## Bead lifecycle on cloister

1. **Pick up** — `rsry_bead_search` first, `rsry_dispatch` once you've
   confirmed scope.
2. **Implement** in the worktree at `~/.rsry/worktrees/cloister/<bead-id>/`.
   Run `pnpm install` first; export `CLOISTER_SCHEMA_ROOT` if the bead
   touches the manifest schema (see CLAUDE.md "Working in worktrees").
3. **Test** with `task lint` (always) and `task verify` (for substrate
   changes — wire codec edits, schema changes, etc.).
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

## Failure-mode playbook

| Symptom | Likely cause | Fix |
|---|---|---|
| `task manifest` fails: `Import failed: /cloister/manifest/cloister.capnp` | Worktree dir not named `cloister/`; capnp import path can't resolve | Set `CLOISTER_SCHEMA_ROOT="$(realpath path/to/your/main/cloister/checkout/..)"` (the parent of a `cloister/`-named directory — same default `scripts/build-manifest.mjs` derives), or symlink the worktree to a `cloister/`-named path |
| `task lint` fails: `Cannot find type definition file for '@cloudflare/workers-types'` | Worktree's `node_modules/` not populated | `pnpm install` in the worktree |
| Commit rejected: "commit message must start with [bead-id]" | `.rsry-bead-id` missing or message hand-typed without the prefix | `echo <bead-id> > .rsry-bead-id` then re-commit, or include `[<bead-id>]` in message |
| `cargo test` fails on `axum` / `leyline-cli-lib` | ley-line ↔ ley-line-open Cargo.toml drift (open bead `ley-line-9e6b97`) | Don't `--no-verify`; wait for that bead to land |
| Apko build fails: `task image:check` errors on `melange.yaml` | Schema drift in the apko/melange tooling | `task image:check` shows the parser error; fix the YAML |

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
