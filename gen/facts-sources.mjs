#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// facts-sources — fetch the source of every vendored facts projection
// (cli/lib/facts/spec/), so the projections can be rebuilt from them and
// compared byte for byte.
//
// Those comparisons live in cli/test/facts and skip without their sources, so
// every gate skipped them, and a provider projection carried a provider
// version it was not built from. CI's facts-checked job runs this with
// `--check`, under which a missing source fails instead of skipping.
//
// Each projection records the release it was built from (`version`), and that
// is the only place the version is stated. This fetches that release:
//
//   an object projection (`api`)        the documents the API publishes at
//                                       that release (OBJECT_SOURCES)
//   a provider projection (`provider`)  `tofu providers schema -json`, with
//                                       each provider at exactly its version
//
// No digest is pinned for a source: the committed projection is the pin.
// What is fetched is checked by rebuilding the projection from it, so a tag
// moved to other content fails the comparison.
//
// Usage: node gen/facts-sources.mjs <dir>    fetch into <dir>, and print the
//                                            variables the tests read
//        node gen/facts-sources.mjs --check  fetch into a temporary directory
//                                            and run the facts tests with them
//
// The providers need OpenTofu: `tofu` on PATH, or TOFU=<path>.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SPEC_DIR = join(ROOT, "cli/lib/facts/spec");

/**
 * Where each object API publishes the documents its projection is built
 * from, at a release, and the variable naming them for the tests.
 * `files` are the generator's inputs (gen/facts-spec.mjs).
 */
export const OBJECT_SOURCES = Object.freeze({
  kubernetes: Object.freeze({
    url: (version, file) => `https://raw.githubusercontent.com/kubernetes/kubernetes/v${version}/api/openapi-spec/v3/${file}`,
    files: Object.freeze(["api__v1_openapi.json", "apis__apps__v1_openapi.json", "apis__batch__v1_openapi.json"]),
    env: (dir) => ({ FACTS_KUBERNETES_OPENAPI: dir }),
  }),
  "knative-serving": Object.freeze({
    url: (version, file) => `https://raw.githubusercontent.com/knative/serving/knative-v${version}/config/core/300-resources/${file}`,
    files: Object.freeze(["service.yaml"]),
    env: (dir) => ({ FACTS_KNATIVE_SERVICE_CRD: join(dir, "service.yaml") }),
  }),
});

const VERSION = /^\d+\.\d+\.\d+$/;
const PROVIDER = /^[a-z0-9-]+\/[a-z0-9-]+$/;

/** Every vendored projection, by file name. */
export function readVendored(dir = SPEC_DIR) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => ({ file, spec: JSON.parse(readFileSync(join(dir, file), "utf8")) }));
}

/**
 * What to fetch for the projections: each object API's documents at the
 * release its projection records, and the providers. Refuses a projection
 * whose source it cannot name, so a projection added without one fails here
 * rather than going unchecked.
 */
export function planSources(vendored) {
  const objects = [];
  const providers = [];
  for (const { file, spec } of vendored) {
    if (!VERSION.test(spec.version ?? "")) throw new Error(`${file} records no release version (${JSON.stringify(spec.version)})`);
    if (typeof spec.api === "string" && spec.provider === undefined) {
      const source = OBJECT_SOURCES[spec.api];
      if (!source) throw new Error(`${file} is a projection of the ${spec.api} API, and OBJECT_SOURCES does not say where ${spec.api} publishes its documents`);
      // Several files may be built from one API's documents (Kubernetes'
      // kinds, and ObjectMeta's schema). They are fetched once, so they must
      // be of one release.
      const same = objects.find((o) => o.api === spec.api);
      if (same && same.version !== spec.version) {
        throw new Error(`${file} records ${spec.api} ${spec.version}, and ${same.files[0]} records ${same.version}: projections of one API are of one release`);
      }
      if (same) same.files.push(file);
      else objects.push({ files: [file], api: spec.api, version: spec.version, source });
    } else if (typeof spec.provider === "string" && spec.api === undefined) {
      if (!PROVIDER.test(spec.provider)) throw new Error(`${file} names its provider ${JSON.stringify(spec.provider)}, which is not <namespace>/<type>`);
      providers.push({ file, provider: spec.provider, version: spec.version });
    } else {
      throw new Error(`${file} is neither an object projection (api) nor a provider projection (provider)`);
    }
  }
  return { objects, providers };
}

/** A configuration under which tofu installs each provider at exactly the version its projection records. */
export function providersConfig(providers) {
  const names = new Map();
  for (const { file, provider } of providers) {
    const name = provider.split("/")[1];
    if (names.has(name)) throw new Error(`${file} and ${names.get(name)} both name a provider called ${name}`);
    names.set(name, file);
  }
  const rows = providers.map(({ provider, version }) => `    ${provider.split("/")[1]} = { source = "${provider}", version = "${version}" }`);
  return `terraform {\n  required_providers {\n${rows.join("\n")}\n  }\n}\n`;
}

/**
 * Fetch `url` into `file`. A dropped connection, a server error or a rate
 * limit is tried again, twice; any other refusal is final.
 */
export async function download(url, file, { fetchImpl = fetch, wait = (ms) => new Promise((done) => setTimeout(done, ms)) } = {}) {
  let failure;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await wait(2000 * attempt);
    let bytes;
    try {
      const res = await fetchImpl(url);
      if (!res.ok) {
        failure = `${res.status} ${res.statusText ?? ""}`.trim();
        if (res.status < 500 && res.status !== 429) break;
        continue;
      }
      bytes = Buffer.from(await res.arrayBuffer());
    } catch (error) {
      failure = error.message;
      continue;
    }
    writeFileSync(file, bytes);
    return;
  }
  throw new Error(`could not fetch ${url}: ${failure}`);
}

function tofu(args, cwd, stdout) {
  const bin = process.env.TOFU || "tofu";
  // tofu's progress goes to stderr: stdout may be the variables this prints.
  const result = spawnSync(bin, args, { cwd, encoding: "utf8", maxBuffer: 1 << 30, stdio: ["ignore", stdout ? "pipe" : 2, 2] });
  if (result.error) throw new Error(`could not run ${bin}: ${result.error.message}. Install OpenTofu, or name it with TOFU=<path>`);
  if (result.status !== 0) throw new Error(`${bin} ${args.join(" ")} exited ${result.status}`);
  return result.stdout;
}

/**
 * Fetch every source into `dir`. Returns the variables the tests read, each
 * naming what was written.
 */
export async function fetchSources(dir, { vendored = readVendored(), fetchImpl = fetch, wait } = {}) {
  const { objects, providers } = planSources(vendored);
  const env = {};
  for (const { api, version, source } of objects) {
    const into = join(dir, api);
    mkdirSync(into, { recursive: true });
    for (const name of source.files) {
      const url = source.url(version, name);
      console.error(`facts-sources: ${url}`);
      await download(url, join(into, name), { fetchImpl, wait });
    }
    Object.assign(env, source.env(into));
  }
  if (providers.length) {
    const work = join(dir, "providers");
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, "main.tf"), providersConfig(providers));
    console.error(`facts-sources: ${providers.map((p) => `${p.provider} ${p.version}`).join(", ")}`);
    tofu(["init", "-input=false", "-no-color"], work, false);
    const schema = join(dir, "providers-schema.json");
    writeFileSync(schema, tofu(["providers", "schema", "-json"], work, true));
    env.FACTS_PROVIDERS_SCHEMA = schema;
  }
  return env;
}

async function main(args) {
  const check = args.length === 1 && args[0] === "--check";
  if (!check && (args.length !== 1 || args[0].startsWith("-"))) {
    console.error("usage: node gen/facts-sources.mjs <dir> | --check");
    return 2;
  }
  const dir = check ? mkdtempSync(join(tmpdir(), "facts-sources-")) : resolve(args[0]);
  try {
    mkdirSync(dir, { recursive: true });
    const env = await fetchSources(dir);
    if (!check) {
      for (const [name, value] of Object.entries(env)) console.log(`${name}=${value}`);
      return 0;
    }
    // Every facts test, not only the ones that read a source, so a check that
    // moves between files still runs here.
    const run = spawnSync(process.execPath, ["--test", "cli/test/facts/*.test.mjs"], {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, ...env, FACTS_SOURCES_REQUIRED: "1" },
    });
    return run.status ?? 1;
  } finally {
    if (check) rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`facts-sources: ${error.message}`);
      process.exit(1);
    },
  );
}
