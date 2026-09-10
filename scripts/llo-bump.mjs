#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// llo-bump — move every ley-line-open channel from ONE input: a release tag.
// Per cloister-464216.
//
// ── Why this exists ──────────────────────────────────────────────────────────
//
// `lint:upstream-pins` already enumerates every channel that states an LLO
// version, and fails the build when they disagree. Nothing wrote them. So the
// invariant was railed and the operation satisfying it was eleven manual steps
// — which made the rail's whole function "notice that a human did eleven steps
// wrong".
//
// That is this repo's own doctrine inverted. "An invariant with no rail is a
// comment" is recorded in CLAUDE.md; this was the mirror case, a rail with no
// operation. It looks safe and silently taxes every bump. And it is not
// hypothetical: the one-rev rule exists BECAUSE the pins once drifted to five
// revs with leyline-core resolving three times in one lockfile. The rail was
// added after that; the manual process that caused it never changed.
//
// ── The channel list is imported, never restated ─────────────────────────────
//
// `upstreamChannels()` comes from the rail. A bump script with its own copy
// would be a CHECKER and a WRITER disagreeing: add a fifth channel, the writer
// silently skips it, the checker correctly fails every bump afterwards, and the
// bug presents as "the rail is broken".
//
// ── Two preconditions that were lore, not code ───────────────────────────────
//
// Both fired for real this session and were caught only by checking:
//
//   1. THE TAG OBJECT IS NOT THE COMMIT. `git rev-parse v0.16.0` yields the tag
//      object; cargo `rev =` needs `v0.16.0^{}`. A tag sha fails with cargo's
//      bare "location searched" error that never mentions the version. LLO
//      quoted the tag sha twice, for v0.15.1 and v0.16.0.
//
//   2. A TAG IS NOT A RELEASE. On v0.16.0 the tag was on the remote while
//      `gh release view` answered "release not found" — the publish workflow was
//      still running. Bumping there leaves schema-bridge.lock.json pointing at
//      404s while the cargo and input channels resolve fine from git: the tree
//      is half-bumped AND green until someone regenerates.
//
// Both are refusals here rather than notes, because a precondition that lives in
// a commit message protects exactly one person once.
//
// Usage: node scripts/llo-bump.mjs <tag> [--dry-run]

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import TOML from "smol-toml";

import { upstreamChannels, collectLloPins } from "./lint-upstream-pins.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "agentic-research/ley-line-open";
const UPSTREAM = `https://github.com/${REPO}`;

/** Generator families cloister pins. Read from the lock, not restated. */
function lockedFamilies(lock) {
  return Object.keys(lock.binaries ?? {});
}
const PLATFORMS = ["darwin-amd64", "darwin-arm64", "linux-amd64", "linux-arm64"];

function die(msg) {
  process.stderr.write(`llo-bump: ${msg}\n`);
  process.exit(1);
}

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", ...opts }).trim();
}

/**
 * Precondition 1 — resolve a tag to the COMMIT it points at.
 *
 * `^{}` peels an annotated tag. Without it you get the tag object's sha, which
 * is a valid git object and an invalid cargo rev.
 */
function resolveCommit(tag, lloRoot) {
  try {
    sh("git", ["-C", lloRoot, "fetch", "--tags", "--quiet", "origin"]);
  } catch {
    // lint-allow-silent: offline is fine if the tag is already local; the
    // rev-parse below is the real check and fails loudly.
  }
  let commit;
  try {
    commit = sh("git", ["-C", lloRoot, "rev-parse", `${tag}^{}`]);
  } catch {
    die(`tag ${tag} not found in ${lloRoot}. Fetch it, or check the name.`);
  }
  const tagObject = sh("git", ["-C", lloRoot, "rev-parse", tag]);
  if (tagObject !== commit) {
    process.stdout.write(
      `  note: ${tag} is an annotated tag — object ${tagObject.slice(0, 8)}, ` +
      `commit ${commit.slice(0, 8)}. Pinning the COMMIT.\n`,
    );
  }
  return commit;
}

/**
 * Precondition 2 — the RELEASE exists and carries every asset we will fetch.
 *
 * Checked before a single file is written. A half-bump is worse than no bump:
 * the git-resolved channels succeed, the release-resolved one 404s, and the
 * tree is inconsistent in a way `task lint` will not notice until a regen.
 */
function requireRelease(tag, families) {
  let raw;
  try {
    raw = sh("gh", ["release", "view", tag, "--repo", REPO, "--json", "assets,isDraft"]);
  } catch {
    die(
      `no published release for ${tag}.\n` +
      `  The TAG can exist while the release does not — the publish workflow may still\n` +
      `  be running. Bumping now would point schema-bridge.lock.json at 404s while the\n` +
      `  cargo and input channels resolve fine from git: half-bumped and green.\n` +
      `  Watch it: gh run watch --repo ${REPO} <run-id>`,
    );
  }
  const rel = JSON.parse(raw);
  if (rel.isDraft) die(`release ${tag} is still a DRAFT — its assets are not downloadable.`);
  const have = new Set((rel.assets ?? []).map((a) => a.name));
  const want = families.flatMap((f) => PLATFORMS.map((p) => `${f}-${p}`));
  const missing = want.filter((n) => !have.has(n));
  if (missing.length) {
    die(
      `release ${tag} exists but is missing ${missing.length} of ${want.length} ` +
      `generator binaries:\n${missing.map((m) => `    ${m}`).join("\n")}\n` +
      `  A build job likely failed. Do not bump against a partial release.`,
    );
  }
  return want.length;
}

/** Download each pinned generator and hash it. */
function generatorDigests(tag, families) {
  const out = {};
  for (const fam of families) {
    out[fam] = {};
    for (const plat of PLATFORMS) {
      const name = `${fam}-${plat}`;
      const bytes = execFileSync("gh", [
        "release", "download", tag, "--repo", REPO,
        "--pattern", name, "--output", "-",
      ], { maxBuffer: 256 * 1024 * 1024 });
      out[fam][plat] = createHash("sha256").update(bytes).digest("hex");
    }
  }
  return out;
}

// ── Writers ──────────────────────────────────────────────────────────────────
//
// NO PATTERN MATCHING. `lint:structured-parse` requires a format with a parser
// to be parsed, and CLAUDE.md records a `name = "X"` TOML regex producing four
// phantom binding-parity violations before a real parser replaced it. A regex
// that WRITES is worse than one that reads: a near-miss corrupts the file
// instead of miscounting.
//
// But a parse/serialise round-trip is equally wrong here — it drops comments,
// and this tree has already had a typo'd `[inputs.*]` key silently ERASED from
// cluster.toml by exactly that. cluster.toml carries ~90 lines of operator
// rationale that must survive.
//
// So: PARSE to learn the exact current values, then replace those literals
// inside a structurally-located slice. There is no pattern to get wrong —
// a 40-hex commit sha and a known version string are unambiguous — and the
// surrounding bytes, comments included, are untouched.

/** Line range of a top-level TOML table, located by scanning headers. */
function tableSlice(lines, header) {
  const start = lines.findIndex((l) => l.trim() === header);
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) { end = i; break; }
  }
  return { start, end };
}

/** Replace exact literals on lines that already name the upstream dependency. */
function writeCargo(pins, commit, version, dry) {
  let touched = 0;
  for (const rel of new Set(pins.map((p) => p.file))) {
    const abs = resolve(ROOT, rel);
    const lines = readFileSync(abs, "utf8").split("\n");
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
      // Structural predicate: this line declares the upstream git dep. Only
      // then are the two literals below replaced, so an unrelated line that
      // happens to contain the same version string is never touched.
      if (!lines[i].includes(UPSTREAM)) continue;
      const before = lines[i];
      for (const pin of pins.filter((p) => p.file === rel)) {
        if (pin.rev) lines[i] = lines[i].split(pin.rev).join(commit);
        if (pin.version) lines[i] = lines[i].split(`"${pin.version}"`).join(`"${version}"`);
      }
      if (lines[i] !== before) changed = true;
    }
    if (changed) { touched += 1; if (!dry) writeFileSync(abs, lines.join("\n")); }
  }
  return touched;
}

/** cluster.toml `[inputs.llo]`: the ref's sha and the version, in-table only. */
function writeInput(commit, version, dry) {
  const abs = resolve(ROOT, "cluster.toml");
  const raw = readFileSync(abs, "utf8");
  // Parsed for the CURRENT values — this is what removes the need for a pattern.
  const doc = TOML.parse(raw);
  const cur = doc?.inputs?.llo;
  if (!cur?.ref || !cur?.version) die("cluster.toml has no [inputs.llo] ref/version");
  const oldSha = String(cur.ref).split("@").pop();
  if (!/^[0-9a-f]{40}$/.test(oldSha)) die(`[inputs.llo].ref does not end in a commit sha: ${cur.ref}`);

  const lines = raw.split("\n");
  const span = tableSlice(lines, "[inputs.llo]");
  if (!span) die("could not locate the [inputs.llo] table");
  for (let i = span.start; i < span.end; i++) {
    lines[i] = lines[i].split(oldSha).join(commit).split(`"${cur.version}"`).join(`"${version}"`);
  }
  if (!dry) writeFileSync(abs, lines.join("\n"));
  return { oldSha, oldVersion: cur.version };
}

/** schema-bridge.lock.json: JSON, so a real round-trip is correct here. */
function writeGeneratorLock(tag, digests, dry) {
  const abs = resolve(ROOT, "schema-bridge.lock.json");
  const lock = JSON.parse(readFileSync(abs, "utf8"));
  lock.version = tag;
  for (const fam of Object.keys(lock.binaries)) lock.binaries[fam] = digests[fam];
  if (!dry) writeFileSync(abs, `${JSON.stringify(lock, null, 2)}\n`);
}

/**
 * Re-vendor the generated execution/v1 contract artifact.
 *
 * This is the step that cannot be a version string: the artifact is GENERATED
 * from LLO's schema by LLO's plugin, so bumping the pins without regenerating
 * leaves cloister validating against the previous contract while claiming the
 * new one. `llo-execution-contract.lock.json` records the pair, and
 * `lint:schema-claim` reads the artifact for the field names cloister must not
 * restate — so a stale artifact silently relaxes that rail too.
 *
 * The generator comes from the DIGEST-VERIFIED path, never a hand download.
 * The v0.15.0 re-vendor was first done with a binary fetched straight from the
 * release, which is the exact unverified input schema-bridge.lock.json exists
 * to refuse.
 */
function revendorArtifact(tag, commit, lloRoot, dry) {
  const plugin = sh("node", [resolve(ROOT, "scripts/fetch-schema-bridge.mjs"),
                             "capnpc-schema-bridge-tooldefs"]);
  const tmp = mkdtempSync(join(tmpdir(), "llo-revendor-"));
  const specDir = join(tmp, "spec");
  mkdirSync(specDir, { recursive: true });
  // `git archive | tar -x` rather than a checkout: no working-tree mutation in
  // the LLO clone, which may be someone's active branch.
  execFileSync("sh", ["-c",
    `git -C ${JSON.stringify(lloRoot)} archive ${JSON.stringify(tag)} rs/ll-core/schema-spec | tar -x -C ${JSON.stringify(specDir)}`,
  ]);
  const specRoot = join(specDir, "rs/ll-core/schema-spec");
  const out = join(tmp, "out");
  mkdirSync(out, { recursive: true });
  sh("capnp", ["compile", `-o${plugin}:${out}`, "--src-prefix=.",
               "execution/v1/execution.capnp"], { cwd: specRoot });

  const generated = join(out, "execution.tools.json");
  if (!existsSync(generated)) die("capnp produced no execution.tools.json — check the plugin");
  const bytes = readFileSync(generated);
  const sha = createHash("sha256").update(bytes).digest("hex");

  const artifactPath = resolve(ROOT, "src/generated/llo-execution-tools.json");
  const unchanged = existsSync(artifactPath)
    && createHash("sha256").update(readFileSync(artifactPath)).digest("hex") === sha;

  if (!dry) {
    writeFileSync(artifactPath, bytes);
    const lp = resolve(ROOT, "llo-execution-contract.lock.json");
    const lock = JSON.parse(readFileSync(lp, "utf8"));
    lock.sourceCommit = commit;
    lock.sourceTag = tag;
    lock.sha256 = sha;
    writeFileSync(lp, `${JSON.stringify(lock, null, 2)}\n`);
  }
  return { sha, unchanged };
}

// ── Entry ────────────────────────────────────────────────────────────────────

function main(argv) {
  const dry = argv.includes("--dry-run");
  const tag = argv.find((a) => !a.startsWith("--"));
  if (!tag) die("usage: node scripts/llo-bump.mjs <tag> [--dry-run]");

  const lloRoot = process.env.LLO_ROOT ?? resolve(ROOT, "../ley-line-open");
  if (!existsSync(lloRoot)) {
    die(`no ley-line-open checkout at ${lloRoot}. Set LLO_ROOT.`);
  }

  const lock = JSON.parse(readFileSync(resolve(ROOT, "schema-bridge.lock.json"), "utf8"));
  const families = lockedFamilies(lock);
  const version = tag.replace(/^v/, "");

  process.stdout.write(`llo-bump: ${tag}\n`);
  const commit = resolveCommit(tag, lloRoot);
  const assetCount = requireRelease(tag, families);
  process.stdout.write(`  release OK — ${assetCount} generator binaries present\n`);

  // The channel list is the RAIL's, imported. See the header.
  const channels = upstreamChannels();
  const pins = collectLloPins();
  process.stdout.write(`  ${channels.length} channel(s) from lint:upstream-pins\n`);

  const digests = generatorDigests(tag, families);
  const n = writeCargo(pins, commit, version, dry);
  writeInput(commit, version, dry);
  writeGeneratorLock(tag, digests, dry);

  process.stdout.write(
    `${dry ? "  DRY RUN — nothing written\n" : ""}` +
    `  cargo: ${n} manifest(s) @ ${commit.slice(0, 8)} / ${version}\n` +
    `  input: cluster.toml @ ${commit.slice(0, 8)} / ${version}\n` +
    `  generator: schema-bridge.lock.json @ ${tag}, ${families.length} famil(ies) re-digested\n`,
  );
  // The artifact is generated, so it is part of the bump rather than a
  // follow-up. Skippable only because `capnp` is not everywhere.
  if (argv.includes("--skip-revendor")) {
    process.stdout.write("  artifact: SKIPPED (--skip-revendor)\n");
  } else {
    const { sha, unchanged } = revendorArtifact(tag, commit, lloRoot, dry);
    process.stdout.write(
      `  artifact: ${unchanged ? "unchanged" : "regenerated"} @ ${sha.slice(0, 16)}…\n`,
    );
  }

  if (!dry) {
    process.stdout.write(
      "\n  Next: task cluster:resolve && task cluster:emit && task manifest --force\n" +
      "        then task lint && task rs:test --force\n",
    );
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
