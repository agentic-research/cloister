// SPDX-License-Identifier: AGPL-3.0-or-later

import { Chalk } from "chalk";

function hasEnv(env, name) {
  return Object.prototype.hasOwnProperty.call(env ?? {}, name);
}

function forcedLevel(env) {
  if (!hasEnv(env, "FORCE_COLOR")) return null;
  const raw = String(env.FORCE_COLOR ?? "").trim().toLowerCase();
  if (raw === "0" || raw === "false") return 0;
  if (raw === "" || raw === "true") return 1;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) ? Math.max(0, Math.min(3, parsed)) : 1;
}

function terminalLevel(stream) {
  if (!stream?.isTTY) return 0;
  const depth = typeof stream.getColorDepth === "function" ? stream.getColorDepth() : 4;
  if (depth >= 24) return 3;
  if (depth >= 8) return 2;
  return 1;
}

function resolveLevel({ stdout, env, colorMode, json }) {
  if (json || colorMode === "never") return 0;
  if (colorMode === "always") {
    return Math.max(1, forcedLevel(env) ?? 0, terminalLevel(stdout));
  }
  if (hasEnv(env, "NO_COLOR")) return 0;
  const forced = forcedLevel(env);
  if (forced !== null) return forced;
  return terminalLevel(stdout);
}

/** Build one per-invocation renderer; never mutate Chalk's process-global level. */
export function createOutputContext({
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env,
  colorMode = "auto",
  json = false,
} = {}) {
  const level = resolveLevel({ stdout, env, colorMode, json });
  const style = new Chalk({ level });
  return {
    colorEnabled: level > 0,
    json,
    style,
    log(value = "") { stdout.write(`${value}\n`); },
    warn(value = "") { stderr.write(`${value}\n`); },
    error(value = "") { stderr.write(`${value}\n`); },
  };
}
