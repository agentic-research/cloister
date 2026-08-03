// SPDX-License-Identifier: AGPL-3.0-or-later
// Repository-only compatibility helper. Product behavior lives under cli/.

import { pathToFileURL } from "node:url";

export async function runIfDirect(moduleUrl, main, label) {
  if (!process.argv[1] || moduleUrl !== pathToFileURL(process.argv[1]).href) return;
  try {
    process.exitCode = (await main(process.argv.slice(2))) ?? 0;
  } catch (error) {
    process.stderr.write(`${label}: unexpected error: ${error.message}\n`);
    process.exitCode = 2;
  }
}
