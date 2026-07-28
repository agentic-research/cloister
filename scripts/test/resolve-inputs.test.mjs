// scripts/test/resolve-inputs.test.mjs
//
// Contract tests for scripts/resolve-inputs.mjs — ADR-0026 Phase 1b
// resolver + lockfile writer (cloister-cf7a3b).
//
// Run with:
//   pnpm exec tsx --test scripts/test/resolve-inputs.test.mjs
//
// Tests two surfaces:
//   - resolveInput(): per-spec file:// + https:// resolution, digest
//     pin verification, error shapes
//   - buildLockfile(): cluster.lock.toml document shape
//
// Synthesizes file:// fixtures in a tmpdir and mocks fetch() for
// network-shaped refs so tests don't depend on sockets or external
// services. No regex assertions per operator request — substring
// checks + structural deep-equals only.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  resolveInput,
  buildLockfile,
  parseGithubRef,
  githubRefToHttpsUrl,
  rewriteIoGithubOrgSugar,
  parseServerJsonMeta,
  deriveGeneratedBackends,
  deriveStripPrefix,
  parsePackagesOci,
  resolveOciDigest,
  deriveRequiresSession,
  declaredTransportTypes,
  udsSocketPath,
} from "../resolve-inputs.mjs";

function sha256hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function specDefaults(partial) {
  return {
    name:     partial.name ?? "test-input",
    ref:      partial.ref ?? "",
    version:  partial.version ?? "",
    digest:   partial.digest ?? "",
    from:     partial.from ?? "",
    provides: partial.provides ?? [],
    requires: partial.requires ?? [],
  };
}

// ── file:// resolver ─────────────────────────────────────────────────────

test("resolveInput: file:// — happy path returns resolved row with sha256", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "resolve-file-"));
  try {
    const path = resolve(dir, "payload.bin");
    const payload = Buffer.from("hello cloister inputs");
    writeFileSync(path, payload);

    const row = await resolveInput(specDefaults({
      name:    "alpha",
      ref:     `file://${path}`,
      version: "0.1.0",
    }));

    assert.equal(row.name, "alpha");
    assert.equal(row.ref, `file://${path}`);
    assert.equal(row.resolved, "0.1.0");
    assert.equal(row.sha256, `sha256:${sha256hex(payload)}`);
    assert.equal(row.fetched_from, `file://${path}`);
    assert.equal(row.signer, "");
    assert.equal(row.bytes, payload.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveInput: file:// — missing file errors with the path", async () => {
  await assert.rejects(
    () => resolveInput(specDefaults({ name: "missing", ref: "file:///does/not/exist" })),
    (err) => err.inputName === "missing" && err.detail.includes("file not found"),
  );
});

test("resolveInput: `from` (dev-loop override) wins over `ref`", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "resolve-from-"));
  try {
    const path = resolve(dir, "dev.bin");
    writeFileSync(path, Buffer.from("dev-loop content"));

    const row = await resolveInput(specDefaults({
      name: "alpha",
      ref:  "https://example.com/should-be-ignored",
      from: `file://${path}`,
    }));

    assert.equal(row.fetched_from, `file://${path}`, "from must take precedence over ref");
    assert.equal(row.bytes, "dev-loop content".length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── https:// resolver ────────────────────────────────────────────────────

test("resolveInput: https:// — happy path fetches + hashes", async () => {
  const payload = Buffer.from("https-fetched content");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(url, "https://example.com/server.json");
    return new Response(payload, { status: 200, statusText: "OK" });
  };

  try {
    const row = await resolveInput(specDefaults({
      name: "remote",
      ref: "https://example.com/server.json",
      version: "1.2.3",
    }));

    assert.equal(row.name, "remote");
    assert.equal(row.ref, "https://example.com/server.json");
    assert.equal(row.resolved, "1.2.3");
    assert.equal(row.fetched_from, "https://example.com/server.json");
    assert.equal(row.bytes, payload.length);
    assert.equal(row.sha256, `sha256:${sha256hex(payload)}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resolveInput: http:// (unencrypted) is rejected with explicit error", async () => {
  await assert.rejects(
    () => resolveInput(specDefaults({ name: "insecure", ref: "http://example.com/foo" })),
    (err) => err.inputName === "insecure" && err.detail.includes("https://"),
  );
});

// ── digest pin (defense-in-depth) ────────────────────────────────────────

test("resolveInput: digest pin MATCH passes through", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "resolve-digest-ok-"));
  try {
    const path = resolve(dir, "pinned.bin");
    const payload = Buffer.from("pinned content");
    writeFileSync(path, payload);
    const pin = sha256hex(payload);

    const row = await resolveInput(specDefaults({
      name:   "pinned",
      ref:    `file://${path}`,
      digest: `sha256:${pin}`,
    }));
    assert.equal(row.sha256, `sha256:${pin}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveInput: digest pin MISMATCH fails loudly (tamper defense)", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "resolve-digest-bad-"));
  try {
    const path = resolve(dir, "tampered.bin");
    writeFileSync(path, Buffer.from("real content"));

    await assert.rejects(
      () => resolveInput(specDefaults({
        name:   "tampered",
        ref:    `file://${path}`,
        digest: "sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      })),
      (err) => err.detail.includes("digest mismatch"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveInput: digest pin accepts the bare-hex form (no sha256: prefix)", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "resolve-digest-bare-"));
  try {
    const path = resolve(dir, "bare.bin");
    const payload = Buffer.from("bare digest content");
    writeFileSync(path, payload);
    const pin = sha256hex(payload);

    const row = await resolveInput(specDefaults({
      name:   "bare",
      ref:    `file://${path}`,
      digest: pin, // No sha256: prefix
    }));
    assert.equal(row.sha256, `sha256:${pin}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── unsupported scheme ───────────────────────────────────────────────────

test("resolveInput: unsupported scheme errors and lists the supported set", async () => {
  // A truly-unsupported scheme (not file/https/github/io.github.org).
  // The error message must enumerate every supported scheme so the
  // operator can see what they have today.
  await assert.rejects(
    () => resolveInput(specDefaults({ name: "future", ref: "registry+npm://acme/tool" })),
    (err) => err.detail.includes("unsupported")
      && err.detail.includes("file://")
      && err.detail.includes("https://")
      && err.detail.includes("github://")
      && err.detail.includes("io.github.org/"),
  );
});

test("resolveInput: empty ref + empty from errors with explicit message", async () => {
  await assert.rejects(
    () => resolveInput(specDefaults({ name: "empty" })),
    (err) => err.detail.includes("neither"),
  );
});

// ── buildLockfile shape ──────────────────────────────────────────────────

test("buildLockfile: produces canonical document with schema marker + per-input rows", () => {
  const metadata = { name: "test-cluster", version: "0.1.0" };
  const inputs = [
    {
      name: "alpha", ref: "file:///foo", resolved: "0.1.0",
      sha256: "sha256:abc", fetched_from: "file:///foo", signer: "", bytes: 42,
    },
    {
      name: "beta", ref: "https://x/y", resolved: "^1.0",
      sha256: "sha256:def", fetched_from: "https://x/y", signer: "", bytes: 100,
    },
  ];

  const doc = buildLockfile(metadata, inputs);

  assert.equal(doc.schema, "cloister/lockfile/v1");
  assert.equal(doc.cluster, "test-cluster");
  assert.equal(doc.version, "0.1.0");
  assert.ok(doc._comment.includes("ADR-0026 Phase 1b"), "comment must cite the ADR + phase");

  // Per-input rows present + carry the right fields.
  assert.deepEqual(Object.keys(doc.inputs).sort(), ["alpha", "beta"]);
  assert.equal(doc.inputs.alpha.sha256, "sha256:abc");
  assert.equal(doc.inputs.alpha.bytes, 42);
  assert.equal(doc.inputs.beta.fetched_from, "https://x/y");
  assert.equal(doc.inputs.beta.signer, "", "Phase 3 will populate; Phase 1b leaves empty");
});

test("buildLockfile: empty inputs[] produces a doc with empty inputs table (still valid)", () => {
  const doc = buildLockfile({ name: "empty", version: "0.0.1" }, []);
  assert.equal(doc.cluster, "empty");
  assert.deepEqual(doc.inputs, {}, "empty inputs table is valid");
});

// ── github:// scheme — parseGithubRef (cloister-5f5aee) ──────────────────

test("parseGithubRef: whole-repo at a branch", () => {
  assert.deepEqual(
    parseGithubRef("github://anthropic/skills@main"),
    { owner: "anthropic", repo: "skills", path: "", gitRef: "main" },
  );
});

test("parseGithubRef: whole-repo at a SHA", () => {
  assert.deepEqual(
    parseGithubRef("github://anthropic/skills@abc123def456"),
    { owner: "anthropic", repo: "skills", path: "", gitRef: "abc123def456" },
  );
});

test("parseGithubRef: whole-repo at a semver tag", () => {
  assert.deepEqual(
    parseGithubRef("github://anthropic/skills@v1.2.0"),
    { owner: "anthropic", repo: "skills", path: "", gitRef: "v1.2.0" },
  );
});

test("parseGithubRef: single-file path", () => {
  assert.deepEqual(
    parseGithubRef("github://anthropic/skills/python-bridge.md@v1.2.0"),
    { owner: "anthropic", repo: "skills", path: "python-bridge.md", gitRef: "v1.2.0" },
  );
});

test("parseGithubRef: multi-segment path", () => {
  assert.deepEqual(
    parseGithubRef("github://anthropic/skills/dir/sub/file.json@main"),
    { owner: "anthropic", repo: "skills", path: "dir/sub/file.json", gitRef: "main" },
  );
});

test("parseGithubRef: missing @<ref> throws", () => {
  assert.throws(
    () => parseGithubRef("github://anthropic/skills"),
    (err) => err.message.includes("must pin a git ref"),
  );
});

test("parseGithubRef: empty git-ref after @ throws", () => {
  assert.throws(
    () => parseGithubRef("github://anthropic/skills@"),
    (err) => err.message.includes("empty git ref"),
  );
});

test("parseGithubRef: missing repo segment throws", () => {
  assert.throws(
    () => parseGithubRef("github://anthropic@main"),
    (err) => err.message.includes("owner/repo"),
  );
});

test("parseGithubRef: empty owner throws", () => {
  assert.throws(
    () => parseGithubRef("github:///skills@main"),
    (err) => err.message.includes("owner/repo"),
  );
});

test("parseGithubRef: non-github:// scheme throws", () => {
  assert.throws(
    () => parseGithubRef("https://github.com/anthropic/skills"),
    (err) => err.message.includes("not a github://"),
  );
});

test("parseGithubRef: non-string input throws", () => {
  assert.throws(
    () => parseGithubRef(null),
    (err) => err.message.includes("not a github://"),
  );
});

// ── github:// scheme — githubRefToHttpsUrl (cloister-5f5aee) ─────────────

test("githubRefToHttpsUrl: empty path → codeload tarball", () => {
  assert.equal(
    githubRefToHttpsUrl({ owner: "anthropic", repo: "skills", path: "", gitRef: "main" }),
    "https://codeload.github.com/anthropic/skills/tar.gz/main",
  );
});

test("githubRefToHttpsUrl: empty path + SHA-shaped ref", () => {
  assert.equal(
    githubRefToHttpsUrl({ owner: "anthropic", repo: "skills", path: "", gitRef: "abc123def" }),
    "https://codeload.github.com/anthropic/skills/tar.gz/abc123def",
  );
});

test("githubRefToHttpsUrl: path → raw URL", () => {
  assert.equal(
    githubRefToHttpsUrl({ owner: "anthropic", repo: "skills", path: "python-bridge.md", gitRef: "v1.2.0" }),
    "https://raw.githubusercontent.com/anthropic/skills/v1.2.0/python-bridge.md",
  );
});

test("githubRefToHttpsUrl: multi-segment path preserved", () => {
  assert.equal(
    githubRefToHttpsUrl({ owner: "anthropic", repo: "skills", path: "dir/sub/file.json", gitRef: "main" }),
    "https://raw.githubusercontent.com/anthropic/skills/main/dir/sub/file.json",
  );
});

// ── github:// scheme — resolveInput error paths (cloister-5f5aee) ────────

test("resolveInput: github:// missing @<ref> → ResolveError naming the input", async () => {
  await assert.rejects(
    () => resolveInput(specDefaults({ name: "gh-no-ref", ref: "github://anthropic/skills" })),
    (err) => err.inputName === "gh-no-ref" && err.detail.includes("must pin a git ref"),
  );
});

test("resolveInput: github:// malformed (missing repo) → ResolveError", async () => {
  await assert.rejects(
    () => resolveInput(specDefaults({ name: "gh-bad", ref: "github://anthropic@main" })),
    (err) => err.inputName === "gh-bad" && err.detail.includes("owner/repo"),
  );
});

// ── github:// scheme — resolveInput integration (cloister-5f5aee) ────────

test("resolveInput: github:// integration — full code path with fetch mock", async () => {
  const payload = Buffer.from("github-mocked tarball bytes");
  const originalFetch = globalThis.fetch;
  let observedUrl = null;
  globalThis.fetch = async (url) => {
    observedUrl = url;
    return new Response(payload, { status: 200 });
  };
  try {
    const row = await resolveInput(specDefaults({
      name: "gh-mock",
      ref:  "github://anthropic/skills@main",
    }));
    assert.equal(
      observedUrl,
      "https://codeload.github.com/anthropic/skills/tar.gz/main",
      "resolver must transform github:// → codeload tarball URL for whole-repo refs",
    );
    assert.equal(row.fetched_from, "https://codeload.github.com/anthropic/skills/tar.gz/main",
      "fetched_from records the actual https URL fetched, not the source github:// ref");
    assert.equal(row.ref, "github://anthropic/skills@main",
      "ref preserves the operator-authored shape (github://) for round-trip back to cluster.toml");
    assert.equal(row.sha256, `sha256:${sha256hex(payload)}`);
    assert.equal(row.bytes, payload.length);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resolveInput: github:// + path → raw URL via fetch mock", async () => {
  const payload = Buffer.from("# Skill\n\nbody");
  const originalFetch = globalThis.fetch;
  let observedUrl = null;
  globalThis.fetch = async (url) => {
    observedUrl = url;
    return new Response(payload, { status: 200 });
  };
  try {
    await resolveInput(specDefaults({
      name: "gh-file",
      ref:  "github://anthropic/skills/python-bridge.md@v1.2.0",
    }));
    assert.equal(
      observedUrl,
      "https://raw.githubusercontent.com/anthropic/skills/v1.2.0/python-bridge.md",
      "single-file github:// refs MUST route through raw.githubusercontent.com",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── io.github.org/ → github:// sugar (cloister-771364) ──────────────────

test("rewriteIoGithubOrgSugar: whole-repo ref rewrites to github://", () => {
  assert.equal(
    rewriteIoGithubOrgSugar("io.github.org/anthropics/skills@main"),
    "github://anthropics/skills@main",
  );
});

test("rewriteIoGithubOrgSugar: single-file path rewrites", () => {
  assert.equal(
    rewriteIoGithubOrgSugar("io.github.org/anthropics/skills/python-bridge.md@v1.2.0"),
    "github://anthropics/skills/python-bridge.md@v1.2.0",
  );
});

test("rewriteIoGithubOrgSugar: multi-segment path preserved", () => {
  assert.equal(
    rewriteIoGithubOrgSugar("io.github.org/x/y/dir/sub/file.json@abc"),
    "github://x/y/dir/sub/file.json@abc",
  );
});

test("rewriteIoGithubOrgSugar: non-matching refs pass through unchanged", () => {
  assert.equal(rewriteIoGithubOrgSugar("github://x/y@main"), "github://x/y@main");
  assert.equal(rewriteIoGithubOrgSugar("file:///abs/path"), "file:///abs/path");
  assert.equal(rewriteIoGithubOrgSugar("https://example.com/x"), "https://example.com/x");
});

test("rewriteIoGithubOrgSugar: bare prefix with no suffix passes through (pathological)", () => {
  // The github parser will surface a clean error; double-bookkeeping
  // here would just duplicate that validation.
  assert.equal(rewriteIoGithubOrgSugar("io.github.org/"), "io.github.org/");
});

test("rewriteIoGithubOrgSugar: non-string input passes through unchanged", () => {
  assert.equal(rewriteIoGithubOrgSugar(null), null);
  assert.equal(rewriteIoGithubOrgSugar(42), 42);
});

test("resolveInput: io.github.org/ sugar routes through github:// resolver via fetch mock", async () => {
  const payload = Buffer.from("io.github sugar e2e payload");
  const originalFetch = globalThis.fetch;
  let observedUrl = null;
  globalThis.fetch = async (url) => {
    observedUrl = url;
    return new Response(payload, { status: 200 });
  };
  try {
    const row = await resolveInput(specDefaults({
      name: "io-sugar",
      ref:  "io.github.org/anthropics/skills@main",
    }));
    assert.equal(
      observedUrl,
      "https://codeload.github.com/anthropics/skills/tar.gz/main",
      "io.github.org/ ref MUST route through codeload.github.com (same path as github:// form)",
    );
    // The lockfile preserves the ORIGINAL operator-authored ref shape
    // so subsequent re-resolves see the same input string.
    assert.equal(row.ref, "io.github.org/anthropics/skills@main",
      "ref column records the operator-authored io.github.org/ form, not the rewritten github://");
    // fetched_from records the actual URL, same as the github:// path.
    assert.equal(row.fetched_from, "https://codeload.github.com/anthropics/skills/tar.gz/main");
    assert.equal(row.sha256, `sha256:${sha256hex(payload)}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resolveInput: io.github.org/ sugar with single-file path routes to raw.githubusercontent.com", async () => {
  const payload = Buffer.from("# Skill\n\nbody");
  const originalFetch = globalThis.fetch;
  let observedUrl = null;
  globalThis.fetch = async (url) => {
    observedUrl = url;
    return new Response(payload, { status: 200 });
  };
  try {
    await resolveInput(specDefaults({
      name: "io-sugar-file",
      ref:  "io.github.org/anthropics/skills/python-bridge.md@v1.2.0",
    }));
    assert.equal(
      observedUrl,
      "https://raw.githubusercontent.com/anthropics/skills/v1.2.0/python-bridge.md",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resolveInput: io.github.org/ sugar without @<ref> errors per github:// validator", async () => {
  // Sugar rewrites without validating; the github parser is the
  // authoritative validator. A bad io.github.org/ ref should surface
  // the same error message a bad github:// ref would.
  await assert.rejects(
    () => resolveInput(specDefaults({ name: "io-bad", ref: "io.github.org/anthropics/skills" })),
    (err) => err.inputName === "io-bad" && err.detail.includes("must pin a git ref"),
  );
});

test("resolveInput: github:// fetch failure surfaces both URLs in the error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("not found", { status: 404, statusText: "Not Found" });
  try {
    await assert.rejects(
      () => resolveInput(specDefaults({
        name: "gh-404",
        ref:  "github://anthropic/skills@deadbeef",
      })),
      (err) => err.inputName === "gh-404"
        && err.detail.includes("404")
        && err.detail.includes("codeload.github.com")
        && err.detail.includes("github://anthropic/skills@deadbeef"),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── _meta.art.cloister/v1 — parser (cloister-cb7263, P3 of LLO-enablement arc) ─

test("parseServerJsonMeta: non-JSON bytes returns null", () => {
  // Bytes that don't parse as JSON (e.g. a tarball or arbitrary text)
  // are legitimate — they mean "no _meta block available". The resolver
  // falls back to single-backend heuristic.
  const bytes = Buffer.from("\x1f\x8b\x08\x00not-json-just-some-bytes");
  assert.equal(parseServerJsonMeta(bytes), null);
});

test("parseServerJsonMeta: JSON without _meta block returns null", () => {
  const bytes = Buffer.from(JSON.stringify({
    name: "io.github.example/foo",
    version: "0.1.0",
  }));
  assert.equal(parseServerJsonMeta(bytes), null);
});

test("parseServerJsonMeta: JSON with _meta but no art.cloister/v1 key returns null", () => {
  const bytes = Buffer.from(JSON.stringify({
    name: "io.github.example/foo",
    _meta: { "other.vendor/v1": { groups: [] } },
  }));
  assert.equal(parseServerJsonMeta(bytes), null);
});

test("parseServerJsonMeta: canonical LLO vector parses to three groups", () => {
  const bytes = Buffer.from(JSON.stringify({
    "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
    name: "io.github.agentic-research/ley-line-open",
    version: "0.2.0",
    description: "...",
    _meta: {
      "art.cloister/v1": {
        groups: [
          { name: "lsp", advertisedPrefix: "lsp_", upstreamNames: ["lsp_hover", "lsp_defs", "lsp_refs", "lsp_symbols", "lsp_diagnostics"] },
          { name: "lifecycle", advertisedPrefix: "", upstreamNames: ["status", "enrich", "reparse"] },
          { name: "sheaf", advertisedPrefix: "sheaf_", upstreamNames: ["sheaf_set_topology"] },
        ],
      },
    },
  }));
  const meta = parseServerJsonMeta(bytes);
  assert.ok(meta, "must return parsed _meta block");
  assert.equal(meta.groups.length, 3);
  assert.equal(meta.groups[0].name, "lsp");
  assert.deepEqual(meta.groups[0].upstreamNames, ["lsp_hover", "lsp_defs", "lsp_refs", "lsp_symbols", "lsp_diagnostics"]);
  assert.equal(meta.groups[1].advertisedPrefix, "");
  assert.equal(meta.groups[2].name, "sheaf");
});

test("parseServerJsonMeta: empty groups[] returns null (treated as opt-out per wire spec)", () => {
  // wire/meta-groups.md §"Top-level shape": "An empty `groups: []` means
  // 'this server author opted in but declared no groups.' It is
  // semantically equivalent to omitting `_meta.art.cloister/v1` entirely."
  const bytes = Buffer.from(JSON.stringify({
    name: "io.github.example/foo",
    _meta: { "art.cloister/v1": { groups: [] } },
  }));
  assert.equal(parseServerJsonMeta(bytes), null);
});

// ── _meta.art.cloister/v1 — malformed input shape errors ─────────────────

test("parseServerJsonMeta: groups not an array throws explanatory error", () => {
  const bytes = Buffer.from(JSON.stringify({
    name: "io.github.example/foo",
    _meta: { "art.cloister/v1": { groups: "lsp" } },
  }));
  assert.throws(
    () => parseServerJsonMeta(bytes),
    (err) => err.message.includes("groups") && err.message.includes("array"),
  );
});

test("parseServerJsonMeta: group missing name throws", () => {
  const bytes = Buffer.from(JSON.stringify({
    _meta: { "art.cloister/v1": { groups: [{ upstreamNames: ["foo"] }] } },
  }));
  assert.throws(
    () => parseServerJsonMeta(bytes),
    (err) => err.message.includes("name"),
  );
});

test("parseServerJsonMeta: group with empty name throws", () => {
  const bytes = Buffer.from(JSON.stringify({
    _meta: { "art.cloister/v1": { groups: [{ name: "", upstreamNames: ["foo"] }] } },
  }));
  assert.throws(
    () => parseServerJsonMeta(bytes),
    (err) => err.message.includes("name"),
  );
});

test("parseServerJsonMeta: group missing upstreamNames throws", () => {
  const bytes = Buffer.from(JSON.stringify({
    _meta: { "art.cloister/v1": { groups: [{ name: "lsp" }] } },
  }));
  assert.throws(
    () => parseServerJsonMeta(bytes),
    (err) => err.message.includes("upstreamNames"),
  );
});

test("parseServerJsonMeta: group with empty upstreamNames throws", () => {
  // wire/meta-groups.md: "Empty `upstreamNames` is a spec violation. A
  // group that claims no tools is a no-op backend; the resolver SHOULD
  // fail the build."
  const bytes = Buffer.from(JSON.stringify({
    _meta: { "art.cloister/v1": { groups: [{ name: "lsp", upstreamNames: [] }] } },
  }));
  assert.throws(
    () => parseServerJsonMeta(bytes),
    (err) => err.message.includes("upstreamNames") && err.message.includes("empty"),
  );
});

test("parseServerJsonMeta: duplicate group name within groups[] throws", () => {
  // wire/meta-groups.md: "two groups in the same `server.json` with the
  // same `name` is a spec violation."
  const bytes = Buffer.from(JSON.stringify({
    _meta: { "art.cloister/v1": { groups: [
      { name: "lsp", upstreamNames: ["a"] },
      { name: "lsp", upstreamNames: ["b"] },
    ] } },
  }));
  assert.throws(
    () => parseServerJsonMeta(bytes),
    (err) => err.message.includes("duplicate") && err.message.includes("lsp"),
  );
});

// ── deriveGeneratedBackends — one group → one backend row ────────────────

test("deriveGeneratedBackends: canonical LLO vector emits three backends", () => {
  const meta = {
    groups: [
      { name: "lsp", advertisedPrefix: "lsp_", upstreamNames: ["lsp_hover", "lsp_defs", "lsp_refs", "lsp_symbols", "lsp_diagnostics"] },
      { name: "lifecycle", advertisedPrefix: "", upstreamNames: ["status", "enrich", "reparse"] },
      { name: "sheaf", advertisedPrefix: "sheaf_", upstreamNames: ["sheaf_set_topology"] },
    ],
  };
  const spec = specDefaults({ name: "llo" });
  const rows = deriveGeneratedBackends(spec, meta);
  assert.equal(rows.length, 3);

  // Each row carries the source input name so operators can trace the
  // generated backend back to its [inputs.<name>] origin.
  for (const row of rows) {
    assert.equal(row.input, "llo");
    assert.equal(row.dynamicTools, true);
  }

  assert.equal(rows[0].name, "lsp");
  assert.equal(rows[0].handlesPrefix, "lsp_");
  assert.deepEqual(rows[0].claims, ["lsp_hover", "lsp_defs", "lsp_refs", "lsp_symbols", "lsp_diagnostics"]);
  // llo's upstreamNames already carry the prefix — no stripping needed.
  assert.equal(rows[0].stripPrefix, "", "already-prefixed upstreamNames need no stripPrefix");

  assert.equal(rows[1].name, "lifecycle");
  assert.equal(rows[1].handlesPrefix, "");
  assert.deepEqual(rows[1].claims, ["status", "enrich", "reparse"]);
  assert.equal(rows[1].stripPrefix, "", "empty advertisedPrefix needs no stripPrefix");

  assert.equal(rows[2].name, "sheaf");
  assert.equal(rows[2].handlesPrefix, "sheaf_");
  assert.deepEqual(rows[2].claims, ["sheaf_set_topology"]);
  assert.equal(rows[2].stripPrefix, "");
});

// ── deriveStripPrefix (cloister-2d987e, Bug 3) ───────────────────────────
//
// The resolver never threaded a stripPrefix onto generated backends
// before this fix. McpProxyToolBackend.handles() (mcp-proxy.ts) checks
// the ADVERTISED/external tool name against `claims`, which holds the
// BARE upstreamNames verbatim. When advertisedPrefix is non-empty and
// upstreamNames are bare (mache's shape), the advertised name never
// matches claims without stripping the prefix first — this is exactly
// the bug the PR #96 discussion surfaced empirically.

test("deriveStripPrefix: bare upstreamNames under a non-empty prefix → strips the prefix (mache shape)", () => {
  const group = { name: "callgraph", advertisedPrefix: "mache_", upstreamNames: ["find_callers", "find_callees"] };
  assert.equal(deriveStripPrefix(group), "mache_");
});

test("deriveStripPrefix: already-prefixed upstreamNames under a non-empty prefix → no strip (llo shape)", () => {
  const group = { name: "lsp", advertisedPrefix: "lsp_", upstreamNames: ["lsp_hover", "lsp_defs"] };
  assert.equal(deriveStripPrefix(group), "");
});

test("deriveStripPrefix: empty advertisedPrefix → no strip regardless of upstreamNames shape", () => {
  const group = { name: "lifecycle", advertisedPrefix: "", upstreamNames: ["status", "enrich"] };
  assert.equal(deriveStripPrefix(group), "");
});

test("deriveStripPrefix: missing advertisedPrefix (defaults to '') → no strip", () => {
  const group = { name: "bare", upstreamNames: ["status"] };
  assert.equal(deriveStripPrefix(group), "");
});

test("deriveStripPrefix: mixed bare + already-prefixed upstreamNames → throws (malformed group)", () => {
  const group = {
    name: "mixed",
    advertisedPrefix: "mache_",
    upstreamNames: ["find_callers", "mache_already_prefixed"],
  };
  assert.throws(
    () => deriveStripPrefix(group),
    (err) => {
      assert.match(err.message, /mixed/);
      assert.match(err.message, /mache_/);
      return true;
    },
  );
});

test("deriveGeneratedBackends: mache-shape bare upstreamNames under non-empty prefix threads stripPrefix through", () => {
  const meta = {
    groups: [
      { name: "callgraph", advertisedPrefix: "mache_", upstreamNames: ["find_callers", "find_callees"] },
    ],
  };
  const rows = deriveGeneratedBackends(specDefaults({ name: "mache" }), meta);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].handlesPrefix, "mache_");
  assert.equal(rows[0].stripPrefix, "mache_", "bare upstreamNames under a non-empty prefix must derive stripPrefix");
});

test("deriveGeneratedBackends: single-group _meta emits one backend", () => {
  const meta = {
    groups: [{ name: "only", advertisedPrefix: "x_", upstreamNames: ["x_one"] }],
  };
  const rows = deriveGeneratedBackends(specDefaults({ name: "mono" }), meta);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "only");
  assert.equal(rows[0].handlesPrefix, "x_");
  assert.deepEqual(rows[0].claims, ["x_one"]);
});

test("deriveGeneratedBackends: group without advertisedPrefix defaults handlesPrefix to ''", () => {
  // wire/meta-groups.md: "advertisedPrefix missing | OK; defaults to ''".
  const meta = {
    groups: [{ name: "bare", upstreamNames: ["status"] }],
  };
  const rows = deriveGeneratedBackends(specDefaults({ name: "x" }), meta);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].handlesPrefix, "");
});

test("deriveGeneratedBackends: inherits urlBinding/serviceBinding from input spec when present", () => {
  // [inputs.<name>] may carry urlBinding/serviceBinding hints; the
  // resolver threads them through onto the generated backend rows so
  // the downstream manifest emitter has the binding info.
  const meta = { groups: [{ name: "g", upstreamNames: ["t"] }] };
  const spec = {
    ...specDefaults({ name: "withBindings" }),
    urlBinding:     "LLO_MCP_URL",
    serviceBinding: "LLO_MCP",
    requiresSession: true,
  };
  const rows = deriveGeneratedBackends(spec, meta);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].urlBinding, "LLO_MCP_URL");
  assert.equal(rows[0].serviceBinding, "LLO_MCP");
  assert.equal(rows[0].requiresSession, true);
});

test("deriveGeneratedBackends: missing urlBinding/serviceBinding leaves them as empty string", () => {
  const meta = { groups: [{ name: "g", upstreamNames: ["t"] }] };
  const rows = deriveGeneratedBackends(specDefaults({ name: "noBindings" }), meta);
  assert.equal(rows[0].urlBinding, "");
  assert.equal(rows[0].serviceBinding, "");
  assert.equal("requiresSession" in rows[0], false);
});

// ── deriveGeneratedBackends — heuristic fallback (no _meta) ──────────────

test("deriveGeneratedBackends: null _meta emits single-backend fallback with claim-all semantics", () => {
  // README §"Heuristic fallback": when _meta is absent, the resolver
  // MUST produce a single-backend default with claims=[], handlesPrefix="",
  // dynamicTools=true (legacy "claim everything" shape).
  const rows = deriveGeneratedBackends(specDefaults({ name: "legacyInput" }), null);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].input, "legacyInput");
  // Per resolver convention: fallback backend name == input name.
  assert.equal(rows[0].name, "legacyInput");
  assert.equal(rows[0].handlesPrefix, "");
  assert.deepEqual(rows[0].claims, [], "fallback uses empty claims = legacy claim-all");
  assert.equal(rows[0].dynamicTools, true);
});

// ── resolveInput end-to-end with _meta-bearing fixture ───────────────────

test("resolveInput: file:// pointing at server.json with canonical _meta produces 3 generatedBackends", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "resolve-meta-llo-"));
  try {
    const path = resolve(dir, "server.json");
    const serverJson = {
      "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
      name: "io.github.agentic-research/ley-line-open",
      version: "0.2.0",
      description: "...",
      _meta: {
        "art.cloister/v1": {
          groups: [
            { name: "lsp", advertisedPrefix: "lsp_", upstreamNames: ["lsp_hover", "lsp_defs", "lsp_refs", "lsp_symbols", "lsp_diagnostics"] },
            { name: "lifecycle", advertisedPrefix: "", upstreamNames: ["status", "enrich", "reparse"] },
            { name: "sheaf", advertisedPrefix: "sheaf_", upstreamNames: ["sheaf_set_topology"] },
          ],
        },
      },
    };
    writeFileSync(path, JSON.stringify(serverJson, null, 2));

    const row = await resolveInput(specDefaults({
      name: "llo",
      ref:  `file://${path}`,
    }));
    assert.equal(row.name, "llo");
    assert.ok(Array.isArray(row.generatedBackends), "row carries generatedBackends[]");
    assert.equal(row.generatedBackends.length, 3);
    assert.equal(row.generatedBackends[0].name, "lsp");
    assert.equal(row.generatedBackends[1].name, "lifecycle");
    assert.equal(row.generatedBackends[2].name, "sheaf");
    assert.deepEqual(
      row.generatedBackends[0].claims,
      ["lsp_hover", "lsp_defs", "lsp_refs", "lsp_symbols", "lsp_diagnostics"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveInput: file:// pointing at non-JSON bytes emits heuristic fallback + warning", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "resolve-meta-fallback-"));
  try {
    const path = resolve(dir, "tarball.bin");
    writeFileSync(path, Buffer.from("\x1f\x8bnot json"));

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.join(" ")); };
    try {
      const row = await resolveInput(specDefaults({ name: "tarred", ref: `file://${path}` }));
      assert.equal(row.generatedBackends.length, 1);
      assert.deepEqual(row.generatedBackends[0].claims, [], "fallback claims=[]");
      assert.equal(row.generatedBackends[0].handlesPrefix, "");
      assert.equal(row.generatedBackends[0].dynamicTools, true);
    } finally {
      console.warn = originalWarn;
    }
    assert.ok(
      warnings.some((w) => w.includes("tarred") && w.includes("_meta.art.cloister/v1") && w.includes("fallback")),
      `expected fallback warning naming the input, got: ${JSON.stringify(warnings)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveInput: file:// pointing at malformed _meta (empty upstreamNames) errors with input name", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "resolve-meta-malformed-"));
  try {
    const path = resolve(dir, "broken.json");
    writeFileSync(path, JSON.stringify({
      name: "broken",
      _meta: { "art.cloister/v1": { groups: [
        { name: "broken", upstreamNames: [] },
      ] } },
    }));

    await assert.rejects(
      () => resolveInput(specDefaults({ name: "brokenInput", ref: `file://${path}` })),
      (err) => err.inputName === "brokenInput"
        && err.detail.includes("upstreamNames")
        && err.detail.includes("empty"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveInput: file:// pointing at a group with mixed bare + already-prefixed upstreamNames errors with input name (cloister-2d987e, Bug 3)", async () => {
  // End-to-end: deriveStripPrefix's mixed-shape guard must surface as a
  // ResolveError naming the input, not an uncaught crash — mirrors the
  // malformed-_meta test above but exercises the newer stripPrefix path.
  const dir = mkdtempSync(resolve(tmpdir(), "resolve-strip-mixed-"));
  try {
    const path = resolve(dir, "mixed.json");
    writeFileSync(path, JSON.stringify({
      name: "mixed",
      _meta: { "art.cloister/v1": { groups: [
        { name: "callgraph", advertisedPrefix: "mache_", upstreamNames: ["find_callers", "mache_already_prefixed"] },
      ] } },
    }));

    await assert.rejects(
      () => resolveInput(specDefaults({ name: "mixedInput", ref: `file://${path}` })),
      (err) => err.inputName === "mixedInput"
        && err.detail.includes("mixes")
        && err.detail.includes("mache_"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── buildLockfile augmentation — [generated_backends] section ────────────

test("buildLockfile: emits [generated_backends] when rows carry generatedBackends[]", () => {
  const metadata = { name: "test-cluster", version: "0.1.0" };
  const inputs = [
    {
      name: "llo", ref: "file:///foo", resolved: "0.2.0",
      sha256: "sha256:abc", fetched_from: "file:///foo", signer: "", bytes: 42,
      generatedBackends: [
        { input: "llo", name: "lsp", handlesPrefix: "lsp_", claims: ["lsp_hover", "lsp_defs"], dynamicTools: true, urlBinding: "", serviceBinding: "" },
        { input: "llo", name: "lifecycle", handlesPrefix: "", claims: ["status"], dynamicTools: true, urlBinding: "", serviceBinding: "" },
      ],
    },
  ];
  const doc = buildLockfile(metadata, inputs);
  assert.ok(Array.isArray(doc.generated_backends), "lockfile carries generated_backends[]");
  assert.equal(doc.generated_backends.length, 2);
  assert.equal(doc.generated_backends[0].input, "llo");
  assert.equal(doc.generated_backends[0].name, "lsp");
  assert.deepEqual(doc.generated_backends[0].claims, ["lsp_hover", "lsp_defs"]);
  assert.equal(doc.generated_backends[1].name, "lifecycle");
});

test("buildLockfile: omits [generated_backends] when no input carries generated rows", () => {
  // Back-compat: existing lockfiles without [generated_backends] are
  // still valid. The resolver only emits the section when at least one
  // input has produced backend rows.
  const doc = buildLockfile({ name: "x", version: "0.0.1" }, [
    { name: "alpha", ref: "file:///x", resolved: "0.1", sha256: "sha256:a", fetched_from: "file:///x", signer: "", bytes: 10 },
  ]);
  assert.equal(doc.generated_backends, undefined,
    "no [generated_backends] section when no input carries rows");
});

// ── End-to-end recipe — LLO via canonical _meta vector ───────────────────

test("e2e: file:// LLO server.json with canonical _meta block produces 3-backend lockfile", async () => {
  // Stage the canonical LLO vector in a tmpdir, resolve via file://,
  // assert the lockfile body has 3 [[generated_backends]] entries with
  // names/handlesPrefix/claims matching the spec vector exactly.
  const dir = mkdtempSync(resolve(tmpdir(), "e2e-llo-meta-"));
  try {
    const path = resolve(dir, "server.json");
    const serverJson = {
      "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
      name: "io.github.agentic-research/ley-line-open",
      version: "0.2.0",
      description: "...",
      _meta: {
        "art.cloister/v1": {
          groups: [
            { name: "lsp", advertisedPrefix: "lsp_", upstreamNames: ["lsp_hover", "lsp_defs", "lsp_refs", "lsp_symbols", "lsp_diagnostics"] },
            { name: "lifecycle", advertisedPrefix: "", upstreamNames: ["status", "enrich", "reparse"] },
            { name: "sheaf", advertisedPrefix: "sheaf_", upstreamNames: ["sheaf_set_topology"] },
          ],
        },
      },
    };
    writeFileSync(path, JSON.stringify(serverJson, null, 2));

    const row = await resolveInput(specDefaults({ name: "lloMcp", ref: `file://${path}` }));
    const doc = buildLockfile({ name: "test-cluster", version: "0.1.0" }, [row]);
    assert.ok(Array.isArray(doc.generated_backends));
    assert.equal(doc.generated_backends.length, 3);

    const byName = Object.fromEntries(doc.generated_backends.map((b) => [b.name, b]));
    assert.deepEqual(byName.lsp.claims, ["lsp_hover", "lsp_defs", "lsp_refs", "lsp_symbols", "lsp_diagnostics"]);
    assert.equal(byName.lsp.handlesPrefix, "lsp_");
    assert.equal(byName.lsp.input, "lloMcp");
    assert.deepEqual(byName.lifecycle.claims, ["status", "enrich", "reparse"]);
    assert.equal(byName.lifecycle.handlesPrefix, "");
    assert.deepEqual(byName.sheaf.claims, ["sheaf_set_topology"]);
    assert.equal(byName.sheaf.handlesPrefix, "sheaf_");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── ADR-0038: packages[].oci → self-declared bundle image ────────────────

test("parsePackagesOci: no packages[] → null", () => {
  assert.equal(parsePackagesOci(Buffer.from(JSON.stringify({ name: "x", _meta: {} }))), null);
});

test("parsePackagesOci: non-JSON bytes → null", () => {
  assert.equal(parsePackagesOci(Buffer.from("not json at all")), null);
});

test("parsePackagesOci: oci entry → identifier + version + empty digest", () => {
  const bytes = Buffer.from(JSON.stringify({
    packages: [{ registryType: "oci", identifier: "ghcr.io/org/mache", version: "0.13.0" }],
  }));
  assert.deepEqual(parsePackagesOci(bytes), {
    identifier: "ghcr.io/org/mache", version: "0.13.0", digest: "",
  });
});

test("parsePackagesOci: snake_case registry_type is tolerated", () => {
  const bytes = Buffer.from(JSON.stringify({
    packages: [{ registry_type: "oci", identifier: "ghcr.io/org/mache", version: "0.13.0" }],
  }));
  assert.equal(parsePackagesOci(bytes).identifier, "ghcr.io/org/mache");
});

test("parsePackagesOci: digest-pinned entry carries the digest", () => {
  const bytes = Buffer.from(JSON.stringify({
    packages: [{ registryType: "oci", identifier: "ghcr.io/org/mache", digest: "sha256:abc123" }],
  }));
  const oci = parsePackagesOci(bytes);
  assert.equal(oci.digest, "sha256:abc123");
  assert.equal(oci.version, "");
});

test("parsePackagesOci: first oci entry wins; non-oci packages ignored", () => {
  const bytes = Buffer.from(JSON.stringify({
    packages: [
      { registryType: "npm", identifier: "@org/mache" },
      { registryType: "oci", identifier: "ghcr.io/org/mache", version: "0.13.0" },
    ],
  }));
  assert.equal(parsePackagesOci(bytes).identifier, "ghcr.io/org/mache");
});

test("parsePackagesOci: packages[] with only non-oci entries → null", () => {
  const bytes = Buffer.from(JSON.stringify({
    packages: [{ registryType: "npm", identifier: "@org/mache", version: "1.0.0" }],
  }));
  assert.equal(parsePackagesOci(bytes), null);
});

test("parsePackagesOci: oci entry missing identifier throws (opt-in must be correct)", () => {
  const bytes = Buffer.from(JSON.stringify({
    packages: [{ registryType: "oci", version: "0.13.0" }],
  }));
  assert.throws(() => parsePackagesOci(bytes), /identifier/);
});

test("resolveInput: file:// server.json with oci packages populates row.oci", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "resolve-oci-"));
  try {
    const path = resolve(dir, "server.json");
    writeFileSync(path, JSON.stringify({
      name: "io.github.org/mache",
      version: "0.13.0",
      packages: [{ registryType: "oci", identifier: "ghcr.io/agentic-research/mache", version: "0.13.0" }],
    }));
    // mutableTagReason: this fixture's image is synthetic — there is no
    // registry to probe, so digest resolution cannot succeed. Since ADR-0041
    // now FAILS CLOSED on an unresolvable digest, the fixture must acknowledge
    // the downgrade the same way an operator would.
    const row = await resolveInput({
      ...specDefaults({ name: "mache", ref: `file://${path}` }),
      mutableTagReason: "synthetic test fixture — no registry to probe",
    });
    assert.deepEqual(row.oci, {
      identifier: "ghcr.io/agentic-research/mache", version: "0.13.0", digest: "",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveInput: file:// server.json with no packages → row.oci is null", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "resolve-nooci-"));
  try {
    const path = resolve(dir, "server.json");
    writeFileSync(path, JSON.stringify({ name: "x", version: "1.0.0" }));
    const row = await resolveInput(specDefaults({ name: "x", ref: `file://${path}` }));
    assert.equal(row.oci, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildLockfile: emits inputs.<name>.oci (identifier+version) when a row carries oci", () => {
  const doc = buildLockfile({ name: "c", version: "0.1.0" }, [{
    name: "mache", ref: "io.github.org/mache@main", resolved: "0.13.0",
    sha256: "sha256:aa", fetched_from: "file:///x", signer: "", bytes: 10,
    generatedBackends: [],
    oci: { identifier: "ghcr.io/agentic-research/mache", version: "0.13.0", digest: "" },
  }]);
  assert.deepEqual(doc.inputs.mache.oci, {
    identifier: "ghcr.io/agentic-research/mache", version: "0.13.0",
  });
});

test("buildLockfile: omits oci key when a row has no oci (back-compat)", () => {
  const doc = buildLockfile({ name: "c", version: "0.1.0" }, [{
    name: "llo", ref: "x", resolved: "1", sha256: "sha256:bb",
    fetched_from: "file:///y", signer: "", bytes: 5, generatedBackends: [], oci: null,
  }]);
  assert.equal("oci" in doc.inputs.llo, false);
});

// ── resolveOciDigest: tag → immutable digest (ADR-0041 / cloister-091106) ──

function mockRegistryRes({ status = 200, headers = {}, json = null }) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => h.get(String(k).toLowerCase()) ?? null },
    json: async () => json,
  };
}

test("resolveOciDigest: 401 → anonymous token → retry returns docker-content-digest", async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, auth: opts.headers?.Authorization ?? "" });
    if (url.includes("/manifests/") && !opts.headers?.Authorization) {
      return mockRegistryRes({
        status: 401,
        headers: {
          "www-authenticate":
            'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:agentic-research/mache:pull"',
        },
      });
    }
    if (url.startsWith("https://ghcr.io/token")) {
      return mockRegistryRes({ status: 200, json: { token: "anon-abc" } });
    }
    return mockRegistryRes({ status: 200, headers: { "docker-content-digest": "sha256:deadbeef" } });
  };
  const digest = await resolveOciDigest("ghcr.io/agentic-research/mache", "v0.16.2", fetchImpl);
  assert.equal(digest, "sha256:deadbeef");
  // The token request carried service + scope parsed from the challenge.
  const tokenCall = calls.find((c) => c.url.startsWith("https://ghcr.io/token"));
  assert.ok(tokenCall.url.includes("service=ghcr.io"));
  assert.ok(tokenCall.url.includes("scope="));
  // The retried manifest HEAD carried the bearer token.
  assert.ok(calls.some((c) => c.url.includes("/manifests/") && c.auth === "Bearer anon-abc"));
});

test("resolveOciDigest: direct 200 (public, no auth challenge) returns digest", async () => {
  const fetchImpl = async () =>
    mockRegistryRes({ status: 200, headers: { "docker-content-digest": "sha256:cafe" } });
  assert.equal(await resolveOciDigest("ghcr.io/x/y", "v1", fetchImpl), "sha256:cafe");
});

test("resolveOciDigest: unresolvable (403, private w/o creds) falls back to empty string", async () => {
  const fetchImpl = async () => mockRegistryRes({ status: 403 });
  assert.equal(await resolveOciDigest("ghcr.io/private/img", "v1", fetchImpl), "");
});

test("resolveOciDigest: no registry host or empty ref returns empty string without fetching", async () => {
  const fetchImpl = async () => {
    throw new Error("resolveOciDigest should not fetch for a malformed input");
  };
  assert.equal(await resolveOciDigest("no-slash-identifier", "v1", fetchImpl), "");
  assert.equal(await resolveOciDigest("ghcr.io/x/y", "", fetchImpl), "");
});

// ── Session-ness is DERIVED from the declared transport (cloister-4ae222) ──
//
// The tool already publishes its transport; requiring an operator to also set
// `requiresSession` made it a second statement of one fact. mache's row omitted
// it, so every mache_* tool silently vanished from tools/list behind a 404
// "Invalid session ID" (cloister-af794d).

test("streamable-http derives a session", () => {
  assert.equal(deriveRequiresSession({ remotes: [{ type: "streamable-http" }] }), true);
});

test("stdio derives no session — a pipe has nothing to establish", () => {
  assert.equal(deriveRequiresSession({ remotes: [{ type: "stdio" }] }), false);
});

test("a server offering BOTH biases to the transport cloister speaks", () => {
  // The exact case a single boolean per input cannot express, and the reason
  // the operator flagged the old model as wrong.
  assert.equal(
    deriveRequiresSession({ remotes: [{ type: "stdio" }, { type: "streamable-http" }] }),
    true,
  );
});

test("transport declared under packages[].transport is read (LLO 11.2 shape)", () => {
  // ley-line-open 11.2 dropped `remotes` entirely and moved transport into the
  // package entry. Reading only remotes[] returned null for LLO, which falls
  // back to the operator's unset flag and would treat a streamable-http server
  // as sessionless — the same failure that hid every mache_* tool, arriving
  // from the other direction.
  assert.equal(
    deriveRequiresSession({
      packages: [{ registryType: "oci", transport: { type: "streamable-http" } }],
    }),
    true,
  );
});

test("both transport shapes coexist and both are read", () => {
  // As of 2026-07-28 mache/rosary/canonical-hours use remotes[], LLO uses
  // packages[].transport. cloister does not own the registry schema and cannot
  // make upstreams converge, so it tolerates both.
  assert.deepEqual(
    declaredTransportTypes({
      remotes: [{ type: "stdio" }],
      packages: [{ transport: { type: "streamable-http" } }],
    }),
    ["stdio", "streamable-http"],
  );
});

test("a package with no transport block contributes nothing", () => {
  assert.deepEqual(declaredTransportTypes({ packages: [{ registryType: "oci" }] }), []);
});

test("no declared transport returns null so the explicit value still applies", () => {
  // Null, not false: absence must not silently mean "no session" — that is the
  // defect class this change exists to remove, not to relocate.
  assert.equal(deriveRequiresSession({}), null);
  assert.equal(deriveRequiresSession({ remotes: [] }), null);
  assert.equal(deriveRequiresSession(null), null);
});

test("the real server.json of every pinned input derives a session", async (t) => {
  // Cross-check against the ACTUAL upstream documents, not fixtures: mache,
  // rosary and canonical-hours all declare streamable-http, so the derivation
  // should reproduce rosary's hand-set `true` and supply the one mache was
  // missing.
  //
  // Skipped when the sibling checkouts are absent, which is the normal case on
  // CI — a runner has cloister and nothing else. This is a LOCAL cross-check
  // against reality, not the derivation's coverage: the four cases above own
  // that, and they are pure and portable. Do not "fix" this by pointing it at
  // a committed fixture; a fixture of a document we do not control proves only
  // that we copied it correctly once.
  const { readFileSync, existsSync } = await import("node:fs");
  const { homedir } = await import("node:os");
  const paths = ["mache", "rosary", "canonical-hours"].map(
    (repo) => [repo, `${homedir()}/remotes/art/${repo}/server.json`],
  );
  const present = paths.filter(([, path]) => existsSync(path));
  if (present.length === 0) {
    t.skip("sibling repo checkouts not present (expected on CI)");
    return;
  }
  for (const [repo, path] of present) {
    const doc = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(deriveRequiresSession(doc), true, `${repo} derives a session`);
  }
});
// ── UDS as an input transport (ADR-0051 / cloister-8c6b21) ────────────────
//
// The win is not throughput: a same-host MCP server needs NO listening TCP
// port, so its exposure is scoped by filesystem permissions instead of a port
// reachable to anything that can reach loopback.

test("no connection block resolves exactly as before — mcpProxy via urlBinding", () => {
  const rows = deriveGeneratedBackends(
    { ...specDefaults({ name: "llo" }), urlBinding: "LLO_MCP_URL", serviceBinding: "LSP_MCP" },
    null,
  );
  assert.equal(rows[0].urlBinding, "LLO_MCP_URL");
  assert.equal(rows[0].serviceBinding, "LSP_MCP");
  assert.equal(rows[0].kind, undefined, "no connection ⇒ no udsForward kind");
});

test("transport=uds emits a udsForward row carrying socketPath", () => {
  const rows = deriveGeneratedBackends(
    {
      ...specDefaults({ name: "llo" }),
      urlBinding: "LLO_MCP_URL",
      connection: { transport: { uds: null }, socketPath: "/run/cloister-uds/llo.sock", vaultSlice: "" },
    },
    null,
  );
  assert.equal(rows[0].kind, "udsForward");
  assert.equal(rows[0].socketPath, "/run/cloister-uds/llo.sock");
  assert.equal(rows[0].urlBinding, undefined, "a uds row carries no urlBinding");
});

test("uds does NOT carry requiresSession — a capnp call has no HTTP to bind a session to", () => {
  const rows = deriveGeneratedBackends(
    {
      ...specDefaults({ name: "x" }),
      requiresSession: true,
      connection: { transport: { uds: null }, socketPath: "/run/x.sock", vaultSlice: "" },
    },
    null,
  );
  assert.equal(rows[0].requiresSession, undefined);
});

test("uds with an empty socketPath FAILS rather than falling back to mcpProxy", () => {
  // Silently resolving a declared uds intent into a different transport would
  // change what the operator asked for without saying so.
  assert.throws(
    () => udsSocketPath({ name: "llo", connection: { transport: { uds: null }, socketPath: "" } }),
    /must name the socket to dial/,
  );
});

test("the TOML string form of transport is accepted alongside the union", () => {
  // TOML has no unions; the operator writes transport = "uds".
  assert.equal(
    udsSocketPath({ name: "x", connection: { transport: "uds", socketPath: "/run/x.sock" } }),
    "/run/x.sock",
  );
  assert.equal(udsSocketPath({ name: "x", connection: { transport: "unset" } }), null);
  assert.equal(udsSocketPath({ name: "x" }), null);
});

// ── Unresolvable digests fail closed (ADR-0041 / cloister-8c6b21) ─────────

test("an unresolvable OCI digest REFUSES rather than pinning by mutable tag", async () => {
  // Previously this warned and pinned by tag anyway — a supply-chain downgrade
  // accepted quietly enough to survive review: the warning scrolls past in a
  // build log and the lockfile still looks pinned.
  const dir = mkdtempSync(resolve(tmpdir(), "resolve-failclosed-"));
  try {
    const path = resolve(dir, "server.json");
    writeFileSync(path, JSON.stringify({
      name: "x", version: "1",
      packages: [{ registryType: "oci", identifier: "ghcr.io/nope/nope", version: "9.9.9" }],
    }));
    await assert.rejects(
      () => resolveInput(specDefaults({ name: "nope", ref: `file://${path}` })),
      (err) => err.detail.includes("Refusing to pin by mutable tag"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stated mutableTagReason accepts the downgrade explicitly", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "resolve-ack-"));
  try {
    const path = resolve(dir, "server.json");
    writeFileSync(path, JSON.stringify({
      name: "x", version: "1",
      packages: [{ registryType: "oci", identifier: "ghcr.io/nope/nope", version: "9.9.9" }],
    }));
    const row = await resolveInput({
      ...specDefaults({ name: "nope", ref: `file://${path}` }),
      mutableTagReason: "image not published yet — see upstream bead",
    });
    // Pinned by tag, and NOT carrying a digest it does not have.
    assert.equal(row.oci.version, "9.9.9");
    assert.equal(row.oci.digest, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
