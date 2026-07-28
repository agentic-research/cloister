// scripts/test/lint-smell-rule-kinship.test.mjs
//
// Run with:  node --test scripts/test/lint-smell-rule-kinship.test.mjs
//
// Contract tests for scripts/lint-smell-rule-kinship.mjs — the drift lint
// that keeps cloister's "mache-smell-rules-shaped" claim honest by recording
// both severity vocabularies and failing when a live source stops matching
// what is recorded (cloister-2fb46a).
//
// The point of this suite is falsification. A lint that has only ever been
// observed to pass is indistinguishable from a lint that cannot fail, so
// every drift case below MUTATES a synthesized source and asserts a non-zero
// exit. Both sides are synthesized rather than read from the real checkouts:
// the mache half must be testable on a cold single-repo runner, which is the
// whole property this lint exists to preserve.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const LINT_SCRIPT = resolve(REPO_ROOT, "scripts/lint-smell-rule-kinship.mjs");

// ── Synthesized sources matching what RECORDED declares ──────────────────
//
// Trimmed to the shapes the lint parses. Drift cases below edit these.

const CLOISTER_SOURCE = `
  if (parsed.severity !== undefined && parsed.severity !== "block" && parsed.severity !== "warn") {
    throw new ToolchainError(
      \`rule file \${name}: severity must be "block" or "warn"\`,
    );
  }
  return {
    id:          parsed.id,
    severity:    parsed.severity ?? "block",      // fail-secure default
    run:         parsed.run,
  };
`;

const MACHE_SOURCE = `
type Severity string

const (
	SeverityOff   Severity = "off"
	SeverityWarn  Severity = "warn"
	SeverityError Severity = "error"
)

func (r *SmellRule) Effective() Severity {
	switch r.Severity {
	case SeverityOff, SeverityError:
		return r.Severity
	default:
		return SeverityWarn
	}
}
`;

function makeSandbox({ cloister = CLOISTER_SOURCE, mache = MACHE_SOURCE } = {}) {
  const dir = mkdtempSync(resolve(tmpdir(), "kinship-lint-"));
  const cloisterFile = resolve(dir, "done-runner.mjs");
  writeFileSync(cloisterFile, cloister);

  let macheRoot = null;
  if (mache !== null) {
    macheRoot = resolve(dir, "mache");
    mkdirSync(resolve(macheRoot, "cmd"), { recursive: true });
    writeFileSync(resolve(macheRoot, "cmd", "smell_rules.go"), mache);
  } else {
    // An existing directory that is demonstrably not a mache checkout —
    // exercises the unobservable-half branch.
    macheRoot = resolve(dir, "not-mache");
    mkdirSync(macheRoot, { recursive: true });
  }

  return {
    cloisterFile,
    macheRoot,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}

function runLint(sandbox) {
  return spawnSync("node", [LINT_SCRIPT], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DONE_RUNNER_FILE: sandbox.cloisterFile,
      MACHE_REPO: sandbox.macheRoot,
    },
    encoding: "utf8",
  });
}

function withSandbox(opts, fn) {
  const sandbox = makeSandbox(opts);
  try {
    fn(runLint(sandbox), sandbox);
  } finally {
    sandbox.cleanup();
  }
}

// ── The recorded state holds ─────────────────────────────────────────────

test("both halves match what is recorded → exit 0, both verified", () => {
  withSandbox({}, (r) => {
    assert.equal(r.status, 0, `expected pass; stderr:\n${r.stderr}`);
    assert.match(r.stdout, /clean/);
    assert.match(r.stdout, /cloister.*block \| warn.*verified/);
    assert.match(r.stdout, /mache.*off \| warn \| error.*verified/);
  });
});

test("the real tree passes — RECORDED describes the checked-in sources", () => {
  // No sandbox: this is the lint running against cloister's actual
  // done-runner.mjs. The mache half may be unknown here (no checkout on a
  // cold runner) and that is allowed; the cloister half must be verified.
  const r = spawnSync("node", [LINT_SCRIPT], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, `expected pass; stderr:\n${r.stderr}`);
  assert.match(r.stdout, /cloister.*verified/);
});

// ── An unobserved half is UNKNOWN, never satisfied ───────────────────────

test("mache unreachable → exit 0 but reported UNKNOWN with a reason, not verified", () => {
  withSandbox({ mache: null }, (r) => {
    assert.equal(r.status, 0, `expected pass; stderr:\n${r.stderr}`);
    assert.match(r.stdout, /mache.*UNKNOWN/);
    assert.doesNotMatch(r.stdout, /mache.*verified/);
    assert.match(r.stdout, /has no cmd\/smell_rules\.go/);
    assert.match(r.stdout, /never\n?\s*satisfied/);
  });
});

// ── Drift on the cloister half ───────────────────────────────────────────

test("cloister gains a severity value → exit 1", () => {
  const drifted = CLOISTER_SOURCE.replace(
    'parsed.severity !== "warn")',
    'parsed.severity !== "warn" && parsed.severity !== "error")',
  );
  withSandbox({ cloister: drifted }, (r) => {
    assert.equal(r.status, 1, `expected drift exit 1; stdout:\n${r.stdout}`);
    assert.match(r.stderr, /accepted severities/);
    assert.match(r.stderr, /cloister/);
  });
});

test("cloister flips its default from block to warn → exit 1", () => {
  const drifted = CLOISTER_SOURCE.replace(
    'parsed.severity ?? "block"',
    'parsed.severity ?? "warn"',
  );
  withSandbox({ cloister: drifted }, (r) => {
    assert.equal(r.status, 1, `expected drift exit 1; stdout:\n${r.stdout}`);
    assert.match(r.stderr, /default severity: recorded "block", live source has "warn"/);
  });
});

// ── Drift on the mache half ──────────────────────────────────────────────

test("mache drops a severity value → exit 1", () => {
  const drifted = MACHE_SOURCE.replace('\tSeverityOff   Severity = "off"\n', "");
  withSandbox({ mache: drifted }, (r) => {
    assert.equal(r.status, 1, `expected drift exit 1; stdout:\n${r.stdout}`);
    assert.match(r.stderr, /accepted severities/);
    assert.match(r.stderr, /mache/);
  });
});

test("mache flips its default arm to error → exit 1", () => {
  const drifted = MACHE_SOURCE.replace(
    "default:\n\t\treturn SeverityWarn",
    "default:\n\t\treturn SeverityError",
  );
  withSandbox({ mache: drifted }, (r) => {
    assert.equal(r.status, 1, `expected drift exit 1; stdout:\n${r.stdout}`);
    assert.match(r.stderr, /default severity: recorded "warn", live source has "error"/);
  });
});

// ── Unparseable sources are a toolchain error, not a pass ────────────────

test("cloister source without the reject guard → exit 2, not a silent pass", () => {
  withSandbox({ cloister: "export const nothing = 1;\n" }, (r) => {
    assert.equal(r.status, 2, `expected toolchain exit 2; stdout:\n${r.stdout}`);
    assert.match(r.stderr, /reject guard/);
  });
});

test("mache source without the const block → exit 2, not a silent pass", () => {
  withSandbox({ mache: "package cmd\n" }, (r) => {
    assert.equal(r.status, 2, `expected toolchain exit 2; stdout:\n${r.stdout}`);
    assert.match(r.stderr, /constants found/);
  });
});

test("mache Effective() returning an undeclared constant → exit 2", () => {
  const drifted = MACHE_SOURCE.replace("return SeverityWarn", "return SeverityNope");
  withSandbox({ mache: drifted }, (r) => {
    assert.equal(r.status, 2, `expected toolchain exit 2; stdout:\n${r.stdout}`);
    assert.match(r.stderr, /unknown constant SeverityNope/);
  });
});
