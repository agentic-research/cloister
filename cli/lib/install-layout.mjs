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
  return {
    checkoutRoot: root,
    binDir,
    cliLink: join(binDir, "cloister"),
    libexecDir,
    providerRecord: join(libexecDir, "runtime-provider.json"),
    nativeHelper: join(libexecDir, "cloister-harness"),
    hostRuntime: join(libexecDir, "cloister-host-runtime"),
  };
}
