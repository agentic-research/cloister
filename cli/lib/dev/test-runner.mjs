// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

function discoverIn(root, directory, accepts) {
  const absolute = resolve(root, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.isFile() && accepts(entry.name))
    .map((entry) => `${directory}/${entry.name}`);
}

/** As discoverIn, and one level of area subdirectories (cli/test/<area>/). */
function discoverWithAreas(root, directory, accepts) {
  const absolute = resolve(root, directory);
  if (!existsSync(absolute)) return [];
  const areas = readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "fixtures")
    .map((entry) => `${directory}/${entry.name}`);
  return [directory, ...areas].flatMap((dir) => discoverIn(root, dir, accepts));
}

/**
 * Discover the repository's Node test suites by convention.
 *
 * Each area keeps its tests beside it, in its own `test/` directory; cli/test is
 * grouped once more by the part of the CLI under test. The nono checks stay next
 * to the native harness they exercise and use a `nono-` prefix. The separately
 * built harness-binary test is intentionally owned by `task harness:binary:test`.
 */
/** Where Node test suites live: one `test/` per area, beside the code it tests. */
export const NODE_TEST_DIRS = Object.freeze(["cli/test", "lint/test", "gen/test", "dev/test"]);

export function discoverNodeTests(root = process.cwd()) {
  return [
    ...NODE_TEST_DIRS.flatMap((dir) => discoverWithAreas(root, dir, (name) => name.endsWith(".test.mjs"))),
    ...discoverIn(
      root,
      "tools/harness-sandbox/test",
      (name) => name.startsWith("nono-") && name.endsWith(".test.mjs"),
    ),
  ].sort();
}

/**
 * The failing tests in a TAP stream: each `not ok` line with the block under
 * it, up to the line that closes the block. A skipped or todo test is `ok`.
 */
export function failedTests(tap) {
  const failures = [];
  let open = null;
  for (const line of tap.split("\n")) {
    if (/^\s*not ok \d+/.test(line)) {
      if (open) failures.push(open);
      open = [line];
    } else if (open) {
      open.push(line);
      if (line.trim() === "...") { failures.push(open); open = null; }
    }
  }
  if (open) failures.push(open);
  // A failing subtest fails its parent too: report the innermost, once.
  return failures.filter((f) => !/subtestsFailed|[0-9]+ subtests? failed/.test(f.join("\n"))).map((f) => f.join("\n"));
}

export function runNodeTests({
  root = process.cwd(),
  env = process.env,
  spawn = spawnSync,
  log = console.error,
} = {}) {
  const tests = discoverNodeTests(root);
  if (tests.length === 0) {
    throw new Error(`no Node tests found under ${resolve(root)}`);
  }
  // The same TAP goes to the terminal and to a file. The file is read back
  // only to say, last, WHICH tests failed: this run prints several thousand
  // lines and `task lint` interleaves other suites after it, so a failure is
  // otherwise one `not ok` line thousands of lines above the exit status. A
  // CI log viewer that keeps only the tail does not show it at all.
  const scratch = mkdtempSync(join(tmpdir(), "cloister-node-tests-"));
  const tapFile = join(scratch, "results.tap");
  try {
    const result = spawn(
      process.execPath,
      [
        "--import", "tsx", "--test",
        "--test-reporter=tap", "--test-reporter-destination=stdout",
        "--test-reporter=tap", `--test-reporter-destination=${tapFile}`,
        ...tests,
      ],
      { cwd: resolve(root), env, stdio: "inherit" },
    );
    if (result.error) throw result.error;
    const status = result.signal ? 1 : (result.status ?? 1);
    if (status !== 0) {
      const failures = existsSync(tapFile) ? failedTests(readFileSync(tapFile, "utf8")) : [];
      log(`\ncloister dev test: ${failures.length} failing test(s)${failures.length ? ":" : " found in the results; the run itself failed (see above)"}`);
      for (const failure of failures) log(`\n${failure}`);
    }
    return status;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
