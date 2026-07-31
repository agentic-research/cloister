// SPDX-License-Identifier: AGPL-3.0-or-later

const COLOR_MODES = new Set(["auto", "always", "never"]);

export class GlobalOptionsError extends Error {}

/**
 * Remove Cloister-wide flags before command dispatch. The first `--` is a hard
 * boundary: everything after it belongs to the launched tool and is preserved.
 */
export function parseGlobalOptions(argv, _env = process.env) {
  const clean = [];
  let colorMode = "auto";
  let explicitColor = false;
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (passthrough) {
      clean.push(token);
      continue;
    }
    if (token === "--") {
      passthrough = true;
      clean.push(token);
      continue;
    }
    if (token === "--no-color") {
      colorMode = "never";
      explicitColor = true;
      continue;
    }
    if (token === "--color") {
      const value = argv[index + 1];
      if (!COLOR_MODES.has(value)) {
        throw new GlobalOptionsError("--color requires one of: auto, always, never");
      }
      colorMode = value;
      explicitColor = true;
      index += 1;
      continue;
    }
    clean.push(token);
  }

  return { argv: clean, colorMode, explicitColor };
}
