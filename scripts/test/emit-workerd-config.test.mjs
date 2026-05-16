// scripts/test/emit-workerd-config.test.mjs
//
// Run with:  node --test scripts/test/emit-workerd-config.test.mjs
//
// Covers the do-storage path substitution added by ADR-0023
// (cloister-addcdd). Synthesizes a stub config.capnp + dist/ in a
// tmpdir, runs the script with various CLOISTER_DO_PATH values,
// asserts the emitted dist/config.capnp carries the expected path.
//
// Lives under scripts/test/ for the same reason as
// lint-bundle-isolation.test.mjs — vitest pool-workers can't spawn
// the script (no node:child_process), so we use the plain node test
// runner.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SCRIPT = join(HERE, "..", "emit-workerd-config.mjs");

// Minimal config.capnp template carrying every shape the script
// touches: a modules array (one entry, just to satisfy the locator
// + wasm check), a do-storage service with the disk path field.
const STUB_TEMPLATE = `using Workerd = import "/workerd/workerd.capnp";

const cloisterWorker :Workerd.Worker = (
  modules = [
    ( name = "worker",
      esModule = embed "dist/index.js" ),
  ],
  bindings = [],
);

const config :Workerd.Config = (
  services = [
    ( name = "cloister-worker",
      worker = cloisterWorker,
    ),
    ( name = "do-storage",
      disk = (
        path = "/data/do",
        writable = true,
      ),
    ),
  ],
);
`;

function setupSandbox() {
  const dir = mkdtempSync(join(tmpdir(), "emit-workerd-config-test-"));
  writeFileSync(join(dir, "config.capnp"), STUB_TEMPLATE);
  const distDir = join(dir, "dist");
  mkdirSync(distDir, { recursive: true });
  // Bare-minimum bundle artifacts the script expects to find. The
  // .wasm file just needs to exist; the script doesn't inspect content.
  writeFileSync(join(distDir, "index.js"), "// stub bundle\n");
  writeFileSync(join(distDir, "stub.wasm"), Buffer.from([0x00, 0x61, 0x73, 0x6d]));
  return { dir, distDir };
}

function runScript(cwd, env = {}) {
  return execFileSync(process.execPath, [SCRIPT], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

test("default DO_PATH stays /data/do (no env-var)", () => {
  const { dir } = setupSandbox();
  try {
    const out = runScript(dir);
    assert.match(out, /do-storage path = \/data\/do \(default\)/);
    const emitted = readFileSync(join(dir, "dist", "config.capnp"), "utf8");
    assert.match(emitted, /name = "do-storage",[\s\S]*?path = "\/data\/do"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLOISTER_DO_PATH overrides the do-storage path", () => {
  const { dir } = setupSandbox();
  const override = "/tmp/cloister-test-override/do";
  try {
    const out = runScript(dir, { CLOISTER_DO_PATH: override });
    assert.match(out, /do-storage path = \/tmp\/cloister-test-override\/do \(via CLOISTER_DO_PATH\)/);
    const emitted = readFileSync(join(dir, "dist", "config.capnp"), "utf8");
    assert.match(emitted, new RegExp(`name = "do-storage",[\\s\\S]*?path = "${override.replace(/\//g, "\\/")}"`));
    // Template's literal /data/do must NOT survive into the do-storage
    // service entry (it may still appear elsewhere, e.g. comments, but
    // not as the disk path).
    const doStorageIdx = emitted.indexOf('name = "do-storage"');
    const nextServiceIdx = emitted.indexOf("( name = ", doStorageIdx + 1);
    const doStorageBlock = emitted.slice(
      doStorageIdx,
      nextServiceIdx === -1 ? emitted.length : nextServiceIdx,
    );
    assert.doesNotMatch(doStorageBlock, /path = "\/data\/do"/, "literal /data/do leaked into the overridden do-storage block");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("relative CLOISTER_DO_PATH is rejected with a clear error", () => {
  const { dir } = setupSandbox();
  try {
    assert.throws(
      () => runScript(dir, { CLOISTER_DO_PATH: "relative/do" }),
      (err) => {
        // Script writes the error to stderr and exits 1; execFileSync
        // surfaces both as the thrown error's .stderr buffer.
        const stderr = String(err.stderr ?? "");
        assert.match(stderr, /CLOISTER_DO_PATH must be an absolute path/);
        assert.match(stderr, /relative\/do/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing do-storage entry in template fails fast", () => {
  const { dir } = setupSandbox();
  // Strip the do-storage service from the template — script should die.
  const broken = STUB_TEMPLATE.replace(/\( name = "do-storage",[\s\S]*?\),\s*\n/, "");
  writeFileSync(join(dir, "config.capnp"), broken);
  try {
    assert.throws(
      () => runScript(dir),
      (err) => {
        const stderr = String(err.stderr ?? "");
        assert.match(stderr, /do-storage `path = "\.\.\."` field/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
