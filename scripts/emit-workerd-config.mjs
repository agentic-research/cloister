// emit-workerd-config.mjs — generate dist/config.capnp from the source
// template + the wrangler-emitted bundle.
//
// Why this script exists (the short answer):
//   cloister is an ES-module worker. ES-module workers cannot use
//   wrangler's `[[wasm_modules]]` binding shape — the constraint is
//   enforced in three places (wrangler CLI, Cloudflare docs, workerd's
//   capnp schema). The only supported wasm-loading path for ES-module
//   workers is `import wasmModule from "*.wasm"` plus a
//   `[[rules]] type = "CompiledWasm"` entry, and wrangler bundles those
//   imports with content-hashed filenames. workerd, in turn, has no
//   module-glob: every module embedded in a Worker must be declared
//   explicitly in config.capnp. So someone has to translate the
//   wrangler bundle's hashed filenames into explicit `modules = [ ... ]`
//   entries. That someone is this script. See ADR-0017 for the full
//   alternatives-considered + cloister-273533 for the empirical layer-
//   by-layer confirmation.
//
// Why not `[[wasm_modules]]` (the FAQ this script keeps prompting):
//   - wrangler 3.x/4.x rejects `[wasm_modules]` against an ES-module
//     worker with `You cannot configure [wasm_modules] with an ES
//     module worker. Instead, import the .wasm module directly in your
//     code` — confirmed empirically in cloister-273533.
//   - workerd's `wasmModule @7 :Data` binding in workerd.capnp is
//     annotated `Only supported when using Service Workers syntax.`
//     The constraint is schema-level, not just CLI-level.
//   - Switching cloister to service-worker syntax would mean dropping
//     `export default { fetch }` plus all exported DO classes — a
//     much larger reversal than this script is worth.
//
// What this script does:
//   - Reads the source-of-truth `config.capnp` template at the repo
//     root (worker-only baseline `modules = [ ... ]`).
//   - Finds the `modules = [ ... ]` array using a bracket-balanced
//     parser (no regex over the array body — robust against template
//     whitespace / comment changes).
//   - Replaces the modules array with the worker module + one wasm
//     module entry per `*.wasm` file emitted by wrangler into `dist/`.
//   - Rewrites `embed "dist/<X>"` → `embed "<X>"` (paths in the emitted
//     config are dist-relative since `workerd serve dist/config.capnp`
//     resolves embeds relative to the config file).
//
// Naming detail (load-bearing, do not change without re-testing):
//   The bundled JS imports as `import x from "./<filename>"`, but
//   workerd's module resolver normalizes the `./` away when the
//   importer (`worker`) has no path prefix of its own. The module must
//   be registered with the bare name (no `./`) — registering as
//   `./<filename>` results in workerd erroring with `No such module
//   "<filename>"` at first request. Confirmed empirically against
//   workerd 1.20250718 + 1.20260424.
//
// Failure modes (intentional — silent-pass would mask real breakage):
//   - No `dist/` directory → exit 1.
//   - No `*.wasm` files in `dist/` → exit 1 (the worker imports at
//     least one wasm module via `src/wire/signet-verify.ts`; zero
//     means wrangler is misconfigured).
//   - The source template's modules block can't be located by the
//     bracket parser → exit 1 (drift between this script and the
//     template).
//   - The emitted output doesn't contain every expected wasm entry →
//     exit 1 (defensive — should be unreachable, but guards against a
//     future refactor regression).
//
// Per cloister-0854b7, hardened per cloister-7b1af5, see ADR-0017.
//
// Path-resolution extension (cloister-addcdd, ADR-0023):
//   The `do-storage` service's `path` field is the second substitution
//   this script performs. The template uses `/data/do` as the
//   apko/OCI default; on hosts where that path isn't writable (notably
//   macOS where SIP makes `/data` un-mkdir-able), operators set
//   `CLOISTER_DO_PATH` to any user-writable location. The substitution
//   runs at build time so the emitted dist/config.capnp carries the
//   resolved absolute path workerd reads at boot.

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DIST = path.join(ROOT, "dist");
const SOURCE = path.join(ROOT, "config.capnp");
const TARGET = path.join(DIST, "config.capnp");

// Default matches apko.yaml:50 + the existing template default. Override
// via CLOISTER_DO_PATH for hosts where /data isn't writable (macOS SIP,
// containers with different mount conventions, multi-instance dev).
const DO_PATH_DEFAULT = "/data/do";
const DO_PATH = process.env.CLOISTER_DO_PATH ?? DO_PATH_DEFAULT;
if (!path.isAbsolute(DO_PATH)) {
  die(
    `CLOISTER_DO_PATH must be an absolute path; got ${JSON.stringify(DO_PATH)}. ` +
      `workerd resolves disk service paths relative to its CWD which is unpredictable; ` +
      `pin to an absolute path (e.g. $HOME/.local/share/cloister/do or /tmp/cloister-test/do).`,
  );
}
// Reject chars that would either break the capnp string literal we
// substitute into (`"`, `\`) or produce confusing diagnostics (control
// chars like newline/tab/NUL). The substitution writes DO_PATH verbatim
// inside `path = "<DO_PATH>"`; any of these would either close the
// string early, introduce an unintended escape, or produce a literal
// newline that workerd's capnp parser surfaces as a confusing "unexpected
// token" error one step removed from the actual problem. POSIX paths
// legally allow `"` and `\` but in practice nobody uses them; reject
// upfront with a clear error rather than silently emit broken capnp.
const FORBIDDEN_DO_PATH_RE = /["\\\x00-\x1f]/;
if (FORBIDDEN_DO_PATH_RE.test(DO_PATH)) {
  die(
    `CLOISTER_DO_PATH contains a character that would corrupt the emitted ` +
      `capnp string literal: ${JSON.stringify(DO_PATH)}. Forbidden: ` +
      `double-quote, backslash, control characters (NUL through 0x1F including ` +
      `newline + tab). Pick a path without these (filesystem paths in practice ` +
      `don't use them).`,
  );
}

function die(msg) {
  console.error(`emit-workerd-config: ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(DIST)) {
  die(`dist/ not found; run \`wrangler deploy --dry-run --outdir dist\` first`);
}

if (!fs.existsSync(SOURCE)) {
  die(`source template ${SOURCE} not found`);
}

const wasmFiles = fs.readdirSync(DIST).filter((f) => f.endsWith(".wasm"));
if (wasmFiles.length === 0) {
  die(
    `no *.wasm files in dist/ — wrangler should have emitted at least one ` +
      `(leyline-sign via src/wire/signet-verify.ts); check wrangler.toml [[rules]] CompiledWasm`,
  );
}

const config = fs.readFileSync(SOURCE, "utf8");

// Locate the `modules = ` array in the template using a bracket-
// balanced parser. The template has multiple `[ ... ]` arrays
// (services, sockets, bindings, durableObjectNamespaces, modules);
// we want the one introduced by `modules = `. Once the keyword is
// found, walk forward to the opening `[`, then count brackets to
// find the matching close — robust against comments, whitespace,
// or nested parens inside entries.
function locateModulesArray(src) {
  // Anchor on the `modules` field assignment. Use a small explicit
  // scan rather than regex over the body — only the keyword + `=`
  // needs matching, and we want a clear error if even that drifts.
  const keyword = "modules";
  let cursor = 0;
  while (cursor < src.length) {
    const idx = src.indexOf(keyword, cursor);
    if (idx === -1) return null;
    // Require that `modules` is a fresh identifier (preceded by
    // whitespace or newline) and followed by ` =` after optional
    // whitespace — avoids matching `wasmModules` or similar.
    const before = idx === 0 ? "\n" : src[idx - 1];
    if (!/\s/.test(before)) {
      cursor = idx + keyword.length;
      continue;
    }
    let after = idx + keyword.length;
    while (after < src.length && /[ \t]/.test(src[after])) after += 1;
    if (src[after] !== "=") {
      cursor = idx + keyword.length;
      continue;
    }
    // Found `modules =`. Advance to the opening `[`.
    let openIdx = after + 1;
    while (openIdx < src.length && /\s/.test(src[openIdx])) openIdx += 1;
    if (src[openIdx] !== "[") {
      // `modules =` exists but isn't followed by an array literal —
      // that's template drift the script doesn't handle.
      return null;
    }
    // Bracket-balanced walk. capnp doesn't allow `[`/`]` inside
    // string literals in this template (filenames are filename-safe),
    // but be defensive: skip over string literals and `#` comment
    // lines so we don't miscount.
    let depth = 1;
    let walk = openIdx + 1;
    while (walk < src.length && depth > 0) {
      const ch = src[walk];
      if (ch === '"') {
        // Skip string literal.
        walk += 1;
        while (walk < src.length && src[walk] !== '"') {
          if (src[walk] === "\\") walk += 1; // skip escape
          walk += 1;
        }
        walk += 1; // past closing quote
        continue;
      }
      if (ch === "#") {
        // Skip to end of line (capnp line comment).
        while (walk < src.length && src[walk] !== "\n") walk += 1;
        continue;
      }
      if (ch === "[") depth += 1;
      else if (ch === "]") depth -= 1;
      walk += 1;
    }
    if (depth !== 0) return null;
    // `walk` is now one past the matching `]`. The replacement
    // region is the array literal itself (`[` through `]`, exclusive
    // of trailing comma) — we preserve the leading indentation and
    // the `modules = ` prefix on the surrounding text.
    return { arrayStart: openIdx, arrayEnd: walk };
  }
  return null;
}

const located = locateModulesArray(config);
if (!located) {
  die(
    `source template ${SOURCE} doesn't contain a locatable \`modules = [ ... ]\` ` +
      `array; the template diverged from the script's expectations`,
  );
}

// Build the replacement array. Match the template's two-space outer
// indentation (the field sits inside the `cloisterWorker` const) and
// four-space inner indentation for entries. This is byte-for-byte
// what the previous regex-replace emitted; the layout below is the
// contract with downstream consumers (workerd, vimdiff against past
// builds, etc.).
const wasmEntries = wasmFiles
  .map((wasm) => `    ( name = "${wasm}",\n      wasm = embed "${wasm}" ),`)
  .join("\n");

const replacementArray = `[
    ( name = "worker",
      esModule = embed "index.js",
    ),
${wasmEntries}
  ]`;

let output =
  config.slice(0, located.arrayStart) +
  replacementArray +
  config.slice(located.arrayEnd);

// Substitute the do-storage service's `path` field with the resolved
// DO_PATH. The locator narrows the search in three stages so a generic
// `path` token elsewhere in the template (a future field, a comment
// that wasn't stripped, a different service's `disk` block) can't
// mis-match:
//
//   1. Find the do-storage *service entry* — anchor on
//      `name = "do-storage"`, walk backward to its opening `(`, then
//      paren-balance forward to its matching close. That's the service
//      block range.
//   2. Find the `disk = (` group inside the service block. Paren-
//      balance again for the disk's range.
//   3. Inside the disk's range, find `path = "..."`. The string body
//      is what we substitute.
//
// Returns { stringStart, stringEnd, serviceStart, serviceEnd } so the
// post-substitution sanity check can verify the replacement landed
// inside the bounded service range, not just anywhere after the anchor.
//
// Targets:
//   ( name = "do-storage",         ← serviceStart points at this `(`
//     disk = (
//       path = "/data/do",         ← stringStart...stringEnd
//       writable = true,
//     ),
//   ),                              ← serviceEnd points one past this `)`
function findGroupRange(src, openIdx) {
  // Walk paren-balanced from openIdx (must point at `(`) to the
  // matching `)`. Skips over comments + string literals so escapes
  // can't desync the counter. Returns the index one past the close.
  if (src[openIdx] !== "(") return -1;
  let depth = 1;
  let walk = openIdx + 1;
  while (walk < src.length && depth > 0) {
    const ch = src[walk];
    if (ch === '"') {
      walk += 1;
      while (walk < src.length && src[walk] !== '"') {
        if (src[walk] === "\\") walk += 1;
        walk += 1;
      }
      walk += 1;
      continue;
    }
    if (ch === "#") {
      while (walk < src.length && src[walk] !== "\n") walk += 1;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    walk += 1;
  }
  return depth === 0 ? walk : -1;
}

function locateDoStoragePathString(src) {
  // Stage 1: do-storage service block boundaries.
  const serviceAnchor = 'name = "do-storage"';
  const anchorIdx = src.indexOf(serviceAnchor);
  if (anchorIdx === -1) return null;
  // Walk backward to find the service entry's opening `(`. The
  // template shape is `( name = "do-storage", …`, so the `(` is on
  // the same line, before the anchor, with only whitespace between
  // it and `name`.
  let serviceStart = anchorIdx - 1;
  while (serviceStart >= 0 && /\s/.test(src[serviceStart])) serviceStart -= 1;
  if (serviceStart < 0 || src[serviceStart] !== "(") return null;
  const serviceEnd = findGroupRange(src, serviceStart);
  if (serviceEnd === -1) return null;
  const serviceBlock = src.slice(serviceStart, serviceEnd);

  // Stage 2: locate `disk = (` inside the service block.
  const diskAnchor = serviceBlock.indexOf("disk");
  if (diskAnchor === -1) return null;
  // Require `disk` is a fresh identifier (preceded by whitespace)
  // followed by ` = (`. Anything else means the template diverged.
  const diskBefore = diskAnchor === 0 ? "\n" : serviceBlock[diskAnchor - 1];
  if (!/\s/.test(diskBefore)) return null;
  let diskAfter = diskAnchor + "disk".length;
  while (diskAfter < serviceBlock.length && /[ \t]/.test(serviceBlock[diskAfter])) diskAfter += 1;
  if (serviceBlock[diskAfter] !== "=") return null;
  diskAfter += 1;
  while (diskAfter < serviceBlock.length && /\s/.test(serviceBlock[diskAfter])) diskAfter += 1;
  if (serviceBlock[diskAfter] !== "(") return null;
  const diskOpenIdx = serviceStart + diskAfter; // absolute index in src
  const diskEnd = findGroupRange(src, diskOpenIdx);
  if (diskEnd === -1) return null;
  const diskBlock = src.slice(diskOpenIdx, diskEnd);

  // Stage 3: locate `path = "..."` inside the disk block.
  const pathAnchor = diskBlock.indexOf("path");
  if (pathAnchor === -1) return null;
  const pathBefore = pathAnchor === 0 ? "\n" : diskBlock[pathAnchor - 1];
  if (!/\s/.test(pathBefore)) return null;
  let pathAfter = pathAnchor + "path".length;
  while (pathAfter < diskBlock.length && /[ \t]/.test(diskBlock[pathAfter])) pathAfter += 1;
  if (diskBlock[pathAfter] !== "=") return null;
  pathAfter += 1;
  while (pathAfter < diskBlock.length && /[ \t]/.test(diskBlock[pathAfter])) pathAfter += 1;
  if (diskBlock[pathAfter] !== '"') return null;
  // Walk the string body to find the closing quote.
  const stringStartRel = pathAfter + 1;
  let stringEndRel = stringStartRel;
  while (stringEndRel < diskBlock.length && diskBlock[stringEndRel] !== '"') {
    if (diskBlock[stringEndRel] === "\\") stringEndRel += 1;
    stringEndRel += 1;
  }
  if (stringEndRel >= diskBlock.length) return null;
  // Translate disk-block-relative offsets back to absolute indices.
  return {
    stringStart: diskOpenIdx + stringStartRel,
    stringEnd: diskOpenIdx + stringEndRel,
    serviceStart,
    serviceEnd,
  };
}

const doPathLoc = locateDoStoragePathString(output);
if (!doPathLoc) {
  die(
    `source template doesn't contain a locatable do-storage \`disk = ( path = "..." )\` ` +
      `shape; the template diverged from the script's expectations (do-storage anchor, ` +
      `disk group, or path field missing / nested differently)`,
  );
}
const beforePathValue = output.slice(0, doPathLoc.stringStart);
const afterPathValue = output.slice(doPathLoc.stringEnd);
output = beforePathValue + DO_PATH + afterPathValue;

// Embed paths in the template are template-relative (`dist/<X>`);
// in the emitted config they're dist-relative (just `<X>`). Strip
// the prefix everywhere it appears — currently only on the worker
// entry, but defensive in case future template entries pick up the
// same pattern.
output = output.split('embed "dist/').join('embed "');

// Sanity: every wasm file we found in dist/ must appear as a
// `wasm = embed "<name>"` entry in the output. Belt-and-suspenders
// — should be unreachable, guards against regressions in the
// emission logic above.
for (const wasm of wasmFiles) {
  if (!output.includes(`wasm = embed "${wasm}"`)) {
    die(
      `output didn't include wasm entry for ${wasm} — emission logic ` +
        `regression; aborting before writing a broken config`,
    );
  }
}

// Sanity: re-locate the do-storage path field in the OUTPUT and assert
// the string body is exactly DO_PATH. Bounding via the same 3-stage
// locator (service → disk → path) means a `path` token elsewhere in
// the output (e.g. a future field added in another service's `disk`
// block, or a path-shaped value in a comment that wasn't stripped)
// can't satisfy this check. The previous version searched the whole
// post-anchor slice for `path = "<DO_PATH>"`, which would have passed
// if the substitution silently mis-landed but the same string happened
// to appear in any later service entry.
const postLoc = locateDoStoragePathString(output);
if (!postLoc) {
  die(
    `post-substitution sanity: do-storage \`disk = ( path = "..." )\` shape ` +
      `no longer locatable in the emitted output — substitution corrupted ` +
      `the surrounding structure`,
  );
}
const emittedValue = output.slice(postLoc.stringStart, postLoc.stringEnd);
if (emittedValue !== DO_PATH) {
  die(
    `post-substitution sanity: do-storage path field is ${JSON.stringify(emittedValue)} ` +
      `in the emitted output but should be ${JSON.stringify(DO_PATH)}. ` +
      `Locator regression; aborting before writing a broken config.`,
  );
}

fs.writeFileSync(TARGET, output);
console.log(
  `emit-workerd-config: wrote ${TARGET} (${wasmFiles.length} wasm module(s): ${wasmFiles.join(", ")})`,
);
console.log(
  `emit-workerd-config:   do-storage path = ${DO_PATH}` +
    (DO_PATH === DO_PATH_DEFAULT ? " (default)" : " (via CLOISTER_DO_PATH)"),
);
