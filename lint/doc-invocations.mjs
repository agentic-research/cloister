#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// lint/doc-invocations.mjs — every `cloister …` and `task …` line the docs
// tell someone to run names a command, flags and tasks that exist.
//
// Why: a recipe's README told users to run `task init -- --recipe
// multi-tenant-smoke` and the CLI answered `unknown recipe` (cloister-449f82);
// docs/reference/cli.md is generated from cli/surface.mjs, but the other
// documents that quote the CLI are prose, and nothing read them back. This is
// mache's doc-vs-CLI gate (cmd/docs_cli_surface_test.go) for cloister.
//
// What it reads: shell fences (```sh, ```bash, ```shell, ```console) in every
// tracked markdown file except ADRs, which are a dated record and may quote a
// surface that has since changed, and the CHANGELOG, for the same reason.
// Lines are tokenized by a shell tokenizer (shell-quote), not split on spaces,
// so quoting, `&&`, pipes, redirections and comments do not masquerade as
// arguments.
//
// What it proves, for each invocation it finds:
//
//   cloister … / node …/cloister.mjs …   the command is declared in
//       cli/surface.mjs (the declaration help, the reference docs and the
//       parsers read), or is a group of declared commands asked for help; and,
//       where the command declares its flags, every `--flag` is one of them,
//       or a global option, or --help.
//   task …                                every task named exists, as Task
//       itself reports (`task --list-all --json`): the Taskfiles are not
//       re-parsed here.
//
// What it does not prove: that a documented command succeeds, or that its
// positional arguments are right. cli/surface.mjs does not declare
// positionals, so their count is not checked. A command whose entry declares
// no flags has its words checked and its flags not; the report counts them,
// so that number can be watched going down.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseShell } from "shell-quote";

import { COMMANDS, GLOBAL_OPTIONS, commandFor } from "../cli/surface.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHELL_FENCES = new Set(["sh", "bash", "shell", "console"]);

/** The markdown files whose invocations are held to the CLI. */
export function gatedDocs(root = ROOT) {
  return execFileSync("git", ["ls-files", "-z", "--", "*.md"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    // ADRs, the CHANGELOG and docs/superpowers/ (dated notes, plans and specs)
    // are records: they may quote a surface that has since changed.
    .filter((f) => !f.startsWith("docs/adr/") && !f.startsWith("docs/superpowers/") && f !== "CHANGELOG.md" && !f.startsWith(".beads/"));
}

/**
 * The shell fences of one markdown text, as `{ line, text, lang }` with
 * `line` the 1-based line of the fence's first content line. Backslash
 * continuations are joined, as the shell joins them, so one command is one
 * entry.
 */
export function shellFences(markdown) {
  const out = [];
  let open = null;
  markdown.split("\n").forEach((l, i) => {
    const fence = /^\s*```\s*([A-Za-z]*)\s*$/.exec(l);
    if (!open && fence && SHELL_FENCES.has(fence[1].toLowerCase())) open = { line: i + 2, lines: [], lang: fence[1].toLowerCase() };
    else if (open && /^\s*```\s*$/.test(l)) { out.push(open); open = null; }
    else if (open) open.lines.push(l);
  });
  const commands = [];
  for (const block of out) {
    let start = null;
    let joined = "";
    block.lines.forEach((raw, k) => {
      // A console fence shows a prompt; what follows `$ ` is the command, and
      // a line without one is output.
      let line = raw;
      if (block.lang === "console") {
        if (start === null && !/^\s*\$ /.test(line)) return;
        if (start === null) line = line.replace(/^\s*\$ /, "");
      }
      if (start === null) start = block.line + k;
      if (/\\\s*$/.test(line)) { joined += `${line.replace(/\\\s*$/, "")} `; return; }
      joined += line;
      commands.push({ line: start, text: joined });
      start = null;
      joined = "";
    });
    if (start !== null) commands.push({ line: start, text: joined });
  }
  return commands;
}

/**
 * The simple commands in one shell line, each an argv of strings. Parameters
 * stay as `$NAME`; operators, redirections and comments separate or end
 * commands. Leading `NAME=value` assignments are dropped.
 */
export function simpleCommands(text) {
  const tokens = parseShell(text, (name) => `$${name}`);
  const commands = [];
  let argv = [];
  const end = () => { if (argv.length) commands.push(argv); argv = []; };
  const redirect = (t) => t && typeof t === "object" && [">", ">>", "<", ">&", "<&", "<(", ">|"].includes(t.op);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    // shell-quote does not attach a file descriptor to its redirection: in
    // `2>&1` the `2` arrives as a word. A bare number right before a
    // redirection is that descriptor, not an argument.
    if (typeof t === "string" && /^\d+$/.test(t) && redirect(tokens[i + 1])) continue;
    if (typeof t === "string") { argv.push(t); continue; }
    if (t.comment !== undefined) { end(); break; }
    if (redirect(t)) { i += 1; continue; }
    end();
  }
  end();
  return commands.map((argv) => {
    let k = 0;
    while (k < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[k])) k += 1;
    return argv.slice(k);
  }).filter((argv) => argv.length);
}

/** The arguments to cloister in `argv`, or null when it does not run cloister. */
export function cloisterArgs(argv) {
  const [head, ...rest] = argv;
  if (head === "cloister" || head.endsWith("/cloister")) return rest;
  if (head === "npx" || head === "pnpm") {
    const i = rest[0] === "exec" ? 1 : 0;
    if (rest[i] === "cloister") return rest.slice(i + 1);
    return null;
  }
  if (head === "node" && rest[0] && /(^|\/)(cloister\.mjs)$/.test(rest[0])) return rest.slice(1);
  return null;
}

const GLOBAL_FLAGS = new Set(GLOBAL_OPTIONS.map((o) => o.flag));

/** Why `args` (after `cloister`) is not a declared invocation, or null when it is. */
export function cloisterProblem(args) {
  // Global options may sit before the command words.
  let i = 0;
  while (i < args.length && GLOBAL_FLAGS.has(args[i].split("=")[0])) {
    const option = GLOBAL_OPTIONS.find((o) => o.flag === args[i].split("=")[0]);
    i += option.value && !args[i].includes("=") ? 2 : 1;
  }
  const rest = args.slice(i);
  const words = [];
  for (const a of rest) {
    if (a.startsWith("-")) break;
    words.push(a);
  }
  const help = rest.includes("--help") || rest.includes("-h");
  if (words.length === 0) return null; // `cloister`, `cloister --help`
  if (words[0] === "help" && words.length === 1) return null;
  const declared = commandFor(words);
  if (!declared) {
    const group = words.join(" ");
    if (help && COMMANDS.some((c) => c.name.startsWith(`${group} `))) return null;
    return `\`cloister ${words.join(" ")}\` is not a declared command (cli/surface.mjs)`;
  }
  if (!declared.flags) return null;
  const byFlag = new Map(declared.flags.map((f) => [f.flag, f]));
  const after = rest.slice(declared.name.split(" ").length);
  for (let k = 0; k < after.length; k++) {
    const a = after[k];
    if (a === "--") break; // what follows belongs to something else (`cloister run -- tool`)
    if (!a.startsWith("--")) continue;
    const name = a.split("=")[0];
    if (name === "--help" || GLOBAL_FLAGS.has(name)) continue;
    const flag = byFlag.get(name);
    if (!flag) return `\`cloister ${declared.name}\` declares no flag ${name}`;
    if (flag.value && !a.includes("=")) k += 1;
  }
  return null;
}

/**
 * Every task name and alias, as Task itself reports them: the repository's,
 * and those of the Taskfile `cloister init` copies into every scaffold
 * (recipes/_shared/), since the docs tell a user to run those inside one.
 */
export function taskNames(root = ROOT) {
  const list = (cwd, args = []) => JSON.parse(execFileSync("task", ["--list-all", "--json", ...args], { cwd, encoding: "utf8" }))
    .tasks.flatMap((t) => [t.name, ...(t.aliases ?? [])]);
  return new Set([...list(root), ...list(resolve(root, "recipes/_shared"), ["--taskfile", "Taskfile.yml"])]);
}

/** Why `args` (after `task`) names a task that does not exist, or null. */
export function taskProblem(args, names) {
  for (const a of args) {
    if (a === "--") break; // arguments to the task
    if (a.startsWith("-")) return null; // `task --list`, `task -f …`: Task's own flags; not a task name
    if (a.includes("=")) continue; // `task foo VAR=value`
    if (!names.has(a)) return `\`task ${a}\` is not a task (task --list-all)`;
  }
  return null;
}

/** Every documented invocation that does not hold, as `{ file, line, text, problem }`. */
export function problems(root = ROOT) {
  const names = taskNames(root);
  const found = [];
  let checked = 0;
  let flagsUnchecked = 0;
  for (const file of gatedDocs(root)) {
    const markdown = readFileSync(resolve(root, file), "utf8");
    for (const { line, text } of shellFences(markdown)) {
      let commands;
      try {
        commands = simpleCommands(text);
      } catch (error) {
        found.push({ file, line, text, problem: `not a shell line: ${error.message}` });
        continue;
      }
      for (const argv of commands) {
        const cloister = cloisterArgs(argv);
        if (cloister) {
          checked += 1;
          const words = cloister.filter((a) => !a.startsWith("-"));
          const declared = commandFor(words);
          if (declared && !declared.flags) flagsUnchecked += 1;
          const problem = cloisterProblem(cloister);
          if (problem) found.push({ file, line, text, problem });
        } else if (basename(argv[0]) === "task") {
          checked += 1;
          const problem = taskProblem(argv.slice(1), names);
          if (problem) found.push({ file, line, text, problem });
        }
      }
    }
  }
  return { found, checked, flagsUnchecked };
}

function main() {
  const { found, checked, flagsUnchecked } = problems();
  for (const p of found) console.error(`${p.file}:${p.line}: ${p.problem}\n    ${p.text.trim()}`);
  if (found.length) {
    console.error(`lint-doc-invocations: ${found.length} documented invocation(s) the CLI or Taskfiles would refuse`);
    process.exit(1);
  }
  console.log(`lint-doc-invocations: OK — ${checked} documented invocation(s) hold; ${flagsUnchecked} name a command whose flags cli/surface.mjs does not declare, so their flags were not checked`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
