// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A command's flags, parsed from its declaration in cli/surface.mjs
// (ADR-0077 Part 3, as amended).
//
// cli/surface.mjs is the one declaration of the command line: help, the
// reference docs, the one-file build's `standalone` set and `--help` are all
// read from it. This parses argv against a command's declared flags and
// arguments and nothing else: a flag with a `value` takes one, a flag without
// is a switch, a `repeatable` flag may be given more than once, a declared
// `short` alias (`-y`) means its flag, an absent flag takes its declared
// `default`, and a `required` one must be given. Declared `arguments` are the
// positionals, in order; only the last may be `repeatable`. An undeclared
// flag, a missing value, a stray argument, a missing required argument, a flag
// given twice and a switch given a value are each refused by name. So what a
// command accepts is exactly what its help lists: both are read from the same
// entry.

import { parseArgs } from "node:util";

import { COMMANDS } from "../surface.mjs";

export class FlagsError extends Error {}

/** The key a flag's value is returned under: `--min-strength` → `minStrength`. */
export const flagKey = (flag) => flag.replace(/^--/, "").replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());

/** The key an argument's value is returned under: `<run-id>` → `runId`. */
export const argumentKey = (name) => flagKey(`--${name.replace(/^<|>$/g, "")}`);

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
  // A declared `--` is the end of options: what follows is passed through, as
  // `passthrough`, and is not parsed (`cloister run -- <tool> <its args>`).
  const passes = (command.flags ?? []).some((f) => f.flag === "--");
  const declared = (command.flags ?? []).filter((f) => f.flag !== "--");
  const end = passes ? argv.indexOf("--") : -1;
  const passthrough = end === -1 ? [] : argv.slice(end + 1);
  if (end !== -1) argv = argv.slice(0, end);
  const options = {};
  for (const f of declared) {
    if (!f.flag.startsWith("--")) throw new Error(`flags: ${name} declares ${JSON.stringify(f.flag)}, which is not a --long flag`);
    const option = { type: f.value ? "string" : "boolean", multiple: f.repeatable === true };
    if (f.short !== undefined) {
      if (!/^-[a-zA-Z]$/.test(f.short)) throw new Error(`flags: ${name} declares ${f.flag} with short ${JSON.stringify(f.short)}, which is not -<letter>`);
      option.short = f.short.slice(1);
    }
    options[f.flag.slice(2)] = option;
  }
  const args = command.arguments ?? [];
  for (const [index, a] of args.entries()) {
    if (!/^<[a-z][a-z0-9-]*>$/.test(a.name)) throw new Error(`flags: ${name} declares argument ${JSON.stringify(a.name)}, which is not <name>`);
    if (a.repeatable && index !== args.length - 1) throw new Error(`flags: ${name} declares ${a.name} repeatable, and only its last argument can be`);
    if (declared.some((f) => flagKey(f.flag) === argumentKey(a.name))) throw new Error(`flags: ${name} declares both ${a.name} and a flag of the same key`);
  }
  let values;
  let positionals;
  let tokens;
  try {
    ({ values, positionals, tokens } = parseArgs({ args: argv, options, strict: true, allowPositionals: args.length > 0, tokens: true }));
  } catch (error) {
    throw new FlagsError(sentence(error, name));
  }
  // `--` ends the options only where the command declares it (above). Taken
  // anywhere else, it would make what follows an argument without saying so.
  if (tokens.some((token) => token.kind === "option-terminator")) {
    throw new FlagsError(`unexpected argument "--" for \`cloister ${name}\``);
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
  let next = 0;
  for (const a of args) {
    const key = argumentKey(a.name);
    if (a.repeatable) {
      out[key] = positionals.slice(next);
      next = positionals.length;
      if (a.required && out[key].length === 0) throw new FlagsError(`${a.name} is required`);
    } else if (next < positionals.length) {
      out[key] = positionals[next++];
    } else if (a.required) {
      throw new FlagsError(`${a.name} is required`);
    } else {
      out[key] = undefined;
    }
  }
  if (next < positionals.length) {
    throw new FlagsError(`unexpected argument ${JSON.stringify(positionals[next])} for \`cloister ${name}\``);
  }
  if (passes) out.passthrough = passthrough;
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
