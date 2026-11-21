// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference path="./lib/bundle-globals.d.ts" />
//
// `--help` always answers, and answers the same way: from the declaration in
// cli/surface.mjs, before any command code runs.
//
// Each command used to parse `--help` for itself, after whatever it does
// first. So `cloister runtime inspect --help` asked for an LLO control socket
// before it would print a usage line, and `cloister install --help` went
// through a bootstrap that runs `pnpm install` before it looked at its
// arguments. Help bogged down by configuration is help that is not there when
// it is needed. Both entry points (bin/cloister.mjs, and cli/index.mjs, which
// the one-file build enters) ask here first. This module imports only the
// declaration, which imports nothing, so it works before `node_modules`
// exists. cli/test/help.test.mjs runs `--help` on every declared command with
// no configuration at all.

import { COMMANDS, STANDALONE, commandFor, renderCommandHelp, renderHelp } from "./surface.mjs";

const isHelp = (arg) => arg === "--help" || arg === "-h";

/**
 * The help text `argv` asks for, or undefined when it asks for none.
 *
 * `argv` is what follows the global options. Only arguments before a `--`
 * count: after it they belong to something else (`cloister run -- tool
 * --help` asks the tool).
 *
 * @param {string[]} argv
 * @returns {string | undefined}
 */
export function helpFor(argv) {
  const end = argv.indexOf("--");
  const own = end === -1 ? argv : argv.slice(0, end);
  const words = [];
  for (const arg of own) {
    if (arg.startsWith("-")) break;
    words.push(arg);
  }
  if (words.length === 0) {
    // `cloister`, `cloister --help`, `cloister help`: the top-level text is
    // index.mjs's to print, where a bare `cloister` is also handled.
    return own.some(isHelp) ? renderHelp() : undefined;
  }
  if (words[0] === "help" && words.length === 1) return renderHelp();
  if (!own.some(isHelp)) return undefined;

  const declared = commandFor(words);
  if (declared) {
    const text = renderCommandHelp(declared.name);
    if (globalThis.__CLOISTER_BUNDLE__ === true && !declared.standalone) {
      return `${text}\nThis command needs a cloister checkout; the one-file build does not run it.`;
    }
    return text;
  }
  // A group: `cloister cluster --help`, `cloister runtime storage --help`.
  const group = words.join(" ");
  const members = COMMANDS.filter((c) => c.name.startsWith(`${group} `));
  if (members.length) return renderGroupHelp(group, members);
  return undefined;
}

/** Help for a group of commands that share their first words. */
function renderGroupHelp(group, members) {
  const width = Math.max(...members.map((c) => c.name.length)) + 12;
  const lines = [`Usage: cloister ${group} <command> [options]`, "", "Commands:"];
  for (const c of members) {
    const note = globalThis.__CLOISTER_BUNDLE__ === true && !STANDALONE.includes(c.name) ? "  (needs a checkout)" : "";
    lines.push(`  ${`cloister ${c.name} ...`.padEnd(width)} ${c.summary}${note}`);
  }
  lines.push("", `Run \`cloister ${group} <command> --help\` for its options.`, "");
  return lines.join("\n");
}
