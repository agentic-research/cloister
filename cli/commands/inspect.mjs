// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `cloister inspect --terraform <file> --wrangler <file>`: read a rendered
// Terraform/OpenTofu document and/or wrangler configs and report what they
// describe beside what cluster.toml declares (ADR-0073). Read-only: it runs no
// tool and writes nothing.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { parseTomlToCluster } from "../lib/cluster/toml-to-cluster.mjs";
import { draftCluster } from "../lib/facts/draft.mjs";
import { importFacts } from "../lib/facts/import.mjs";
import { buildReport, renderReport } from "../lib/facts/report.mjs";
import { importWrangler } from "../lib/facts/wrangler.mjs";

export class InspectUsageError extends Error {}

/**
 * The finding kinds `--fail-on` may name. `evidenced` is not one: it is the
 * answer a check wants.
 */
export const FAIL_ON_KINDS = ["undeclared", "contradicted", "unknown"];

/**
 * The exit code when a finding of a `--fail-on` kind is reported. Distinct
 * from 1 (the check could not run) and 2 (it was called wrongly), so a CI job
 * can tell "the plan disagrees" from "the checker broke".
 */
export const EXIT_FINDINGS = 3;

export function parseArgs(argv) {
  const opts = { json: false, wrangler: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new InspectUsageError(`${arg} requires a value`);
      i += 1;
      return next;
    };
    if (arg === "--terraform") opts.terraform = value();
    else if (arg === "--wrangler") opts.wrangler.push(value());
    else if (arg === "--dir") opts.dir = value();
    else if (arg === "--env") opts.env = value();
    else if (arg === "--json") opts.json = true;
    else if (arg === "--draft") opts.draft = true;
    else if (arg === "--name") opts.name = value();
    else if (arg === "--local") opts.local = value();
    else if (arg === "--local-kind") opts.localKind = value();
    else if (arg === "--fail-on") opts.failOn = parseFailOn(value());
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new InspectUsageError(`unknown argument: ${arg}`);
  }
  if (!opts.help && !opts.terraform && opts.wrangler.length === 0) {
    throw new InspectUsageError(
      "--terraform <file> (the output of `terraform show -json`) or --wrangler <file> is required",
    );
  }
  if (opts.draft && opts.failOn) throw new InspectUsageError("--fail-on checks a plan against cluster.toml; --draft writes one, so there is nothing to check");
  if (opts.draft) {
    if (!opts.terraform) throw new InspectUsageError("--draft needs --terraform <file>: a draft is written from a rendered plan or state");
    if (!opts.env) throw new InspectUsageError("--draft needs --env <name>: the environment its placements and connection targets are written for");
    if (opts.json) throw new InspectUsageError("--draft prints cluster.toml; it cannot be combined with --json");
    if (opts.local === opts.env) throw new InspectUsageError(`--local and --env are both "${opts.env}"; a second placement needs a second environment`);
    if (opts.localKind && !opts.local) throw new InspectUsageError("--local-kind needs --local <env>");
    if (opts.localKind && !["kubernetes", "knative"].includes(opts.localKind)) throw new InspectUsageError(`--local-kind "${opts.localKind}" is not one of kubernetes, knative`);
  } else if (opts.name || opts.local || opts.localKind) {
    throw new InspectUsageError(`${opts.name ? "--name" : opts.local ? "--local" : "--local-kind"} is only used with --draft`);
  }
  return opts;
}

function parseFailOn(text) {
  const kinds = text.split(",").map((k) => k.trim()).filter(Boolean);
  if (kinds.length === 0) throw new InspectUsageError(`--fail-on needs one or more of ${FAIL_ON_KINDS.join(", ")}`);
  for (const kind of kinds) {
    if (!FAIL_ON_KINDS.includes(kind)) throw new InspectUsageError(`--fail-on "${kind}" is not one of ${FAIL_ON_KINDS.join(", ")}`);
  }
  return [...new Set(kinds)];
}

/**
 * True when git tracks `file`. A rendered state or plan prints every secret
 * it holds in plain text, so a tracked copy is a leak already made or about to
 * be. Not being in a repository, or git being absent, is not tracked.
 */
export function isGitTracked(file, spawn = spawnSync, env = process.env) {
  const result = spawn("git", ["ls-files", "--error-unmatch", "--", basename(file)], {
    cwd: dirname(file),
    stdio: "ignore",
    env: withoutGitEnv(env),
  });
  return result.status === 0;
}

/**
 * `env` without git's own variables. Inside a git hook, git exports GIT_DIR
 * and GIT_INDEX_FILE, and with those set `cwd` no longer chooses the
 * repository: the question would be answered for the hook's repository, not
 * the file's, and a tracked document could be reported untracked
 * (cloister-10804d). Every `GIT_*` variable is dropped rather than a listed
 * few, so nothing here has to track git's list.
 */
export function withoutGitEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("GIT_")));
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
    log("Usage: cloister inspect [--terraform <file>] [--wrangler <file>]... [--dir <path>] [--env <name>] [--json] [--fail-on <kinds>]\n       cloister inspect --terraform <file> --draft --env <name> [--local <env> [--local-kind kubernetes|knative]] [--name <cluster name>]");
    return 0;
  }

  const wranglerFiles = opts.wrangler.map((f) => resolve(f));
  for (const [i, file] of wranglerFiles.entries()) {
    if (!existsSync(file)) {
      errLog(`cloister inspect: no such file: ${opts.wrangler[i]}`);
      return 2;
    }
  }
  let file;
  if (opts.terraform) {
    file = resolve(opts.terraform);
    if (!existsSync(file)) {
      errLog(`cloister inspect: no such file: ${opts.terraform}`);
      return 2;
    }
    // Only the rendered Terraform document is refused when tracked: a wrangler
    // config is normally committed and holds no secrets this tool reads.
    // Check the path as given AND what it resolves to: a symlink in an untracked
  // directory can point at a tracked file.
  const tracked = deps.isGitTracked ?? isGitTracked;
  if (tracked(file) || tracked(realpathSync(file))) {
      errLog(
        `cloister inspect: ${opts.terraform} is tracked by git. A rendered Terraform document ` +
          "prints secrets in plain text, so it must not be committed. Remove it from the " +
          "repository (and rotate anything it exposed), then pass an untracked copy.",
      );
      return 2;
    }
  }

  try {
    const imported = file
      ? importFacts(JSON.parse(readFileSync(file, "utf8")))
      : { kind: null, formatVersion: null, facts: [], skipped: {} };
    for (const wranglerFile of wranglerFiles) imported.facts.push(importWrangler(wranglerFile));
    if (opts.draft) {
      // The draft is printed, never written: the operator chooses where it
      // goes, and an existing cluster.toml is not read and cannot be replaced.
      const draft = draftCluster(imported, { env: opts.env, name: opts.name, local: opts.local, localKind: opts.localKind });
      log(draft.toml);
      return 0;
    }
    let cluster;
    const dir = resolve(opts.dir ?? ".");
    const clusterPath = join(dir, "cluster.toml");
    if (existsSync(clusterPath)) {
      cluster = await parseTomlToCluster(readFileSync(clusterPath, "utf8"));
    } else if (opts.dir) {
      errLog(`cloister inspect: no cluster.toml in ${opts.dir}`);
      return 2;
    } else if (opts.failOn) {
      // Without a file there is nothing declared, so nothing could be
      // undeclared or contradicted: the check would pass having checked nothing.
      errLog(`cloister inspect: --fail-on needs a cluster.toml to check against, and there is none in ${dir}. Pass --dir`);
      return 2;
    }
    const report = buildReport(imported, cluster, { env: opts.env });
    log(opts.json ? JSON.stringify(report, null, 2) : renderReport(report));
    if (opts.failOn) {
      const failing = report.findings.filter((f) => opts.failOn.includes(f.kind));
      if (failing.length) {
        const counts = opts.failOn
          .map((kind) => [kind, failing.filter((f) => f.kind === kind).length])
          .filter(([, n]) => n > 0)
          .map(([kind, n]) => `${n} ${kind}`);
        errLog(`cloister inspect: ${counts.join(", ")} (--fail-on ${opts.failOn.join(",")})`);
        return EXIT_FINDINGS;
      }
    }
    return 0;
  } catch (error) {
    errLog(`cloister inspect: ${error.message}`);
    return 1;
  }
}
