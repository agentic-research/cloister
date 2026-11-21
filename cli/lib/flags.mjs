// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A command's flags, parsed from its declaration in cli/surface.mjs
// (ADR-0077 Part 3, as amended).
//
// cli/surface.mjs is the one declaration of the command line: help, the
// reference docs, the one-file build's `standalone` set and `--help` are all
// read from it. This parses argv against a command's declared flags and
// nothing else: a flag with a `value` takes one, a flag without is a switch, a
// `repeatable` flag may be given more than once, an absent flag takes its
// declared `default`, and a `required` one must be given. An undeclared flag,
// a missing value, a stray argument, a flag given twice and a switch given a
// value are each refused by name. So the flags a command accepts are exactly
// the flags its help lists: both are read from the same entry.

import { parseArgs } from "node:util";

import { COMMANDS } from "../surface.mjs";

export class FlagsError extends Error {}

/** The key a flag's value is returned under: `--min-strength` → `minStrength`. */
export const flagKey = (flag) => flag.replace(/^--/, "").replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());

/**
 * Parse `argv`, the arguments after the command's words, as the flags of the
 * declared command `name`.
 *
 * @param {string} name e.g. "cluster graph"
 * @param {string[]} argv
 * @returns {Record<string, string | string[] | boolean | undefined>} each declared flag by its key
 */
export function parseFlags(name, argv) {
  const command = COMMANDS.find((c) => c.name === name);
  if (!command) throw new Error(`flags: no command ${JSON.stringify(name)} is declared in cli/surface.mjs`);
  const declared = command.flags ?? [];
  const options = {};
  for (const f of declared) {
    if (!f.flag.startsWith("--")) throw new Error(`flags: ${name} declares ${JSON.stringify(f.flag)}, which is not a --long flag`);
    options[f.flag.slice(2)] = { type: f.value ? "string" : "boolean", multiple: f.repeatable === true };
  }
  let values;
  let tokens;
  try {
    ({ values, tokens } = parseArgs({ args: argv, options, strict: true, allowPositionals: false, tokens: true }));
  } catch (error) {
    throw new FlagsError(sentence(error, name));
  }
  // parseArgs keeps the last of a repeated flag. Which one was meant is a
  // guess, so a flag given twice is refused unless it is declared repeatable.
  const seen = new Set();
  for (const token of tokens) {
    if (token.kind !== "option") continue;
    if (seen.has(token.name) && !options[token.name].multiple) throw new FlagsError(`--${token.name} is given more than once`);
    seen.add(token.name);
  }
  const out = {};
  for (const f of declared) {
    const given = values[f.flag.slice(2)];
    if (given === undefined && f.required) throw new FlagsError(`${f.flag} is required`);
    out[flagKey(f.flag)] = given !== undefined ? given : f.default !== undefined ? f.default : f.value ? (f.repeatable ? [] : undefined) : false;
  }
  return out;
}

/** Node's parseArgs errors, in this CLI's words. */
function sentence(error, name) {
  // The flag as Node quotes it, without the `<value>` it appends.
  const option = /'(-[^' ]+)/.exec(error.message)?.[1];
  switch (error.code) {
    case "ERR_PARSE_ARGS_UNKNOWN_OPTION": return `unknown option ${JSON.stringify(option)} for \`cloister ${name}\``;
    case "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL": return `unexpected argument ${JSON.stringify(/'([^']+)'/.exec(error.message)?.[1])} for \`cloister ${name}\``;
    case "ERR_PARSE_ARGS_INVALID_OPTION_VALUE":
      if (/argument missing/.test(error.message)) return `${option} requires a value`;
      if (/does not take an argument/.test(error.message)) return `${option} is a switch and takes no value`;
      // `--env --json`: the next argument is a flag, so the value is missing.
      if (/ambiguous/.test(error.message)) return `${option} requires a value (for one that starts with "-", write ${option}=<value>)`;
      return error.message;
    default: return error.message;
  }
}
