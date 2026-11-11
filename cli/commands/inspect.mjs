// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `cloister inspect --terraform <file>`: read a rendered Terraform/OpenTofu
// document and report what it describes beside what cluster.toml declares
// (ADR-0073). Read-only: it runs no tool and writes nothing.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { parseTomlToCluster } from "../lib/cluster/toml-to-cluster.mjs";
import { importFacts } from "../lib/facts/import.mjs";
import { buildReport, renderReport } from "../lib/facts/report.mjs";

export class InspectUsageError extends Error {}

export function parseArgs(argv) {
  const opts = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new InspectUsageError(`${arg} requires a value`);
      i += 1;
      return next;
    };
    if (arg === "--terraform") opts.terraform = value();
    else if (arg === "--dir") opts.dir = value();
    else if (arg === "--json") opts.json = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new InspectUsageError(`unknown argument: ${arg}`);
  }
  if (!opts.help && !opts.terraform) {
    throw new InspectUsageError("--terraform <file> is required (the output of `terraform show -json`)");
  }
  return opts;
}

/**
 * True when git tracks `file`. A rendered state or plan prints every secret
 * it holds in plain text, so a tracked copy is a leak already made or about to
 * be. Not being in a repository, or git being absent, is not tracked.
 */
export function isGitTracked(file, spawn = spawnSync) {
  const result = spawn("git", ["ls-files", "--error-unmatch", "--", basename(file)], {
    cwd: dirname(file),
    stdio: "ignore",
  });
  return result.status === 0;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const log = deps.log ?? console.log;
  const errLog = deps.errLog ?? console.error;
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    if (error instanceof InspectUsageError) {
      errLog(`cloister inspect: ${error.message}`);
      return 2;
    }
    throw error;
  }
  if (opts.help) {
    log("Usage: cloister inspect --terraform <file> [--dir <path>] [--json]");
    return 0;
  }

  const file = resolve(opts.terraform);
  if (!existsSync(file)) {
    errLog(`cloister inspect: no such file: ${opts.terraform}`);
    return 2;
  }
  if ((deps.isGitTracked ?? isGitTracked)(file)) {
    errLog(
      `cloister inspect: ${opts.terraform} is tracked by git. A rendered Terraform document ` +
        "prints secrets in plain text, so it must not be committed. Remove it from the " +
        "repository (and rotate anything it exposed), then pass an untracked copy.",
    );
    return 2;
  }

  try {
    const imported = importFacts(JSON.parse(readFileSync(file, "utf8")));
    let cluster;
    const dir = resolve(opts.dir ?? ".");
    const clusterPath = join(dir, "cluster.toml");
    if (existsSync(clusterPath)) {
      cluster = await parseTomlToCluster(readFileSync(clusterPath, "utf8"));
    } else if (opts.dir) {
      errLog(`cloister inspect: no cluster.toml in ${opts.dir}`);
      return 2;
    }
    const report = buildReport(imported, cluster);
    log(opts.json ? JSON.stringify(report, null, 2) : renderReport(report));
    return 0;
  } catch (error) {
    errLog(`cloister inspect: ${error.message}`);
    return 1;
  }
}
