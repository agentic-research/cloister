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
| **`cloister/credential-isolation/v1`** capability | **ADR-0024**, `cloister-spec/credential-isolation/v1/`, `docs/plans/credential-isolation-capability.md` | **`cloister-8f57f0`** | First concrete capability under the substrate-as-kernel framing. TDD baseline (stub + 29 failing tests) lives on branch `tdd/credential-isolation-v1`. Phases 1-11 in the plan doc; each closes when its test tranche turns green. |
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
| `cloister-cf2e6a` | schema-bridge: emit .strict() on generated zod objects | in flight (skeptic N1 follow-up from cloister-ae06f3) |
| `cloister-fe891f` | cluster:toml chains canonicalize step (operator UX) | closed (PR #12, 2026-05-17) |
| `cloister-0d5e0f` | `task done` pre-PR readiness gate (drop-in rules, mache smell-rules shape) | P2 — in flight |

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
