// SPDX-License-Identifier: AGPL-3.0-or-later

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveInstallLayout } from "../lib/install-layout.mjs";
import { renderCommandHelp } from "../surface.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export async function main(argv = process.argv.slice(2), deps = {}) {
  const log = deps.log ?? console.log;
  const errLog = deps.errLog ?? console.error;
  const env = deps.env ?? process.env;
  const [sub, ...rest] = argv;

  if (sub === "--help" || sub === "-h" || (sub === "install" && rest.includes("--help"))) {
    log(renderCommandHelp("runtime install"));
    return 0;
  }
  if (sub !== "install" || rest.length > 0) {
    errLog(`cloister runtime: expected \`install\`, got ${JSON.stringify(argv.join(" "))}`);
    return 2;
  }

  const root = resolve(deps.root ?? ROOT);
  const layout = resolveInstallLayout({ env, checkoutRoot: root });
  try {
    const install = deps.installCompatibilityProvider
      ?? (await import("../lib/runtime/install-compatibility.mjs")).installCompatibilityProvider;
    const record = await install({ root, layout, spawn: deps.spawn, platform: deps.platform });
    log(
      `cloister runtime install: installed ${record.provider} provider ` +
      `(${record.maturity}) in ${layout.libexecDir}`,
    );
    return 0;
  } catch (error) {
    errLog(`cloister runtime install: ${error.message}`);
    return 1;
  }
}
