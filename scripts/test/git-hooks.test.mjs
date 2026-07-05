// scripts/test/git-hooks.test.mjs
//
// Contract tests for local git hooks. These are text-level tests on
// purpose: the hook should stay a small shell script, while the test pins
// the operational invariants that caused real push friction.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

function read(rel) {
  return readFileSync(resolve(REPO_ROOT, rel), "utf8");
}

function taskBlock(taskfile, name) {
  const match = taskfile.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [\\w:-]+:|^\\S)`, "m"));
  assert.ok(match, `Taskfile must contain ${name}:`);
  return match[1];
}

test("pre-push hook honors package.json packageManager before running Task", () => {
  const hook = read("scripts/git-hooks/pre-push");

  assert.match(hook, /package\.json/, "hook must read package.json");
  assert.match(hook, /packageManager/, "hook must honor packageManager");
  assert.match(hook, /pnpm@\$\{EXPECTED_PNPM_VERSION\}|pnpm@10\.30\.3|\$PACKAGE_MANAGER/, "hook must derive/use the pinned pnpm spec");
  assert.match(hook, /corepack/, "hook should use Corepack when a matching pnpm is not already on PATH");
  assert.match(hook, /mktemp -d/, "hook should isolate selected pnpm in a temp shim dir");
  assert.match(hook, /ln -s "\$PNPM_BIN" "\$PNPM_SHIM_DIR\/pnpm"/, "hook should symlink only pnpm, not prepend the whole install dir");
  assert.match(hook, /pnpm --version|\$PNPM_BIN --version|\$candidate" --version/, "hook must verify the selected pnpm version");
  assert.match(hook, /task --force pre-push/, "hook still runs the pre-push Taskfile target with cache bypass");
});

test("Taskfile pre-push runs the strict gate once instead of lint plus verify twice", () => {
  const taskfile = read("Taskfile.yml");
  const ci = taskBlock(taskfile, "ci");
  const prePush = taskBlock(taskfile, "pre-push");

  assert.doesNotMatch(
    ci,
    /task:\s*lint[\s\S]*task:\s*verify/,
    "ci must not invoke lint and then verify; verify already depends on lint",
  );
  assert.match(
    prePush,
    /deps:\s*\[verify\]/,
    "pre-push should depend directly on the strict verify gate",
  );
  assert.doesNotMatch(
    prePush,
    /deps:\s*\[ci\]/,
    "pre-push should not route through ci when ci exists for human/CI mirroring",
  );
});
