# `task done` — pre-PR feature-readiness gate

Per [`cloister-0d5e0f`](../../). Drop-in rule runner that bundles the
"is this feature ready to ship?" checks into one verb. Shape mirrors
mache's external smell rules (`MACHE_SMELL_RULES_DIR` →
`examples/smell-rules/*.json`) — each check is one JSON file under
`done-rules/`, no central registry to update.

## Usage

```sh
task done            # runs every rule; exits 1 if any block-severity fails
```

Set `DONE_RULES_DIR` to point at a different rules directory (handy for
testing or for repo-specific extensions).

## Output shape

```
task done: 4 rule(s) loaded from /path/to/done-rules
  ✓ lint-passes — task lint exits 0 (the project's fast-gate of record)
  ✓ branch-on-feature — current branch is feat/* | fix/* | chore/*
  ✓ bead-pinned — .rsry-bead-id exists and contains a non-empty bead id
  ⚠ no-uncommitted-noise — no untracked or modified files outside .beads/
      [exit=1] ?? scripts/new-thing.mjs

task done: 3 pass, 1 warn, 0 block
```

Exit codes:
- **0** — no `block`-severity failures (warns may exist)
- **1** — one or more `block`-severity failures
- **2** — toolchain error (malformed rule, JSON parse error, etc.)

## Severity

| Severity | Effect on exit | Use for |
|---|---|---|
| `block` (default) | Non-zero exit; surfaces in the FAIL summary | Hard requirements you wouldn't merge without |
| `warn` | Reported but doesn't block | Hygiene reminders; nudges, not gates |

`severity` is optional; if you omit it, the runner defaults to `block`
(fail-secure — an unannotated rule blocks shipment until the operator
explicitly classifies it as `warn`).

## Adding a rule

Drop a JSON file into `done-rules/` (or wherever `DONE_RULES_DIR` points):

```json
{
  "id":          "tests-pass",
  "description": "the project's test suite exits 0",
  "severity":    "block",
  "run":         "pnpm exec vitest run"
}
```

- **`id`** (required) — stable identifier; must be unique within the
  rules directory; appears in output + as the failure handle in the
  FAIL summary.
- **`run`** (required) — shell command. Exit 0 = pass; anything else =
  fail. Stdout/stderr surface in the per-rule output on failure.
- **`description`** (recommended) — one-line explanation; renders in
  every result line.
- **`severity`** (optional, default `"block"`) — `"block"` or
  `"warn"`. See above.

Files are loaded in filename-sorted order. Conventional naming pattern
is `NN-<id>.json` where `NN` is a two-digit prefix (matches the
existing seed-rule shape: `00-lint-passes.json`,
`10-branch-on-feature.json`, etc.) — keeps the per-rule output reading
in a sensible order. Non-`.json` files in the directory are ignored,
so a `README.md` is fine.

## Built-in seed rules (V1)

| File | Severity | Purpose |
|---|---|---|
| `00-lint-passes.json` | block | `task lint` exits 0 — the project's fast-gate of record |
| `10-branch-on-feature.json` | block | Current branch matches `feat/*` / `fix/*` / `chore/*` / `docs/*` / `test/*` / `refactor/*` (not `main`, not detached) |
| `20-bead-pinned.json` | block | `.rsry-bead-id` exists + matches `<repo>-<6hex>` so the commit-msg hook auto-prefixes (Golden Rule 11) |
| `40-no-uncommitted-noise.json` | warn | `git status -s` clean outside `.beads/` runtime state |

More rules in the [cloister-0d5e0f follow-ups
queue](#follow-ups) — each is its own bead so the V1 ships small.

## Follow-ups

Rules deferred from V1; each warrants its own design + tests:

- `verify-passes` — `task verify` exits 0. Slow, opt-in flag.
- `drift-gates-clean` — enumerate every `*:check-drift` task + run it.
- `commits-prefixed` — every commit on the branch matches
  `[<bead-id>] type(scope): description` (Golden Rule 11).
- `pr-body-checklist` — if a PR is open for the branch, body contains
  `## Summary` + `## Test plan`.
- `e2e-walked` — recording-style rule that lets operators stamp "I
  manually exercised the feature end-to-end" with a timestamp.

## Design rationale

- **Drop-in JSON** matches mache's external smell rules — proven
  shape, low ceremony, no central registry. Adding a check is one
  file; no Taskfile edit, no runner edit.
- **Shell as the universal escape hatch** — rules that need
  non-trivial logic shell out to repo scripts (`scripts/check-X.sh`)
  rather than embedding logic in JSON. Keeps the rule format simple.
- **Fail-secure default** — an unannotated rule blocks. Surfacing a
  "warn" rule is an explicit decision the operator must make.
- **Deterministic order** — rules run in sorted-filename order so PR
  output is stable for review.
- **Reusable across cloister-sibling repos** — the runner takes
  `DONE_RULES_DIR` as input; nothing in `done-runner.mjs` is
  cloister-specific. Future lift to a shared tool / `taskfile-include`
  is straightforward.
