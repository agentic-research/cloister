// scripts/test/pull-inputs.test.mjs
//
// Run with:  node --test scripts/test/pull-inputs.test.mjs
//
// Unit tests for the pure ref-resolution helpers in pull-inputs.mjs
// (ociPullRef precedence + collectOciRefs lockfile walk). The pull
// itself shells out to a container runtime and isn't unit-tested here.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ociPullRef,
  collectOciRefs,
  parsePullArgs,
  validatePullSafety,
  isAffirmative,
  selectOciRefs,
} from "../pull-inputs.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PULL_SCRIPT = resolve(HERE, "..", "pull-inputs.mjs");

// ── ociPullRef: ADR-0038 precedence ──────────────────────────────────

test("ociPullRef: digest wins (content-addressed)", () => {
  assert.equal(
    ociPullRef({ identifier: "ghcr.io/org/tool", version: "1.2.3", digest: "sha256:abc" }),
    "ghcr.io/org/tool@sha256:abc",
  );
});

test("ociPullRef: version when no digest", () => {
  assert.equal(
    ociPullRef({ identifier: "ghcr.io/org/tool", version: "1.2.3" }),
    "ghcr.io/org/tool:1.2.3",
  );
});

test("ociPullRef: bare identifier when neither digest nor version", () => {
  assert.equal(ociPullRef({ identifier: "ghcr.io/org/tool" }), "ghcr.io/org/tool");
});

test("ociPullRef: null / missing identifier → null", () => {
  assert.equal(ociPullRef(null), null);
  assert.equal(ociPullRef(undefined), null);
  assert.equal(ociPullRef({}), null);
  assert.equal(ociPullRef({ version: "1.0.0" }), null);
  assert.equal(ociPullRef({ identifier: "   " }), null);
});

// ── collectOciRefs: lockfile walk ────────────────────────────────────

test("collectOciRefs: one row per input; ref null when no oci; pinned only for digest", () => {
  const doc = {
    inputs: {
      llo:    { sha256: "sha256:1", oci: { identifier: "ghcr.io/org/llo", version: "0.5.6" } },
      pinned: { sha256: "sha256:2", oci: { identifier: "ghcr.io/org/x", digest: "sha256:dd" } },
      mache:  { sha256: "sha256:3" }, // no oci
    },
  };
  const rows = collectOciRefs(doc);
  assert.deepEqual(rows, [
    { name: "llo",    ref: "ghcr.io/org/llo:0.5.6",   pinned: false },
    { name: "pinned", ref: "ghcr.io/org/x@sha256:dd", pinned: true },
    { name: "mache",  ref: null,                       pinned: false },
  ]);
});

test("collectOciRefs: empty / missing inputs table → []", () => {
  assert.deepEqual(collectOciRefs({}), []);
  assert.deepEqual(collectOciRefs({ inputs: {} }), []);
  assert.deepEqual(collectOciRefs(null), []);
});

// ── consent + immutable-artifact policy ──────────────────────────────

test("parsePullArgs: safe defaults require interactive confirmation and immutable refs", () => {
  assert.deepEqual(parsePullArgs([]), {
    printOnly: false,
    yes: false,
    allowUnpinned: false,
  });
});

test("parsePullArgs: automation and explicit downgrade are separate flags", () => {
  assert.deepEqual(parsePullArgs(["mache", "--yes", "--allow-unpinned"]), {
    printOnly: false,
    yes: true,
    allowUnpinned: true,
    inputs: ["mache"],
  });
});

test("parsePullArgs: unknown flags fail loud", () => {
  assert.throws(() => parsePullArgs(["--surprise"]), /unknown argument/);
});

test("validatePullSafety: digest-pinned rows are accepted", () => {
  assert.doesNotThrow(() => validatePullSafety([
    { name: "mache", ref: "ghcr.io/art/mache@sha256:abc", pinned: true },
  ], { allowUnpinned: false }));
});

test("validatePullSafety: mutable refs are rejected by default", () => {
  assert.throws(
    () => validatePullSafety([
      { name: "llo", ref: "ghcr.io/art/llo:0.8.0", pinned: false },
    ], { allowUnpinned: false }),
    /refusing 1 mutable artifact reference.*--allow-unpinned/s,
  );
});

test("validatePullSafety: explicit downgrade permits mutable refs", () => {
  assert.doesNotThrow(() => validatePullSafety([
    { name: "llo", ref: "ghcr.io/art/llo:0.8.0", pinned: false },
  ], { allowUnpinned: true }));
});

test("isAffirmative: only an explicit yes proceeds", () => {
  for (const answer of ["y", "Y", "yes", " YES "]) {
    assert.equal(isAffirmative(answer), true, answer);
  }
  for (const answer of ["", "n", "no", "sure", "1"]) {
    assert.equal(isAffirmative(answer), false, answer);
  }
});

test("selectOciRefs scopes acquisition without weakening unrelated mutable refs", () => {
  const rows = [
    { name: "llo", ref: "ghcr.io/art/llo:latest", pinned: false },
    { name: "mache", ref: "ghcr.io/art/mache@sha256:abc", pinned: true },
  ];
  assert.deepEqual(selectOciRefs(rows, ["mache"]), [rows[1]]);
  assert.throws(() => selectOciRefs(rows, ["unknown"]), /unknown input/);
});

function withPullFixture({ pinned = true }, fn) {
  const dir = mkdtempSync(resolve(tmpdir(), "cloister-pull-"));
  const lock = resolve(dir, "cluster.lock.toml");
  const runtime = resolve(dir, "fake-runtime");
  const log = resolve(dir, "pull.log");
  const oci = pinned
    ? 'identifier = "ghcr.io/art/tool"\ndigest = "sha256:abc"'
    : 'identifier = "ghcr.io/art/tool"\nversion = "1.2.3"';
  writeFileSync(lock, `schema = "cloister/lockfile/v1"\n[inputs.tool.oci]\n${oci}\n`);
  writeFileSync(runtime, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PULL_LOG"\n');
  chmodSync(runtime, 0o755);
  try {
    fn({ dir, lock, runtime, log });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runPull(args, fixture) {
  return spawnSync("node", [PULL_SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      CLOISTER_LOCKFILE: fixture.lock,
      CONTAINER_CMD: fixture.runtime,
      PULL_LOG: fixture.log,
    },
  });
}

test("non-interactive invocation downloads nothing without --yes", () => {
  withPullFixture({ pinned: true }, (fixture) => {
    const r = runPull([], fixture);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /without confirmation.*--yes/s);
    assert.equal(existsSync(fixture.log), false);
  });
});

test("--yes materializes the exact digest-pinned reference", () => {
  withPullFixture({ pinned: true }, (fixture) => {
    const r = runPull(["--yes"], fixture);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      readFileSync(fixture.log, "utf8"),
      "pull ghcr.io/art/tool@sha256:abc\n",
    );
  });
});

test("--yes alone does not authorize a mutable artifact downgrade", () => {
  withPullFixture({ pinned: false }, (fixture) => {
    const r = runPull(["--yes"], fixture);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /refusing 1 mutable artifact reference/);
    assert.equal(existsSync(fixture.log), false);
  });
});

test("--allow-unpinned and --yes visibly downgrade and pull", () => {
  withPullFixture({ pinned: false }, (fixture) => {
    const r = runPull(["--allow-unpinned", "--yes"], fixture);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /WARNING.*mutable artifact references/s);
    assert.equal(
      readFileSync(fixture.log, "utf8"),
      "pull ghcr.io/art/tool:1.2.3\n",
    );
  });
});
