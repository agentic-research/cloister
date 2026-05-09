# CLAUDE.md — project memory for Claude Code in this repo

This file is loaded into every Claude Code session that touches
cloister. Keep it short, high-signal, and current. If a section grows
past ~25 lines it probably wants to be its own ADR or doc.

## What cloister is

A v8-isolate hypervisor running on workerd. The public face is
SSE/HTTP (MCP/JSON-RPC over it); inside, a typed capnp manifest
declares routes and backends; outside, the same TypeScript bundle runs
on `workerd serve config.capnp` locally and on Cloudflare Workers in
production.

Read [README.md](README.md) → [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) → ADRs in
order if you're new. The ADRs are the source of truth for *why*; the
top-level docs describe *what*.

## Source-of-truth files

- **`cloister.capnp`** — the consumer manifest at the repo root. Routes,
  backends, scopes. Edit this, then `task manifest`. Schema lives at
  `manifest/cloister.capnp`. Schema-evolution rules: append-only fields,
  monotonically-increasing ordinals, never renumber. Per ADR-0004.
- **`config.capnp` + `wrangler.toml`** — must stay in sync. Same
  bindings (`BEAD_STORE`, `NOTME`, `LLO_MCP_URL`, etc.) declared on
  both paths because workerd-local and CF-prod each parse their own.
- **`docs/adr/`** — every architectural decision lives here. Add a new
  numbered ADR before changing the substrate. The next free number is
  ADR-0011 (0001–0010 taken, with 0007–0010 currently `Proposed`).
- **`src/index.ts`** — composition root. Imports the typed manifest,
  hands it to `instantiate()`, exports the Worker. Don't add logic
  here; add routes / backends in their own files.

## Build & test

```sh
task lint            # tsc + worker tests + plugin tests, ~2s gate
task test            # workerd integration (real DOs, real SQLite)
task verify          # strict CI gate: lint + capnp CLI roundtrip + companion stub
task manifest        # capnp → src/generated/manifest.ts (run after cloister.capnp edits)
task dev             # wrangler dev hot-reload on :8787
task serve:local     # workerd serve directly (no CF account needed)
task smoke           # end-to-end with leyline + cloister on private ports
```

The `lint` is the inner-loop gate. Run it before every commit.

## Commit conventions

Every commit must reference a bead, enforced by the commit-msg hook
(Golden Rule 11):

```
[cloister-abc123] type(scope): description
```

The hook auto-injects the prefix if `.rsry-bead-id` exists at the
repo root. For session work without an active bead, use
`bead: cloister` as the trailer instead — the hook treats that as
sufficient.

## Architecture conventions

- **Routes are declarative** — defined in `cloister.capnp`, instantiated
  by `src/manifest/runtime.ts`. Don't hand-code routes in `src/index.ts`.
- **Backends are kind-typed** — `durableObject`, `httpForward`,
  `serviceBinding`, `udsForward`, `leylineNet` (per ADRs 0002, 0005).
  Adding a new kind requires a schema field, a TS mirror in
  `src/manifest/types.ts`, and a runtime branch in `runtime.ts`.
- **The wire is leyline-net at companion ↔ backend** — signed capnp
  manifests with AEAD. `src/wire/codec.ts` is the cloister-side encoder/
  decoder. Per ADR-0005 amendment, cloister ↔ companion is plain capnp
  IPC (no AEAD inside the trust boundary).
- **Trust state lives in TrustStore (singleton)** — per ADR-0012, the
  `peer_lease_counters` table is on a hypervisor-layer singleton DO
  (`env.TRUST_STORE`, idFromName("cluster")), separate from per-repo
  BeadStore. `peer_attestations` will live there too when bdcbe7 lands;
  cross-DO writes use ADR-0003 content-addressed handoff so per-DO ACID
  still holds. Lease writes attest on every authenticated call (§13.2).
- **Lease verification lives in `src/routes/lease-middleware.ts`** —
  `verifyAndUpsertLease` runs the full pipeline: header parse → wasm32
  cert chain verify → claims required → epoch + validity-window check →
  Web Crypto Ed25519 request-sig verify → scope match → TrustStore RPC
  upsert. End-to-end tested. Wiring into `src/routes/mcp.ts` is the
  follow-up bead (needs notme bundle-fetcher + test-fixture migration).

## In-flight substrate work (ADRs 0007–0012)

| ADR | Status | Decade thread |
|---|---|---|
| 0007 — Interlace substrate (Signet leases + attestation + discovery) | Proposed | `interlace-substrate/identity-lease`, `/attestation`, `/discovery` |
| 0008 — companion pool / load balancing | Proposed | `interlace-substrate/adrs` |
| 0009 — compute substrate portability (Linux / Firecracker / WASM / unikernel) | Proposed | `interlace-substrate/adrs` |
| 0010 — vault + bundle clusters (replaces env-var bindings with scoped slices) | Proposed | `interlace-substrate/vault` |
| 0011 — hypervisor / bundle boundary (three-criterion test) | Proposed | `interlace-substrate/adrs` |
| 0012 — TrustStore vs BeadStore (DO classification correction) | Accepted | `interlace-substrate/adrs` |

Decade `interlace-substrate` is the active workstream. `rsry_decade_list`
+ `rsry_thread_list --decade interlace-substrate` show the live queue.

## What NOT to add

- **Auth bypass.** ADR-0007 amendment 2026-05-08 explicitly removed
  `INTERLACE_DEV_BYPASS`. When the lease middleware lands, it ships
  always-on. Dev workflow uses `notme` to mint short-lived dev certs
  against a real master.
- **Userspace WireGuard in cloister.** Workerd has no kernel access;
  apko runs unprivileged. Off-platform peers use CF Tunnel / WARP per
  `docs/deployment/off-platform-peers.md`.
- **Env-var bindings for new credentials.** ADR-0010 makes vault slices
  the binding substrate. New bindings should land as `vaultSlice`
  declarations on a bundle, not as `[vars]` entries.
- **Hand-coded route registration.** Goes in the manifest, not in TS.

## When to write an ADR

If you're about to:
- Add a new manifest schema field on `Gateway`, `Bundle`, `Backend`, or `Route`
- Change the wire format at any seam (public face, IPC, companion ↔ backend)
- Touch the trust boundary (auth, identity, vault scoping, attestation)
- Pick a new substrate target (host runtime, deployment shape)
- Make a decision someone might want to reverse later

…draft a numbered ADR in `docs/adr/` before the implementation. The
ADRs are written for "the careful reviewer in six months who has
forgotten everything and needs to understand why." Keep that reader
in mind.

## Working in worktrees

`rsry dispatch` creates worktrees under `~/.rsry/worktrees/cloister/<bead-id>/`.
Two gotchas to know:

1. **`pnpm install` doesn't auto-run** when `git worktree add` creates
   a new tree. Run it manually before `task lint`.
2. **`task manifest` needs `CLOISTER_SCHEMA_ROOT`** in worktrees because
   the capnp `import "/cloister/manifest/cloister.capnp"` expects a
   literal `cloister/`-named directory at the schema root. Workaround:
   either set `CLOISTER_SCHEMA_ROOT` to the parent of a `cloister/`-named
   checkout (e.g. point it at the main repo's parent dir if the bead
   doesn't change schema), or symlink the worktree directory so a
   parent named `cloister/` exists alongside it.

Tracking bead for both: file one when these bite a real piece of
work.
