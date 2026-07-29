# CLAUDE.md — project memory for Claude Code in this repo

This file is loaded into every Claude Code session that touches
cloister. Keep it short, high-signal, and current. If a section grows
past ~25 lines it probably wants to be its own ADR or doc.

## What cloister is

A v8-isolate hypervisor running on workerd. The public face is
MCP over Streamable HTTP (JSON-RPC POST; the legacy HTTP+SSE transport
is Deprecated per MCP 2026-07-28 and kept only for the 12-month window);
inside, a typed capnp manifest
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
- **`config.capnp` + `wrangler.toml`** — must stay in sync, now ENFORCED by
  `lint:binding-parity` rather than asserted (`cloister-9aeb3f`). Same
  bindings (`BEAD_STORE`, `NOTME`, `LLO_MCP_URL`, etc.) declared on
  both paths because workerd-local and CF-prod each parse their own.
- **`docs/adr/`** — every architectural decision lives here. Add a new
  numbered ADR before changing the substrate. **Per-ADR design status is
  GENERATED — see [`docs/adr/INDEX.md`](docs/adr/INDEX.md)**, derived from
  each ADR's own frontmatter by `task adr:index` and CI-gated by
  `adr:index:check`. Do **not** hand-restate the ADR list or their statuses
  here (or in README/STATUS) — it rots; that's what `INDEX.md` is for.
  *Implementation* status (did an ADR actually ship) lives in its tracking
  bead + git, never in prose. Reserved numbers: 0032 (unused), 0037 (secure
  MCP ingress transports).
- **`src/index.ts`** — composition root. Imports the typed manifest,
  hands it to `instantiate()`, exports the Worker. Don't add logic
  here; add routes / backends in their own files.

## Build & test

`@agentic-research/dpop` (notme's DPoP verifier SDK, per ADR-0047) is
published publicly on npmjs and requires no registry authentication. The SDK
used to be vendored at `src/vendor/notme-dpop.ts`; it is now a real dependency
(`notme-18450e` / `cloister-195e47`) — don't re-vendor it.

### Pinning ley-line-open

LLO crates are pinned by **git rev AND version, and both must match** — cargo
resolves on the pair, so bumping the rev alone fails with a bare "location
searched" error that does not mention the version. All five crates
(`leyline-core`, `-cas-ffi`, `-fs`, `-sign`, `-schema-bridge`) should move
together: they once drifted to five different revs with `leyline-core`
resolving three times in one lockfile, which is what `cargo update -p
leyline-core` refusing as *ambiguous* looks like.

The release tag is **not** the delivery path for the schema-bridge generator —
`task cluster:zod` builds it from the pinned git rev, so a stale pin silently
regenerates against an old generator and exits 0. As of LLO v0.12.0 the
generator ships as a downloadable release binary; moving `schema-bridge:build`
onto it is `cloister-9170d0`.

```sh
task lint            # tsc + worker tests + script/rail tests, ~2s gate
task test            # workerd integration (real DOs, real SQLite)
task verify          # strict CI gate: lint + capnp CLI roundtrip + companion stub
task manifest        # capnp → src/generated/manifest.ts (run after cloister.capnp edits)
task dev             # wrangler dev hot-reload on :8787
task serve:local     # workerd serve directly (no CF account needed)
task smoke           # end-to-end with leyline + cloister on private ports
```

The `lint` is the inner-loop gate. Run it before every commit.

### Substrate-property lint invariants (lint:bundle-isolation)

`scripts/lint-bundle-isolation.mjs` runs twelve invariants per `task lint`:

| Inv | What | ADR |
|---|---|---|
| 1 | No globalOutbound to network / external on cluster-tier | ADR-0013 |
| 2 | Vault / credential bindings only on declared holdsCredential bundles | ADR-0013 |
| 3 | Every bundle has a tier + non-empty hypervisorRationale if hypervisor | ADR-0011 |
| 4 | Cluster-tier service bindings resolve to a wire OR `external` service | ADR-0013 |
| 5 | Hypervisor-to-hypervisor service bindings appear in `wires[]` | ADR-0018 gap 5 |
| 6 | Input tenancy.workerdId resolves to a bundle; trustedTier alignment | ADR-0030 §A5 |
| 7 | tenantDispatch row.binding ↔ workerd alignment via input.workerdId | ADR-0034 / cloister-ce936e |
| 8 | perTenant=true bundle has a tenantDispatch route declared | ADR-0034 / cloister-cedcf3 |
| 9 | perTenant bundle wired by at least one tenantDispatch binding | ADR-0034 / cloister-cedcf3 |
| 10 | External bundle image derivable (operator `ext.image` OR a linked input's `packages[].oci`); WARN-level | ADR-0038 |
| 11 | Confinement facet (fs.allow / allowHosts / port.bind) is valid + fail-closed | cloister-a34edc |
| 12 | Every `durableObjectNamespace` binding on a bundle's Worker resolves to a declared `durableObjectNamespaces` entry (same-Worker or named cross-worker `serviceName`) | cloister-f9d473 |

Together Inv 6-9 enforce the chain `tenantDispatch row.binding → wire → bundle ← input.workerdId` for multi-tenant deployments (see [`docs/reference/tenancy-model.md`](docs/reference/tenancy-model.md)); Inv 12 enforces the parallel chain `bundle DO binding → durableObjectNamespaces entry` — config.capnp's `durableObjectNamespaces` list (line ~235) is a hardcoded host-side declaration on behalf of every bundle that binds a Durable Object, and until Inv 12 nothing checked that a binding's named class was actually declared there.

### Trust-surface rails

Ten further rails run per `task lint`. Each exists because an invariant was
stated somewhere (an ADR, a schema comment, a code comment) but nothing
enforced it, and it drifted. Each has a companion test asserting *the shipped
tree satisfies it*, so the rail cannot pass vacuously.

| Rail | Invariant | Origin |
|---|---|---|
| `lint:lease-gate-source` | `env.INTERLACE_ROOT_PUBKEY` is read only in the gate resolver + CA-bundle source | ADR-0053 / `cloister-220c9d` |
| `lint:trust-env-locality` | every other trust-secret env var is read only in its own resolver | `cloister-21e42e` |
| `lint:silent-swallow` | a bare `catch {}` on the trust/IO surface must surface the error or carry `lint-allow-silent: <reason>` | `cloister-bd7210` |
| `lint:log-shape` | operational logs on the trust surface are structured (`logEvent`), never ad-hoc strings | `cloister-bd7e51` |
| `lint:dev-escape` | no committed `[inputs.*] from =` dev-escape (it wins over `ref`) | ADR-0026 |
| `config:check` | no `.env.local` value silently shadowed by `.dev.vars` under `wrangler dev` | `cloister-21f273` |
| `lint:binding-parity` | a binding read in `src/` is declared on BOTH deployment paths (or carries a declared asymmetry) | `cloister-9aeb3f` |
| `lint:structured-parse` | a format with a parser is parsed, not hand-matched (`.capnp` + prose exempt) | `cloister-2fb46a` |
| `lint:spec-citation` | every `leyline-schema-spec/...` citation resolves to a real file in LLO | `cloister-e83a33` |
| `lint:harness-target-literals` | provider literals live only in the `[[gateway.harnessTargets]]` declaration | `cloister-742e19` |

The shared lesson: **an invariant with no rail is a comment.** When adding a
substrate rule, add the rail in the same change — and give it a test that runs
against the real tree, not just fixtures.

## Commit conventions

Every commit must reference a bead, enforced by the commit-msg hook
(Golden Rule 11):

```
[cloister-abc123] type(scope): description
```

The hook auto-injects the prefix if `.rsry-bead-id` exists at the
repo root. Otherwise the `[bead-id]` prefix is **required** — the
hook has no `bead:` trailer escape hatch, so session work still needs
a real bead to reference. File one, or reference the bead the work
was discovered under.

## Architecture conventions

- **Routes are declarative** — defined in `cloister.capnp`, instantiated
  by `src/manifest/runtime.ts`. Don't hand-code routes in `src/index.ts`.
- **Backends are kind-typed** — five variants (`durableObject`,
  `mcpProxy`, `serviceBinding`, `udsForward`, `leylineNet`). Canonical
  reference: [`docs/reference/backend-kinds.md`](docs/reference/backend-kinds.md)
  (don't re-enumerate here; that doc owns the table). Adding a new
  kind requires a schema field, a TS mirror in `src/manifest/types.ts`,
  and a runtime branch in `runtime.ts` — per ADRs 0002, 0005, 0015.
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
  **Wired into `McpEdgeRoute.handlePost`** (cloister-b89fdb). The gate
  posture comes from `resolveLeaseGate` (`src/routes/lease-gate.ts`) per
  ADR-0053, and the **only** "off" is `CLOISTER_MODE=dev` *and* no
  authority (neither `DEV_CA_MASTER` nor `INTERLACE_ROOT_PUBKEY` set).
  Everything else enforces — including "no authority at all", which
  enforces and then fails closed at `resolveCABundle` with
  `-32005 CA bundle unavailable`. Unsetting `INTERLACE_ROOT_PUBKEY`
  alone does **not** disable the gate. Granularity is the deployment
  binding, NOT a per-request bypass.
  The verified `VerifiedLease` (peerFp + scope + cert DER + sig)
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
- **Inputs wire by capability, not by hand** — an input declares
  `provides` / `requires` (studs / anti-studs) and the matchmaker
  (`scripts/capability-matchmaker.mjs`, ADR-0027) resolves them during
  `task cluster:toml`. Unsatisfied, ambiguous, self-provided and cyclic
  declarations **fail the build** rather than resolving arbitrarily — that
  fail-closed property is the symbolic half of ADR-0054. Operator guide:
  [`docs/reference/capability-lattice.md`](docs/reference/capability-lattice.md).
  No input declares a lattice yet; the gate is wired so the first one is checked.
- **A field list that mirrors the schema is a bug waiting to happen.**
  `cluster.capnp` is projected to a strict zod schema (`src/generated/
  cluster.zod.ts`, 41 schemas, `.strict()`), and consumers read the field list
  from *that* rather than enumerating it. `[[generated_backends]]` rows are
  declared as `struct GeneratedBackend`; `toml-to-cluster` and `resolve-inputs`
  derive their `[inputs.*]` keys from `InputSpecSchema`. Hand-enumerating is
  how ADR-0051's `connection` shipped declarable-and-invisible, and how a
  typo'd `[inputs.*]` key was silently *erased* from cluster.toml by the
  round-trip. capnp's native `= value` defaults are honoured as of LLO f72fca,
  so a default is declared once in the schema and nowhere else. The exception
  that proves it: required-ness. capnp has no required fields, so
  `toml-to-cluster`'s check 4z states what the schema structurally *cannot* —
  that is the one case where an explicit list is right.

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
  as a `disclosure` route kind. Lease-gated whenever the gate enforces
  (see `resolveLeaseGate` above — not merely "when
  `INTERLACE_ROOT_PUBKEY` is set"); scope `disclosure:<fp>`.
  Auth-failure collapses into the same constant-time 404 to avoid
  peer-existence + cert-validity oracles.
- **Threat model is the contract** for the lease/attestation surface —
  `docs/security/threat-model.md` (math-friend authored, cross-linked
  from ADR-0007/0011/0012 frontmatter). Adding a new seam (cert mint,
  bundle fetch, lease step, counter write, cross-DO handoff, disclosure
  endpoint, compute substrate) means extending the model first.
- **Two CAS hash algorithms, intentionally distinct.** SHA-256
  (`crypto.subtle.digest`) is the application-layer digest: bead
  `content_hash`, attestation references, default BlobStore keying.
  BLAKE3-256 (wasm32 FFI to LLO `leyline-cas-ffi`, synchronous via
  `src/wire/cas-hash.ts`) is the substrate digest: blob identity in
  build-cache/v1, arena roots. The build-cache/v1 wire overloads the
  OCI `sha256:` prefix with BLAKE3 hex — `BlobStore.put` dual-verifies
  against both algorithms. See
  `leyline-schema-spec/build-cache/v1/wire/digest-encoding.md` for the full
  encoding rule.

## In-flight substrate work (ADRs 0007–0036)

Per-ADR **design** status is generated at
[`docs/adr/INDEX.md`](docs/adr/INDEX.md) from each ADR's frontmatter;
**implementation** status lives in the ADR's tracking bead + git — never
hand-restated in prose (see the source-of-truth note above; this is why
we don't keep a parallel status ledger). The table below is the
decade-thread index only: it names the post-0007 decade additions +
their decade-thread home.

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
| 0026 — tool composition model (Nix-flakes-shaped, MCP-registry-resolved, content-addressed, Interlace-signed) | `interlace-substrate/adrs` |
| 0027 — substrate-as-kernel: capability matchmaker (n-dim) | `interlace-substrate/adrs` |
| 0028 — capability identifier scheme (three concerns, three names) | `interlace-substrate/adrs` |
| 0029 — per-repo membership boundary for OCI registry | `interlace-substrate/adrs` |
| 0030 — multi-workerd substrate (process-level tenant isolation) | `interlace-substrate/adrs` |
| 0031 — `cloister.capnp` as build artifact | `interlace-substrate/adrs` |
| 0032 — *reserved-but-unused* | — |
| 0033 — bd as cloister-mediated bead substrate (rsry MCP + bd storage) | `interlace-substrate/adrs` |
| 0034 — true multi-tenant access spec across rosary/mache/ley-line/notme/signet | `interlace-substrate/adrs` |
| 0035 — cloister ↔ LLO boundary (bridge crates in cloister, leyline-* in LLO) | `interlace-substrate/adrs` |
| 0036 — schema-bridge multi-output IR (Phase 1 in cloister, Phase 2 lift to LLO) | `interlace-substrate/adrs` |
| 0037 — *reserved* (secure MCP ingress transports, `cloister-22a5ca`) | — |
| 0038 — derive bundle image from `server.json` `packages[].oci` | `interlace-substrate/adrs` |
| 0039 — securing local Durable Object SQLite at rest | `interlace-substrate/vault` |
| 0040 — harness-in-cloister (control + credential + audit plane) | `interlace-substrate/adrs` |
| 0041 — OCI image-publish contract (each backend repo publishes its own distroless image) | `interlace-substrate/adrs` |
| 0042 — turnkey local harness run (`task harness:dev`; dev-mode seams behind `CLOISTER_MODE=dev` + `lint:no-dev-mode` rail) | `interlace-substrate/vault` |
| 0043 — cloister as the isolated delivery plane for skills/agents/tools (harness gets skills via cloister not the filesystem; load-event receipts) | `interlace-substrate/adrs` |
| 0044 — compute-isolation substrate (libkrun microVM, HVF+KVM one mediator; host-mediated policy fs) | `harness-substrate/compute-substrate` |
| 0045 — leyline-sign lift to LLO (signing-substrate consolidation; cloister bridges LLO `ll-sign` like cloister-cas bridges leyline-cas-ffi) | `interlace-substrate/adrs` |
| 0046 — mediated-capability core (syscall / rpc / ipc as 1:1 transport adapters over one core) | `harness-substrate/compute-substrate` |
| 0047 — vault bundle-identity (per-bundle DO instances + notme DPoP-token verify) | `interlace-substrate/vault` |
| 0048 — unified tool primitive (cloister defines tooling; definition-inside-the-boundary) | `interlace-substrate/adrs` |
| 0049 — cloister host-runtime (one composed native runtime: nono + leyline-fs + libkrun) | `harness-substrate/compute-substrate` |
| 0050 — FS-mediation approach (content-addressed rootfs + VM isolation as the substrate) | `harness-substrate/compute-substrate` |
| 0051 — same-host UDS as an input transport | `interlace-substrate/adrs` |
| 0052 — bead merge algebras converged twice — unify into one specification | `interlace-substrate/adrs` |
| 0053 — unified lease-gate authority resolution (one resolver; empty authority fails closed) | `interlace-substrate/identity-lease` |
| 0054 — neuro-symbolic dispatch (the model parses, the substrate decides) | `interlace-substrate/adrs` |
| 0055 — RFC 9728 protected-resource metadata (discoverable OAuth resource server) | `interlace-substrate/adrs` |

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

## Operator-facing knobs (2026-06-24 additions)

- **`BEAD_STORAGE_BACKEND`** (env var, optional, default `"do"`) — per
  ADR-0033 D5 amendment + cloister-c8b907 migration. Switches Step 2 of
  the bead-create orchestrator between cloister's BeadStore DurableObject
  (`"do"`) and rsry's `rsry_bead_create` MCP tool via ROSARY_BUNDLE
  (`"rsry"`). Both paths preserve the §13.4 audit chain via the bead_id
  link on `peer_attestations` (cloister-dea77c). When unset / unknown,
  defaults to `"do"` with a one-shot deprecation warning per
  cloister-f34f7b.
- **`perTenant: Bool` on BundleSpec** (cluster.toml, default false) —
  per ADR-0034 + cloister-cedcf3. Operator declares a bundle as
  tenant-scoped; emit-compose Phase 2 (deferred) will emit one container
  per tenant. Lint Inv 8 + Inv 9 enforce that perTenant=true requires a
  matching `tenantDispatch` route + binding chain. See
  [`docs/reference/tenancy-model.md`](docs/reference/tenancy-model.md).

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
3. **The pre-push hook enforces the pinned pnpm.** It reads
   `package.json#packageManager` and refuses to run the gate with an
   ambient mismatched `pnpm` (Codex's bundled runtime has exposed newer
   pnpm versions). If it fails before Task starts, activate the pinned
   version with Corepack or put a matching pnpm earlier on `PATH`.

Tracking bead for these: file one when they bite a real piece of
work.
