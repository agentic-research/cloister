// SPDX-License-Identifier: AGPL-3.0-or-later
//
// scripts/resolve-inputs.mjs — ADR-0026 Phase 1b + Phase 2 subpiece 1
// (cloister-cf7a3b + cloister-5f5aee) — input resolver +
// cluster.lock.toml writer.
//
// Reads `cluster.toml`'s `[inputs.*]` blocks, resolves each input via
// its ref scheme, computes a content-addressed digest, writes the
// resolved metadata to `cluster.lock.toml`. Operators commit the
// lockfile alongside cluster.toml so deploys are reproducible.
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

  return {
    name:         spec.name,
    ref:          spec.ref,
    resolved:     spec.version || "",
    sha256:       `sha256:${sha256}`,
    fetched_from: fetchedFrom,
    signer:       "", // Phase 3 — Interlace receipts populate this
    bytes:        bytes.length,
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

// ── Lockfile shape ──────────────────────────────────────────────────────

/**
 * Build the cluster.lock.toml document body. Header carries the
 * source cluster.toml's metadata + a generated-at timestamp. Each
 * input lands in its own `[inputs.<name>]` table mirroring the
 * source cluster.toml structure.
 */
export function buildLockfile(clusterMetadata, resolvedInputs) {
  const doc = {
    "_comment": "Generated by scripts/resolve-inputs.mjs (ADR-0026 Phase 1b). " +
                "Commit this file alongside cluster.toml — deploys verify each input's " +
                "sha256 against the committed digest. Phase 3 will add Interlace receipt " +
                "signatures (`signer` field populated from the input's actor).",
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
    ref:      typeof spec.ref      === "string" ? spec.ref      : "",
    version:  typeof spec.version  === "string" ? spec.version  : "",
    digest:   typeof spec.digest   === "string" ? spec.digest   : "",
    from:     typeof spec.from     === "string" ? spec.from     : "",
    provides: Array.isArray(spec.provides) ? spec.provides : [],
    requires: Array.isArray(spec.requires) ? spec.requires : [],
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
