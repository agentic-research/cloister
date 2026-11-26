// SPDX-License-Identifier: AGPL-3.0-or-later
//
// gen/facts-sources.mjs fetches the source of every vendored facts projection
// at the release the projection records. What it fetches runs only in CI's
// facts-checked job (it needs the network and OpenTofu); this holds the parts
// that decide what to fetch, against the shipped projections.

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { download, fetchSources, planSources, providersConfig, readVendored, SPEC_DIR } from "../facts-sources.mjs";

const spec = (file, fields) => ({ file, spec: fields });
const noWait = async () => {};

test("every shipped projection has a source, at the release it records", () => {
  const vendored = readVendored();
  // Every file in the directory, so a projection added there is planned or refused.
  assert.deepEqual(vendored.map((v) => v.file), readdirSync(SPEC_DIR).filter((f) => f.endsWith(".json")).sort());
  const { objects, providers } = planSources(vendored);
  const version = (file) => vendored.find((v) => v.file === file).spec.version;
  assert.deepEqual(
    objects.flatMap(({ version: v, source }) => source.files.map((f) => source.url(v, f))),
    [
      `https://raw.githubusercontent.com/knative/serving/knative-v${version("knative-serving.schema.json")}/config/core/300-resources/service.yaml`,
      ...["api__v1_openapi.json", "apis__apps__v1_openapi.json", "apis__batch__v1_openapi.json"].map(
        (f) => `https://raw.githubusercontent.com/kubernetes/kubernetes/v${version("kubernetes-api.schema.json")}/api/openapi-spec/v3/${f}`,
      ),
    ],
  );
  assert.deepEqual(providers.map((p) => p.file), ["cloudflare.schema.json", "google.schema.json", "kubernetes.schema.json"]);
  // Kubernetes' documents are fetched once for both files built from them.
  assert.deepEqual(objects.map((o) => o.files), [["knative-serving.schema.json"], ["kubernetes-api.schema.json", "kubernetes-object-meta.schema.json"]]);
  assert.equal(objects.flatMap((o) => o.files).length + providers.length, vendored.length);
});

test("files built from one API's documents are of one release", () => {
  assert.throws(
    () => planSources([spec("a.json", { api: "kubernetes", version: "1.37.0" }), spec("b.json", { api: "kubernetes", version: "1.36.0" })]),
    /b\.json records kubernetes 1\.36\.0, and a\.json records 1\.37\.0: projections of one API are of one release/,
  );
});

test("each provider is installed at exactly the version its projection records", () => {
  const { providers } = planSources(readVendored());
  const config = providersConfig(providers);
  for (const { file, spec: s } of readVendored().filter((v) => v.spec.provider)) {
    assert.ok(config.includes(`${s.provider.split("/")[1]} = { source = "${s.provider}", version = "${s.version}" }`), file);
  }
  assert.equal(
    providersConfig([{ file: "a.json", provider: "cloudflare/cloudflare", version: "5.29.0" }]),
    'terraform {\n  required_providers {\n    cloudflare = { source = "cloudflare/cloudflare", version = "5.29.0" }\n  }\n}\n',
  );
  // Two providers of one type would need two local names this does not invent.
  assert.throws(
    () => providersConfig([{ file: "a.json", provider: "one/thing", version: "1.0.0" }, { file: "b.json", provider: "two/thing", version: "1.0.0" }]),
    /b\.json and a\.json both name a provider called thing/,
  );
});

test("a projection whose source cannot be named is refused, not left unchecked", () => {
  assert.throws(() => planSources([spec("gizmo.schema.json", { api: "gizmos", version: "1.0.0" })]), /gizmo\.schema\.json is a projection of the gizmos API, and OBJECT_SOURCES does not say where gizmos publishes/);
  assert.throws(() => planSources([spec("x.json", { version: "1.0.0" })]), /x\.json is neither an object projection \(api\) nor a provider projection \(provider\)/);
  assert.throws(() => planSources([spec("x.json", { api: "kubernetes", provider: "a/b", version: "1.0.0" })]), /neither/);
  for (const version of [undefined, "latest", "v1.0.0", "1.0", "1.0.0-rc.1"]) {
    assert.throws(() => planSources([spec("x.json", { api: "kubernetes", version })]), /x\.json records no release version/);
  }
  for (const provider of ["registry.opentofu.org/a/b", "a", "a/b/c", "A/b", 'a/b" }']) {
    assert.throws(() => planSources([spec("p.json", { provider, version: "1.0.0" })]), /is not <namespace>\/<type>/);
  }
});

test("a fetch is tried again only when trying again could help", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "facts-sources-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "doc");
  const responses = (...rs) => {
    const calls = [];
    return { calls, fetchImpl: async (url) => { calls.push(url); const r = rs[calls.length - 1]; if (r instanceof Error) throw r; return r; } };
  };
  const ok = (body) => ({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(body).buffer });
  const status = (code, text) => ({ ok: false, status: code, statusText: text });

  // A refusal that says the file is not there is final.
  let r = responses(status(404, "Not Found"));
  await assert.rejects(download("https://x/doc", file, { fetchImpl: r.fetchImpl, wait: noWait }), /could not fetch https:\/\/x\/doc: 404 Not Found/);
  assert.equal(r.calls.length, 1);

  // A dropped connection, a server error and a rate limit are tried again.
  r = responses(new Error("socket hang up"), status(503, "Service Unavailable"), ok("body"));
  await download("https://x/doc", file, { fetchImpl: r.fetchImpl, wait: noWait });
  assert.equal(r.calls.length, 3);
  assert.equal(readFileSync(file, "utf8"), "body");

  // Three times, then the last failure is what is reported.
  r = responses(status(429, "Too Many Requests"), status(502, "Bad Gateway"), new Error("ECONNRESET"), ok("never"));
  await assert.rejects(download("https://x/doc", file, { fetchImpl: r.fetchImpl, wait: noWait }), /could not fetch https:\/\/x\/doc: ECONNRESET/);
  assert.equal(r.calls.length, 3);
});

test("object sources are written where the tests read them, and named by the variables they read", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "facts-sources-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const vendored = readVendored().filter((v) => v.spec.api);
  const fetched = [];
  const fetchImpl = async (url) => {
    fetched.push(url);
    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(url).buffer };
  };
  const env = await fetchSources(dir, { vendored, fetchImpl, wait: noWait });
  assert.deepEqual(Object.keys(env).sort(), ["FACTS_KNATIVE_SERVICE_CRD", "FACTS_KUBERNETES_OPENAPI"]);
  assert.equal(readFileSync(env.FACTS_KNATIVE_SERVICE_CRD, "utf8"), fetched.find((u) => u.endsWith("/service.yaml")));
  for (const f of ["api__v1_openapi.json", "apis__apps__v1_openapi.json", "apis__batch__v1_openapi.json"]) {
    assert.equal(readFileSync(join(env.FACTS_KUBERNETES_OPENAPI, f), "utf8"), fetched.find((u) => u.endsWith(`/${f}`)));
  }
  assert.equal(fetched.length, 4);
});
