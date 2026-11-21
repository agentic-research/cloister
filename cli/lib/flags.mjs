// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A command's flags, parsed from its declaration (ADR-0077 Part 3).
//
// A command declared in manifest/cli.capnp is an `$Op` whose input struct is
// its flags. schema-bridge turns it into an entry of
// src/generated/cli.tools.json, and this parses argv against that entry and
// nothing else: a field `fooBar` is the flag `--foo-bar`, a boolean is a
// switch, a string takes a value, and an absent flag takes its declared
// default. An undeclared flag, a missing value or a stray argument is refused
// by name. So the flags a command accepts are exactly the flags it declares,
// and help, docs and parser cannot disagree about them.

import { parseArgs } from "node:util";

import TOOLS from "../../src/generated/cli.tools.json" with { type: "json" };

export class FlagsError extends Error {}

/** The flag for a declared field: `fooBar` → `foo-bar`. */
export const flagName = (field) => field.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** The declared commands, by name. */
export function declaredCommand(name) {
  return TOOLS.find((tool) => tool.name === name);
}

/**
 * Parse `argv`, the arguments after the command's words, as the flags of the
 * declared command `name`.
 *
 * @param {string} name e.g. "cluster graph"
 * @param {string[]} argv
 * @returns {Record<string, string | boolean>} each declared field, set or defaulted
 */
export function parseFlags(name, argv) {
  const tool = declaredCommand(name);
  if (!tool) throw new Error(`flags: no command ${JSON.stringify(name)} is declared in manifest/cli.capnp`);
  const properties = tool.inputSchema.properties ?? {};
  const options = {};
  for (const [field, prop] of Object.entries(properties)) {
    if (prop.type !== "string" && prop.type !== "boolean") {
      // A declared type this parser does not read is a declaration it cannot
      // honour; refusing it here is louder than accepting it as a string.
      throw new Error(`flags: ${name} declares ${field} as ${prop.type}, which cli/lib/flags.mjs does not parse yet`);
    }
    options[flagName(field)] = { type: prop.type };
  }
  let values;
  let tokens;
  try {
    ({ values, tokens } = parseArgs({ args: argv, options, strict: true, allowPositionals: false, tokens: true }));
  } catch (error) {
    throw new FlagsError(sentence(error, name));
  }
  // parseArgs keeps the last of a repeated flag. Which one was meant is a
  // guess, so a flag given twice is refused instead.
  const seen = new Set();
  for (const token of tokens) {
    if (token.kind !== "option") continue;
    if (seen.has(token.name)) throw new FlagsError(`--${token.name} is given more than once`);
    seen.add(token.name);
  }
  const out = {};
  for (const [field, prop] of Object.entries(properties)) {
    const given = values[flagName(field)];
    out[field] = given !== undefined ? given : prop.default;
    if (out[field] === undefined) throw new FlagsError(`--${flagName(field)} is required`);
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
