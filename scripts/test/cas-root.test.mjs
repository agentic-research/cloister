// SPDX-License-Identifier: AGPL-3.0-or-later
//
// prepareCas (cloister-727354): the CLI's one door to the microVM CAS. The
// host runtime is a real executable here (a shell script standing in for
// `cloister-host-runtime cas-attach`), reached through the real
// runCompatibilityJson, so the argv, the env hand-off and the JSON parse are
// exercised rather than stubbed.

import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CasUnavailableError, lazyRootfsInCas, prepareCas } from "../../cli/lib/runtime/cas-root.mjs";

function fixture(t, reply) {
  const dir = mkdtempSync(join(tmpdir(), "cas-root-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const casRoot = join(dir, "mnt", "cas");
  mkdirSync(casRoot, { recursive: true });
  const argvLog = join(dir, "argv");
  const bin = join(dir, "fake-host-runtime");
  writeFileSync(
    bin,
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvLog}'\ncat <<'JSON'\n${JSON.stringify(reply(casRoot))}\nJSON\n`,
  );
  chmodSync(bin, 0o755);
  const record = { microvm: { casRoot, casStateDir: join(dir, "state") } };
  const warnings = [];
  const options = (extra = {}) => ({
    env: { CLOISTER_HOST_RUNTIME_BIN: bin, ...extra },
    readRecord: () => record,
    warn: (line) => warnings.push(line),
  });
  return { dir, casRoot, record, argvLog, warnings, options };
}

test("a provisioned volume is attached through cas-attach and its rootfs found", (t) => {
  const f = fixture(t, (casRoot) => ({ provisioned: true, volume: { casRoot } }));
  mkdirSync(join(f.casRoot, "ab12"));
  const cas = prepareCas(f.options());
  assert.deepEqual(
    readFileSync(f.argvLog, "utf8").trim().split("\n"),
    ["cas-attach", "--state-dir", f.record.microvm.casStateDir],
  );
  assert.deepEqual(cas.rootfsInCas("ab12"), { present: true, casRoot: f.casRoot });
  assert.deepEqual(cas.rootfsInCas("cd34"), { present: false, casRoot: f.casRoot });
  assert.deepEqual(f.warnings, []);
});

test("a record naming a volume that is not provisioned is refused with the remedy", (t) => {
  const f = fixture(t, () => ({ provisioned: false }));
  assert.throws(
    () => prepareCas(f.options()),
    (error) =>
      error instanceof CasUnavailableError &&
      /none is provisioned there/.test(error.message) &&
      /Run: cloister runtime install/.test(error.message),
  );
});

test("a volume whose root differs from the record is refused", (t) => {
  const f = fixture(t, () => ({ provisioned: true, volume: { casRoot: "/elsewhere/cas" } }));
  assert.throws(
    () => prepareCas(f.options()),
    (error) =>
      error instanceof CasUnavailableError &&
      error.message.includes("/elsewhere/cas") &&
      error.message.includes(f.casRoot) &&
      /Run: cloister runtime install/.test(error.message),
  );
});

test("a CLOISTER_CAS_ROOT that disagrees with the record is refused before anything is attached", (t) => {
  const f = fixture(t, (casRoot) => ({ provisioned: true, volume: { casRoot } }));
  assert.throws(
    () => prepareCas(f.options({ CLOISTER_CAS_ROOT: "/stale/cas" })),
    (error) => error instanceof CasUnavailableError && /unset\s+CLOISTER_CAS_ROOT/.test(error.message),
  );
  assert.throws(() => readFileSync(f.argvLog), { code: "ENOENT" }, "cas-attach never ran");
  // The same value as the record is not a disagreement.
  prepareCas(f.options({ CLOISTER_CAS_ROOT: f.casRoot }));
});

test("an install that predates the volume warns in one line and does not attach", (t) => {
  const f = fixture(t, () => ({ provisioned: false }));
  delete f.record.microvm.casStateDir;
  const cas = prepareCas(f.options());
  assert.equal(cas.casRoot, f.casRoot);
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /predates the case-sensitive CAS volume.*Run: cloister runtime install/);
  assert.throws(() => readFileSync(f.argvLog), { code: "ENOENT" }, "cas-attach never ran");
});

test("a record with no CAS root says to install", (t) => {
  const f = fixture(t, () => ({ provisioned: false }));
  assert.throws(
    () => prepareCas({ ...f.options(), readRecord: () => ({}) }),
    (error) => error instanceof CasUnavailableError && /Run: cloister runtime install/.test(error.message),
  );
});

test("lazyRootfsInCas attaches nothing until a rootfs is asked for, then only once", (t) => {
  const f = fixture(t, (casRoot) => ({ provisioned: true, volume: { casRoot } }));
  let reads = 0;
  const lookup = lazyRootfsInCas({ ...f.options(), readRecord: () => { reads += 1; return f.record; } });
  assert.equal(reads, 0);
  lookup("aa");
  lookup("bb");
  assert.equal(reads, 1);
});
