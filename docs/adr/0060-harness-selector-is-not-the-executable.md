---
title: "ADR-0060: A harness target's selector is not its executable"
status: Accepted (2026-07-30)
date: 2026-07-30
tags: [harness, cli, schema, confinement, declaration]
relates_to:
  - 0004-manifest-schema-evolution.md
  - 0042-turnkey-local-harness-run.md
  - 0057-declaration-model.md
---

# ADR-0060 — A harness target's selector is not its executable

## Context

`[[gateway.harnessTargets]]` declares each harness cloister can launch. Today
`name` does three jobs at once:

| Concern | claude-code | codex |
|---|---|---|
| **selector** — what you type after `--harness` / `--target` | `claude-code` | `codex` |
| **execution** — binary name, state dir, state env var | `claude`, `.claude`, `CLAUDE_CONFIG_DIR` | `codex`, `.codex`, `CODEX_HOME` |
| **provider** — vault service, key + base-URL env, strip list | `anthropic` | `openai` |

For `codex` the selector and the executable coincide. For Claude Code they do
not: the product is `claude-code`, the binary is `claude`. The resolver
(`scripts/lib/harness/launch.mjs`) falls back to the selector when no
`entryPoint` is declared:

```js
const cmd = requested.harnessBin || target.entryPoint || target.name;
```

so on a machine with Claude Code installed:

```
$ which claude-code    → not found
$ which claude         → /Users/…/.local/bin/claude

$ cloister run --harness claude-code --repo /abs/repo --setup-only
cloister run: could not resolve "claude-code" on $PATH.
```

The verb whose entire purpose is "run a harness confined to this repo" does not
run its primary harness without `--harness-bin /abs/path` on every invocation.

The row already half-declares the right answer: `stateDir = ".claude"` uses the
SHORT name. The execution identity was known and simply never stated as the
executable.

`entryPoint` exists but is an ABSOLUTE path by contract — correct for a pinned
deployment, wrong to commit for a developer machine where the install location
differs (`~/.local/bin`, homebrew, npm global). It is not the field for "the
binary is called something other than the product".

### Why no test caught it

Every existing test either passes `--harness-bin` explicitly or asserts on the
`LaunchRequest` *before* resolution. The `$PATH` lookup is therefore exercised
only where selector == binary — true for `codex`, false for `claude-code`. A
green gate and a broken verb, which is this repo's recurring shape: the
invariant held for the case the fixture happened to cover.

## Decision

**Add `executable @10 :Text` to `HarnessTarget`** — the binary NAME to resolve
on `$PATH`, distinct from the selector. Resolution becomes:

```
requested.harnessBin || target.entryPoint || target.executable || target.name
```

Four rungs, each meaningful and each narrower than the last:

1. `--harness-bin` — explicit per-invocation override.
2. `entryPoint` — absolute path, pinned deployment; the only form valid under
   confinement without a `$PATH` lookup.
3. `executable` — the binary's NAME, when it differs from the selector.
4. `name` — the existing default, still correct wherever they coincide.

`executable = "claude"` is declared on the claude-code row. `codex` declares
nothing new and behaves exactly as before.

### Flat field, not nested facets

The three concerns above are real, and grouping them structurally
(`[execution]` / `[provider]` sub-tables) was considered. Rejected for now:

- **ADR-0004 governs.** Fields are append-only with monotonically-increasing
  ordinals and never renumbered. A new optional field at `@10` is precisely that
  shape. Restructuring the row into sub-tables changes every reader of
  `harnessTargets` — the TOML bridge, the zod and Go emitters, the generated
  types, `harness-targets.mjs` — for a benefit that is presentational.
- **The grouping is not yet load-bearing.** Two harnesses, and the only concern
  that actually leaked was execution-vs-selector. Nesting to express a boundary
  that one field fixes is structure ahead of need.

This does not preclude facets later: if a third concern appears, or a harness
needs per-facet overrides, the fields group without changing their meaning.

### Selector aliases are NOT added

`--harness claude` still fails, listing `claude-code|codex`. Aliases were
considered and rejected: `resolveTarget` deliberately refuses an unknown name
rather than falling back, because "a typo would silently launch a different
provider and bill the wrong account". An alias table is a second name-space to
keep consistent, and the failure it prevents is a legible error message. If the
product name is the wrong selector, the fix is to rename the target — a
different decision, made once, not an alias.

## Consequences

- `cloister run --harness claude-code --repo <abs>` works on a stock install
  with no `--harness-bin`.
- A harness whose binary differs from its product name is a declaration, not a
  special case — consistent with `lint:harness-target-literals`' rule that
  adding a harness is a new row and never an edit to the harness path.
- The rail must assert against the **declared** targets, not a fixture: for each
  `[[gateway.harnessTargets]]` row, resolve its executable and assert it exists,
  skipping with a NAMED reason when that harness is not installed. A fixture
  would have passed the bug this ADR fixes; only the real declaration catches
  it, and a silent skip would restore the same blind spot.
- `entryPoint` keeps its meaning unchanged (absolute, pinned, confinement-safe).
  The two fields are not alternatives at the same level — `entryPoint` answers
  "where", `executable` answers "what it is called".

## References

- `cloister-1011aa` — the tracking bead, with the reproduction.
- ADR-0042 — the turnkey local harness run this verb packages.
- ADR-0004 — schema evolution: append-only, never renumber.
