# ADR-0045 — leyline-sign: consume the shared LLO artifact + retire the cloister fork

- **Status:** **Amended 2026-07-09 — original premise corrected (see Amendment).**
  Was "Proposed" (drafted 2026-07-08).
- **Tracking bead:** `cloister-8e6d5d` (consume LLO wasm + delete the fork) →
  depends on `ley-line-open-a2099a`. (Original `cloister-c4aa20` closed — see below.)
- **Pairs with:**
  - ADR-0035 (cloister↔LLO boundary — "`leyline-*` live in LLO, bridge crates in cloister")
  - ADR-0019 (sign-only trust-anchor-helper protocol)
  - ADR-0007 (Interlace lease/attestation — the wasm cert-chain verify *is* the lease gate)

## Amendment (2026-07-09) — the premise below was based on stale info

This ADR was drafted 2026-07-08 asserting a **lift of `leyline-sign` *from*
cloister *into* LLO**. That premise is **wrong**. Confirmed by the LLO agent + the
git log + lectio:

- **`leyline-sign` — including its `host` feature — was already canonical in LLO**
  at `ley-line-open/rs/ll-open/sign/`, **shipped in LLO v0.5.2 on 2026-06-25**
  (PRs #115 `cert_chain` + `lsign_alloc/free`, #116 `signingTime` omission). LLO
  is now at 0.5.8. Nothing needed lifting.
- **cloister's `rs/crates/sign` is a stale *fork*** — deletable. **LLO PR #160**
  consolidates it away.
- The draft was written without querying **lectio** (which surfaced the shipped
  state in one search) or re-reading **ADR-0035** — it mistook the local fork for
  the source of truth.

**Corrected decision.** cloister **consumes** LLO's canonical `leyline-sign` and
**deletes its fork**: `src/wire/signet-verify.ts` imports the LLO-published
`leyline-sign` wasm artifact (the in-isolate CMS/cert-chain verify — prerequisite
**`ley-line-open-a2099a`**, the LLO-native wasm32-emit → `notme/wasm/` work), and
`rs/crates/sign` is removed (git-dep LLO's crate for any native helper use). There
is **no lift, no cloister-side bridge crate, no two-phase producer→consumer** — the
artifact already exists; cloister just consumes it. Tracked by `cloister-8e6d5d`.

The **I1–I4 invariants** below remain valid — they govern LLO's crate + cloister's
consumption (byte-equality, wasm32, the `ed25519-dalek ~2.1` pin, no host closure
in the verify path). The **CAS wasm** (`leyline-cas-ffi` hash) is a separate,
genuinely-additive scope, not part of this. The beads the draft spawned
(`cloister-c4aa20`, `ley-line-open-395b7f`, `-8da7bc`) are closed as stale-premise;
`ley-line-c764c6`/`e25413` are LLO-side zombies (dead ley-line paths), owned by the
LL agent's reconciliation. Read the sections below as *historical context for the
invariants*, not the plan.

## Context

`rs/crates/sign` (package `leyline-sign`) is the last un-consolidated
`leyline-*` crate. It's named in the `leyline-*` namespace — which ADR-0035
places in LLO — but it lives in cloister as a **standalone fork**: it depends on
no LLO crate and vendors its own cert-chain / Ed25519 / CMS / x509 stack. Its two
consolidated peers show the target shape:

- **`cloister-cas`** is a thin **bridge** → LLO `leyline-cas-ffi` (git-pinned rev
  `593ee61`). The model.
- **rosary** consolidated onto LLO `leyline-core` (git rev `c3515b9`) —
  "can't drift off the substrate lock" (2026-07-09).

LLO's `rs/` is `ll-core` (`leyline-core`) + `ll-open` — **no signing crate**. So
cloister's `leyline-sign` is the *de-facto* canonical signing substrate, just in
the wrong repo.

**The crate already splits cleanly along the lift boundary.** The default
(host-less) build is a verify core that builds for `wasm32-unknown-unknown`
byte-identically regardless of features; the `host` feature layer is gated by
`#[cfg(all(feature = "host", not(target_arch = "wasm32")))]` at every module
boundary (per `cloister-99165e`, the `rs:sign:wasm` contract). The seam is drawn:

| src module | tier | destination |
|---|---|---|
| `cert_chain.rs`, `cert.rs`, `cms.rs`, `oid.rs`, `ffi.rs`, `error.rs`, `lib.rs` (default) | **verify core** — wasm32, no host deps | **→ LLO `ll-sign`** |
| `host/` (keystore, HTTP server, signing pipeline, rate limiter), `bin/helper.rs` | **host layer** — ADR-0019 daemon + KEK sources | **stays cloister** |

## Decision

Lift the **verify core** into LLO as `ll-sign` (package `leyline-sign`); cloister
keeps the **`host` layer + helper binary** as a crate that **bridges** to it —
mirroring `cloister-cas`→`leyline-cas-ffi` and rosary→`leyline-core`.

- **LLO `ll-sign`** = today's default-feature surface: the byte-exact cert-chain
  verifier, Ed25519 verify, CMS/x509 parsing, the FFI/wasm export. Canonical for
  cloister, rosary, and any future consumer.
- **cloister `rs/crates/sign`** becomes the `host` layer + `leyline-sign-helper`
  bin, depending on `ll-sign` (git rev pin, like `cloister-cas`). The ADR-0019
  trust-anchor daemon, OS-keystore/KEK sources, and HTTP server are cloister's
  *tooling*, not the substrate — they stay.
- **cloister's wasm glue is unchanged** (`src/wire/cas-hash.ts`-shaped loaders,
  `lease-middleware.ts` integration) — it loads `ll-sign`'s wasm artifact instead
  of the local crate's. No TS change beyond the artifact path.

## Contract — invariants the lift MUST preserve

- **I1 — Byte-equality.** `ll-sign`'s cert-chain verify produces byte-identical
  results to today's cloister implementation. The fixed-seed fixtures
  (`rs gen-fixture` → `test/wire/fixtures/cert-chain.ts`) are the golden vector;
  the cross-implementation byte-equality test runs on **both** sides (LLO CI
  regenerates + diffs; cloister keeps its consumer test). A drift here breaks the
  lease gate silently — this is the load-bearing invariant.
- **I2 — wasm32 target.** `ll-sign` default features build for
  `wasm32-unknown-unknown` with **no host deps** in the verify path; the
  `#[cfg(all(feature="host", not(target_arch="wasm32")))]` discipline moves with
  the code, and `crate-type` keeps `cdylib` for the wasm artifact.
- **I3 — Crypto pins travel.** The `ed25519-dalek = "~2.1"` tilde-pin (ADR-0019
  §Implementation pins — math-friend's constant-time + algorithm-substitution
  defense) moves to `ll-sign` verbatim.
- **I4 — No host closure in the verify path.** `ll-sign` default features pull in
  **none** of `keyring` / `nono` / `axum` / `tokio` — the sigstore-verify /
  aws-lc-rs / landlock transitive closure (threat-model §17.1) stays behind
  cloister's `host` feature, off the minimal wasm attack surface.

## Sequence — two-phase, cross-repo

1. **Phase 1 (LLO — `ley-line-open-395b7f`):** create `rs/ll-sign` from the verify
   core; move the `gen-fixture` example + cert-chain golden vectors here so LLO
   owns its test oracle (the dep-story refinement — LLO stays independently
   testable); wire wasm32 CI + the byte-equality fixture (I1/I2); publish a rev.
2. **Phase 2 (cloister):** `rs/crates/sign` drops the vendored verify core, adds
   `leyline-sign = { git = "…/ley-line-open", rev = "<pin>", … }`, keeps `host/` +
   `bin/helper.rs`; confirm the wasm artifact byte-hash, the lease gate, and the
   cert-chain fixtures are unchanged. This half looks exactly like `cloister-cas`.

## Consequences

- One canonical `leyline-sign`; cloister + rosary + future peers consume it; no
  fork drift. ADR-0035 is fully realized for the signing substrate.
- The lift touches the authenticated-request path (the lease gate). Risk is
  contained by I1 (byte-equality golden) + I2 (wasm32 preservation) — the same
  guarantees `cloister-cas` already relies on for `leyline-cas-ffi`.
- Cross-repo rev-pin coordination (an `ll-sign` bump is a reviewed cloister PR,
  like `cloister-cas`'s `593ee61`).

## Alternatives considered

- **Keep the fork.** Rejected: drift risk, ADR-0035 violation, and rosary already
  consolidated its signing onto LLO — cloister would be the lone hold-out.
- **Make cloister canonical; rosary/others depend on cloister.** Rejected: a
  workerd/TS repo shouldn't be the source of truth for the Rust crypto substrate;
  ADR-0035 places `leyline-*` in LLO for exactly this reason.
- **Move the whole crate (incl. the helper) to LLO.** Rejected: the
  `leyline-sign-helper` is cloister's ADR-0019 trust-anchor *tooling* — it carries
  the OS-keystore/KEK-source + HTTP-serving concerns that are cloister deployment
  policy, not substrate. Only the verify core belongs in LLO.
