#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// gen/bundle-plan.mjs — build the plan checker as ONE file that needs only
// Node 22.
//
// The plan checker is `cloister inspect`: point it at a rendered Terraform
// plan (`terraform show -json`) and it drafts a `cluster.toml` of the
// services and who calls whom, or compares the plan with a `cluster.toml`
// you already have. It is the smallest useful thing cloister does, and it
// should not need the rest of cloister installed to do it: no Rust, no Cap'n
// Proto, no Task, no checkout.
//
// What makes one file possible, and what each part relies on:
//
//   - every "am I being run as a script" check goes through
//     cli/lib/started-as-script.mjs, which the bundle's define turns off,
//     so the bundle runs only the entry below;
//   - the generated cluster schema is loaded through
//     cli/lib/cluster/cluster-schema.mjs, which imports it literally in a
//     bundle;
//   - mappings and specs are JSON imports, which the bundler carries.
//
// After building, the bundle is checked: it must not import anything but
// Node's own modules, so that a missing package is caught here and not on
// someone's machine.
//
// Usage: node gen/bundle-plan.mjs [--out <file>]   (default dist/cloister-plan.mjs)

import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The one thing the bundle runs. */
const ENTRY = `
import { main } from "./cli/commands/inspect.mjs";
process.exitCode = await main(process.argv.slice(2));
`;

export async function bundlePlan(out = resolve(ROOT, "dist/cloister-plan.mjs")) {
  const version = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")).version ?? "0.0.0";
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: ROOT, sourcefile: "cloister-plan-entry.mjs", loader: "js" },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile: out,
    define: { "globalThis.__CLOISTER_BUNDLE__": "true" },
    // Some dependencies are CommonJS and call require(); an ES module has none.
    banner: {
      js: [
        "#!/usr/bin/env node",
        `// cloister-plan ${version}: the plan checker from cloister (https://github.com/agentic-research/cloister).`,
        "// Built by gen/bundle-plan.mjs. AGPL-3.0-or-later. Do not edit.",
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
    if (by.length) console.error(`bundle-plan: imported from ${by.join(", ")}`);
    throw new Error(`bundle-plan: the bundle imports ${foreign.map((p) => `"${p}"`).join(", ")} at run time, which a plain Node install does not have`);
  }
  return { out, bytes: outputs[0].bytes, inputs: Object.keys(result.metafile.inputs).length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf("--out");
  const { out, bytes, inputs } = await bundlePlan(at > 0 ? resolve(process.argv[at + 1]) : undefined);
  console.log(`bundle-plan: wrote ${out.replace(`${ROOT}/`, "")} (${(bytes / 1024).toFixed(0)} KiB, ${inputs} inputs)`);
}
