# Direction — config de-sprawl: declarative, tool-owned, isolated dev/test config

- **Date:** 2026-07-07
- **Status:** Direction / pre-ADR (raised while landing ADR-0042). Graduates to a
  numbered ADR when we commit to building it.
- **Raised by:** the operator, reacting to the ADR-0042 dev-mode work adding
  `CLOISTER_MODE=""`-style pins to `vitest.config.ts`.

## The smell

`vitest.config.ts` hand-maintains a growing pile of **raw env-var bindings**
(`VAULT_KEK_SOURCE`, `INTERLACE_ROOT_PUBKEY`, `INTERLACE_MASTER_PUBKEY`,
`INTERLACE_DISCLOSURE_HMAC_KEY`, `RECEIPT_*`, and briefly the ADR-0042 dev
knobs). Each is really **config for some tool/subsystem**, but they're all
flattened into one central test file. Two consequences:

1. **The pile grows unboundedly.** Every new subsystem knob becomes another
   line in the test config, owned by nobody in particular.
2. **The dev run and the test env share a surface.** `task harness:dev` writes
   `.dev.vars`; vitest-pool-workers *also* loads `.dev.vars`. So dev config
   leaks into the suite — which is why a defensive `CLOISTER_MODE=""` pin was
   even tempting. That pin treats the symptom.

This is off-grain for this repo, which already has **recipes** (`recipes/*`) and
a **declarative operator surface** (`cluster.toml`, ADR-0025) as its
repeatable-setup primitives. Config-as-env-var-pile predates them.

## The direction

1. **Config is tool-owned.** Each subsystem exposes its own typed config
   surface (defaults + schema); the composition root assembles them. The test
   config *composes* those surfaces instead of hand-restating every binding.
2. **Repeatable environments are declarative named configs**, recipe-shaped —
   the test env, the harness-dev run, and prod are instantiations of one model,
   not three bespoke binding lists. The test env becomes a named config the
   suite loads; the harness-dev run becomes a `dev-config.toml`.
3. **Dev-run config is isolated from the test env by construction** — a separate
   surface, so no defensive pins. (Mechanism TBD *with a wrangler-capable
   verification*: wrangler **named environments were investigated and rejected**
   — they don't inherit this repo's top-level `[[durable_objects]]` /
   `[[services]]` / `[[migrations]]`, so `[env.harnessdev]` would force
   duplicating that whole block, i.e. *more* sprawl. Likely candidates: `--var`
   flags for the run, or a dedicated config loader that vitest never reads.)
4. **Secrets never live in config artifacts.** The API key stays an env var
   (`ANTHROPIC_API_KEY`), injected into the vault seed at runtime — never
   written into any `.toml`.

## Why not now

This is a **cross-cutting refactor** of how the whole app configures itself. It
deserves its own deliberate design pass + a numbered ADR + a wrangler-capable
verification of the isolation mechanism — not an inline change bolted onto the
ADR-0042 session. Rushing it would trade one kind of debt for another.

## Interim (ADR-0042, shipped)

Until this lands: `task harness:dev` writes `.dev.vars` and **removes it on
exit** (`harness-dev.mjs` cleanup), so an active dev session doesn't leave
test-polluting state. `lint:no-dev-mode` still guarantees no *committed* config
enables a dev seam. The `vitest.config.ts` dev pins were reverted — the cleanup
+ lint cover the real cases without adding to the pile.

## When it graduates

Trigger: someone picks up the config-model refactor. First step is a numbered
ADR that (a) picks the tool-owned config-surface shape, (b) settles the dev/test
isolation mechanism against a real wrangler run, (c) sequences the migration of
the existing `vitest.config.ts` bindings. File a bead then.
