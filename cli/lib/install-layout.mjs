// SPDX-License-Identifier: AGPL-3.0-or-later

import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function resolveInstallLayout({
  env = process.env,
  home = homedir(),
  checkoutRoot = process.cwd(),
} = {}) {
  const root = resolve(checkoutRoot);
  const binDir = resolve(env.CLOISTER_BIN_DIR || join(home, ".local", "bin"));
  const libexecDir = resolve(
    env.CLOISTER_LIBEXEC_DIR || join(home, ".local", "libexec", "cloister"),
  );
  // Mutable runtime state (cloister-991e65): the content store the microVM tier
  // reads rootfs trees from, and the per-run ephemeral roots LLO creates and
  // removes. XDG state, not libexec — these are written at run time.
  const stateDir = resolve(
    env.CLOISTER_STATE_DIR || join(home, ".local", "state", "cloister"),
  );
  return {
    checkoutRoot: root,
    binDir,
    cliLink: join(binDir, "cloister"),
    libexecDir,
    providerRecord: join(libexecDir, "runtime-provider.json"),
    nativeHelper: join(libexecDir, "cloister-harness"),
    hostRuntime: join(libexecDir, "cloister-host-runtime"),
    krunWorker: join(libexecDir, "leyline-krun-worker"),
    stateDir,
    casRoot: join(stateDir, "cas"),
    runRoot: join(stateDir, "run"),
  };
}
