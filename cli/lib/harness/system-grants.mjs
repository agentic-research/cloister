// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { join } from "node:path";

/** Return only the system paths that belong to this OS and exist now. */
export function systemGrants({
  platform = osPlatform(),
  home = homedir(),
  pathExists = existsSync,
} = {}) {
  // nono's library does not seed the CLI's system groups. These are the
  // loader/tool paths a child process needs before any workspace grant matters.
  const commonRead = [
    "/bin", "/usr/bin", "/usr/sbin", "/usr/local/bin",
    "/usr/lib", "/usr/local/lib", "/usr/share", "/opt",
    join(home, ".local/bin"), join(home, ".local/share"),
    join(home, ".config/git"),
  ];
  const commonFiles = [join(home, ".gitconfig"), join(home, ".gitignore_global")];

  let readDirectories;
  let readWriteDirectories;
  if (platform === "darwin") {
    // Measured macOS loader paths plus the root-level symlinks used by Apple's
    // git/Xcode shims. Granting only /private/var and /private/etc is not enough.
    readDirectories = [
      ...commonRead,
      "/System/Library", "/Library", "/Library/Frameworks",
      "/private/var/db", "/private/etc", "/private/var", "/private",
      "/System/Volumes", "/System/Cryptexes", "/opt/homebrew", "/var", "/etc",
    ];
    readWriteDirectories = ["/dev", "/private/var/folders"];
  } else if (platform === "linux") {
    // Debian's dynamic loader lives under /lib. Runtimes commonly inspect
    // /proc. Neither is a macOS system path.
    readDirectories = [...commonRead, "/lib", "/lib64", "/etc", "/proc"];
    readWriteDirectories = ["/dev"];
  } else {
    readDirectories = commonRead;
    readWriteDirectories = ["/dev"];
  }

  // CapabilityManifest -> CapabilitySet rejects a typed grant whose path is
  // absent. A portable policy must not name the other operating system's tree,
  // or optional user config that is not installed on this machine.
  /** @param {string[]} paths */
  const existing = (paths) => [...new Set(paths)].filter((path) => pathExists(path));
  return {
    readDirectories: existing(readDirectories),
    readWriteDirectories: existing(readWriteDirectories),
    readFiles: existing(commonFiles),
  };
}
