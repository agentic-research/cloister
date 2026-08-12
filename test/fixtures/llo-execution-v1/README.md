# `test/fixtures/llo-execution-v1/`

Vendored, byte-for-byte, from ley-line-open. **Do not edit these files.**

| File | Upstream path | Pinned by |
|---|---|---|
| `test-vectors/canonical-run.json` | `rs/ll-core/schema-spec/execution/v1/test-vectors/canonical-run.json` | `VECTORS.sha256` (vendored alongside) |
| `test-vectors/run-id.json` | same dir | `VECTORS.sha256` — run-identity derivation, added by LLO PR #312 |
| `VECTORS.sha256` | same dir | it IS the manifest; `scripts/test/llo-execution-vector.test.mjs` derives its case list from it |

## Why a copy rather than a checkout

Cloister CI has no ley-line-open checkout — the same constraint that makes
`rs/crates/cloister-cas/tests/confinement_digest.rs` inline confinement/v1's
canonical manifest instead of reading it from disk. A vendored copy under its
upstream digest is not a second source of truth: if it drifts from what LLO
published, the digest assertion fails loud, which is the whole point.

## What it is for

`canonical-run.json` is LLO's statement of what a real `cloister/execution/v1`
run *looks like* — a `spec` / `grant` / `receipt` triple. Cloister's own
statement of that contract is `src/generated/llo-execution-tools.json`, pinned
separately by `llo-execution-contract.lock.json`.

Those two artifacts are published independently and cloister pins them
independently, so they can disagree. `scripts/test/llo-execution-vector.test.mjs`
feeds this vector through cloister's *production* request validator to prove
they do not. That check is what was missing when PR #260 shipped a hand-written
ten-field RunSpec sharing zero names with the canonical eleven-field struct and
kept `task lint` green. Per ADR-0063.

## Updating

When LLO republishes `execution/v1`, both pins move together:

1. Re-copy the vector verbatim from the upstream path above.
2. Re-copy `VECTORS.sha256` — the test derives its case list from it, so a new upstream vector becomes a failing test until vendored.
3. Regenerate / re-pin `src/generated/llo-execution-tools.json` and its lock.

Moving one without the other is exactly the failure the test exists to catch,
so expect it to fail until both are done.
