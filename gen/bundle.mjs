#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// gen/bundle.mjs — build the cloister CLI as ONE file that needs only
// Node 22: dist/cloister.mjs.
//
// It is the same CLI as bin/cloister.mjs: the same help, the same commands,
// the same code. What it runs is narrower. A command declared `standalone`
// in cli/surface.mjs reads nothing from a cloister checkout, and runs; every
// other command refuses by name (cli/index.mjs), because it reads files that
// ship beside the source. gen/test/bundle.test.mjs runs every standalone
// command from an empty directory, and holds the rest to that refusal.
//
// The first of them is the plan checker, `cloister inspect`: point it at a
// rendered Terraform plan and it drafts a `cluster.toml`, or compares the plan
// with one (docs/plan-checker.md).
//
// What makes one file possible:
//
//   - every "am I being run as a script" check goes through
//     cli/lib/started-as-script.mjs, which the bundle's define turns off,
//     so the bundle runs only the entry below;
//   - the generated cluster schema is loaded through
//     cli/lib/cluster/cluster-schema.mjs, which imports it literally in a
//     bundle;
//   - data files are JSON imports, which the bundler carries;
//   - `tsx`, which two `cluster` paths use to load TypeScript sources from a
//     checkout, is replaced by a module that refuses. Those paths belong to
//     commands the bundle does not run; the stub makes sure that if one is
//     reached anyway, it says why instead of failing on a native binary.
//
// After building, the bundle is checked: it must not import anything but
// Node's own modules, so that a missing package is caught here and not on
// someone's machine.
//
// Usage: node gen/bundle.mjs [--out <file>]   (default dist/cloister.mjs)

import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The one thing the bundle runs: the CLI, as bin/cloister.mjs runs it. */
const ENTRY = `
import { main } from "./cli/index.mjs";
process.exitCode = await main(process.argv.slice(2));
`;

/** What `tsx/esm/api` becomes in the bundle. */
const TSX_STUB = `
export async function tsImport(specifier) {
  throw new Error("loading " + specifier + " needs a cloister checkout; the one-file build does not carry tsx");
}
`;

/** Replaces `tsx` with TSX_STUB. */
const withoutTsx = {
  name: "without-tsx",
  setup(b) {
    b.onResolve({ filter: /^tsx(\/|$)/ }, (args) => ({ path: args.path, namespace: "without-tsx" }));
    b.onLoad({ filter: /.*/, namespace: "without-tsx" }, () => ({ contents: TSX_STUB, loader: "js" }));
  },
};

export async function bundleCli(out = resolve(ROOT, "dist/cloister.mjs")) {
  const version = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")).version ?? "0.0.0";
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: ROOT, sourcefile: "cloister-entry.mjs", loader: "js" },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile: out,
    define: { "globalThis.__CLOISTER_BUNDLE__": "true" },
    plugins: [withoutTsx],
    // Some dependencies are CommonJS and call require(); an ES module has none.
    banner: {
      js: [
        "#!/usr/bin/env node",
        `// cloister ${version}, the one-file build (https://github.com/agentic-research/cloister).`,
        "// Built by gen/bundle.mjs. AGPL-3.0-or-later. Do not edit.",
        'import { createRequire as __cloisterCreateRequire } from "node:module";',
        "const require = __cloisterCreateRequire(import.meta.url);",
      ].join("\n"),
    },
    legalComments: "eof",
    metafile: true,
    logLevel: "warning",
  });

  // Anything left unresolved is an import the bundle would need at run time.
  const outputs = Object.values(result.metafile.outputs);
  const external = [...new Set(outputs.flatMap((o) => o.imports.filter((i) => i.external).map((i) => i.path)))];
  const foreign = external.filter((path) => !path.startsWith("node:") && !builtinModules.includes(path));
  if (foreign.length) {
    const by = Object.entries(result.metafile.inputs)
      .filter(([, input]) => input.imports.some((i) => foreign.includes(i.path) || /(^|\/)node_modules\/tsx\//.test(i.path)))
      .map(([name]) => name);
    if (by.length) console.error(`bundle: imported from ${by.join(", ")}`);
    throw new Error(`bundle: the bundle imports ${foreign.map((p) => `"${p}"`).join(", ")} at run time, which a plain Node install does not have`);
  }
  return { out, bytes: outputs[0].bytes, inputs: Object.keys(result.metafile.inputs).length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf("--out");
  const { out, bytes, inputs } = await bundleCli(at > 0 ? resolve(process.argv[at + 1]) : undefined);
  console.log(`bundle: wrote ${out.replace(`${ROOT}/`, "")} (${(bytes / 1024).toFixed(0)} KiB, ${inputs} inputs)`);
}
