// cli/test/runtime/pull-inputs.test.mjs
//
// Run with:  node --test cli/test/runtime/pull-inputs.test.mjs
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
  detectRuntime,
} from "../../commands/artifacts-pull.mjs";
import { resolveComposeCmd } from "../../commands/cluster.mjs";
import { engineFor } from "../../lib/cluster/compose-up.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PULL_SCRIPT = resolve(HERE, "../../..", "cli", "commands", "artifacts-pull.mjs");

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

test("collectOciRefs: a multi-image producer's bundle images are pulled too, each once", () => {
  // compose runs notme-proxy from its [[inputs.notme.ociBundles]] row with
  // pull_policy: never; reading only [inputs.notme.oci] left it unpulled.
  const doc = {
    inputs: {
      notme: {
        oci: { identifier: "ghcr.io/org/notme", digest: "sha256:aa" },
        ociBundles: [
          { bundle: "notme-identity", identifier: "ghcr.io/org/notme", digest: "sha256:aa" },
          { bundle: "notme-proxy", identifier: "ghcr.io/org/notme-proxy", digest: "sha256:bb" },
        ],
      },
      // A producer whose own oci is absent: no "has no oci image" row for it.
      split: { ociBundles: [{ bundle: "s", identifier: "ghcr.io/org/s", version: "1.0" }] },
    },
  };
  assert.deepEqual(collectOciRefs(doc), [
    { name: "notme", ref: "ghcr.io/org/notme@sha256:aa", pinned: true },
    { name: "notme", bundle: "notme-proxy", ref: "ghcr.io/org/notme-proxy@sha256:bb", pinned: true },
    { name: "split", bundle: "s", ref: "ghcr.io/org/s:1.0", pinned: false },
  ]);
});

test("collectOciRefs: two producers naming one bundle are refused, as compose refuses them", () => {
  const doc = { inputs: {
    a: { ociBundles: [{ bundle: "b", identifier: "x/b", digest: "sha256:1" }] },
    c: { ociBundles: [{ bundle: "b", identifier: "y/b", digest: "sha256:2" }] },
  } };
  assert.throws(() => collectOciRefs(doc), /bundle "b" is pinned by two multi-image producers/);
});

test("collectOciRefs: empty / missing inputs table → []", () => {
  assert.deepEqual(collectOciRefs({}), []);
  assert.deepEqual(collectOciRefs({ inputs: {} }), []);
  assert.deepEqual(collectOciRefs(null), []);
});

test("collectOciRefs: each operator image the lock pins is pulled by its digest alone (ADR-0083 §2)", () => {
  const D = `sha256:${"a".repeat(64)}`;
  const rows = collectOciRefs({
    inputs: { mache: { oci: { identifier: "ghcr.io/acme/mache", version: "1", digest: `sha256:${"b".repeat(64)}` } } },
    images: [{ ref: "ghcr.io/acme/api:1.4", digest: D }, { ref: "docker.io/redis:7", digest: D }, { ref: "ghcr.io/acme/bad:1", digest: "sha256:short" }],
  });
  assert.deepEqual(rows.filter((r) => r.image), [
    { name: "ghcr.io/acme/api:1.4", ref: `ghcr.io/acme/api@${D}`, pinned: true, image: true },
    { name: "docker.io/redis:7", ref: `docker.io/redis@${D}`, pinned: true, image: true },
  ]);
  // Naming inputs pulls only theirs.
  assert.deepEqual(selectOciRefs(rows, ["mache"]).map((r) => r.name), ["mache"]);
});

test("detectRuntime: the store `cluster up` starts from, by its own rule", () => {
  // On a machine with docker and podman, `cluster up` drives podman compose;
  // pulling into docker's store left an offline `cluster up` without its images.
  const which = (bin) => ["docker", "podman"].includes(bin);
  assert.equal(detectRuntime({}, { which }), "podman");
  assert.equal(detectRuntime({}, { which }), engineFor(resolveComposeCmd({ env: {}, which }), {}));
  assert.equal(detectRuntime({ COMPOSE_CMD: "docker compose" }, { which }), "docker");
  assert.equal(detectRuntime({ CONTAINER_CMD: "nerdctl" }, { which }), "nerdctl");
  assert.equal(detectRuntime({}, { which: () => false }), null);
});

// ── consent + immutable-artifact policy ──────────────────────────────

test("parsePullArgs: safe defaults require interactive confirmation and immutable refs", () => {
  assert.deepEqual(parsePullArgs([]), {
    printOnly: false,
    yes: false,
    allowUnpinned: false,
    inputs: [],
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

test("parsePullArgs: unknown flags fail loud, in the declared parser's words", () => {
  assert.throws(() => parsePullArgs(["--surprise"]), /unknown option "--surprise" for `cloister artifacts pull`/);
});

test("parsePullArgs: -y is --yes, and inputs may sit among the flags", () => {
  assert.deepEqual(parsePullArgs(["llo", "-y", "mache", "--print"]), {
    printOnly: true,
    yes: true,
    allowUnpinned: false,
    inputs: ["llo", "mache"],
  });
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

test("selectOciRefs keeps every image of a selected input", () => {
  const rows = [
    { name: "notme", ref: "ghcr.io/art/notme@sha256:aa", pinned: true },
    { name: "notme", bundle: "notme-proxy", ref: "ghcr.io/art/notme-proxy@sha256:bb", pinned: true },
    { name: "mache", ref: "ghcr.io/art/mache@sha256:cc", pinned: true },
  ];
  assert.deepEqual(selectOciRefs(rows, ["notme"]), rows.slice(0, 2));
  assert.throws(() => selectOciRefs(rows, ["notme", "nope"]), /unknown input selection: nope$/);
});

function withPullFixture({ pinned = true, lockText }, fn) {
  const dir = mkdtempSync(resolve(tmpdir(), "cloister-pull-"));
  const lock = resolve(dir, "cluster.lock.toml");
  const runtime = resolve(dir, "fake-runtime");
  const log = resolve(dir, "pull.log");
  const oci = pinned
    ? 'identifier = "ghcr.io/art/tool"\ndigest = "sha256:abc"'
    : 'identifier = "ghcr.io/art/tool"\nversion = "1.2.3"';
  writeFileSync(lock, lockText ?? `schema = "cloister/lockfile/v1"\n[inputs.tool.oci]\n${oci}\n`);
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

test("--yes pulls every image a multi-image producer pins, naming each bundle's", () => {
  const lockText = [
    'schema = "cloister/lockfile/v1"',
    "[inputs.notme.oci]",
    'identifier = "ghcr.io/art/notme"',
    'digest = "sha256:aa"',
    "[[inputs.notme.ociBundles]]",
    'bundle = "notme-identity"',
    'identifier = "ghcr.io/art/notme"',
    'digest = "sha256:aa"',
    "[[inputs.notme.ociBundles]]",
    'bundle = "notme-proxy"',
    'identifier = "ghcr.io/art/notme-proxy"',
    'digest = "sha256:bb"',
    "",
  ].join("\n");
  withPullFixture({ lockText }, (fixture) => {
    const r = runPull(["--yes", "notme"], fixture);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /notme \(bundle notme-proxy\) → ghcr\.io\/art\/notme-proxy@sha256:bb/);
    assert.equal(
      readFileSync(fixture.log, "utf8"),
      "pull ghcr.io/art/notme@sha256:aa\npull ghcr.io/art/notme-proxy@sha256:bb\n",
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
