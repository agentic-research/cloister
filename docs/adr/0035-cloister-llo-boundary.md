---
title: "ADR-0035: cloister↔LLO boundary — bridge crates in cloister, leyline-* names in LLO"
status: Proposed (2026-06-24)
date: 2026-06-24
tags: [substrate, supply-chain, naming, leyline, vendored-fork]
threat_model: docs/security/threat-model.md
relates_to:
  - 0007-interlace-substrate.md
  - 0019-sign-only-helper-protocol.md
  - 0026-tool-composition-model.md
  - 0028-capability-scheme.md
  - 0029-oci-per-repo-membership-boundary.md
---

## Context

cloister carries Rust crates whose source originated in `ley-line-open`
(LLO) under the `leyline-*` namespace. The 2026-06-24 per-file audit
of `cloister-59c60e` (recorded as a comment on that bead) confirmed
the current state:

| File / path | Origin | Drift from LLO | Why it lives in cloister |
|---|---|---|---|
| `rs/crates/sign/src/cert.rs` | LLO (Apache-2.0 → AGPL-3.0 lift, 2026-05-09) | 3-line license header only | wasm32 verifier path |
| `rs/crates/sign/src/error.rs` | LLO | 3-line license header only | wasm32 verifier path |
| `rs/crates/sign/src/oid.rs` | LLO | 3-line license header only | wasm32 verifier path |
| `rs/crates/sign/src/cms.rs` | LLO | `signingTime` removed for wasm32; documented inline | wasm32 verifier path |
| `rs/crates/sign/src/ffi.rs` | LLO | `lsign_alloc` + `lsign_free` exports added for wasm32; documented inline | wasm32 verifier path |
| `rs/crates/sign/src/lib.rs` | LLO | 15-line fork-explanation header + 2 cloister-only `pub mod` lines | wasm32 verifier path + bridge module decls |
| `rs/crates/sign/src/cert_chain.rs` | cloister-only | n/a | Multi-cert verification chain (ADR-0007 lease pipeline) |
| `rs/crates/sign/src/host/*` | cloister-only | n/a | `leyline-sign-helper` host server (ADR-0019) |
| `rs/crates/sign/src/bin/helper.rs` | cloister-only | n/a | `leyline-sign-helper` binary entrypoint (ADR-0019) |

The lift was driven by the wasm32 consumption gap — workerd's V8
isolate runs leyline-sign as a wasm32 module via `src/wire/signet-verify.ts`
(cloister-bd5241), and LLO's canonical leyline-sign at the time of
lift didn't compile to wasm32 cleanly. Two specific adaptations were
needed:

1. **`signingTime` removal in CMS SignedAttributes** (cms.rs). wasm32
   has no portable host-independent time source; emitting a fixed-time
   placeholder across hosts would silently collapse the temporal-binding
   property of any verifier trusting signingTime. The omission is
   spec-legal per RFC 5652 §5.3.

2. **Explicit linear-memory allocators** (`lsign_alloc` / `lsign_free`
   in ffi.rs). wasm32 callers can't reach Rust's allocator without
   exported entrypoints; the same FFI exports work natively (cdylib
   via cbindgen) and on wasm32, with pointers becoming 32-bit indices
   into wasm linear memory.

Both adaptations are documented inline. Neither has been PR'd back
to LLO yet — that's the convergence work this ADR scopes.

## Decision

**Principle: bridge crates stay in cloister; leyline-* names belong
in LLO.**

Concretely:

1. **leyline-* implementations are canonical in LLO.** When LLO ships
   the wasm32 adaptations (gated on a Cargo feature so existing
   consumers don't break), cloister consumes leyline-sign as a git
   dep — the same pattern `cloister-713b4e` established for
   `leyline-cas-ffi`. The vendored `cms.rs`, `ffi.rs`, `cert.rs`,
   `error.rs`, `lib.rs`, `oid.rs` get deleted in favor of
   `pub use leyline_sign::*;` re-exports (or direct import paths).

2. **Bridge crates with cloister-specific concerns stay in cloister.**
   `cert_chain.rs`, `host/`, and `bin/helper.rs` are NOT leyline-shaped
   — they're cloister's lease-pipeline + ADR-0019 helper protocol
   implementations that happen to depend on leyline-sign. These
   remain in `rs/crates/sign/src/` (or a renamed `rs/crates/cloister-sign/`
   if the name "sign" becomes ambiguous post-consolidation).

3. **Naming follows the implementation.** A crate is `leyline-X` iff
   its canonical implementation lives in LLO. cloister-side bridges
   adopt `cloister-X` naming when they're spun out (this is the
   audit's outcome — today they live under `rs/crates/sign/src/` but
   shouldn't keep the `leyline` prefix once the leyline-* portions
   move upstream).

4. **License continuity is preserved.** When `leyline-sign` becomes a
   git dep, its license stays AGPL-3.0-or-later (LLO's project
   license). cloister-side bridge crates inherit cloister's project
   license (currently AGPL-3.0-or-later as well; if that ever
   changes, the bridge crates may need a separate license declaration).

## Why now

The convergence has three observable wins:

1. **No more silent drift between two AGPL forks of the same code.**
   The 2026-06-24 audit had to read 1270 lines of Rust to confirm
   nothing has actually drifted — the diffs are all intentional. That
   work happens every time someone wonders if the forks are aligned.
   Consuming LLO as a git dep makes drift impossible: the only diff
   is the cargo pin.

2. **wasm32 support becomes a first-class LLO capability.** Today
   LLO consumers who want wasm32 support have to fork; that's
   strictly worse than gating it on `[features] wasm32 = ["…"]`.

3. **The cloister-side bridge concerns become visible.** When
   `cert_chain.rs`, `host/`, and `bin/helper.rs` are the only files
   in `rs/crates/sign/src/`, their cloister-specificity is unambiguous
   — they document themselves as bridge code rather than hiding inside
   a vendored copy of someone else's crate.

## Sequencing

| Step | What | Owner | Bead |
|---|---|---|---|
| 1 | PR LLO with wasm32 changes (allocator exports + signingTime feature flag + module doc) | cloister (upstream PR) | new sub-bead |
| 2 | LLO release containing the wasm32 changes | LLO | LLO-side |
| 3 | Cloister: bump `Cargo.toml` / `cluster.toml` LLO pin to the release | cloister | new sub-bead |
| 4 | Cloister: delete `rs/crates/sign/src/{cert,cms,error,ffi,lib,oid}.rs`; replace with re-exports / direct imports | cloister | new sub-bead |
| 5 | Optional rename: `rs/crates/sign/` → `rs/crates/cloister-sign/` to reflect post-consolidation scope | cloister | follow-up |
| 6 | Update threat-model §15 + ADR-0019 references to point at LLO's canonical leyline-sign | cloister | bundled with step 4 |

Steps 1+2 unblock 3+4. Step 5 is cosmetic and can defer indefinitely.

## Risks + tradeoffs

| Risk | Mitigation |
|---|---|
| LLO's release cadence may not include the wasm32 changes promptly | Cloister carries the vendored copy until LLO ships; the audit shows this is sustainable (no behavioral drift, only documented additions) |
| LLO's API may evolve in a way that breaks cloister's `cert_chain.rs` consumer | cert_chain.rs uses leyline-sign's public API (`verify_signed_data`, `parse_signed_data`, etc.); LLO's semver-pin obligation covers this |
| The wasm32 gating in LLO may not match cloister's exact wasm32 build flags | Land step 1 as a collaborative PR where cloister's wasm32 build is the acceptance test |
| Renaming the crate (step 5) breaks downstream import paths | Defer; the rename is a follow-up, not part of the consolidation |

## Out of scope

- **Other leyline-* crates beyond leyline-sign.** This ADR ratifies
  the principle and applies it concretely to leyline-sign because
  that's the only vendored fork today. If another leyline-* crate is
  ever vendored, the same principle applies; this ADR is the precedent.
- **Bidirectional code flow (cloister → LLO).** `cert_chain.rs`, `host/`,
  and `bin/helper.rs` are NOT intended to move to LLO. They're cloister's
  bridge concerns; LLO has no use for them.
- **The AGPL→Apache relicense question.** LLO's `NOTICE` documents
  that the leyline-sign lift relicensed from Apache-2.0 (original
  private ley-line) to AGPL-3.0-or-later (LLO's project license).
  Re-relicensing in the reverse direction is not in scope.

## References

- `cloister-59c60e` — the leyline-sign convergence tracker (re-titled
  2026-06-24 from "drifted" framing to "convergence plan").
- `cloister-5e4402` — this ADR's design bead.
- `cloister-713b4e` — the precedent migration: `leyline-cas-ffi`
  consumed from LLO as a git dep.
- ADR-0007 — Interlace substrate. cert_chain.rs implements its lease
  verification.
- ADR-0019 — Sign-only trust-anchor-helper. host/ + bin/helper.rs
  ship the helper protocol.
- ADR-0026 — Tool composition model. The same `[inputs.*]` pattern
  cloister uses for upstream MCP servers is the conceptual
  counterpart for upstream Rust crates.
- ADR-0028 — Capability identifier scheme. The naming principle
  (`leyline-X` for LLO-owned, `cloister-X` for cloister-owned) is
  consistent with §6 lane discipline.
- `rs/crates/sign/src/lib.rs` header comment — the operator-facing
  pointer to this convergence plan.
- LLO `rs/ll-open/sign/NOTICE` — license relationship.
