#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Every ley-line-open git dependency in the Rust workspace shares ONE rev and
// ONE version (cloister-9170d0 / the CLAUDE.md LLO-pinning rule).
//
// WHY THIS EXISTS, precisely. `task lint`'s own description has claimed
// "cargo-pin lint" among its checks for as long as the line has existed. No
// such task and no such script were ever written. The gate advertised a check
// that did not exist — the strongest form of the failure this repo keeps
// finding, because a reader auditing coverage reads the description, sees the
// check named, and stops looking.
//
// It is not a hypothetical. Bumping the LLO pins to v0.13.0, four `rev =`
// occurrences in rs/crates/cas/Cargo.toml were updated and the fifth — a
// leyline-fs pin in the DIFFERENT manifest rs/crates/host-runtime/Cargo.toml —
// was missed. `cargo check --workspace --all-targets` exited 0. The only
// evidence was two lines of build output:
//
//     Checking leyline-core v0.12.0 (...rev=28bc3262#28bc3262)
//     Checking leyline-core v0.13.0 (...rev=aac291a4#aac291a4)
//
// Cargo cannot unify git deps at differing revs, so it compiled leyline-core
// TWICE. For a content-addressed substrate that is the collision hazard
// itself: two BLAKE3 fold implementations and two PARTITION_CONTEXT constants
// coexisting in one dependency graph, with which one a given call reaches
// decided by the dep path. cloister-944766 is the bead for what a changed fold
// does to addresses; nothing detected the condition that lets two folds run at
// once. A green `cargo check` is not evidence against it — it is how it looks.
//
// The rule is rev AND version together. A matching rev with a stale `version`
// field still builds (cargo treats it as a floor), so version drift is silent
// in exactly the same way, and a reader diffing manifests sees a version that
// misdescribes the code.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import TOML from "@iarna/toml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RS = join(ROOT, "rs");
const UPSTREAM = "https://github.com/agentic-research/ley-line-open";

// Parsed as TOML, never regexed. A Cargo dependency is expressible as an
// inline table (`x = { git = "…" }`), a full table (`[dependencies.x]`), or
// under any of ~4 dependency sections times N `[target.'cfg(…)']` prefixes. A
// line-anchored pattern reads whichever form the author happened to use and
// silently misses the rest — the same defect as the `name = "X"` TOML regex
// that produced four phantom binding-parity violations before @iarna/toml
// replaced it.
const DEP_SECTIONS = ["dependencies", "dev-dependencies", "build-dependencies"];

/** Every Cargo.toml under rs/, excluding target dirs and test fixtures. */
function manifests(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === "target" || e === "node_modules" || e === ".git") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) manifests(p, out);
    else if (e === "Cargo.toml") out.push(p);
  }
  return out;
}

/** Walk a parsed manifest for dependency tables, including [target.*] nests. */
function* depTables(doc) {
  for (const s of DEP_SECTIONS) if (doc[s]) yield doc[s];
  for (const cfg of Object.values(doc.target ?? {})) {
    if (cfg && typeof cfg === "object") {
      for (const s of DEP_SECTIONS) if (cfg[s]) yield cfg[s];
    }
  }
  // A workspace root may hoist shared pins into [workspace.dependencies].
  const ws = doc.workspace?.dependencies;
  if (ws) yield ws;
}

/** @returns {{file: string, name: string, rev: string, version: string}[]} */
export function collectLloPins(rsDir = RS) {
  const pins = [];
  for (const file of manifests(rsDir)) {
    let doc;
    try {
      doc = TOML.parse(readFileSync(file, "utf8"));
    } catch (e) {
      fail(`could not parse ${relative(ROOT, file)} as TOML: ${e.message}`);
    }
    for (const table of depTables(doc)) {
      for (const [name, spec] of Object.entries(table)) {
        if (!spec || typeof spec !== "object") continue;
        if (spec.git !== UPSTREAM) continue;
        pins.push({
          file: relative(ROOT, file),
          // `package = "…"` renames; report the real crate.
          name: typeof spec.package === "string" ? spec.package : name,
          rev: typeof spec.rev === "string" ? spec.rev : "",
          version: typeof spec.version === "string" ? spec.version : "",
        });
      }
    }
  }
  return pins;
}

function fail(msg) {
  process.stderr.write(`lint:cargo-pins: ${msg}\n`);
  process.exit(1);
}

function main() {
  const pins = collectLloPins();

  // Non-vacuity floor. If a refactor moves the pins somewhere this walk does
  // not reach, every set below collapses to size ≤ 1 and the rail passes while
  // checking nothing — the exact way a rail dies quietly. The shipped tree has
  // five; hard-floor at three so a real reduction is still allowed but a walk
  // that finds nothing is not.
  const MIN_EXPECTED_PINS = 3;
  if (pins.length < MIN_EXPECTED_PINS) {
    fail(
      `found only ${pins.length} ley-line-open git dependency(ies) under rs/ ` +
      `— expected at least ${MIN_EXPECTED_PINS}. Either the pins moved somewhere ` +
      `this lint does not walk (making it vacuous), or the dependency genuinely ` +
      `shrank and MIN_EXPECTED_PINS should be lowered deliberately.`,
    );
  }

  const missing = pins.filter((p) => !p.rev || !p.version);
  if (missing.length) {
    fail(
      `every ley-line-open git dependency must pin BOTH rev and version:\n` +
      missing.map((p) => `  ${p.file}: ${p.name} rev=${p.rev || "<none>"} version=${p.version || "<none>"}`).join("\n"),
    );
  }

  const revs = [...new Set(pins.map((p) => p.rev))];
  const versions = [...new Set(pins.map((p) => p.version))];

  if (revs.length > 1) {
    fail(
      `ley-line-open is pinned at ${revs.length} different revs. Cargo cannot ` +
      `unify git deps across revs, so it compiles the shared crates MORE THAN ` +
      `ONCE — two leyline-core copies means two BLAKE3 folds and two ` +
      `PARTITION_CONTEXT constants in one graph, and \`cargo check\` still ` +
      `exits 0.\n` +
      pins.map((p) => `  ${p.file}: ${p.name} @ ${p.rev.slice(0, 8)} (${p.version})`).join("\n") +
      `\nBump every pin together.`,
    );
  }

  if (versions.length > 1) {
    fail(
      `ley-line-open pins share a rev but declare ${versions.length} different ` +
      `versions (${versions.join(", ")}). Cargo treats \`version\` as a floor, so ` +
      `this builds — and a reader diffing manifests sees a version that ` +
      `misdescribes the pinned code.\n` +
      pins.map((p) => `  ${p.file}: ${p.name} ${p.version}`).join("\n"),
    );
  }

  process.stdout.write(
    `lint:cargo-pins: OK — ${pins.length} ley-line-open pin(s) across ` +
    `${new Set(pins.map((p) => p.file)).size} manifest(s), all at ` +
    `${versions[0]} / ${revs[0].slice(0, 8)}\n`,
  );
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
