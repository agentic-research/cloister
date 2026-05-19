// SPDX-License-Identifier: AGPL-3.0-or-later
//
// scripts/resolve-inputs.mjs — ADR-0026 Phase 1b + Phase 2 subpiece 1
// (cloister-cf7a3b + cloister-5f5aee) + Phase 3 (cloister-cb7263) —
// input resolver + cluster.lock.toml writer + `_meta.art.cloister/v1`
// → generated-backends emitter.
//
// Reads `cluster.toml`'s `[inputs.*]` blocks, resolves each input via
// its ref scheme, computes a content-addressed digest, writes the
// resolved metadata to `cluster.lock.toml`. Operators commit the
// lockfile alongside cluster.toml so deploys are reproducible.
//
// Phase 3 layer (cloister-cb7263): when the resolved bytes are an MCP
// `server.json` carrying a `_meta.art.cloister/v1.groups[]` block (per
// `cloister-spec/mcp-tool/v1/`), the resolver derives ONE backend
// declaration per group and records them in a `[generated_backends]`
// section in the lockfile. Operators commit that, the downstream
// manifest emitter consumes it. When the bytes carry no `_meta` block
// (or aren't JSON at all — e.g. a tarball), the resolver falls back to
// a single-backend heuristic with `claims=[]`, `handlesPrefix=""`,
// `dynamicTools=true` (legacy claim-all shape) and logs a warning so
// the operator can ask the upstream MCP server author to add a
// `_meta` block for finer-grained group composition.
//
// Resolver schemes today:
//
//   - file://<abs-path>             — local filesystem (dev escape hatch +
//                                     the simplest happy path for testing)
//   - https://<url>                 — direct HTTPS fetch (real deploy path)
//   - github://owner/repo@<ref>     — whole-repo tarball via codeload.github.com
//   - github://owner/repo/<p>@<ref> — single file via raw.githubusercontent.com
//   - io.github.org/owner/repo@<r>  — sugar for github://owner/repo@<r>; matches
//                                     the public MCP-registry naming convention.
//                                     Rewrites at parse time; otherwise identical
//                                     to the github:// path.
//
// github:// (and the io.github.org/ sugar form) refs MUST pin a git ref
// (`@<sha|tag|branch>`); no default-branch sniffing — pinning is the
// whole point. The existing content-addressed sha256 digest pin in
// `cluster.lock.toml` is what makes the deploy reproducible regardless
// of branch-head drift.
//
// Phase 2 follow-up (cloister-cf7a3b):
//   - subpiece 3b — registry-backed io.github.org/ resolution per
//                   ADR-0016. Today's sugar lands the URL convention;
//                   a future evolution can route the rewrite through an
//                   external registry consumer protocol without breaking
//                   user-authored refs.
// Phase 3 adds signature verification via Interlace receipts. Phase 4
// adds the capability matchmaker that walks provides/requires.
//
// Wire:
//
//   Exit 0 — all inputs resolved successfully; lockfile written.
//   Exit 1 — one or more inputs failed to resolve.
//   Exit 2 — toolchain error (cluster.toml missing, unparseable, etc.).
//
// Env:
//
//   CLOISTER_CLUSTER_TOML — override path to cluster.toml (defaults
//                           to <repo-root>/cluster.toml).
//   CLOISTER_LOCKFILE     — override path to cluster.lock.toml.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseToml, stringify as stringifyToml } from "@iarna/toml";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(HERE, "..");

const CLUSTER_TOML_PATH = process.env.CLOISTER_CLUSTER_TOML
  ? resolvePath(process.env.CLOISTER_CLUSTER_TOML)
  : resolvePath(REPO_ROOT, "cluster.toml");

const LOCKFILE_PATH = process.env.CLOISTER_LOCKFILE
  ? resolvePath(process.env.CLOISTER_LOCKFILE)
  : resolvePath(REPO_ROOT, "cluster.lock.toml");

class ToolchainError extends Error {}
class ResolveError extends Error {
  constructor(inputName, detail) {
    super(`input "${inputName}": ${detail}`);
    this.inputName = inputName;
    this.detail = detail;
  }
}

// ── Resolvers ───────────────────────────────────────────────────────────

/**
 * Resolve one InputSpec. Returns a `ResolvedInput` row for the lockfile:
 *
 *   {
 *     name:         "<from spec>",
 *     ref:          "<from spec>",
 *     resolved:     "<scheme-specific identifier>",
 *     sha256:       "<hex>",
 *     fetched_from: "<absolute URL or path>",
 *     signer:       "" (Phase 3 will populate),
 *     bytes:        <integer>,
 *   }
 *
 * Throws `ResolveError` on failure. The CLI wrapper collects all
 * errors before exiting so the operator sees the full list.
 */
export async function resolveInput(spec) {
  // `from` (dev-loop override) wins over `ref` per ADR-0026
  // §"Why filesystem from = ... is the dev-loop escape only".
  const rawRef = (spec.from && spec.from.length > 0) ? spec.from : spec.ref;
  if (!rawRef || rawRef.length === 0) {
    throw new ResolveError(spec.name, "neither `ref` nor `from` provided");
  }

  // io.github.org/<owner>/<repo>[/<path>]@<ref> is sugar for the
  // equivalent github:// form. Rewrite once at the top of resolve
  // so the rest of the function only knows the canonical schemes.
  const ref = rewriteIoGithubOrgSugar(rawRef);

  const scheme = ref.split(":")[0];
  let bytes;
  let fetchedFrom;

  switch (scheme) {
    case "file": {
      const path = fileUrlToPath(ref);
      if (!existsSync(path)) {
        throw new ResolveError(spec.name, `file not found: ${path}`);
      }
      bytes = readFileSync(path);
      fetchedFrom = ref;
      break;
    }
    case "https":
    case "http": {
      if (scheme === "http") {
        throw new ResolveError(
          spec.name,
          `http:// is not allowed (man-in-the-middle hazard); use https:// — got ${ref}`,
        );
      }
      const r = await fetch(ref);
      if (!r.ok) {
        throw new ResolveError(spec.name, `HTTP ${r.status} ${r.statusText} for ${ref}`);
      }
      bytes = Buffer.from(await r.arrayBuffer());
      fetchedFrom = ref;
      break;
    }
    case "github": {
      // Parse github://owner/repo[/path]@<git-ref> → https URL, then
      // fall through to the same fetch logic as https://. The
      // resolver records `fetched_from` as the actual https URL so
      // the lockfile shows what was downloaded.
      let parsed;
      try {
        parsed = parseGithubRef(ref);
      } catch (e) {
        throw new ResolveError(spec.name, e.message);
      }
      const httpsUrl = githubRefToHttpsUrl(parsed);
      const r = await fetch(httpsUrl);
      if (!r.ok) {
        throw new ResolveError(
          spec.name,
          `HTTP ${r.status} ${r.statusText} for ${httpsUrl} (resolved from ${ref})`,
        );
      }
      bytes = Buffer.from(await r.arrayBuffer());
      fetchedFrom = httpsUrl;
      break;
    }
    default:
      throw new ResolveError(
        spec.name,
        `unsupported ref scheme "${scheme}" — supported: file://, https://, ` +
        `github://owner/repo@<ref>, io.github.org/owner/repo@<ref>`,
      );
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");

  // Digest pin check (defense-in-depth): if the operator pre-committed
  // a digest, verify the fetched bytes match. A pinned-but-mismatched
  // input is a hard fail — the registry or the network tampered.
  if (spec.digest && spec.digest.length > 0) {
    const expected = spec.digest.startsWith("sha256:") ? spec.digest.slice(7) : spec.digest;
    if (expected !== sha256) {
      throw new ResolveError(
        spec.name,
        `digest mismatch — pinned ${spec.digest}, got sha256:${sha256}`,
      );
    }
  }

  // Phase 3 (cloister-cb7263): walk the resolved bytes for an MCP
  // server.json `_meta.art.cloister/v1.groups[]` block. If present,
  // derive one backend declaration per group. If absent (or the bytes
  // aren't parseable as JSON), fall back to a single-backend heuristic
  // and warn the operator.
  let meta = null;
  try {
    meta = parseServerJsonMeta(bytes);
  } catch (e) {
    // Bytes parsed as JSON + carried _meta.art.cloister/v1 but the
    // block was malformed (missing required field, empty
    // upstreamNames, duplicate group name, etc.). Per the spec
    // constraint matrix this is a build failure, not a silent
    // fallback — the server author opted in, they need to opt in
    // correctly.
    throw new ResolveError(spec.name, e.message);
  }

  let generatedBackends;
  if (meta) {
    generatedBackends = deriveGeneratedBackends(spec, meta);
  } else {
    generatedBackends = deriveGeneratedBackends(spec, null);
    // Warn so the operator knows they're getting a single backend
    // rather than a partitioned set. README §"Heuristic fallback":
    // the fallback exists + emits a warning + does NOT fail the build.
    console.warn(
      `resolve-inputs: input ${spec.name}: no _meta.art.cloister/v1 — ` +
      `using single-backend fallback. For multi-group servers, ask the ` +
      `maintainer to add _meta.`,
    );
  }

  return {
    name:              spec.name,
    ref:               spec.ref,
    resolved:          spec.version || "",
    sha256:            `sha256:${sha256}`,
    fetched_from:      fetchedFrom,
    signer:            "", // Interlace receipts will populate (future ADR-0026 phase)
    bytes:             bytes.length,
    generatedBackends,
  };
}

function fileUrlToPath(url) {
  // Trim the file:// (or file:///) prefix; the remaining string IS
  // the absolute path on disk.
  if (url.startsWith("file:///")) return "/" + url.slice("file:///".length);
  if (url.startsWith("file://"))  return url.slice("file://".length);
  throw new ResolveError("", `malformed file URL: ${url}`);
}

// ── github:// scheme ────────────────────────────────────────────────────

/**
 * Parse a github:// ref into its components. Shape:
 *
 *   github://<owner>/<repo>[/<path>]@<git-ref>
 *
 * Examples:
 *   github://anthropic/skills@main
 *     → { owner: "anthropic", repo: "skills", path: "",                gitRef: "main" }
 *   github://anthropic/skills/python-bridge.md@v1.2.0
 *     → { owner: "anthropic", repo: "skills", path: "python-bridge.md", gitRef: "v1.2.0" }
 *
 * @<git-ref> is REQUIRED. Default-branch sniffing would need a GitHub
 * API call + auth handling, and the resolved digest would drift each
 * time the default branch moves — defeating content-addressed pinning.
 *
 * Exported for unit tests.
 */
export function parseGithubRef(ref) {
  if (typeof ref !== "string" || !ref.startsWith("github://")) {
    throw new Error(`not a github:// ref: ${ref}`);
  }
  const rest = ref.slice("github://".length);
  // Use lastIndexOf so a literal '@' in a path (rare but possible) is
  // tolerated — only the trailing @<ref> is special.
  const atIdx = rest.lastIndexOf("@");
  if (atIdx === -1) {
    throw new Error(
      `github:// ref must pin a git ref with @<sha|tag|branch>; got ${ref}`,
    );
  }
  const ownerRepoPath = rest.slice(0, atIdx);
  const gitRef = rest.slice(atIdx + 1);
  if (gitRef.length === 0) {
    throw new Error(`empty git ref after @ in ${ref}`);
  }
  const parts = ownerRepoPath.split("/");
  if (parts.length < 2 || parts[0].length === 0 || parts[1].length === 0) {
    throw new Error(
      `github:// ref must be github://owner/repo[/path]@<ref>; got ${ref}`,
    );
  }
  const [owner, repo, ...pathParts] = parts;
  const path = pathParts.join("/");
  return { owner, repo, path, gitRef };
}

/**
 * Map a parsed github ref to the https URL the fetch goes to. When
 * `path` is empty, fetch the whole-repo tarball via codeload.github.com;
 * otherwise fetch the single file via raw.githubusercontent.com.
 *
 * codeload.github.com serves a deterministic tarball given a fixed
 * git-ref SHA; the same is true of raw.githubusercontent.com for a
 * fixed-SHA path. (Branches/tags drift; that's why the operator pins
 * sha256 in `cluster.lock.toml`.)
 *
 * Exported for unit tests.
 */
export function githubRefToHttpsUrl({ owner, repo, path, gitRef }) {
  if (path === "") {
    return `https://codeload.github.com/${owner}/${repo}/tar.gz/${gitRef}`;
  }
  return `https://raw.githubusercontent.com/${owner}/${repo}/${gitRef}/${path}`;
}

// ── io.github.org/ → github:// sugar ────────────────────────────────────

const IO_GITHUB_ORG_PREFIX = "io.github.org/";

/**
 * Rewrite `io.github.org/<owner>/<repo>[/<path>]@<ref>` to its
 * `github://<owner>/<repo>[/<path>]@<ref>` equivalent. Non-matching
 * refs pass through unchanged.
 *
 * The sugar exists because the public MCP-registry naming convention
 * names tools as `io.github.org/<owner>/<repo>`. Routing the rewrite
 * at the top of resolveInput means the rest of the resolver only
 * knows two URL schemes (file://, https://) plus github://; nothing
 * else changes.
 *
 * Validation is intentionally light — the rewrite output goes back
 * through `parseGithubRef`, which is the authoritative validator.
 * Refusing here too would be double-bookkeeping. Just check that
 * (a) the prefix matches and (b) the suffix is non-empty.
 *
 * Exported for unit tests.
 */
export function rewriteIoGithubOrgSugar(ref) {
  if (typeof ref !== "string") return ref;
  if (!ref.startsWith(IO_GITHUB_ORG_PREFIX)) return ref;
  const suffix = ref.slice(IO_GITHUB_ORG_PREFIX.length);
  if (suffix.length === 0) return ref; // pathological; let github parser surface the error
  return `github://${suffix}`;
}

// ── `_meta.art.cloister/v1` parsing (cloister-cb7263, P3 of LLO arc) ────
//
// Spec: cloister-spec/mcp-tool/v1/README.md + wire/meta-groups.md.
// Canonical fixture: cloister-spec/mcp-tool/v1/vectors/llo-groups.json.
//
// The resolver consumes the `_meta.art.cloister/v1.groups[]` block out
// of an MCP `server.json` document. Each group becomes one backend
// declaration:
//
//   group.name             → backend.name
//   group.advertisedPrefix → backend.handlesPrefix (default "")
//   group.upstreamNames    → backend.claims (P1 schema slot)
//   (always)               → backend.dynamicTools = true
//
// When _meta is absent OR the resolved bytes aren't JSON at all, the
// resolver falls back to a single backend with `claims=[]`,
// `handlesPrefix=""`, `dynamicTools=true` (legacy claim-everything
// shape) and warns the operator.

/**
 * Parse the `_meta.art.cloister/v1` block out of resolved bytes (which
 * are expected to be an MCP `server.json`). Returns:
 *
 *   - `null` if the bytes aren't JSON, or are JSON but carry no
 *     `_meta.art.cloister/v1` block, or carry an empty `groups: []`
 *     (per wire/meta-groups.md: empty groups[] is semantically
 *     equivalent to omitting the block).
 *   - the parsed `{ groups: [...] }` object on success, with each
 *     group validated against the spec constraint matrix.
 *
 * Throws on a malformed _meta block (missing required field, empty
 * upstreamNames, duplicate group name, etc.) — the server author
 * opted in, they need to opt in correctly. Per
 * `cloister-spec/mcp-tool/v1/wire/meta-groups.md` §"Constraint matrix".
 *
 * Exported for unit tests.
 */
export function parseServerJsonMeta(bytes) {
  let doc;
  try {
    // Try to parse the bytes as JSON. Buffers / typed arrays / strings
    // all work via String().
    const text = typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8");
    doc = JSON.parse(text);
  } catch {
    return null; // Not JSON ⇒ no _meta block ⇒ fallback path.
  }
  if (!doc || typeof doc !== "object" || !doc._meta || typeof doc._meta !== "object") {
    return null;
  }
  const block = doc._meta["art.cloister/v1"];
  if (!block || typeof block !== "object") {
    return null;
  }

  // Validate `groups` field shape.
  const groups = block.groups;
  if (groups === undefined || groups === null) {
    return null; // _meta block present but no groups[] — treat as no opt-in.
  }
  if (!Array.isArray(groups)) {
    throw new Error(
      `_meta.art.cloister/v1.groups must be an array; got ${typeof groups}`,
    );
  }
  if (groups.length === 0) {
    // Per wire/meta-groups.md: "An empty groups: [] means 'this server
    // author opted in but declared no groups.' It is semantically
    // equivalent to omitting _meta.art.cloister/v1 entirely."
    return null;
  }

  // Validate each group.
  const seenNames = new Set();
  const validatedGroups = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (!g || typeof g !== "object") {
      throw new Error(`_meta.art.cloister/v1.groups[${i}] is not an object`);
    }
    // `name`: REQUIRED, non-empty string, unique within groups[].
    if (typeof g.name !== "string" || g.name.length === 0) {
      throw new Error(
        `_meta.art.cloister/v1.groups[${i}].name is required and must be a non-empty string`,
      );
    }
    if (seenNames.has(g.name)) {
      throw new Error(
        `_meta.art.cloister/v1.groups[${i}]: duplicate group name "${g.name}" ` +
        `— group names must be unique within groups[]`,
      );
    }
    seenNames.add(g.name);

    // `upstreamNames`: REQUIRED, non-empty array of strings.
    if (!Array.isArray(g.upstreamNames)) {
      throw new Error(
        `_meta.art.cloister/v1.groups[${i}] (name="${g.name}"): ` +
        `upstreamNames is required and must be an array`,
      );
    }
    if (g.upstreamNames.length === 0) {
      throw new Error(
        `_meta.art.cloister/v1.groups[${i}] (name="${g.name}"): ` +
        `upstreamNames must not be empty — a group with no claims is a no-op backend`,
      );
    }
    for (let j = 0; j < g.upstreamNames.length; j++) {
      if (typeof g.upstreamNames[j] !== "string" || g.upstreamNames[j].length === 0) {
        throw new Error(
          `_meta.art.cloister/v1.groups[${i}] (name="${g.name}"): ` +
          `upstreamNames[${j}] must be a non-empty string`,
        );
      }
    }

    // `advertisedPrefix`: OPTIONAL, defaults to "".
    let advertisedPrefix = "";
    if (g.advertisedPrefix !== undefined) {
      if (typeof g.advertisedPrefix !== "string") {
        throw new Error(
          `_meta.art.cloister/v1.groups[${i}] (name="${g.name}"): ` +
          `advertisedPrefix must be a string when present`,
        );
      }
      advertisedPrefix = g.advertisedPrefix;
    }

    validatedGroups.push({
      name:             g.name,
      advertisedPrefix,
      upstreamNames:    g.upstreamNames.slice(),
    });
  }
  return { groups: validatedGroups };
}

/**
 * Derive `[generated_backends]` rows from a resolved input spec + its
 * (already-validated) `_meta.art.cloister/v1` block. When `meta` is
 * `null` (no opt-in or non-JSON bytes), emits the heuristic-fallback
 * single-backend row with `claims=[]`, `handlesPrefix=""`,
 * `dynamicTools=true`.
 *
 * Each row carries `input` so operators can trace back to the source
 * [inputs.<name>] block, plus `urlBinding`/`serviceBinding` inherited
 * from the spec when set (downstream manifest emitter wires those to
 * env bindings).
 *
 * Exported for unit tests.
 */
export function deriveGeneratedBackends(spec, meta) {
  const urlBinding     = typeof spec.urlBinding     === "string" ? spec.urlBinding     : "";
  const serviceBinding = typeof spec.serviceBinding === "string" ? spec.serviceBinding : "";

  if (meta === null) {
    // Heuristic fallback: one backend, claims=[] (legacy claim-all),
    // handlesPrefix="", dynamicTools=true. Per the README §"Heuristic
    // fallback": the resolver falls back to a documented single-backend
    // default + warning when _meta.art.cloister/v1 is absent.
    return [{
      input:          spec.name,
      name:           spec.name,
      handlesPrefix:  "",
      claims:         [],
      dynamicTools:   true,
      urlBinding,
      serviceBinding,
    }];
  }

  return meta.groups.map((g) => ({
    input:          spec.name,
    name:           g.name,
    // Default advertisedPrefix to "" when callers feed pre-validated
    // meta (parseServerJsonMeta fills the field) or when callers pass
    // a raw group object — wire/meta-groups.md treats absence as "".
    handlesPrefix:  typeof g.advertisedPrefix === "string" ? g.advertisedPrefix : "",
    claims:         g.upstreamNames.slice(),
    dynamicTools:   true,
    urlBinding,
    serviceBinding,
  }));
}

// ── Lockfile shape ──────────────────────────────────────────────────────

/**
 * Build the cluster.lock.toml document body. Header carries the
 * source cluster.toml's metadata + a generated-at timestamp. Each
 * input lands in its own `[inputs.<name>]` table mirroring the
 * source cluster.toml structure.
 *
 * Phase 3 (cloister-cb7263): when at least one resolved input carries
 * a `generatedBackends` array (one backend declaration per
 * `_meta.art.cloister/v1.groups[]` entry, or one heuristic-fallback
 * backend when _meta is absent), the lockfile gains a
 * `[[generated_backends]]` array-of-tables section. Operators commit
 * this; the downstream manifest emitter consumes it to wire the rows
 * into `cloister.capnp` backend declarations.
 */
export function buildLockfile(clusterMetadata, resolvedInputs) {
  const doc = {
    "_comment": "Generated by scripts/resolve-inputs.mjs (ADR-0026 Phase 1b + Phase 3). " +
                "Commit this file alongside cluster.toml — deploys verify each input's " +
                "sha256 against the committed digest. The [generated_backends] section " +
                "(when present) records the resolver's _meta.art.cloister/v1 → " +
                "backend-declaration mapping (cloister-cb7263, P3 of LLO arc). " +
                "A future ADR-0026 phase will add Interlace receipt signatures " +
                "(`signer` field populated from the input's actor).",
    "schema": "cloister/lockfile/v1",
    "cluster": clusterMetadata.name,
    "version": clusterMetadata.version,
    "inputs": Object.fromEntries(
      resolvedInputs.map((row) => [
        row.name,
        {
          ref:          row.ref,
          resolved:     row.resolved,
          sha256:       row.sha256,
          fetched_from: row.fetched_from,
          signer:       row.signer,
          bytes:        row.bytes,
        },
      ]),
    ),
  };

  // Flatten every input's generated_backends[] into a single
  // [[generated_backends]] array-of-tables. Each row carries its
  // `input` field so the operator can trace which [inputs.<name>]
  // block emitted it. Only emit the section when at least one row
  // exists — back-compat with older lockfiles that pre-date P3.
  const generatedRows = [];
  for (const row of resolvedInputs) {
    if (Array.isArray(row.generatedBackends)) {
      for (const backend of row.generatedBackends) {
        generatedRows.push(backend);
      }
    }
  }
  if (generatedRows.length > 0) {
    doc.generated_backends = generatedRows;
  }

  return doc;
}

// ── CLI ─────────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(CLUSTER_TOML_PATH)) {
    throw new ToolchainError(`cluster.toml not found at ${CLUSTER_TOML_PATH}`);
  }
  const raw = readFileSync(CLUSTER_TOML_PATH, "utf8");
  let parsed;
  try {
    parsed = parseToml(raw);
  } catch (e) {
    throw new ToolchainError(`failed to parse ${CLUSTER_TOML_PATH}: ${e.message}`);
  }

  const metadata = parsed.metadata ?? { name: "unknown", version: "0.0.0" };

  // [inputs.<name>] tables parse as { inputs: { <name>: {...} } }
  const inputsTable = parsed.inputs ?? {};
  const specs = Object.entries(inputsTable).map(([name, spec]) => ({
    name,
    ref:            typeof spec.ref            === "string" ? spec.ref            : "",
    version:        typeof spec.version        === "string" ? spec.version        : "",
    digest:         typeof spec.digest         === "string" ? spec.digest         : "",
    from:           typeof spec.from           === "string" ? spec.from           : "",
    // urlBinding / serviceBinding pass through to generated_backends
    // rows (cloister-cb7263, P3). They name env bindings; the resolver
    // doesn't dereference them — that's the downstream manifest
    // emitter's job.
    urlBinding:     typeof spec.urlBinding     === "string" ? spec.urlBinding     : "",
    serviceBinding: typeof spec.serviceBinding === "string" ? spec.serviceBinding : "",
    provides:       Array.isArray(spec.provides) ? spec.provides : [],
    requires:       Array.isArray(spec.requires) ? spec.requires : [],
  }));

  if (specs.length === 0) {
    console.log(`resolve-inputs: no [inputs.*] declared in ${CLUSTER_TOML_PATH} — nothing to resolve`);
    return;
  }

  console.log(`resolve-inputs: resolving ${specs.length} input(s) from ${CLUSTER_TOML_PATH}`);

  const resolved = [];
  const failures = [];
  for (const spec of specs) {
    try {
      const row = await resolveInput(spec);
      resolved.push(row);
      console.log(`  ✓ ${spec.name} → ${row.sha256.slice(0, 19)}... (${row.bytes} bytes)`);
    } catch (e) {
      failures.push(e);
      console.error(`  ✗ ${spec.name}: ${e.detail ?? e.message}`);
    }
  }

  if (failures.length > 0) {
    console.error(`\nresolve-inputs: ${failures.length} input(s) failed to resolve`);
    process.exit(1);
  }

  const doc = buildLockfile(metadata, resolved);
  writeFileSync(LOCKFILE_PATH, stringifyToml(doc));
  console.log(`\nresolve-inputs: wrote ${LOCKFILE_PATH}`);
}

// Run when invoked as a script (not when imported by tests).
const invokedAsScript = process.argv[1] && resolvePath(process.argv[1]) === resolvePath(fileURLToPath(import.meta.url));
if (invokedAsScript) {
  main().catch((e) => {
    if (e instanceof ToolchainError) {
      console.error(`resolve-inputs: ${e.message}`);
      process.exit(2);
    }
    console.error(`resolve-inputs: unexpected error: ${e.message}`);
    process.exit(2);
  });
}
