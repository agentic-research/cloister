// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

function discoverIn(root, directory, accepts) {
  const absolute = resolve(root, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.isFile() && accepts(entry.name))
    .map((entry) => `${directory}/${entry.name}`);
}

/**
 * Discover the repository's Node test suites by convention.
 *
 * Each area keeps its tests beside it, in its own `test/` directory. The nono checks stay next
 * to the native harness they exercise and use a `nono-` prefix. The separately
 * built harness-binary test is intentionally owned by `task harness:binary:test`.
 */
/** Where Node test suites live: one `test/` per area, beside the code it tests. */
export const NODE_TEST_DIRS = Object.freeze(["cli/test", "lint/test", "gen/test", "dev/test"]);

export function discoverNodeTests(root = process.cwd()) {
  return [
    ...NODE_TEST_DIRS.flatMap((dir) => discoverIn(root, dir, (name) => name.endsWith(".test.mjs"))),
    ...discoverIn(
      root,
      "tools/harness-sandbox/test",
      (name) => name.startsWith("nono-") && name.endsWith(".test.mjs"),
    ),
  ].sort();
}

export function runNodeTests({
  root = process.cwd(),
  env = process.env,
  spawn = spawnSync,
} = {}) {
  const tests = discoverNodeTests(root);
  if (tests.length === 0) {
    throw new Error(`no Node tests found under ${resolve(root)}`);
  }
  const result = spawn(
    process.execPath,
    ["--import", "tsx", "--test", ...tests],
    { cwd: resolve(root), env, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  return result.signal ? 1 : (result.status ?? 1);
}
