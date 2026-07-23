// SPDX-License-Identifier: AGPL-3.0-or-later
//
// task mutate — targeted mutation testing (cloister-dab35a).
//
// WHY THIS EXISTS
//
// Green tests and line coverage measured nothing on two real bugs this repo
// shipped:
//
//   * The gateway actor fingerprint defaulted to a TRUTHY placeholder that
//     sailed past well-known.ts's empty-check opt-out and published a
//     fabricated cluster identity. The suite did not merely miss it — it
//     ENSHRINED it: two assertions pinned the broken value verbatim, turning a
//     fail-open bug into a requirement.
//   * `resolveCABundle`'s fail-closed guard could be deleted entirely — falling
//     through to `getCABundle(..., { rootPubkey: "" })`, which SKIPS signature
//     verification — and all 1396 tests still passed. The behaviour was correct
//     and asserted only by a comment.
//
// Coverage answers "was this line executed". Mutation answers the question that
// actually matters: "would the suite NOTICE if the behaviour changed".
//
// WHY NOT STRYKER
//
// Stryker cannot drive `vitest-pool-workers`, which executes tests inside real
// workerd. That puts the entire ~20k-line src/ surface — every fail-closed
// security property, i.e. the only place a surviving mutant is a FINDING — out
// of its reach. It could only mutate the ~4k-line scripts/ rails, which already
// kill 9/9 hand-written mutants. Broad, noisy coverage of the well-tested half
// and nothing on the half that matters.
//
// So the mutants here are CURATED rather than generated: each one is a specific
// regression a reviewer would care about, and each carries the reason. A
// surviving mutant is a missing test, not a style nit.
//
// SAFETY
//
// Every mutant is applied to a real file and reverted in a `finally`. The probe
// REFUSES to run against a dirty working tree, so an interrupted run can never
// destroy uncommitted work; the worst case is a file restored from the copy
// held in memory.
//
// Opt-in by design: `task mutate`, never a dependency of `task lint`. The
// inner-loop gate is content-hash cached at ~3s warm and must stay that way.

import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

const NODE_TEST = (suite) => ["node", ["--import", "tsx", "--test", suite]];
const VITEST = (file) => ["pnpm", ["exec", "vitest", "run", file]];

/**
 * Each mutant names a behaviour and breaks it. `anchor` must appear EXACTLY
 * once in `file` — if it doesn't, the probe fails loudly rather than silently
 * testing nothing (a mutant that fails to apply is the worst outcome: it looks
 * like a pass).
 */
const MUTANTS = [
  // ── the lint rails: does a no-op finder get caught, or do the live-tree
  // guards (which assert "no violations in the shipped tree") pass vacuously?
  {
    id: "rail/lease-gate-source:no-op",
    file: "scripts/lint-lease-gate-source.mjs",
    anchor: "export function findViolations(rel, text) {",
    replace: "export function findViolations(rel, text) {\n  return [];",
    run: () => NODE_TEST("scripts/test/lint-lease-gate-source.test.mjs"),
    why: "a finder that reports nothing must fail the positive unit cases, not just satisfy the live-tree guard",
  },
  {
    id: "rail/silent-swallow:no-op",
    file: "scripts/lint-silent-swallow.mjs",
    anchor: "export function findSilentSwallows(rel, text) {",
    replace: "export function findSilentSwallows(rel, text) {\n  return [];",
    run: () => NODE_TEST("scripts/test/lint-silent-swallow.test.mjs"),
    why: "same — a no-op silent-swallow detector must be caught",
  },
  {
    id: "rail/log-shape:no-op",
    file: "scripts/lint-log-shape.mjs",
    anchor: "export function findStringLogs(rel, text) {",
    replace: "export function findStringLogs(rel, text) {\n  return [];",
    run: () => NODE_TEST("scripts/test/lint-log-shape.test.mjs"),
    why: "same — a no-op string-log detector must be caught",
  },
  {
    id: "rail/trust-env-locality:no-op",
    file: "scripts/lint-trust-env-locality.mjs",
    anchor: "export function findViolations(rel, text) {",
    replace: "export function findViolations(rel, text) {\n  return [];",
    run: () => NODE_TEST("scripts/test/lint-trust-env-locality.test.mjs"),
    why: "same — a no-op trust-env locality detector must be caught",
  },
  {
    id: "rail/dev-escape:no-op",
    file: "scripts/lint-dev-escape.mjs",
    anchor: "export function findDevEscapes(rel, text) {",
    replace: "export function findDevEscapes(rel, text) {\n  return [];",
    run: () => NODE_TEST("scripts/test/lint-dev-escape.test.mjs"),
    why: "same — a no-op dev-escape detector must be caught",
  },

  // ── semantic rail mutants: the boundaries that were easy to get wrong.
  {
    id: "rail/dev-escape:section-scope",
    file: "scripts/lint-dev-escape.mjs",
    anchor: 'inInputsSection = line.startsWith("[inputs.") || line.startsWith("[[inputs");',
    replace: "inInputsSection = true;",
    run: () => NODE_TEST("scripts/test/lint-dev-escape.test.mjs"),
    why: "`from` is overloaded — [[wires]] from is a bundle name. Losing the [inputs.*] scoping must fail",
  },
  {
    id: "rail/trust-env-locality:word-boundary",
    file: "scripts/lint-trust-env-locality.mjs",
    anchor: "if (after === undefined || !WORD_CHARS.includes(after)) return true;",
    replace: "return true;",
    run: () => NODE_TEST("scripts/test/lint-trust-env-locality.test.mjs"),
    why: "without the identifier boundary, env.RECEIPT_EPOCH would match env.RECEIPT_EPOCHS",
  },
  {
    id: "rail/log-shape:allow-marker-bypass",
    file: "scripts/lint-log-shape.mjs",
    anchor: "if (isAllowed(lines, lineNo)) continue;",
    replace: "if (true) continue;",
    run: () => NODE_TEST("scripts/test/lint-log-shape.test.mjs"),
    why: "treating every site as allow-marked silently disables the rail",
  },
  {
    id: "rail/silent-swallow:assume-surfaced",
    file: "scripts/lint-silent-swallow.mjs",
    anchor: "const surfaced = SURFACES.some((s) => body.includes(s));",
    replace: "const surfaced = true;",
    run: () => NODE_TEST("scripts/test/lint-silent-swallow.test.mjs"),
    why: "assuming every catch surfaces its error silently disables the rail",
  },

  // ── build-leg validation.
  {
    id: "build/actor-fingerprint:never-throws",
    file: "scripts/toml-to-cluster.mjs",
    anchor: "export function assertActorFingerprint(fp) {",
    replace: "export function assertActorFingerprint(fp) {\n  return fp;",
    run: () => NODE_TEST("scripts/test/cluster-toml-roundtrip.test.mjs"),
    why: "a non-empty fingerprint is PUBLISHED on /.well-known — accepting a malformed one advertises a fabricated identity",
  },

  // ── the fail-closed security paths. A survivor here is a FINDING, not a nit.
  {
    id: "src/lease-gate:never-enforces",
    file: "src/routes/lease-gate.ts",
    anchor: '  if (isDev && !hasAuthority) return { mode: "off" };',
    replace: '  return { mode: "off" };',
    run: () => VITEST(""),
    why: "THE security property: if the gate always resolves off, auth is never enforced on any request",
  },
  {
    id: "src/ca-bundle-source:not-fail-closed",
    file: "src/storage/ca-bundle-source.ts",
    anchor: "throw new CaUnavailableError(",
    replace:
      'return await getCABundle(notmeBundleFetcher(env), nowMs, { rootPubkey: "" }); throw new CaUnavailableError(',
    run: () => VITEST("test/storage/ca-bundle-source.test.ts"),
    why: "falling through with an empty rootPubkey SKIPS signature verification — this survived 1396 tests until a test was written for it",
  },
];

function gitIsClean() {
  const r = spawnSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT, encoding: "utf8" });
  const dirty = (r.stdout || "")
    .split("\n")
    .filter((l) => l.trim() !== "")
    // The bead DB churns constantly and is not source; ignore it.
    .filter((l) => !l.includes(".beads/"))
    .filter((l) => !l.startsWith("??"));
  return { clean: dirty.length === 0, dirty };
}

// A mutant result is only meaningful if the suite PASSES on unmutated code.
// Without this, a missing/broken test command exits non-zero and the probe
// reports "killed" — safety it never verified. That is the same sin as a test
// asserting current output, and it bit this very script: the ca-bundle-source
// mutant reported "killed" on a branch where its test file did not yet exist.
const baselineCache = new Map();
function baselinePasses(m) {
  const [cmd, args] = m.run();
  const key = [cmd, ...args].join(" ");
  if (!baselineCache.has(key)) {
    const r = spawnSync(cmd, args.filter((a) => a !== ""), {
      cwd: REPO_ROOT, encoding: "utf8", stdio: "pipe", timeout: 15 * 60 * 1000,
    });
    baselineCache.set(key, r.status === 0);
  }
  return baselineCache.get(key);
}

function runMutant(m) {
  const abs = resolve(REPO_ROOT, m.file);
  const original = readFileSync(abs, "utf8");
  const count = original.split(m.anchor).length - 1;
  if (count !== 1) {
    return { id: m.id, status: "ERROR", detail: `anchor matched ${count}× (expected exactly 1) in ${m.file}` };
  }
  if (!baselinePasses(m)) {
    return {
      id: m.id,
      status: "ERROR",
      detail: "test command FAILS on unmutated code (missing file? broken suite?) — a 'killed' here would be meaningless",
    };
  }
  try {
    writeFileSync(abs, original.replace(m.anchor, m.replace));
    const [cmd, args] = m.run();
    const r = spawnSync(cmd, args.filter((a) => a !== ""), {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 15 * 60 * 1000,
    });
    // Non-zero exit = a test failed = the mutant was detected.
    return { id: m.id, status: r.status === 0 ? "SURVIVED" : "killed", why: m.why };
  } finally {
    writeFileSync(abs, original);
  }
}

const only = process.argv.slice(2).find((a) => a.startsWith("--only="));
const selected = only ? MUTANTS.filter((m) => m.id.includes(only.slice("--only=".length))) : MUTANTS;

const { clean, dirty } = gitIsClean();
if (!clean) {
  console.error("mutation-probe: REFUSING to run — the working tree has uncommitted changes.");
  console.error("  Mutants rewrite real files; a crash mid-run could clobber your work. Commit or stash first.");
  for (const d of dirty.slice(0, 10)) console.error(`    ${d}`);
  process.exit(2);
}

console.log(`mutation-probe: ${selected.length} curated mutant(s). A SURVIVOR means a missing test.\n`);
const results = [];
for (const m of selected) {
  process.stdout.write(`  ${m.id.padEnd(42)} … `);
  const r = runMutant(m);
  results.push(r);
  const label =
    r.status === "killed" ? "\x1b[32mkilled\x1b[0m" :
    r.status === "SURVIVED" ? "\x1b[31mSURVIVED\x1b[0m" : "\x1b[33mERROR\x1b[0m";
  console.log(label + (r.detail ? ` — ${r.detail}` : ""));
}

const survived = results.filter((r) => r.status === "SURVIVED");
const errored = results.filter((r) => r.status === "ERROR");
const killed = results.filter((r) => r.status === "killed").length;

console.log(`\nmutation score: ${killed}/${results.length} killed`);
for (const s of survived) {
  console.log(`\n  \x1b[31mSURVIVED\x1b[0m ${s.id}`);
  console.log(`    ${s.why}`);
  console.log(`    → write a test that fails when this behaviour is removed.`);
}
for (const e of errored) console.log(`\n  \x1b[33mERROR\x1b[0m ${e.id}: ${e.detail}`);

const post = gitIsClean();
if (!post.clean) {
  console.error("\nmutation-probe: tree NOT restored after run — inspect immediately:");
  for (const d of post.dirty) console.error(`    ${d}`);
  process.exit(2);
}
console.log("tree restored cleanly.");
process.exit(survived.length > 0 || errored.length > 0 ? 1 : 0);
