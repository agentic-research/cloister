#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `cloister skills list|pin` — make ADR-0061's declarations usable.
//
// ── Why this exists ────────────────────────────────────────────────────────
//
// ADR-0061 made skills declared and digest-verified. On a real machine that
// meant 56 skills reported UNDECLARED and a `[[gateway.skills]]` block per
// skill to hand-write, each with a digest computed by hand.
//
// A verification scheme nobody can afford to adopt is a verification scheme
// nobody adopts. This is the difference between the mechanism existing and the
// property holding.
//
//   cloister skills list          what is declared, what is not, what changed
//   cloister skills pin           write the declarations with current digests
//
// ── Why `pin` prints instead of editing, by default ────────────────────────
//
// Pinning is an act of TRUST: it says "I have looked at these bytes and I
// vouch for them." A command that silently rewrote cluster.toml would turn
// that into a keystroke, and the first thing anyone would do after a failed
// verification is re-run it — laundering a change they never reviewed into a
// pin that looks deliberate.
//
// So `pin` writes to stdout and you paste. `--write` exists for the first-run
// case, and refuses to overwrite an EXISTING pin without `--force`: adopting
// skills you have not pinned yet is bookkeeping; changing a pin that already
// exists is the thing worth a second keystroke.

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join, isAbsolute } from "node:path";
import { renderCommandHelp } from "../surface.mjs";
import { digestSkillDir } from "../lib/harness/launch.mjs";
import { createOutputContext } from "../lib/output.mjs";

export class SkillsUsageError extends Error {}

/**
 * Read the declared skills out of a cluster.toml without a TOML parser
 * round-trip — we only ever ADD blocks, never rewrite existing ones.
 *
 * @param {string} tomlText
 * @returns {Map<string,string>} name → digest ("" when declared-but-unpinned)
 */
export function parseDeclaredSkills(tomlText) {
  const out = new Map();
  // lint-allow-rawparse: this reads back what THIS file wrote — a fixed block
  // shape it emits itself — to answer "is this name already declared". A full
  // parse would also work; what it would NOT do is preserve the operator's
  // formatting and comments on write, which is why the write path is
  // append-only text rather than a parse/serialize round-trip.
  const re = /\[\[gateway\.skills\]\]\s*\n(?:\s*name\s*=\s*"([^"]+)"\s*\n\s*digest\s*=\s*"([^"]*)"|\s*digest\s*=\s*"([^"]*)"\s*\n\s*name\s*=\s*"([^"]+)")/g;
  let m;
  while ((m = re.exec(tomlText)) !== null) {
    const name = m[1] ?? m[4];
    const digest = m[2] ?? m[3] ?? "";
    if (name) out.set(name, digest);
  }
  return out;
}

/** Render `[[gateway.skills]]` blocks, sorted so the output is stable. */
export function renderSkillBlocks(entries) {
  return [...entries]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => `[[gateway.skills]]\nname = ${JSON.stringify(e.name)}\ndigest = ${JSON.stringify(e.digest)}\n`)
    .join("\n");
}

/**
 * Survey a skills directory against a cluster's declarations.
 *
 * @returns {{name:string, digest:string, declared:boolean, pinned:boolean, changed:boolean}[]}
 */
export function surveySkills(skillsDir, declared, deps = {}) {
  const rd = deps.readdirSync ?? readdirSync;
  const st = deps.statSync ?? statSync;
  if (!(deps.exists ?? existsSync)(skillsDir)) return [];
  return rd(skillsDir)
    .filter((n) => {
      try { return st(join(skillsDir, n)).isDirectory(); } catch { return false; }
    })
    .sort()
    .map((name) => {
      const digest = digestSkillDir(join(skillsDir, name));
      const decl = declared.get(name);
      return {
        name,
        digest,
        declared: decl !== undefined,
        pinned: Boolean(decl),
        // `changed` is the interesting state: declared, pinned, and the bytes
        // no longer match. That is the one an operator must look at rather
        // than re-pin reflexively.
        changed: Boolean(decl) && decl !== digest,
      };
    });
}

const SKILL_STATE_ORDER = new Map([
  ["CHANGED", 0],
  ["unpinned", 1],
  ["undeclared", 2],
  ["pinned", 3],
]);

export function classifySkill(skill) {
  if (skill.changed) return "CHANGED";
  if (!skill.declared) return "undeclared";
  return skill.pinned ? "pinned" : "unpinned";
}

export function sortSkillsForDisplay(survey) {
  return [...survey].sort((left, right) => {
    const stateDelta = SKILL_STATE_ORDER.get(classifySkill(left))
      - SKILL_STATE_ORDER.get(classifySkill(right));
    return stateDelta || left.name.localeCompare(right.name);
  });
}

function skillSummary(survey, skillsDir) {
  const counts = { pinned: 0, unpinned: 0, undeclared: 0, CHANGED: 0 };
  for (const skill of survey) counts[classifySkill(skill)] += 1;
  return `${survey.length} skill(s) in ${skillsDir}: ` +
    `${counts.pinned} pinned, ${counts.unpinned} unpinned, ` +
    `${counts.undeclared} undeclared, ${counts.CHANGED} CHANGED`;
}

export function renderSkillsList(survey, { output, skillsDir }) {
  const ordered = sortSkillsForDisplay(survey);
  const summary = skillSummary(ordered, skillsDir);
  if (ordered.length > 20) {
    output.log(summary);
    output.log("");
  }

  const stateStyle = {
    CHANGED: output.style.red.bold,
    unpinned: output.style.yellow,
    undeclared: output.style.dim,
    pinned: output.style.green,
  };
  for (const skill of ordered) {
    const state = classifySkill(skill);
    const padding = " ".repeat(11 - state.length);
    output.log(
      `  ${stateStyle[state](state)}${padding} ${skill.name.padEnd(34)} ` +
      `${output.style.dim(skill.digest)}`,
    );
  }
  output.log("");
  output.log(summary);

  const changed = ordered.filter((skill) => classifySkill(skill) === "CHANGED");
  if (changed.length) {
    output.log("");
    output.log("CHANGED means the bytes moved under an existing pin. Review before re-pinning —");
    output.log("re-pinning is how an unreviewed change becomes one that looks deliberate.");
  }
  return changed.length ? 1 : 0;
}

export function parseArgs(argv) {
  const out = {
    help: false,
    sub: null,
    dir: ".",
    stateDir: null,
    write: false,
    force: false,
    names: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { out.help = true; continue; }
    if (a === "--write") { out.write = true; continue; }
    if (a === "--force") { out.force = true; continue; }
    if (a === "--dir" || a === "--state-dir") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new SkillsUsageError(`${a} requires a value`);
      if (a === "--dir") out.dir = v; else out.stateDir = v;
      i++; continue;
    }
    if (!out.sub && (a === "list" || a === "pin")) { out.sub = a; continue; }
    if (!a.startsWith("-")) {
      if (out.sub !== "pin") {
        throw new SkillsUsageError("skill names are only accepted by `skills pin`");
      }
      if (!out.names.includes(a)) out.names.push(a);
      continue;
    }
    throw new SkillsUsageError(`unknown option ${JSON.stringify(a)}`);
  }
  return out;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const defaultOutput = createOutputContext({ env: deps.env ?? process.env });
  const output = deps.output ?? {
    ...defaultOutput,
    log: deps.log ?? defaultOutput.log,
    error: deps.errLog ?? defaultOutput.error,
  };
  const log = output.log;
  const errLog = output.error;

  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e instanceof SkillsUsageError) { errLog(`cloister skills: ${e.message}`); return 2; }
    throw e;
  }
  if (args.help || !args.sub) {
    log(renderCommandHelp(args.sub === "pin" ? "skills pin" : "skills list"));
    return args.sub ? 0 : 2;
  }

  const root = isAbsolute(args.dir) ? args.dir : resolve(process.cwd(), args.dir);
  const tomlPath = resolve(root, "cluster.toml");
  if (!existsSync(tomlPath)) {
    errLog(`cloister skills: no cluster.toml in ${root} — is this a cluster directory?`);
    return 2;
  }
  const toml = readFileSync(tomlPath, "utf8");
  const declared = parseDeclaredSkills(toml);
  const skillsDir = args.stateDir
    ? resolve(args.stateDir, "skills")
    : join(homedir(), ".claude", "skills");

  const survey = surveySkills(skillsDir, declared);
  if (survey.length === 0) {
    log(`cloister skills: no skills found in ${skillsDir}`);
    return 0;
  }

  if (args.sub === "list") {
    return renderSkillsList(survey, { output, skillsDir });
  }

  // pin
  const byName = new Map(survey.map((skill) => [skill.name, skill]));
  const unknown = args.names.filter((name) => !byName.has(name));
  if (unknown.length) {
    errLog(
      `cloister skills: no skill named ${unknown.map((name) => JSON.stringify(name)).join(", ")} ` +
      `in ${skillsDir}`,
    );
    return 2;
  }
  const selected = args.names.length
    ? args.names.map((name) => byName.get(name))
    : survey;
  const changed = selected.filter((skill) => skill.changed);
  const toPin = args.force ? selected : selected.filter((skill) => !skill.pinned);
  if (toPin.length === 0) {
    log(args.names.length
      ? "cloister skills: the selected skill(s) are already pinned; nothing to do."
      : "cloister skills: everything is already pinned; nothing to do.");
    if (changed.length) {
      errLog(`  …but ${changed.length} pinned skill(s) CHANGED. Review, then re-pin with --force.`);
      return 1;
    }
    return 0;
  }
  if (changed.length && !args.force) {
    errLog(
      `cloister skills: ${changed.length} skill(s) changed under an existing pin ` +
      `(${changed.map((s) => s.name).join(", ")}). Refusing to re-pin them silently — ` +
      `review the change, then pass --force. Skills you have NOT pinned yet are unaffected.`,
    );
  }

  const blocks = renderSkillBlocks(toPin.map((s) => ({ name: s.name, digest: s.digest })));
  if (!args.write) {
    log(`# ${toPin.length} skill(s) — append to ${tomlPath}, then run \`cloister cluster generate\``);
    log("");
    log(blocks);
    return 0;
  }

  writeFileSync(tomlPath, `${toml.replace(/\n+$/, "")}\n\n${blocks}`);
  log(`cloister skills: appended ${toPin.length} declaration(s) to ${tomlPath}`);
  log("  next: cloister cluster generate    # regenerate declared artifacts");
  return 0;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().then((c) => process.exit(c));
}
