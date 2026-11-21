// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference path="./bundle-globals.d.ts" />
//
// The JSON outputs the CLI prints, held to their declaration (ADR-0077).
//
// Each output is a struct in manifest/cli.capnp. Its format version is
// recorded in schema/cli-formats.lock.json by gen/cli-schema.mjs, and read
// from there, so it is stated once. Before an output is printed it is parsed
// with the schema schema-bridge generated for it, and the result must equal
// what was built: an extra field fails the parse (the schema is strict), and a
// missing one shows up as a default the parse filled in. So the shape a
// consumer validates against is the shape it gets, in every build.

import { isDeepStrictEqual } from "node:util";

import LOCK from "../../schema/cli-formats.lock.json" with { type: "json" };

/**
 * The format version of an output, as recorded in the lock.
 *
 * @param {string} name the output's struct name in manifest/cli.capnp
 */
export function formatVersion(name) {
  const held = LOCK.outputs[name];
  if (!held) throw new Error(`output-format: no output named ${JSON.stringify(name)} in schema/cli-formats.lock.json`);
  return held.formatVersion;
}

/** @returns {Promise<typeof import("../../src/generated/cli.zod.ts")>} */
async function loadCliSchema() {
  // As cli/lib/cluster/cluster-schema.mjs: a bundle imports the generated
  // TypeScript literally; a checkout loads it through tsx.
  if (globalThis.__CLOISTER_BUNDLE__ === true) {
    return import("../../src/generated/cli.zod.ts");
  } else {
    const { tsImport } = await import("tsx/esm/api");
    return tsImport(new URL("../../src/generated/cli.zod.ts", import.meta.url).href, { parentURL: import.meta.url });
  }
}

/**
 * `body` as the output `name`, with its formatVersion first, checked against
 * its generated schema. Throws, naming what differs, when it does not match.
 *
 * @param {string} name the output's struct name in manifest/cli.capnp
 * @param {object} body the output, without formatVersion
 */
export async function declaredOutput(name, body) {
  const value = { formatVersion: formatVersion(name), ...body };
  const schema = (await loadCliSchema())[`${name}Schema`];
  if (!schema) throw new Error(`output-format: src/generated/cli.zod.ts has no ${name}Schema`);
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`output-format: this ${name} does not match manifest/cli.capnp: ${result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  }
  if (!isDeepStrictEqual(result.data, value)) {
    throw new Error(`output-format: this ${name} lacks fields manifest/cli.capnp declares (the schema filled in defaults)`);
  }
  return value;
}
