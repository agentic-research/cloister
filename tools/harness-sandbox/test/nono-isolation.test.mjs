// SPDX-License-Identifier: AGPL-3.0-or-later
//
// nono-isolation.test.mjs — proves the nono-confined harness contract at
// the KERNEL, not by convention (cloister-24717d).
//
// nono (https://nono.sh) is Seatbelt on macOS + Landlock on Linux behind
// one capability CLI; it's the sandbox provider `SANDBOX=nono task
// harness:dev` shells out to. The contract under test:
//   1. a real node binary runs confined
//   2. the workdir (`-a`) is readable + writable
//   3. a decoy secret in $HOME — a file that provably exists — is denied
//      with a kernel EPERM ("Operation not permitted"), NOT ENOENT.
//      Empty output alone is never treated as a denial. ($HOME is the
//      surface nono protects by default; /tmp is default-allowed so a
//      decoy there would prove nothing.)
//   4. ~/.ssh is denied the same way (when it exists on the host)
//   5. --open-port lets the harness reach localhost TCP (the cloister
//      vault-proxy seam); --allow-unix-socket the UDS seam
//   6. --block-net kernel-denies external connects (EPERM, no packet)
//
// Cross-platform (nono does darwin + linux); skips cleanly when the nono
// CLI isn't installed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const HAVE_NONO = (() => {
  try {
    return spawnSync("nono", ["--version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
})();
const SKIP = HAVE_NONO ? false : "nono CLI not installed (https://nono.sh)";

const workdir = HAVE_NONO ? mkdtempSync(join(realpathSync(tmpdir()), "nono-wd-")) : null;
// The decoy lives in $HOME: that's the surface nono default-denies (it
// default-allows /tmp + system paths so binaries run). Unique name, and
// removed again in after().
const decoy = HAVE_NONO ? join(homedir(), `.nono-isolation-decoy-${process.pid}.txt`) : null;
const DECOY_CONTENT = "SIMULATED PRIVATE KEY — must never be readable confined";

if (HAVE_NONO) {
  writeFileSync(join(workdir, "inside.txt"), "hello-from-workdir");
  writeFileSync(decoy, DECOY_CONTENT);
}

// Base argv for a confined run: workdir rw, outbound network blocked.
// `-s` silences nono's banner so assertions see only the child's output;
// `--allow-cwd` because non-interactive runs can't prompt (cwd == workdir).
const nonoArgs = (extra, argv) => [
  "run", "-s", "-a", workdir, "--allow-cwd", "--block-net", "--no-audit",
  ...extra, "--", ...argv,
];

function confined(argv, extra = []) {
  return spawnSync("nono", nonoArgs(extra, argv), {
    encoding: "utf8", cwd: workdir, timeout: 60_000,
  });
}

// Async variant for the network tests: the loopback/UDS listener lives in
// THIS process, so the parent's event loop must stay free to accept —
// spawnSync would deadlock it.
function confinedAsync(argv, extra = []) {
  return new Promise((res) => {
    const child = spawn("nono", nonoArgs(extra, argv), { cwd: workdir });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const t = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (status) => { clearTimeout(t); res({ status, stdout, stderr }); });
  });
}

// A REAL denial: nonzero exit + the kernel EPERM message. Empty stdout
// alone proves nothing (this bit an earlier spike); and ENOENT would mean
// we tested a file that doesn't exist.
function assertKernelDenied(r, path) {
  assert.notEqual(r.status, 0, `expected nonzero exit for ${path}, got ${r.status}`);
  assert.match(
    r.stderr,
    /operation not permitted|permission denied|EPERM|EACCES/i,
    `expected a kernel denial for ${path}; stderr was: ${r.stderr}`,
  );
  assert.doesNotMatch(
    r.stderr,
    /no such file|ENOENT/i,
    `got ENOENT for ${path} — the test target must exist for the denial to mean anything`,
  );
}

test("nono: node binary runs confined", { skip: SKIP }, () => {
  const r = confined([process.execPath, "-e", 'console.log("boot-ok")']);
  assert.equal(r.status, 0, `node failed to boot confined (exit ${r.status}): ${r.stderr}`);
  assert.match(r.stdout, /boot-ok/);
});

test("nono: workdir read succeeds", { skip: SKIP }, () => {
  const r = confined([
    process.execPath, "-e",
    'process.stdout.write(require("fs").readFileSync(process.argv[1], "utf8"))',
    join(workdir, "inside.txt"),
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "hello-from-workdir");
});

test("nono: workdir write succeeds", { skip: SKIP }, () => {
  const target = join(workdir, "written-confined.txt");
  const r = confined([
    process.execPath, "-e",
    'require("fs").writeFileSync(process.argv[1], "written-from-inside")',
    target,
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(target, "utf8"), "written-from-inside");
});

test("nono: $HOME decoy secret is kernel-denied (EPERM, not ENOENT)", { skip: SKIP }, () => {
  // The decoy DEFINITELY exists — prove it unsandboxed first.
  assert.equal(readFileSync(decoy, "utf8"), DECOY_CONTENT);
  const viaCat = confined(["/bin/cat", decoy]);
  assertKernelDenied(viaCat, decoy);
  assert.doesNotMatch(viaCat.stdout, /SIMULATED PRIVATE KEY/);
  const viaNode = confined([
    process.execPath, "-e",
    'require("fs").readFileSync(process.argv[1], "utf8")',
    decoy,
  ]);
  assertKernelDenied(viaNode, decoy);
  assert.doesNotMatch(viaNode.stdout, /SIMULATED PRIVATE KEY/);
});

test("nono: ~/.ssh is kernel-denied", { skip: SKIP || !existsSync(join(homedir(), ".ssh")) }, () => {
  const sshDir = join(homedir(), ".ssh");
  const r = confined(["/bin/ls", sshDir]);
  assertKernelDenied(r, sshDir);
  assert.equal(r.stdout.trim(), "", `~/.ssh listing leaked: ${r.stdout}`);
});

test("nono: --open-port reaches localhost TCP (the vault-proxy seam)", { skip: SKIP }, async () => {
  const server = createServer((c) => { c.on("error", () => {}); c.end("vault-proxy-hello"); });
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  const { port } = server.address();
  try {
    const r = await confinedAsync([
      process.execPath, "-e",
      `const c=require("net").connect(${port},"127.0.0.1");` +
      'c.on("data",d=>{process.stdout.write(d.toString());process.exit(0)});' +
      'c.on("error",e=>{console.error(e.code);process.exit(1)});',
    ], ["--open-port", String(port)]);
    assert.equal(r.status, 0, `localhost connect failed: ${r.stderr}`);
    assert.match(r.stdout, /vault-proxy-hello/);
  } finally {
    server.close();
  }
});

test("nono: --allow-unix-socket reaches the UDS seam", { skip: SKIP }, async () => {
  // sun_path caps at ~104 bytes on macOS — keep the socket path short.
  const sockDir = mkdtempSync(join(realpathSync(tmpdir()), "nono-uds-"));
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
    ], ["--allow-unix-socket", sock]);
    assert.equal(r.status, 0, `unix-socket connect failed: ${r.stderr}`);
    assert.match(r.stdout, /uds-hello/);
  } finally {
    server.close();
    rmSync(sockDir, { recursive: true, force: true });
  }
});

test("nono: --block-net kernel-denies external connects (EPERM before any packet)", { skip: SKIP }, () => {
  const r = confined([
    process.execPath, "-e",
    'const c=require("net").connect(443,"1.1.1.1");' +
    'c.setTimeout(5000,()=>{console.error("TIMEOUT");process.exit(3)});' +
    'c.on("connect",()=>{console.error("CONNECTED");process.exit(2)});' +
    'c.on("error",e=>{console.error("code="+e.code);process.exit(e.code==="EPERM"||e.code==="EACCES"?0:1)});',
  ]);
  assert.equal(r.status, 0, `expected synchronous EPERM/EACCES on external connect; got: ${r.stderr}`);
  assert.match(r.stderr, /code=(EPERM|EACCES)/);
});

test.after(() => {
  if (workdir) rmSync(workdir, { recursive: true, force: true });
  if (decoy) rmSync(decoy, { force: true });
});
