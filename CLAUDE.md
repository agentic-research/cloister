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
  numbered ADR before changing the substrate. **For the canonical
  per-ADR status table, see [`docs/STATUS.md`](docs/STATUS.md)** —
  don't duplicate the list here, it rots. Quick orient: next free
  number is **ADR-0026** (0001–0021 + 0023–0025 land; **ADR-0022
  reserved-but-not-drafted** — schema-bridge positioning, see
  `cloister-ae587d`). Most ADRs are Accepted; ADR-0008 Deferred
  (multi-companion scale not yet a real signal); ADR-0010 stays
  Proposed (manifest-side enforcement ratified by ADR-0013); ADR-0020
  + ADR-0021 are Proposed; everything else 0011–0019, 0023–0025 is
  Accepted. ADR-0023 ships `CLOISTER_DO_PATH` (macOS unblocker);
  ADR-0024 specifies the `cloister/credential-isolation/v1` capability
  under the substrate-as-kernel framing; ADR-0025 ships the bidi
  TOML ↔ capnp pipeline with `cluster.toml` at repo root.
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
- **Backends are kind-typed** — `durableObject`, `mcpProxy` (formerly
  `httpForward` per ADR-0015 Phase 1 rename; both schema variants
  still parse), `serviceBinding`, `udsForward`, `leylineNet` (per
  ADRs 0002, 0005, 0015). Adding a new kind requires a schema field,
  a TS mirror in `src/manifest/types.ts`, and a runtime branch in
  `runtime.ts`.
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
  `verifyAndUpsertLease` runs the full pipeline: header parse → clock-
  skew bound → wasm32 cert chain verify → claims required → epoch +
  validity-window check → Web Crypto Ed25519 request-sig verify →
  scope match → seen-nonces replay check → TrustStore RPC upsert.
  **Wired into `McpEdgeRoute.handlePost`** (cloister-b89fdb); the gate
  is active when `INTERLACE_ROOT_PUBKEY` is set, skipped when unset
  (dev/test mode — deployment-binding granularity, NOT per-request
  bypass). The verified `VerifiedLease` (peerFp + scope + cert DER + sig)
  is threaded into `callTool` so the cross-DO `bead_create` orchestrator
  can write attestation rows against the same cert that authorized the
  call. Per cloister-492c08.
- **Cross-DO `bead_create` orchestration lives in
  `src/routes/bead-create-orchestrator.ts`** — runs the ADR-0012 four-
  step handoff (BlobStore.put → BeadStore.bead_create → TrustStore.applyAttestation →
  optional pending enqueue) for the one state-boundary write that
  participates in the §13.4 audit. `McpEdgeRoute.callTool` intercepts
  `tools/call bead_create` and delegates here when the lease gate is
  on. Other bead methods (search, list, get, close, comment, update)
  stay intra-DO. The `beads.content_hash` column links bead rows to
  their canonical-bytes digest. Per cloister-492c08; threat model §8 +
  §11 row H.5.
- **Path matching uses `URLPattern`** — Web Platform standard,
  workerd-native, no regex. Exact-match routes use `pathname === "..."`;
  parameterized routes use `new URLPattern({ pathname: "/foo/:bar" })`
  patterns built once at construction. See `src/routes/disclosure.ts`,
  `src/routes/notme-identity.ts`, `src/manifest/runtime.ts:HttpProxyRoute`
  for examples.
- **Disclosure endpoint lives in `src/routes/disclosure.ts`** —
  `GET /interlace/peers/{fp}` streams a peer's attestation chain +
  pending state as JSONL, with HMAC-signed cursors and constant-time
  404 error responses (threat model §9). Registered in `cloister.capnp`
  as a `disclosure` route kind. Lease-gated when `INTERLACE_ROOT_PUBKEY`
  is set (scope `disclosure:<fp>`); auth-failure collapses into the
  same constant-time 404 to avoid peer-existence + cert-validity oracles.
- **Threat model is the contract** for the lease/attestation surface —
  `docs/security/threat-model.md` (math-friend authored, cross-linked
  from ADR-0007/0011/0012 frontmatter). Adding a new seam (cert mint,
  bundle fetch, lease step, counter write, cross-DO handoff, disclosure
  endpoint, compute substrate) means extending the model first.

## In-flight substrate work (ADRs 0007–0025)

Per-ADR status lives in [`docs/STATUS.md`](docs/STATUS.md); the table
below names the post-0007 decade additions + their decade-thread
home. When a new ADR lands, update STATUS.md first; this table is
the decade-thread index only.

| ADR | Decade thread |
|---|---|
| 0007 — Interlace substrate (Signet leases + attestation + discovery) | `interlace-substrate/identity-lease`, `/attestation`, `/discovery` |
| 0008 — companion pool / load balancing | `interlace-substrate/adrs` |
| 0009 — compute substrate portability (Linux / Firecracker / WASM / unikernel) | `interlace-substrate/adrs` |
| 0010 — vault + bundle clusters | `interlace-substrate/vault` |
| 0011 — hypervisor / bundle boundary (three-criterion test) | `interlace-substrate/adrs` |
| 0012 — TrustStore vs BeadStore (DO classification correction) | `interlace-substrate/adrs` |
| 0013 — slice-grant enforcement (V8 isolate + service-binding-as-syscall) | `interlace-substrate/vault` |
| 0014 — pluggable KEK source (Keychain / libsecret / file / env) | `interlace-substrate/vault` |
| 0015 — MCP-Proxy-Server alignment (`mcpProxy` backend rename) | `interlace-substrate/adrs` |
| 0016 — cloister as private MCP registry | `interlace-substrate/adrs` |
| 0017 — workerd-config generator rationale | `interlace-substrate/adrs` |
| 0018 — notme co-location (Alternative 4: split surface) | `interlace-substrate/vault` |
| 0019 — sign-only trust-anchor-helper protocol | `interlace-substrate/vault` |
| 0020 — adversarial red-team rotation charter | `interlace-substrate/adversarial` |
| 0021 — per-bundle vault DO instances (ADR-0013 design impl) | `interlace-substrate/vault` |
| 0022 — *reserved-but-not-drafted* (schema-bridge positioning, `cloister-ae587d`) | — |
| 0023 — host-path resolution (`CLOISTER_DO_PATH` macOS unblocker) | `interlace-substrate/adrs` |
| 0024 — `cloister/credential-isolation/v1` capability | `interlace-substrate/credential-isolation` |
| 0025 — bidi TOML ↔ capnp pipeline (`cluster.toml` operator surface) | `interlace-substrate/adrs` |

Decade `interlace-substrate` is the active workstream. `rsry_decade_list`
+ `rsry_thread_list --decade interlace-substrate` show the live queue.

In-flight MCP-spec-alignment work (cloister-as-MCP-Proxy-Server formalization)
is tracked in the `mcp-spec-alignment` thread; draft SEP at
[`docs/mcp-seps/`](docs/mcp-seps/).

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
