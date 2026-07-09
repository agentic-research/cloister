// SPDX-License-Identifier: AGPL-3.0-or-later
//
// seatbelt-isolation.test.mjs — proves the deny-default Seatbelt profile
// (tools/harness-sandbox/harness.sb) enforces the harness isolation
// contract at the KERNEL, not by convention (cloister-24717d).
//
// The contract under test:
//   1. a real node binary loads and runs confined (no dyld SIGABRT)
//   2. WORKDIR is readable + writable
//   3. a decoy secret OUTSIDE the workdir — a file that provably exists —
//      is denied with a sandbox EPERM ("Operation not permitted"),
//      NOT ENOENT. Empty output alone is never treated as a denial.
//   4. ~/.ssh is denied the same way (when it exists on the host)
//   5. localhost TCP + unix sockets (the cloister vault-proxy seam) work
//   6. external network is kernel-denied (EPERM before any packet)
//
// macOS-only: sandbox-exec is Seatbelt's CLI. Skips cleanly elsewhere.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import {
  mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir, homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DARWIN = process.platform === "darwin";
const PROFILE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "harness.sb");

// One root under /private/tmp — deliberately NOT os.tmpdir(): the profile
// allows the darwin per-user temp (/var/folders/…/T), so a decoy there
// would be readable by design. /private/tmp gets no content allowance,
// which also means the workdir tests prove the WORKDIR param itself.
// The decoy secret is a SIBLING of the workdir — outside it, but
// guaranteed to exist (we write it and re-read it unsandboxed).
const root = DARWIN ? mkdtempSync("/private/tmp/seatbelt-") : null;
const workdir = root ? join(root, "workdir") : null;
const stateDir = root ? join(root, "state") : null;
const decoy = root ? join(root, "decoy-secret.txt") : null;
const DECOY_CONTENT = "SIMULATED PRIVATE KEY — must never be readable confined";

if (DARWIN) {
  spawnSync("mkdir", ["-p", workdir, stateDir]);
  writeFileSync(join(workdir, "inside.txt"), "hello-from-workdir");
  writeFileSync(decoy, DECOY_CONTENT);
}

// node's own prefix must be readable for the confined spawn; pass it as
// HARNESS_RUNTIME so the test works for nvm/asdf installs under $HOME too.
const nodeRuntime = DARWIN ? dirname(dirname(realpathSync(process.execPath))) : "";

const sandboxArgs = (argv) => [
  "-D", `WORKDIR=${workdir}`,
  "-D", `HARNESS_RUNTIME=${nodeRuntime}`,
  "-D", `HARNESS_STATE=${stateDir}`,
  "-D", `HARNESS_STATE_FILE=${join(root, "state.json")}`,
  "-f", PROFILE,
  ...argv,
];

function confined(argv, opts = {}) {
  return spawnSync("sandbox-exec", sandboxArgs(argv), {
    encoding: "utf8", cwd: workdir, timeout: 30_000, ...opts,
  });
}

// Async variant for the network tests: the loopback/UDS listener lives in
// THIS process, so the parent's event loop must stay free to accept —
// spawnSync would deadlock it.
function confinedAsync(argv) {
  return new Promise((res) => {
    const child = spawn("sandbox-exec", sandboxArgs(argv), { cwd: workdir });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const t = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("close", (status) => { clearTimeout(t); res({ status, stdout, stderr }); });
  });
}

// A REAL denial: nonzero exit + the sandbox EPERM message. Empty stdout
// alone proves nothing (this bit an earlier spike); and ENOENT would mean
// we tested a file that doesn't exist.
function assertSandboxDenied(r, path) {
  assert.notEqual(r.status, 0, `expected nonzero exit for ${path}, got ${r.status}`);
  assert.match(
    r.stderr,
    /operation not permitted|EPERM/i,
    `expected a sandbox EPERM for ${path}; stderr was: ${r.stderr}`,
  );
  assert.doesNotMatch(
    r.stderr,
    /no such file|ENOENT/i,
    `got ENOENT for ${path} — the test target must exist for the denial to mean anything`,
  );
}

test("seatbelt: node binary loads and runs under the deny-default profile", { skip: !DARWIN }, () => {
  const r = confined([process.execPath, "-e", 'console.log("boot-ok")']);
  assert.equal(r.status, 0, `node failed to boot confined (exit ${r.status}): ${r.stderr}`);
  assert.match(r.stdout, /boot-ok/);
});

test("seatbelt: workdir read succeeds", { skip: !DARWIN }, () => {
  const r = confined([
    process.execPath, "-e",
    'process.stdout.write(require("fs").readFileSync(process.argv[1], "utf8"))',
    join(workdir, "inside.txt"),
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "hello-from-workdir");
});

test("seatbelt: workdir write succeeds", { skip: !DARWIN }, () => {
  const target = join(workdir, "written-confined.txt");
  const r = confined([
    process.execPath, "-e",
    'require("fs").writeFileSync(process.argv[1], "written-from-inside")',
    target,
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(target, "utf8"), "written-from-inside");
});

test("seatbelt: decoy secret outside the workdir is kernel-denied (EPERM, not ENOENT)", { skip: !DARWIN }, () => {
  // The decoy DEFINITELY exists — prove it unsandboxed first.
  assert.equal(readFileSync(decoy, "utf8"), DECOY_CONTENT);
  const viaCat = confined(["/bin/cat", decoy]);
  assertSandboxDenied(viaCat, decoy);
  assert.doesNotMatch(viaCat.stdout, /SIMULATED PRIVATE KEY/);
  const viaNode = confined([
    process.execPath, "-e",
    'require("fs").readFileSync(process.argv[1], "utf8")',
    decoy,
  ]);
  assertSandboxDenied(viaNode, decoy);
});

test("seatbelt: ~/.ssh is kernel-denied", { skip: !DARWIN || !existsSync(join(homedir(), ".ssh")) }, () => {
  const sshDir = join(homedir(), ".ssh");
  // Listing the directory (its contents exist by the skip-guard) must be
  // an EPERM, and its entries must not leak into stdout.
  const r = confined(["/bin/ls", sshDir]);
  assertSandboxDenied(r, sshDir);
  assert.equal(r.stdout.trim(), "", `~/.ssh listing leaked: ${r.stdout}`);
});

test("seatbelt: localhost TCP (the cloister vault-proxy seam) is reachable", { skip: !DARWIN }, async () => {
  const server = createServer((c) => { c.on("error", () => {}); c.end("vault-proxy-hello"); });
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  const { port } = server.address();
  try {
    const r = await confinedAsync([
      process.execPath, "-e",
      `const c=require("net").connect(${port},"127.0.0.1");` +
      'c.on("data",d=>{process.stdout.write(d.toString());process.exit(0)});' +
      'c.on("error",e=>{console.error(e.code);process.exit(1)});',
    ]);
    assert.equal(r.status, 0, `localhost connect failed: ${r.stderr}`);
    assert.equal(r.stdout, "vault-proxy-hello");
  } finally {
    server.close();
  }
});

test("seatbelt: unix socket (UDS seam) is reachable", { skip: !DARWIN }, async () => {
  // sun_path caps at 104 bytes on macOS — keep the socket path short.
  const sockDir = mkdtempSync(join(realpathSync(tmpdir()), "sb-uds-"));
  const sock = join(sockDir, "s.sock");
  const server = createServer((c) => { c.on("error", () => {}); c.end("uds-hello"); });
  await new Promise((res) => server.listen(sock, res));
  try {
    const r = await confinedAsync([
      process.execPath, "-e",
      'const c=require("net").connect(process.argv[1]);' +
      'c.on("data",d=>{process.stdout.write(d.toString());process.exit(0)});' +
      'c.on("error",e=>{console.error(e.code);process.exit(1)});',
      sock,
    ]);
    assert.equal(r.status, 0, `unix-socket connect failed: ${r.stderr}`);
    assert.equal(r.stdout, "uds-hello");
  } finally {
    server.close();
    rmSync(sockDir, { recursive: true, force: true });
  }
});

test("seatbelt: external network is kernel-denied (EPERM before any packet)", { skip: !DARWIN }, () => {
  const r = confined([
    process.execPath, "-e",
    'const c=require("net").connect(443,"1.1.1.1");' +
    'c.setTimeout(5000,()=>{console.error("TIMEOUT");process.exit(3)});' +
    'c.on("connect",()=>{console.error("CONNECTED");process.exit(2)});' +
    'c.on("error",e=>{console.error("code="+e.code);process.exit(e.code==="EPERM"?0:1)});',
  ]);
  assert.equal(r.status, 0, `expected synchronous EPERM on external connect; got: ${r.stderr}`);
  assert.match(r.stderr, /code=EPERM/);
});

test.after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
