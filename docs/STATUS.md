# cloister STATUS — what's shipped, what's drafted, what's blocked

This is the project's reality index. Every capability, ADR, and
substrate decision should be findable here with a one-line status.
Updated as PRs merge / beads close / drafts ship.

For the why-and-shape of each entry, follow the linked ADR. For the
work-tracking, follow the linked bead.

## Shipped (running in main today)

| Capability | Reference | Bead | Status |
|---|---|---|---|
| Workerd substrate (v8-isolate hypervisor) | ADR-0001, ADR-0011 | — | shipped |
| Declarative routing via `cloister.capnp` | ADR-0002, ADR-0004 | — | shipped |
| Per-tier bundle classification (hypervisor / cluster) | ADR-0011 | — | shipped |
| Interlace lease verification | ADR-0007, `src/routes/lease-middleware.ts` | — | shipped |
| TrustStore + BeadStore + BlobStore DOs | ADR-0012 | — | shipped |
| Slice-grant enforcement (V8 isolate + service-binding-as-syscall) | ADR-0013 | — | shipped |
| Pluggable KEK source (`keychain://`, `op://`, `apple-password://`, `keyring://`, `secret-tool://`, `file://`, `env://`, `http(s)://`) | ADR-0014 | — | shipped |
| Sign-only trust-anchor-helper (`leyline-sign-helper`) | ADR-0019, `rs/crates/sign/` | `cloister-99165e` | shipped |
| Per-bundle vault DO instances | ADR-0021 | — | shipped (manifest-side via ADR-0013 enforcement) |
| schema-bridge (capnp → zod for `cluster.capnp`) | `tools/schema-bridge/` | — | shipped (cluster.capnp only — see `cloister-aea8a7`) |
| `CLOISTER_DO_PATH` host path resolution (macOS unblocker) | ADR-0023 | `cloister-addcdd` | shipped 2026-05-16 |
| Interlace 0.2.0 receipts (Phase 1: emit-but-don't-enforce) | `interlace-spec/0.2.0-draft/`, `cloister-ae713f` | — | shipped 2026-05-12 |
| Adversarial red-team rotation charter | ADR-0020 | `cloister-1f249f` | charter shipped; cycles ongoing |
| Notme co-location design (Alternative 4 split surface) | ADR-0018 | `cloister-db99cd` | design accepted; impl pending |
| Compute substrate portability (Phase 1: OCI + workerd) | ADR-0009 | — | Phase 1 shipped; Phase 2+ (Firecracker / WASI / unikernel) future |
| `task image:run` composable OCI image launcher | `cloister-a3681d` | closed | shipped 2026-05-16 |
| DO SQLite unencrypted-at-rest disclaimer | `cloister-a3681d` | closed | shipped 2026-05-16 |
| **Bidi TOML ↔ capnp pipeline (Phase 1)** — `cluster.toml` operator surface; `cluster:toml` / `:export` / `:roundtrip` Taskfile entries; drift gate in `task verify` | **ADR-0025**, `cluster.toml`, `scripts/toml-to-cluster.mjs`, `scripts/cluster-to-toml.mjs` | `cloister-ae06f3` | shipped 2026-05-17 (PR #9) |

## Drafted (design landed, no shipped behavior yet)

| Capability | Reference | Bead | Notes |
|---|---|---|---|
| **`cloister/credential-isolation/v1`** capability | **ADR-0024**, `cloister-spec/credential-isolation/v1/`, `docs/plans/credential-isolation-capability.md` | **`cloister-8f57f0`** | First concrete capability under the substrate-as-kernel framing. **Phase 0** (parser) + **Phase 1** (identity gates: constant-shape 401/403/404) shipped 2026-05-18 (PR pending). Phases 2-7 add their tests back as they ship; the plan doc owns the full test list. |
| Substrate-as-kernel framing (every concrete subsystem → v1 reference impl of a named Capability Interface, k8s CNI/CSI/CRI shape) | — | `cloister-1b59a2` | Framing direction; formalizing ADR is **pending from user's other LLM session** (network-identity ADR). Don't pre-empt. Phase 1 of the substrate-schema-neutral rail shipped via `cloister-ae06f3` 2026-05-17. |
| ADR-0022 — schema-bridge positioning + bidi pipeline framing | — (ADR not yet drafted) | `cloister-ae587d` | Overdue. ADR-0025 ships the bidi rail without it; ADR-0022 still wanted to close out the schema-bridge narrative. |

## Blocked

| Capability | Bead | Blocked on |
|---|---|---|
| Layer 2 addressability schema (`bundle.implements`, `wire.requires`, `route.requiresCapability`) | `cloister-ae4ed2` | User's incoming network-identity / "lego blocks" ADR |
| Port `@notme/contract` → schema-bridge | `cloister-9f03ed` | Trigger-gated: needs (a) top-level `const` mapping in schema-bridge OR (b) a non-TS consumer OR (c) contract growing past ~10 shapes |
| `interface`/generics/annotations/etc. in schema-bridge | `cloister-9f54d6` (meta) | First real schema hits the gap |
| schema-bridge: top-level `const` support | `cloister-9ea507` | None — ready |
| schema-bridge: cover `cloister.capnp` + `cli-config.capnp` | `cloister-aea8a7` | None — ready |
| Bot-author identity governance | — | Decision deferred; revisit when needed |
| Framing ADR (the OSS-front-door "add-type" lede direction) | — (no bead — captured in memory as `cloister-normie-framing`) | User authoring via separate LLM session |

## Pending follow-ups (have beads, deferred priority)

| Bead | Title | Priority |
|---|---|---|
| `cloister-ae8dac` | Re-incorporate 6 Copilot fixes onto main | closed (PR #6) |
| `cloister-ae587d` | ADR-0022 schema-bridge positioning | P3 — overdue but not blocking |
| `cloister-aea8a7` | schema-bridge: cover `cloister.capnp` + `cli-config.capnp` | P3 |
| `cloister-9f03ed` | port `@notme/contract` → schema-bridge | P3 (trigger-gated) |
| `cloister-9f54d6` | schema-bridge construct-coverage gaps (meta) | P3 |
| `cloister-cf519b` | lint:bundle-isolation: read cluster.ts (not cluster.capnp) after ADR-0025 | closed (PR #10, 2026-05-17) |
| `cloister-cf2e6a` | schema-bridge: emit .strict() on generated zod objects | closed (PR #14, 2026-05-17) |
| `cloister-fe891f` | cluster:toml chains canonicalize step (operator UX) | closed (PR #12, 2026-05-17) |
| `cloister-0d5e0f` | `task done` pre-PR readiness gate (drop-in rules, mache smell-rules shape) | closed (PR #13, 2026-05-17) |
| `cloister-339a22` | cloister/agent-process/v1 design (ACP server-side hosted in workerd) | P2 — design draft on `feat/cloister-339a22-agent-process-v1-design`, math-friend reviewed, awaiting direction |
| `cloister-9bfbf6` | CI lint: ed25519-dalek tilde-pin enforcement (ADR-0019 §15.7) | closed (PR #15, 2026-05-17) |
| `cloister-ff437f` | README §13.2 row unreadable — split into two rows + tighten | closed (PR #16, 2026-05-17) |
| `cloister-963bf6` | doc-polish + reorg: doc-friend audit findings (B1-B8 + P-fixes + archive shipped plans) | closed (PR #17, 2026-05-17) |
| `cloister-ff58d4` | docs/ surface lacks top-level index — orientation map | stale-closed (docs/README.md shipped via commit 201e8a1) |
| `cloister-9cd506` | doc-restructure: per-module READMEs to one voice + one template | P3 — follow-up from 963bf6 doc-friend audit |
| `cloister-9d14f2` | lint:doc-counts — assert "N tests" / "N ADRs" claims | closed (PR #23, 2026-05-17) |
| `cloister-c1691c` | receipts: pruneExpiredReceipts retention sweep | Phase 1+2 shipped (PR #24 + PR #25, 2026-05-17); bead stays open as Phase 3 tracker (per-actor `ca_decommission_after_ms` override, deferred until a real second actor lands) |
| `cloister-0719da` | substrate: TrustStore DO alarm scaffolding (closes pruneSeenNonces + pruneExpiredReceipts orphans) | closed (PR #25, 2026-05-17) |
| `cloister-9d4555` | doc-restructure: canonical "Backend kinds" page | closed (PR #26, 2026-05-17) |
| `cloister-9d602f` | doc-restructure: canonical "Bundle topology" page | closed (PR #27, 2026-05-17) |
| `cloister-c18eb3` | receipts followup: wire P-live verification into mcp-proxy outbound | Phase 1 shipped (PR #28); bead stays open as Phase 2 tracker (live wire-in + upstream CA-bundle fetcher + integration tests) |
| `cloister-da0f35` | host_adversarial.rs: unsafe env var mutation races with parallel tests | closed (PR #18, 2026-05-17) |
| `cloister-d9da67` | keystore: run_subprocess_with_trim reads stdout with no size cap | closed (PR #19, 2026-05-17) |
| `cloister-9bee1f` | /resolve allow-list: startup-time validator rejects prefixes that could match signing-key URLs | closed (PR #20, 2026-05-17) |
| `cloister-aa9376` | vault DO: collapse 403/404 status-code enumeration oracle (mirror disclosure §9.4.b) | closed (PR #21, 2026-05-17) |
| `cloister-d9a3c6` | keystore: TTL cache map grows unboundedly under unique-URL probe flood | stale-closed (shipped under cloister-2a0faa, commit a29dd88; pinned by `resolve_cache_bounded_under_unique_spec_flood`) |
| `cloister-211b68` | vault DO: unbounded RPC queue allows self-DoS (no per-caller budget) | shipped (F1 token-bucket in `vault/src/rate-bucket.ts` + per-method costs in `src/vault-store.ts:#consumeBudget`) — **bead close still blocked by auto-mode classifier; needs explicit user-authorized close** |
| `cloister-2176e4` | vault DO: KEK source path is cached per-DO but cold-start is amplification-amenable | stale-closed (clear-on-rejection at `src/vault-store.ts:524-528` + bounded retry in `vault/src/kek-source.ts:203`; commit 4499f7c) |
| `cloister-21b5eb` | vault DO: write-side has no rate-distinct cost from read-side | stale-closed (credential-payload caps in `vault/src/vault.ts:CREDENTIAL_LIMITS` + write=3/read=1 in RATE_LIMITS.COST; commit 4499f7c) |
| `cloister-d816a0` | ADR-0019 normative-req consolidation (18 → 15; move impl/log invariants to "Implementation pins") | closed (PR #22, 2026-05-17) |

## Convention

- **Shipped** = code is on `main`, tests green, deployable.
- **Drafted** = ADR / spec / plan exists, no shipped behavior. May
  have failing tests on a side branch as the executable plan.
- **Blocked** = work scoped, can't start until the named blocker
  lands.
- **Pending follow-ups** = beads filed, work not urgent, scheduled
  by priority.

Every entry links the canonical ADR / bead / path. If you find yourself
unsure whether something is real on `main`, this is the index — if
it's listed under Shipped, it ships; if it's listed under Drafted, it
doesn't.

## Side branches (entry points for work-in-progress)

- `tdd/credential-isolation-v1` — failing-test baseline for
  `cloister-8f57f0`. Impl PRs for Phases 1-11 branch from here.
- `wip/credential-isolation-recipes` — speculative operator recipes
  (OpenClaw / Claude Code / Codex). Lands as part of Phase 10 of
  `cloister-8f57f0`.

## Updating this file

When a PR merges that changes a capability's status:

- Shipped → leave under Shipped; update the reference column.
- Drafted → moves to Shipped; bead closes.
- Blocked → moves to Drafted or Shipped depending on what landed.
- New capability → add under Drafted with the bead reference.

The convention isn't enforced by a lint script today; just write down
what's true. The bead store + git log are the authoritative sources;
this is the human-readable summary.
