// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Cluster input resolver — ADR-0026 Phase 1b + Phase 2 subpiece 1
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
// `leyline-schema-spec/mcp-tool/v1 (LLO rs/ll-core/schema-spec/mcp-tool/v1)/`), the resolver derives ONE backend
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
import { fileURLToPath, pathToFileURL } from "node:url";

import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(HERE, "../../..");

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
  // Parsed once: `meta` drives backend partitioning, the whole document also
  // carries `remotes[].type`, from which session-ness is derived.
  let doc = null;
  try { doc = JSON.parse(new TextDecoder().decode(bytes)); } catch { doc = null; }

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
  if (isArtifactOnly(doc)) {
    // An artifact publisher declares image identity and NOTHING else. It gets
    // no backends, no routes, no session state — cloister-02dd65's acceptance
    // says so explicitly, and the heuristic fallback below would otherwise
    // manufacture a single claim-all backend for a producer that serves no MCP
    // at all. That backend would then be wired to a urlBinding nothing answers.
    generatedBackends = [];
  } else if (meta) {
    try {
      generatedBackends = deriveGeneratedBackends(spec, meta, doc);
    } catch (e) {
      // deriveStripPrefix (cloister-2d987e, Bug 3) throws when a
      // group's upstreamNames mix bare + already-prefixed names — a
      // malformed group cloister can't safely derive routing for.
      // Wrap as ResolveError so the CLI's per-input failure list names
      // the input, matching the parseServerJsonMeta error handling above.
      throw new ResolveError(spec.name, e.message);
    }
  } else {
    generatedBackends = deriveGeneratedBackends(spec, null, doc);
    // Warn so the operator knows they're getting a single backend
    // rather than a partitioned set. README §"Heuristic fallback":
    // the fallback exists + emits a warning + does NOT fail the build.
    console.warn(
      `resolve-inputs: input ${spec.name}: no _meta.art.cloister/v1 — ` +
      `using single-backend fallback. For multi-group servers, ask the ` +
      `maintainer to add _meta.`,
    );
  }

  // ADR-0038: the tool's self-declared OCI image, if its server.json
  // carries a `packages[]` oci entry. null → the emit step falls back to
  // the operator's hand-set ext.image (or warns loudly if neither exists).
  let oci = null;
  try {
    oci = parsePackagesOci(bytes);
  } catch (e) {
    throw new ResolveError(spec.name, e.message);
  }

  // ADR-0041 / cloister-091106: pin the image by IMMUTABLE DIGEST, not the
  // mutable tag. When the server.json declares oci by identifier+version (a
  // tag) with no digest, resolve the tag → digest at resolve time so the lock
  // pins `identifier@sha256:…` and emit-compose pulls by digest. Best-effort:
  // on failure (private image w/o creds, offline) fall back to the tag with a
  // LOUD warning — a mutable-tag pull is a real supply-chain downgrade.
  // Every artifact gets a digest, not just the primary. A producer's SECOND
  // image is exactly as much a supply-chain input as its first, and pinning one
  // while leaving the other on a mutable tag would be the same downgrade this
  // block exists to prevent — just quieter, because nothing would say so.
  if (oci && Array.isArray(oci.all) && oci.all.length > 1) {
    const resolvedAll = [];
    for (const entry of oci.all) {
      if (entry.identifier && entry.version && !entry.digest) {
        const p = await probeOciDigest(entry.identifier, entry.version);
        resolvedAll.push(p.state === "present" && p.digest ? { ...entry, digest: p.digest } : entry);
      } else {
        resolvedAll.push(entry);
      }
    }
    oci = { ...oci, all: resolvedAll };
    // Keep the primary in step with its own resolved entry.
    if (resolvedAll[0]?.digest) oci = { ...oci, digest: resolvedAll[0].digest };
  }

  if (oci && oci.identifier && oci.version && !oci.digest) {
    const probe = await probeOciDigest(oci.identifier, oci.version);
    const digest = probe.state === "present" ? probe.digest : "";
    if (digest) {
      oci = { ...oci, digest };
    } else if (typeof spec.mutableTagReason === "string" && spec.mutableTagReason !== "") {
      // Explicitly acknowledged by the operator. Still loud — a mutable-tag
      // pin is a real supply-chain downgrade, and the acknowledgement records
      // WHO accepted it, not that it stopped being one.
      process.stderr.write(
        `resolve-inputs: ${spec.name}: pinning by MUTABLE TAG ` +
        `${oci.identifier}:${oci.version} (${probe.state}` +
        `${probe.detail ? `: ${probe.detail}` : ""}) — reason: ` +
        `${spec.mutableTagReason}. An upstream re-push can flow through until ` +
        `that condition lifts.\n`,
      );
      // Record WHY there is no digest, rather than omitting the field and
      // leaving a reader to infer it. lectio's rule: an unresolved reference is
      // surfaced, not hidden, and "outside coverage" is never reported as
      // "does not exist".
      oci = { ...oci, unresolved: probe.state, unresolvedDetail: probe.detail ?? "" };
    } else {
      // FAIL CLOSED (ADR-0041). Previously this warned and pinned by mutable
      // tag anyway, which is a supply-chain downgrade accepted silently-enough
      // that it survives review — the warning scrolls past in a build log and
      // the lockfile looks pinned.
      //
      // An unresolvable digest means the declared image does not exist, is
      // private, or the registry is unreachable. None of those should produce
      // a lockfile that LOOKS pinned. Refusing names the input and the reason;
      // an operator who genuinely wants the downgrade states a mutableTagReason and
      // the acknowledgement is recorded in cluster.toml where review sees it.
      throw new ResolveError(
        spec.name,
        `could not resolve an OCI digest for ${oci.identifier}:${oci.version} — ` +
        `registry probe returned "${probe.state}"` +
        `${probe.detail ? ` (${probe.detail})` : ""}. ` +
        `Note ghcr answers identically for an unpublished and a private image, so ` +
        `"unauthorized" does NOT mean the image is absent. ` +
        `Refusing to pin by mutable tag: the lockfile would look ` +
        `pinned while an upstream re-push flowed through. Publish the image, provide ` +
        `registry auth, or set \`mutableTagReason = "…"\` on [inputs.${spec.name}] ` +
        `stating why and what lifts it (ADR-0041).`,
      );
    }
  }

  // Bundle -> image map from the producer's own topology block. Joined against
  // the resolved artifacts so each bundle carries a DIGEST, not just a name.
  const bundleDecls = parseBundleDeclarations(doc);
  const ociBundles = bundleDecls.size === 0 ? [] : [...bundleDecls].map(([bundle, decl]) => {
    const identifier = decl.package;
    const hit = (oci?.all ?? []).find((e) => e.identifier === identifier);
    if (!hit) {
      throw new ResolveError(
        spec.name,
        `_meta.art.cloister/v1.bundles declares bundle ${JSON.stringify(bundle)} runs ` +
        `${JSON.stringify(identifier)}, but no artifact with that identifier is declared. ` +
        `The topology block and the artifacts list disagree.`,
      );
    }
    return {
      bundle, identifier, version: hit.version, digest: hit.digest,
      // The producer's own declaration, carried so Inv 14 can compare it with
      // what cluster.toml restates by hand (cloister-d8e8fb).
      declared: { tier: decl.tier, kind: decl.kind, httpPort: decl.httpPort, ipcSocket: decl.ipcSocket },
    };
  });

  return {
    name:              spec.name,
    ref:               spec.ref,
    resolved:          spec.version || "",
    sha256:            `sha256:${sha256}`,
    fetched_from:      fetchedFrom,
    signer:            "", // Interlace receipts will populate (future ADR-0026 phase)
    bytes:             bytes.length,
    generatedBackends,
    oci,
    // Bundle -> resolved image, as the PRODUCER declares it. Empty for a
    // single-image input. Not derivable from the addresses — notme's bundle
    // `notme-identity` runs image `.../notme` — so it is carried, not inferred.
    ociBundles,
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
// Spec: leyline-schema-spec/mcp-tool/v1 (LLO rs/ll-core/schema-spec/mcp-tool/v1)/README.md + wire/meta-groups.md.
// Canonical fixture: leyline-schema-spec/mcp-tool/v1 (LLO rs/ll-core/schema-spec/mcp-tool/v1)/vectors/example-multi-group.json.
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
 * `leyline-schema-spec/mcp-tool/v1 (LLO rs/ll-core/schema-spec/mcp-tool/v1)/wire/meta-groups.md` §"Constraint matrix".
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
 * Parse the tool's self-declared container image from a resolved server.json.
 *
 * Two sources, in precedence order (ADR-0038; artifact-only mode per
 * cloister-02dd65 / notme-6e5330):
 *
 *   1. `packages[]` — the MCP-native field. Authoritative when present.
 *   2. `_meta['io.modelcontextprotocol.registry/publisher-provided'].artifacts`
 *      — for a producer that publishes IMAGES and serves no MCP.
 *
 * Why (2) exists: the 2025-12-11 schema's `Package.required` includes
 * `transport`, so an artifact-only producer cannot use `packages[]` without
 * failing the schema its own `$schema` key names. The tempting fix — a
 * placeholder `{"type":"stdio"}` — would be schema-valid and semantically
 * FALSE, and cloister derives session behaviour from
 * `packages[].transport.type`, so it would generate backends for tools that do
 * not exist. The schema makes `packages[]` optional and this `_meta` slot is
 * its designed extension point, so the artifact-only shape validates AND
 * implies no MCP surface.
 *
 * An `artifacts` entry is PACKAGE IDENTITY ONLY — never a transport, a
 * session, or a backend. See `declaredTransportTypes` / `deriveRequiresSession`,
 * which deliberately do not read this slot.
 *
 * Returns `{ identifier, version, digest }` for the FIRST
 * `registryType == "oci"` entry, or `null` when the bytes aren't JSON or
 * neither source carries one (→ emit falls back to the operator's
 * `ext.image`). Throws when an oci entry is present but malformed
 * (declared-but-no-identifier) — an opt-in must be correct, mirroring
 * `parseServerJsonMeta`'s constraint handling.
 */
/**
 * Is this descriptor an ARTIFACT PUBLISHER rather than an MCP server?
 *
 * Derived, never declared — the same discipline as requiresSession itself. A
 * descriptor that carries `_meta` artifacts and declares no tool groups is
 * publishing image identity and nothing else: notme ships two hypervisor-tier
 * bundle images and serves no MCP surface at all.
 *
 * This exists because two correct changes collided. #226 taught the resolver to
 * read the artifacts extension so artifact-only producers could be consumed;
 * cloister-553c39 then made an input that declares no transport a hard refusal,
 * on the grounds that guessing requiresSession is indefensible. Both hold for an
 * MCP server. For an artifact publisher the refusal asks a question that does
 * not apply — there is no session to require because there is no protocol —
 * and `[inputs.notme]` became undeclarable.
 *
 * Note declaredTransportTypes already refuses to read the artifacts array,
 * documented as "reading them here would treat an image publisher as an MCP
 * server". That instinct was right and is now load-bearing in both directions:
 * artifacts do not make you a server, and not being a server exempts you from
 * the server's obligations.
 *
 * @param {unknown} doc Parsed server.json.
 * @returns {boolean}
 */
export function isArtifactOnly(doc) {
  if (!doc || typeof doc !== "object") return false;
  const pp = doc._meta?.["io.modelcontextprotocol.registry/publisher-provided"];
  const hasArtifacts = Array.isArray(pp?.artifacts) && pp.artifacts.length > 0;
  if (!hasArtifacts) return false;
  const groups = doc._meta?.["art.cloister/v1"]?.groups;
  return !Array.isArray(groups) || groups.length === 0;
}

/**
 * Bundle name -> image identifier, as the producer declares it.
 *
 * A multi-image producer names which bundle runs which image; the mapping is NOT
 * derivable from the addresses. notme declares bundle `notme-identity` running
 * image `.../notme` — basename matching would bind it to nothing, or worse, to
 * the wrong image without saying so. Its own descriptor states the reason:
 * "This block is notme's own topology and is not derivable from the image
 * addresses."
 *
 * @param {unknown} doc
 * @returns {Map<string,string>} bundle name -> identifier
 */
export function parseBundlePackageMap(doc) {
  const out = new Map();
  for (const [name, row] of parseBundleDeclarations(doc)) out.set(name, row.package);
  return out;
}

/**
 * The producer's FULL per-bundle declaration, not just the image.
 *
 * `cluster.toml` restates four of these by hand — tier, kind, the wire fact
 * (httpPort or ipcSocket), and the rationale paragraph verbatim — with nothing
 * checking agreement (cloister-d8e8fb). That is the shape cloister-cb735c
 * measured for images: two statements of one fact, only one of which tracks the
 * upstream. The image half is railed by Inv 10; these were not.
 *
 * Carried into the lockfile so the lint can compare. The lockfile is GENERATED,
 * so a derived copy there cannot rot the way a hand-written one does — which is
 * the distinction that makes this a fix rather than a second duplication.
 *
 * SCALARS ONLY. The `rationale` paragraph is deliberately NOT carried: exact
 * prose comparison would flap on any rewording, and a rail that cries wolf on a
 * typo fix gets disabled — which costs more than it catches. Tier, port and
 * socket have crisp equality and are the facts whose disagreement actually
 * changes behaviour.
 *
 * @returns {Map<string, {package: string, tier: string, kind: string, httpPort: number|null, ipcSocket: string|null}>}
 */
export function parseBundleDeclarations(doc) {
  const out = new Map();
  const bundles = doc?._meta?.["art.cloister/v1"]?.bundles;
  if (!Array.isArray(bundles)) return out;
  for (const b of bundles) {
    // A half-stated row is not half-believed: name + package are what make the
    // row usable at all, so a row missing either is skipped entirely rather
    // than contributing a partial entry nothing can act on.
    if (!b || typeof b !== "object") continue;
    if (typeof b.name !== "string" || typeof b.package !== "string") continue;
    out.set(b.name, {
      package: b.package.trim(),
      tier: typeof b.tier === "string" ? b.tier : "",
      kind: typeof b.kind === "string" ? b.kind : "",
      httpPort: Number.isInteger(b.httpPort) ? b.httpPort : null,
      ipcSocket: typeof b.ipcSocket === "string" ? b.ipcSocket : null,
    });
  }
  return out;
}

export function parsePackagesOci(bytes) {
  let doc;
  try {
    const text = typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8");
    doc = JSON.parse(text);
  } catch {
    return null; // Not JSON ⇒ no packages block.
  }
  if (!doc || typeof doc !== "object") return null;

  // Where to look, in precedence order.
  //
  // `packages[]` is the MCP-native field and stays authoritative: a producer
  // mid-migration may carry BOTH, and behaviour must not change under one who
  // adds the extension before dropping packages[] (tolerant-parallel reading,
  // notme-6e5330).
  //
  // `_meta['io.modelcontextprotocol.registry/publisher-provided'].artifacts`
  // is the fallback for an ARTIFACT-ONLY producer — one that publishes images
  // and serves no MCP. Such a producer cannot use `packages[]` at all: the
  // 2025-12-11 schema's `Package.required` includes `transport`, so a
  // transport-less package fails the schema its own `$schema` names. The wrong
  // fix is a placeholder `{"type":"stdio"}` — schema-valid and semantically
  // false, which would make cloister generate backends for tools that do not
  // exist. The schema makes `packages[]` optional and this `_meta` slot is its
  // designed extension point, so an artifact-only file validates AND implies
  // no MCP surface.
  //
  // CRITICAL SEMANTIC: an `artifacts` entry is PACKAGE IDENTITY ONLY. It never
  // implies a transport, a session, or a backend. `declaredTransportTypes` and
  // `deriveRequiresSession` deliberately do not read this slot — pinned by
  // tests, because leaking it there is exactly the failure notme avoided by
  // refusing a placeholder transport.
  const publisherProvided = doc._meta?.["io.modelcontextprotocol.registry/publisher-provided"];
  const candidates = Array.isArray(doc.packages)
    ? doc.packages
    : Array.isArray(publisherProvided?.artifacts)
      ? publisherProvided.artifacts
      : null;
  if (!candidates) return null;

  const source = Array.isArray(doc.packages) ? "packages[]" : "_meta publisher-provided artifacts[]";

  // Tolerate both the camelCase (`registryType`) and snake_case
  // (`registry_type`) spellings the MCP registry schema has used.
  // ALL oci entries, not the first. A single-image producer is the common case
  // and still yields a one-element list; a multi-image producer is why this is a
  // list at all.
  //
  // This was `.find(...)` returning one entry, which meant notme — one manifest
  // declaring TWO images for TWO separately-declared bundles — could only ever
  // pin its first. notme called it before it bit: "Whatever 02dd65 implements
  // shouldn't inherit that." It did (cloister-370eac).
  const ociEntries = candidates.filter(
    (p) => p && typeof p === "object" && (p.registryType ?? p.registry_type) === "oci",
  );
  if (ociEntries.length === 0) return null;

  const parsed = ociEntries.map((oci) => {
    const identifier = typeof oci.identifier === "string" ? oci.identifier.trim() : "";
    if (!identifier) {
      throw new Error(
        `${source} declares a registryType="oci" entry with no "identifier" — ` +
        `an oci entry must name a pullable image reference`,
      );
    }
    return {
      identifier,
      version: typeof oci.version === "string" ? oci.version.trim() : "",
      digest: typeof oci.digest === "string" ? oci.digest.trim() : "",
    };
  });

  // The first entry stays the primary for every single-image consumer; `all`
  // carries the rest so a multi-image producer is not silently truncated.
  // Additive rather than a shape change, because four inputs already depend on
  // the single-object form.
  return { ...parsed[0], all: parsed };
}

/**
 * Resolve an OCI image reference (tagless `identifier` + `ref` tag) to its
 * immutable digest via a Docker registry v2 manifest HEAD (ADR-0041 /
 * cloister-091106). This is the "pin by digest, not tag" security step: the
 * mutable tag is resolved to an immutable `sha256:` at RESOLVE time (TOFU), and
 * consumers pull BY DIGEST — so an upstream re-push after resolve can't flow
 * through until a deliberate re-resolve surfaces the changed digest as a diff.
 *
 * Standard registry auth: HEAD the manifest; on 401, parse the
 * `WWW-Authenticate: Bearer` challenge, fetch an (anonymous, for public repos)
 * token, retry. Returns the `docker-content-digest` header, or "" on ANY
 * failure (private image without creds, network, non-v2 registry). Best-effort
 * by design — a resolve must not hard-fail because a registry is unreachable;
 * the caller warns loudly + falls back to the tag. `fetchImpl` is injectable
 * for tests.
 */
/**
 * Probe a registry for a tag's digest, reporting WHICH outcome occurred.
 *
 * The predecessor this replaced collapsed six distinct conditions into `""` — no registry
 * host, an unparseable auth challenge, no realm, no bearer, any non-ok status,
 * and a thrown fetch. A caller then cannot tell "the image is not published"
 * from "I could not look", and the refusal message has to hedge with a
 * disjunction ("unpublished, private without creds, or unreachable").
 *
 * That collapse is what lectio's model forbids: absence is not nonexistence,
 * and "outside coverage" must not be reported as "does not exist"
 * (lectio ARCHITECTURE.md; `read.rs` — "predating first_observed_at is
 * 'outside coverage', not absent"). lectio surfaces an unresolvable reference
 * explicitly — `dangling: true`, "surfaced not hidden" — rather than omitting
 * the field.
 *
 * Outcomes, and what each tells an operator to DO:
 *
 *   { state: "present",     digest }  pinned; nothing to do
 *   { state: "absent"    }            the registry answered 404 — publish it
 *   { state: "unauthorized" }         401/403 and no anonymous token — it may
 *                                     or may not exist; provide creds
 *   { state: "unreachable", detail }  network/5xx — retry; says nothing about
 *                                     whether the image exists
 *   { state: "notApplicable" }        no registry host in the ref — nothing
 *                                     was ever asked
 *
 * @returns {Promise<{state: string, digest?: string, detail?: string}>}
 */
export async function probeOciDigest(ref, version, fetchImpl = fetch) {
  const slash = String(ref || "").indexOf("/");
  if (slash < 0 || !ref) return { state: "notApplicable" };
  const registry = String(ref).slice(0, slash);
  const repo = String(ref).slice(slash + 1);
  const accept = [
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.docker.distribution.manifest.v2+json",
  ].join(", ");
  const manifestUrl = `https://${registry}/v2/${repo}/manifests/${version}`;
  try {
    let res = await fetchImpl(manifestUrl, { method: "HEAD", headers: { Accept: accept } });
    if (res.status === 401) {
      const challenge = res.headers.get("www-authenticate") || "";
      const m = /Bearer\s+(.+)/i.exec(challenge);
      if (!m) return { state: "unauthorized", detail: "401 with no parseable Bearer challenge" };
      const params = Object.fromEntries(
        m[1].split(",").map((kv) => {
          const eq = kv.indexOf("=");
          return [kv.slice(0, eq).trim(), kv.slice(eq + 1).trim().replace(/^"|"$/g, "")];
        }),
      );
      if (!params.realm) return { state: "unauthorized", detail: "401 challenge names no realm" };
      const tokenUrl = new URL(params.realm);
      if (params.service) tokenUrl.searchParams.set("service", params.service);
      if (params.scope) tokenUrl.searchParams.set("scope", params.scope);
      const tok = await fetchImpl(tokenUrl.toString())
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      const bearer = tok && (tok.token || tok.access_token);
      if (!bearer) return { state: "unauthorized", detail: "anonymous token exchange refused" };
      res = await fetchImpl(manifestUrl, {
        method: "HEAD",
        headers: { Accept: accept, Authorization: `Bearer ${bearer}` },
      });
    }
    // 404 is the one status that means the image genuinely is not there.
    // Everything else non-ok is "could not determine" and must not be reported
    // as absence.
    if (res.status === 404) return { state: "absent" };
    if (res.status === 401 || res.status === 403) {
      return { state: "unauthorized", detail: `registry returned ${res.status}` };
    }
    if (!res.ok) return { state: "unreachable", detail: `registry returned ${res.status}` };
    const digest = res.headers.get("docker-content-digest") || "";
    if (!digest) return { state: "unreachable", detail: "200 with no docker-content-digest header" };
    return { state: "present", digest };
  } catch (e) {
    return { state: "unreachable", detail: String(e && e.message ? e.message : e) };
  }
}

/**
 * Shape an input's resolved oci package into the cluster.lock.toml row.
 * Omits empty version/digest so the emitted TOML stays minimal.
 */
function ociLockfileRow(oci) {
  const row = { identifier: oci.identifier };
  if (oci.version) row.version = oci.version;
  if (oci.digest) row.digest = oci.digest;
  // When there is no digest, say WHY. Omitting the field made "unpinned"
  // indistinguishable from "digest not applicable" — a reader of the lockfile
  // alone could not tell a deliberate downgrade from a shape that never had an
  // image. Per lectio's rule, an unresolved reference is surfaced rather than
  // hidden, and "outside coverage" is never rendered as "does not exist":
  // ghcr answers identically for an unpublished and a private image, so this
  // records `unauthorized`, never `absent`, unless the registry actually 404s.
  if (!oci.digest && oci.unresolved) {
    row.unresolved = oci.unresolved;
    if (oci.unresolvedDetail) row.unresolvedDetail = oci.unresolvedDetail;
  }
  return row;
}

/**
 * Derive the `stripPrefix` a generated backend needs, given one group's
 * `advertisedPrefix` + `upstreamNames` (cloister-2d987e, Bug 3 of the
 * mache resolver migration).
 *
 * `McpProxyToolBackend.handles()` (src/manifest/backends/mcp-proxy.ts)
 * checks the EXTERNAL/advertised tool name against `claims`, which holds
 * the BARE `upstreamNames` verbatim. `tools()` advertises each upstream
 * name as `advertisedPrefix + upstreamName` UNLESS the upstream name
 * already starts with the prefix (the "don't-double-prefix" rule, per
 * wire/meta-groups.md). So:
 *
 *   - already-prefixed upstreamNames (llo's shape: advertisedPrefix
 *     "lsp_", upstreamNames ["lsp_hover", ...]) — the advertised name
 *     equals the bare upstream name; claims already match; no stripping
 *     needed. stripPrefix stays "".
 *   - bare upstreamNames under a non-empty advertisedPrefix (mache's
 *     shape: advertisedPrefix "mache_", upstreamNames ["find_callers",
 *     ...]) — the advertised name is "mache_find_callers" but claims
 *     only holds "find_callers". handles()'s claims check needs
 *     stripPrefix = advertisedPrefix so it can un-prefix the incoming
 *     call before matching against claims.
 *
 * A group whose upstreamNames MIX both shapes (some already start with
 * advertisedPrefix, some don't) can't be given one correct stripPrefix —
 * stripping would break the already-prefixed subset (double-strip) or
 * leaving it unset would break the bare subset (Bug 3). That's a
 * malformed group; this throws rather than silently guessing.
 *
 * Returns "" when advertisedPrefix is empty (no prefix to strip) or all
 * upstreamNames are already prefixed.
 *
 * Exported for unit tests.
 */
export function deriveStripPrefix(group) {
  const prefix = typeof group.advertisedPrefix === "string" ? group.advertisedPrefix : "";
  if (prefix === "") return "";

  const names = Array.isArray(group.upstreamNames) ? group.upstreamNames : [];
  const bareCount     = names.filter((n) => !n.startsWith(prefix)).length;
  const prefixedCount = names.length - bareCount;

  if (bareCount > 0 && prefixedCount > 0) {
    throw new Error(
      `_meta.art.cloister/v1.groups (name="${group.name}"): upstreamNames mixes names ` +
      `already prefixed with "${prefix}" and bare names that aren't — cloister can't ` +
      `derive a single correct stripPrefix for this group. Either prefix every ` +
      `upstreamNames entry with "${prefix}" or none of them.`,
    );
  }

  // All-bare → strip the advertised prefix before matching claims.
  // All-already-prefixed → advertised name already equals the claim;
  // nothing to strip.
  return bareCount > 0 ? prefix : "";
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
/**
 * Derive whether generated backends must run the MCP session lifecycle, from
 * the transport the SERVER declares (cloister-4ae222, ADR-0057 property A).
 *
 * The tool already publishes this, in one of two places — see
 * `declaredTransportTypes()` for both shapes and why both are read. Requiring
 * an operator to ALSO set `requiresSession` in cluster.toml made it a second
 * statement of one fact — and mache's row omitted it, so every `mache_*` tool
 * silently vanished from tools/list with a 404 "Invalid session ID"
 * (cloister-af794d). A boolean per input is also unrepresentable for a server
 * offering both stdio and streamable-http.
 *
 * What is derived, and why it is safe:
 *   stdio            -> false. A pipe has no session; there is nothing to
 *                       establish.
 *   streamable-http  -> true. NOTE the MCP spec makes `Mcp-Session-Id`
 *                       OPTIONAL for the server to assign, so this is not
 *                       "the spec guarantees a session". It is: perform the
 *                       `initialize` handshake (which MCP requires anyway) and
 *                       carry the session id back IF one is returned. That is
 *                       correct against both session-requiring servers
 *                       (mark3labs/mcp-go — mache, rosary) and sessionless
 *                       ones, so deriving true costs nothing when false.
 *   sse              -> true. Legacy transport with its own session model.
 *
 * Returns null when no transport is declared, so the caller can fall back to
 * the operator's explicit value rather than guessing.
 *
 * @param {unknown} doc Parsed server.json.
 * @returns {boolean|null}
 */
export function deriveRequiresSession(doc) {
  const types = declaredTransportTypes(doc);
  if (types.length === 0) return null;
  // Any HTTP-shaped transport means run the lifecycle. A server offering both
  // stdio and streamable-http still needs it on the HTTP leg, which is the leg
  // cloister uses — a single boolean cannot express "depends", so bias to the
  // transport cloister actually speaks.
  return types.some((t) => t === "streamable-http" || t === "sse");
}

/**
 * Transport type strings a server.json declares, from EITHER location.
 *
 * Two shapes coexist in the ecosystem as of 2026-07-28 and both are live:
 *
 *   remotes[].type              mache, rosary, canonical-hours
 *   packages[].transport.type   ley-line-open (11.2 dropped `remotes` entirely)
 *
 * Reading only `remotes[]` silently returns null for ley-line-open, which falls
 * back to the operator's explicit flag — unset for [inputs.llo] — and would have
 * treated a streamable-http server as sessionless. That is the same failure that
 * hid every mache_* tool behind a 404, arriving from the other direction.
 *
 * This is deliberately tolerant rather than picking a winner: cloister does not
 * own the registry schema and cannot make upstreams converge. When one shape
 * wins, delete the other branch — do not add a third.
 *
 * @param {unknown} doc Parsed server.json.
 * @returns {string[]}
 */
export function declaredTransportTypes(doc) {
  if (!doc || typeof doc !== "object") return [];
  // Deliberately does NOT read
  // `_meta['io.modelcontextprotocol.registry/publisher-provided'].artifacts`.
  // Those entries are package identity for an artifact-only producer and imply
  // no MCP surface (cloister-02dd65 / notme-6e5330). Reading them here would
  // treat an image publisher as an MCP server — the exact failure notme avoided
  // by refusing a placeholder transport. Pinned by test.
  const out = [];
  const push = (t) => { if (typeof t === "string" && t) out.push(t); };

  if (Array.isArray(doc.remotes)) {
    for (const r of doc.remotes) if (r && typeof r === "object") push(r.type);
  }
  if (Array.isArray(doc.packages)) {
    for (const pkg of doc.packages) {
      if (pkg && typeof pkg === "object" && pkg.transport && typeof pkg.transport === "object") {
        push(pkg.transport.type);
      }
    }
  }
  return out;
}

/**
 * The socket path when an input declares `transport = "uds"`, else null.
 *
 * A uds transport with an EMPTY socketPath is rejected rather than defaulted:
 * there is no sensible default socket, and silently falling back to mcpProxy
 * would resolve an operator's declared intent into a different transport
 * without saying so. Fail closed and name the input (ADR-0051).
 *
 * @param {object} spec
 * @returns {string|null}
 */
export function udsSocketPath(spec) {
  const c = spec && typeof spec === "object" ? spec.connection : undefined;
  if (!c || typeof c !== "object") return null;
  const t = c.transport;
  const isUds = typeof t === "string" ? t === "uds" : !!(t && typeof t === "object" && "uds" in t);
  if (!isUds) return null;
  const path = typeof c.socketPath === "string" ? c.socketPath.trim() : "";
  if (path === "") {
    throw new Error(
      `input "${spec.name}" declares connection.transport = "uds" with no socketPath — ` +
      `a uds connection must name the socket to dial`,
    );
  }
  return path;
}

export function deriveGeneratedBackends(spec, meta, doc = null) {
  const urlBinding     = typeof spec.urlBinding     === "string" ? spec.urlBinding     : "";
  const serviceBinding = typeof spec.serviceBinding === "string" ? spec.serviceBinding : "";
  // ADR-0051 §3: a UDS input emits `udsForward` rows carrying socketPath;
  // everything else keeps emitting `mcpProxy` exactly as before. The companion
  // dial and capnp ToolCall/ToolResult codec downstream are reused unchanged —
  // this only selects which backend kind the lockfile row names.
  //
  // requiresSession is deliberately NOT threaded onto a udsForward row: the MCP
  // session lifecycle is a Streamable-HTTP concern, and a capnp-over-UDS call
  // has no HTTP request to carry `Mcp-Session-Id` on. Emitting it would be a
  // field the transport cannot honour.
  const uds = udsSocketPath(spec);

  // requiresSession is DERIVED from the transport the server declares, and there
  // is no fallback (cloister-553c39).
  //
  // The operator used to be able to state it in cluster.toml, and an undeclared
  // transport fell back to that flag — defaulting to false when unset. Both
  // halves were wrong:
  //
  //   As a declaration, it restated a fact the server already publishes. mache's
  //   row omitted it once and every mache_* tool vanished from tools/list behind
  //   a 404 "Invalid session ID" (cloister-af794d), because a boolean nobody
  //   maintained disagreed with the transport.
  //
  //   As a fallback, it GUESSED. An undeclared transport is an unresolvable
  //   fact, and neither guess is defensible: false skips the handshake and
  //   404s a session-requiring server (mache + rosary are mark3labs/mcp-go,
  //   which enforces Mcp-Session-Id); true sends a handshake to a stdio server
  //   that has no session to establish.
  //
  // So it fails closed instead, naming the input — the same posture as the OCI
  // digest refusal above, and for the same reason: a lockfile that LOOKS
  // resolved is worse than a build that stops. This is measurably load-bearing,
  // not theoretical: rosary's server.json on main ships packages[0].transport
  // MISSING (rosary-5d9d56), so bumping that input reaches exactly this branch.
  //
  // Not applicable to a UDS row: the MCP session lifecycle is a Streamable-HTTP
  // concern and a capnp-over-UDS call has no HTTP request to carry
  // `Mcp-Session-Id` on, so the field is never emitted there and an undeclared
  // transport is not a problem for it.
  // Scope: this refuses a server.json that PARSED and declares no transport —
  // rosary's actual shape. It deliberately does NOT refuse `doc === null`, which
  // means the bytes were not JSON at all. That path already has a documented,
  // deliberately tolerant contract (README §"Heuristic fallback": one backend,
  // a loud warning, and NOT a build failure), and turning it into a hard refusal
  // here would be a second, unrelated behaviour change smuggled in — the tests
  // that pin the tolerant path caught the attempt.
  let requiresSession = false;
  // An artifact publisher is exempt: it declares no protocol, so "does it need a
  // session" is not an unanswered question, it is an inapplicable one.
  if (uds === null && doc !== null && typeof doc === "object" && !isArtifactOnly(doc)) {
    const derived = deriveRequiresSession(doc);
    if (derived === null) {
      // Plain Error, not ResolveError: deriveGeneratedBackends' caller already
      // wraps thrown messages as `ResolveError(spec.name, e.message)`, so
      // constructing one here produced `input "llo": input "llo": …`. Same
      // convention as deriveStripPrefix.
      throw new Error(
        `declares no transport, so requiresSession cannot be derived. Cloister ` +
        `reads either \`remotes[].type\` or \`packages[].transport.type\`; this ` +
        `server.json has neither. Refusing to guess: false would skip the MCP ` +
        `session handshake and 404 every tool on a session-requiring server, ` +
        `true would send a handshake to a stdio server. Ask the producer to ` +
        `publish its transport (ADR-0057 property A).`,
      );
    }
    requiresSession = derived;
  }

  const transportFields = uds !== null
    ? { kind: "udsForward", socketPath: uds }
    : { urlBinding, serviceBinding, ...(requiresSession ? { requiresSession: true } : {}) };

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
      ...transportFields,
    }];
  }

  return meta.groups.map((g) => ({
    input:          spec.name,
    name:           g.name,
    // Default advertisedPrefix to "" when callers feed pre-validated
    // meta (parseServerJsonMeta fills the field) or when callers pass
    // a raw group object — wire/meta-groups.md treats absence as "".
    handlesPrefix:  typeof g.advertisedPrefix === "string" ? g.advertisedPrefix : "",
    // stripPrefix (cloister-2d987e, Bug 3): only needed when
    // upstreamNames are bare under a non-empty advertisedPrefix — see
    // deriveStripPrefix's doc comment. "" for llo's already-prefixed
    // shape preserves today's behavior exactly.
    stripPrefix:    deriveStripPrefix(g),
    claims:         g.upstreamNames.slice(),
    dynamicTools:   true,
    ...transportFields,
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
    "_comment": "Generated by cloister cluster resolve (ADR-0026 Phase 1b + Phase 3). " +
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
          // ADR-0038: the tool's self-declared OCI image (packages[].oci),
          // when present. Omitted for inputs whose server.json carries no
          // oci package — back-compat with pre-ADR-0038 lockfiles.
          ...(row.oci ? { oci: ociLockfileRow(row.oci) } : {}),
          // Per-bundle images for a multi-image producer, each digest-pinned.
          // Absent for the single-image case, so four existing inputs are
          // byte-unchanged.
          ...(row.ociBundles?.length ? { ociBundles: row.ociBundles.map((b) => ({
            bundle: b.bundle,
            ...ociLockfileRow(b),
            // The producer's own per-bundle facts, carried so Inv 14 can compare
            // them against what cluster.toml restates by hand (cloister-d8e8fb).
            // Empty values are dropped so the lockfile stays byte-stable for a
            // producer that declares only the image.
            ...(b.declared?.tier ? { declaredTier: b.declared.tier } : {}),
            ...(b.declared?.kind ? { declaredKind: b.declared.kind } : {}),
            ...(b.declared?.httpPort ? { declaredHttpPort: b.declared.httpPort } : {}),
            ...(b.declared?.ipcSocket ? { declaredIpcSocket: b.declared.ipcSocket } : {}),
          })) } : {}),
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

export async function main() {
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
  // The input field list is DERIVED from `struct InputSpec` in
  // manifest/cluster.capnp, via the strict schema schema-bridge generates
  // (cloister-71a9f4). It used to be hand-enumerated here, and that list
  // silently dropped whatever nobody remembered to add: ADR-0051's
  // `connection` shipped declarable-and-invisible for exactly this reason
  // (#211), and `tenancy` is dropped by this function today.
  //
  // Deriving the list means a new schema field reaches the resolver without
  // anyone editing this file, and an unknown key in cluster.toml fails
  // instead of being dropped.
  //
  // NOT a full `InputSpecSchema.parse` yet: the pinned schema-bridge (v0.7.9)
  // does not emit capnp defaults into zod, so a strict parse would reject
  // every real input for the fields it legitimately omits. Synthesising those
  // defaults by hand — including a union default for `connection` — would be
  // the same manumation this replaces. Once the v0.11.3 bump lands
  // (cloister-9170d0, blocked on cloister-944766) the schema supplies its own
  // defaults and this becomes a plain `.parse()`.
  const { InputSpecSchema } = await import(
    pathToFileURL(resolvePath(REPO_ROOT, "src/generated/cluster.zod.ts")).href
  );
  const inputShape = InputSpecSchema?._def?.getter?.()?.shape
    ?? InputSpecSchema?.def?.getter?.()?.shape;
  if (!inputShape) {
    throw new ToolchainError(
      "could not introspect InputSpecSchema from src/generated/cluster.zod.ts — " +
      "the generator's output shape changed. Fix that rather than reinstating a " +
      "hand-written field list; the contract should have one source.",
    );
  }
  const declaredInputFields = Object.keys(inputShape);
  const nodeType = (n) => n?._def?.type ?? n?.def?.type;

  const specs = Object.entries(inputsTable).map(([name, spec]) => {
    for (const key of Object.keys(spec)) {
      if (!declaredInputFields.includes(key)) {
        throw new ToolchainError(
          `[inputs.${name}] declares unknown field ${JSON.stringify(key)} — ` +
          `manifest/cluster.capnp's InputSpec declares: ` +
          `${declaredInputFields.slice().sort().join(", ")}`,
        );
      }
    }
    const out = { name };
    for (const key of declaredInputFields) {
      if (key === "name") continue;
      const t = nodeType(inputShape[key]);
      const present = key in spec;
      if (present) {
        const v = spec[key];
        const ok =
          t === "string" ? typeof v === "string"
          : t === "boolean" ? typeof v === "boolean"
          : (t === "array" || t === "readonly") ? Array.isArray(v)
          : true; // nested struct — judged downstream, not here
        if (!ok) {
          throw new ToolchainError(
            `[inputs.${name}].${key} must be ${t}, got ${Array.isArray(v) ? "array" : typeof v}`,
          );
        }
        out[key] = v;
      } else {
        out[key] =
          t === "string" ? ""
          : t === "boolean" ? false
          : (t === "array" || t === "readonly") ? []
          : undefined; // nested struct absent — same as before
      }
    }
    return out;
  });

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
