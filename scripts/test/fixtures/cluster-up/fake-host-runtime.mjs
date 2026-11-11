// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A stand-in for `cloister-host-runtime run --stop-on-stdin-eof <plan>` used by
// scripts/test/cluster-up-process.test.mjs (cloister-991e65). Real process,
// real signals, real stdin pipe — no VM. Behaviour per bundle from env:
//   FAKE_<BUNDLE>      ok | slow-bind | never-bind | bind-then-die | ignore-term
//                      | split-line-then-die (bind, write ONE stderr line in
//                        several small writes, exit 1)
//                      | echo (bind REAL unix sockets that echo every byte
//                        back, standing in for a guest service behind its
//                        §6 bind channel — cloister-991e65 edge relay)
//   FAKE_STOP_MS       delay between SIGTERM and exiting 143 (default 0)
//   FAKE_BIND_MS / FAKE_DIE_MS  delays for slow-bind / bind-then-die
//   FAKE_LOG           file; one "<bundle> <pid> <event>" line per event

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";

const [, , verb, flag, planPath] = process.argv;
if (verb !== "run" || flag !== "--stop-on-stdin-eof") {
  console.error(`fake host runtime: unexpected argv ${process.argv.slice(2).join(" ")}`);
  process.exit(2);
}
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const bundle = plan.bundle;
const mode = process.env[`FAKE_${bundle.toUpperCase()}`] ?? "ok";
const event = (what) => appendFileSync(process.env.FAKE_LOG, `${bundle} ${process.pid} ${what}\n`);
const binds = (plan.confinement?.unixSocket?.allow ?? []).filter((g) => g.mode === "bind").map((g) => g.path);
const bind = () => { for (const p of binds) writeFileSync(p, ""); event("bound"); };

event("start");
if (mode === "ok" || mode === "ignore-term") bind();
if (mode === "echo") {
  let left = binds.length;
  for (const p of binds) {
    createServer((c) => c.pipe(c)).listen(p, () => { left -= 1; if (left === 0) event("bound"); });
  }
}
if (mode === "slow-bind") setTimeout(bind, Number(process.env.FAKE_BIND_MS ?? 300));
if (mode === "bind-then-die") {
  bind();
  setTimeout(() => { event("die"); process.exit(1); }, Number(process.env.FAKE_DIE_MS ?? 300));
}

if (mode === "split-line-then-die") {
  bind();
  const pieces = ["cloister-host-runtime:   ", "| seed: data", "base did not ", "answer\n", "cloister-host-runtime: the workload ran and failed"];
  let i = 0;
  const next = () => {
    if (i < pieces.length) { process.stderr.write(pieces[i++]); setTimeout(next, 30); return; }
    event("die");
    process.exit(1);
  };
  setTimeout(next, 100);
}

process.on("SIGTERM", () => {
  event("term");
  if (mode === "ignore-term") return;
  setTimeout(() => { event("exit"); process.exit(143); }, Number(process.env.FAKE_STOP_MS ?? 0));
});
// The supervisor's end of stdin closes only when it is gone.
process.stdin.on("end", () => { event("eof"); process.exit(143); });
process.stdin.resume();
setInterval(() => {}, 1 << 30);
