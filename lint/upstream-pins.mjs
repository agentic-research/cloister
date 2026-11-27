#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ONE upstream, ONE version — across every channel that states it.
//
// cloister consumes ley-line-open through SIX independent channels, and each
// used to carry its own version string:
//
//   1. [inputs.llo] in cluster.toml       server.json @ git SHA
//   2. Cargo git deps (rs/ + tools/)      every crate @ rev + version, and
//      each workspace's Cargo.lock        the commit cargo resolved for them
//   3. schema-bridge.lock.json            generator binaries @ release tag
//   4. [inputs.llo.oci] in the lockfile   image, DERIVED from (1) — not checked here
//   5. test/wire/fixtures/llo-net-vectors.json  leyline-net/v1 vectors @ release tag
//   6. test/fixtures/llo-*-v1/VECTORS.sha256    spec fixtures @ release tag, one per spec
//
// (5) and (6) are vendored by gen/vendor-llo-spec.mjs, but each records its
// release as committed text like the others, and a bump can skip the script.
// So they are checked with (1)–(3). (6) is one channel per vendored spec: the
// confinement schema and the execution vectors each sat at an older release
// than every other channel claimed, and nothing reported it.
//
// Channel 4 is already derived, which is why it never drifts. The other three
// are hand-stated, and on 2026-07-29 they read 0.11.3, 0.12.0 and 0.12.1
// simultaneously. Nothing reported it: the first version of this rail asserted
// only that the CARGO pins agreed with EACH OTHER, so intra-channel drift was
// caught and cross-channel drift was not. The three were realigned by hand,
// which is not a fix — it is the same maintenance this file exists to remove.
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

import { LLO_SPECS, vendoredFrom } from "../gen/vendor-llo-spec.mjs";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import TOML from "smol-toml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VECTORS_REL = "test/wire/fixtures/llo-net-vectors.json";
const RS = join(ROOT, "rs");
// tools/ holds standalone crates that are NOT rs/ workspace members, so neither
// `cargo check --workspace` nor an rs/-only walk sees them. tools/harness-sandbox
// sat at leyline-sign v0.7.6 while every rs/ pin moved to v0.21.1, invisible to
// this rail for months (cloister-b4d6eb / cloister-3a5ad4).
const CARGO_ROOTS = [RS, join(ROOT, "tools")];
const UPSTREAM = "https://github.com/agentic-research/ley-line-open";

// Parsed as TOML, never regexed. A Cargo dependency is expressible as an
// inline table (`x = { git = "…" }`), a full table (`[dependencies.x]`), or
// under any of ~4 dependency sections times N `[target.'cfg(…)']` prefixes. A
// line-anchored pattern reads whichever form the author happened to use and
// silently misses the rest — the same defect as the `name = "X"` TOML regex
// that produced four phantom binding-parity violations before @iarna/toml
// replaced it.
const DEP_SECTIONS = ["dependencies", "dev-dependencies", "build-dependencies"];

/** Every Cargo.toml under `dir`, excluding target dirs and test fixtures. */
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
export function collectLloPins(roots = CARGO_ROOTS) {
  const pins = [];
  const files = [roots].flat().filter((d) => existsSync(d)).flatMap((d) => manifests(d));
  for (const file of files) {
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

/** Every Cargo.lock under `dir`, excluding target dirs. */
function lockfiles(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === "target" || e === "node_modules" || e === ".git") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) lockfiles(p, out);
    else if (e === "Cargo.lock") out.push(p);
  }
  return out;
}

const parseManifest = (file) => TOML.parse(readFileSync(file, "utf8"));

/**
 * The directory whose Cargo.lock cargo uses for `manifest`, by cargo's rule:
 * the nearest directory at or above the manifest's, up to `root`, whose
 * Cargo.toml has a [workspace] table that does not exclude it, and otherwise
 * the manifest's own. A manifest that names its workspace itself
 * (`package.workspace`) is refused rather than followed.
 */
export function workspaceDirOf(manifest, root = ROOT) {
  const own = dirname(manifest);
  if (parseManifest(manifest).package?.workspace !== undefined) {
    throw new Error(`${relative(ROOT, manifest)} sets package.workspace, which lint:upstream-pins does not follow`);
  }
  for (let dir = own; ; dir = dirname(dir)) {
    const candidate = join(dir, "Cargo.toml");
    if (existsSync(candidate)) {
      const workspace = parseManifest(candidate).workspace;
      const member = relative(dir, own);
      const excluded = (workspace?.exclude ?? []).some((e) => member === e || member.startsWith(`${e}/`));
      if (workspace && !excluded) return dir;
    }
    if (dir === root || dirname(dir) === dir) return own;
  }
}

/**
 * The workspaces whose manifests pin ley-line-open: each one's lockfile, and
 * the crates its manifests pin. `gen/llo-bump.mjs` re-resolves exactly these
 * locks, and this rail checks each one.
 *
 * @returns {{dir: string, lock: string, manifests: string[], crates: string[]}[]}
 */
export function lloWorkspaces(pins = collectLloPins(), root = ROOT) {
  const byDir = new Map();
  for (const pin of pins) {
    const dir = relative(ROOT, workspaceDirOf(resolve(ROOT, pin.file), root));
    const ws = byDir.get(dir) ?? { dir, lock: join(dir, "Cargo.lock"), manifests: [], crates: [] };
    if (!ws.manifests.includes(pin.file)) ws.manifests.push(pin.file);
    if (!ws.crates.includes(pin.name)) ws.crates.push(pin.name);
    byDir.set(dir, ws);
  }
  return [...byDir.values()].sort((a, b) => a.dir.localeCompare(b.dir));
}

/**
 * Every ley-line-open package each Cargo.lock under `roots` records. A lock
 * names the revision its manifest asked for and the commit cargo checked out:
 * `source = "git+<repo>?rev=<rev>#<commit>"`.
 *
 * @returns {{file: string, name: string, rev: string, commit: string}[]}
 */
export function collectLockedLlo(roots = CARGO_ROOTS) {
  const locked = [];
  for (const file of [roots].flat().filter((d) => existsSync(d)).flatMap((d) => lockfiles(d))) {
    for (const pkg of parseManifest(file).package ?? []) {
      if (typeof pkg.source !== "string" || !pkg.source.startsWith("git+")) continue;
      const url = new URL(pkg.source.slice("git+".length));
      if (`${url.origin}${url.pathname}` !== UPSTREAM) continue;
      locked.push({ file: relative(ROOT, file), name: pkg.name, rev: url.searchParams.get("rev") ?? "", commit: url.hash.slice(1) });
    }
  }
  return locked;
}

/**
 * What is wrong with the lockfiles, given the one rev every manifest pins.
 *
 * A lock is cargo's output, but it is committed, so it can lag its manifest.
 * One that does still builds, because cargo re-resolves it, so it passed every
 * gate while `cargo build --locked` refused it: the 0.32.0 bump moved
 * tools/harness-sandbox/Cargo.toml and left its lock at 0.31.0.
 */
export function lockProblems(pins, rev, { root = ROOT, roots = CARGO_ROOTS } = {}) {
  const problems = [];
  const workspaces = lloWorkspaces(pins, root);
  const locked = collectLockedLlo(roots);
  for (const ws of workspaces) {
    if (!existsSync(resolve(ROOT, ws.lock))) {
      problems.push(`${ws.lock} is missing, and ${ws.manifests.join(", ")} pin ley-line-open: cargo records what it resolved for them there`);
      continue;
    }
    const names = new Set(locked.filter((l) => l.file === ws.lock).map((l) => l.name));
    for (const crate of ws.crates.filter((c) => !names.has(c))) {
      problems.push(`${ws.lock} locks no ${crate} from ley-line-open, and ${ws.manifests.join(", ")} pin it`);
    }
  }
  for (const l of locked.filter((l) => l.rev !== rev || l.commit !== rev)) {
    problems.push(`${l.file}: ${l.name} is locked at ${l.commit.slice(0, 8) || "no commit"} (rev ${l.rev.slice(0, 8) || "none"}), and the manifests pin ${rev.slice(0, 8)}`);
  }
  return problems;
}

/**
 * THE canonical list of channels that hand-state an ley-line-open version.
 *
 * Exported so `gen/llo-bump.mjs` writes exactly the set this rail reads.
 * A bump script with its own list is the failure this tree names elsewhere —
 * "a field list that mirrors the schema is a bug waiting to happen" — except
 * worse, because the two lists would be a CHECKER and a WRITER: adding a fifth
 * channel would leave the writer silently skipping it and the checker correctly
 * failing every bump afterwards, with the fix looking like "the rail is broken".
 *
 * Returns descriptors, not values. Each names a file and the shape of the edit;
 * the rail reads them to compare, the bump reads them to write. Neither owns
 * the other's format knowledge.
 *
 * @returns {{kind: "cargo"|"cargo-lock"|"input"|"generator"|"vectors"|"spec-fixture", file: string, detail?: string}[]}
 */
export function upstreamChannels() {
  const out = [];
  const pins = collectLloPins();
  for (const pin of pins) {
    out.push({ kind: "cargo", file: pin.file, detail: pin.name });
  }
  for (const ws of lloWorkspaces(pins)) out.push({ kind: "cargo-lock", file: ws.lock, detail: ws.crates.join(", ") });
  for (const c of readInputVersion()) out.push({ kind: "input", file: "cluster.toml", detail: c.name });
  for (const c of readGeneratorVersion()) out.push({ kind: "generator", file: "schema-bridge.lock.json", detail: c.name });
  for (const c of readVectorsVersion()) out.push({ kind: "vectors", file: VECTORS_REL, detail: c.name });
  for (const c of readSpecFixtureVersions()) out.push({ kind: "spec-fixture", file: c.file, detail: c.name });
  return out;
}

function fail(msg) {
  process.stderr.write(`lint:upstream-pins: ${msg}\n`);
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
      `found only ${pins.length} ley-line-open git dependency(ies) under rs/ + tools/ ` +
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

  // The full commit, so the commit a lockfile records is compared to it
  // exactly, and no tag or branch can move under it. `task llo:bump` writes it.
  const short = pins.filter((p) => !/^[0-9a-f]{40}$/.test(p.rev));
  if (short.length) {
    fail(
      `every ley-line-open git dependency must pin a full 40-hex commit as its rev:\n` +
      short.map((p) => `  ${p.file}: ${p.name} rev=${p.rev}`).join("\n"),
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

  // ── Cross-channel: the check the first version of this rail lacked ──────
  //
  // Everything above compares Cargo pins to EACH OTHER. That caught the
  // leyline-fs pin left behind in a second manifest, and it would not have
  // caught the three-way 0.11.3 / 0.12.0 / 0.12.1 drift, because each channel
  // was internally consistent while disagreeing with the others.
  const cargoVersion = versions[0];
  const channels = [
    { name: "Cargo git deps (rs/**/Cargo.toml)", version: cargoVersion },
    ...readInputVersion(),
    ...readGeneratorVersion(),
    ...readVectorsVersion(),
    ...readSpecFixtureVersions(),
  ];

  // Non-vacuity: with only the Cargo channel readable, the comparison below is
  // over a one-element set and proves nothing — the same silent-pass shape the
  // MIN_EXPECTED_PINS floor guards against upstream of it.
  const expected = 4 + LLO_SPECS.length;
  if (channels.length < expected) {
    fail(
      `only ${channels.length} of the ${expected} hand-stated channels were readable ` +
      `(${channels.map((c) => c.name).join(", ")}). The cross-channel comparison ` +
      `would pass over a set too small to disagree. Either a channel moved, or ` +
      `this lint's readers need updating.`,
    );
  }

  const distinct = [...new Set(channels.map((c) => c.version))];
  if (distinct.length > 1) {
    fail(
      `ley-line-open is stated at ${distinct.length} different versions across ` +
      `channels. Each channel can be internally consistent and still disagree ` +
      `with the others — that is exactly how 0.11.3 / 0.12.0 / 0.12.1 shipped ` +
      `together, with nothing reporting it:\n` +
      channels.map((c) => `  ${c.version.padEnd(10)} ${c.name}`).join("\n") +
      `\nBump every channel together, or derive the ones that can be derived.`,
    );
  }

  // ── Lockfiles: what cargo resolved for the manifests above ──────────────
  let problems;
  try {
    problems = lockProblems(pins, revs[0]);
  } catch (e) {
    fail(e.message);
  }
  if (problems.length) {
    fail(
      `a Cargo lockfile disagrees with the manifests. Cargo re-resolves a lock ` +
      `its manifest has moved past, so this builds, and \`cargo build --locked\` ` +
      `refuses it:\n` +
      problems.map((p) => `  ${p}`).join("\n") +
      `\nRe-resolve each lock (\`task llo:bump\` does, with \`cargo metadata\`).`,
    );
  }
  const locks = lloWorkspaces(pins);

  process.stdout.write(
    `lint:upstream-pins: OK — ley-line-open at ${distinct[0]} across ` +
    `${channels.length} channels; ${pins.length} cargo pin(s) in ` +
    `${new Set(pins.map((p) => p.file)).size} manifest(s) @ ${revs[0].slice(0, 8)}, ` +
    `locked there in ${locks.map((w) => w.lock).join(" and ")}\n`,
  );
}

/**
 * Channel 1 — the operator's input declaration.
 *
 * Returns [] rather than throwing when unreadable, so a fixture tree without a
 * cluster.toml still exercises the Cargo half. The non-vacuity floor above is
 * what stops that leniency from becoming a silent pass on the real tree.
 */
export function readInputVersion() {
  const p = process.env.CLOISTER_CLUSTER_TOML ?? resolve(ROOT, "cluster.toml");
  if (!existsSync(p)) return [];
  try {
    const doc = TOML.parse(readFileSync(p, "utf8"));
    const v = doc.inputs?.llo?.version;
    return typeof v === "string" && v ? [{ name: "[inputs.llo] (cluster.toml)", version: normalize(v) }] : [];
  } catch {
    // lint-allow-silent: an unparseable cluster.toml is `test:cluster-toml`'s
    // failure to report, not this rail's — and reporting it twice, in different
    // words, sends a reader to the wrong file.
    return [];
  }
}

/** Channel 3 — the digest-pinned schema-bridge generator binaries. */
export function readGeneratorVersion() {
  const p = resolve(ROOT, "schema-bridge.lock.json");
  if (!existsSync(p)) return [];
  try {
    const v = JSON.parse(readFileSync(p, "utf8")).version;
    return typeof v === "string" && v ? [{ name: "schema-bridge.lock.json", version: normalize(v) }] : [];
  } catch {
    // lint-allow-silent: as above — fetch-schema-bridge owns that error.
    return [];
  }
}

/**
 * Channel 5 — LLO's leyline-net/v1 wire vectors, vendored by
 * gen/vendor-llo-net-vectors.mjs (via gen/vendor-llo-spec.mjs). A bump that left them behind would test
 * cloister's codecs against the previous release's wire while every other
 * channel claimed the new one.
 */
export function readVectorsVersion() {
  const p = resolve(ROOT, VECTORS_REL);
  if (!existsSync(p)) return [];
  try {
    const v = JSON.parse(readFileSync(p, "utf8")).version;
    return typeof v === "string" && v ? [{ name: `leyline-net vectors (${VECTORS_REL})`, version: normalize(v) }] : [];
  } catch {
    // lint-allow-silent: the vectors test owns an unreadable fixture.
    return [];
  }
}

/**
 * Channel 6 — each spec fixture directory gen/vendor-llo-spec.mjs writes, by
 * the release its VECTORS.sha256 is headed with. A directory with no header
 * yields no channel, and the floor above then fails by count.
 */
export function readSpecFixtureVersions() {
  const out = [];
  for (const { spec, into } of LLO_SPECS) {
    const file = `${into}/VECTORS.sha256`;
    const p = resolve(ROOT, file);
    if (!existsSync(p)) continue;
    const from = vendoredFrom(readFileSync(p, "utf8"));
    if (from) out.push({ name: `${spec} fixtures (${file})`, file, version: normalize(from.tag) });
  }
  return out;
}

/**
 * Strip a leading `v`.
 *
 * ADR-0041 settled that the prefix is a PER-REPO convention, not a mandate:
 * rosary tags `0.10.0`, mache and ley-line-open tag `v0.19.0` / `v0.13.0`, and
 * all three are correct because each matches its own pushed tag. So the same
 * upstream legitimately appears as `0.13.0` in a Cargo `version` field (semver,
 * never v-prefixed) and `v0.13.0` in a release tag. Comparing them raw would
 * report a permanent false disagreement.
 */
function normalize(v) {
  return v.replace(/^v/, "");
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
