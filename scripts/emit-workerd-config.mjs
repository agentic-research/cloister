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
// DO_PATH. Locator pattern matches the modules array shape — anchor
// on `name = "do-storage"`, walk forward to the disk's `path = "..."`
// string literal, replace just the string body (preserving quotes).
//
// Targets:
//   ( name = "do-storage",
//     disk = (
//       path = "/data/do",   ← this string literal's value
//       writable = true,
//     ),
//   ),
function locateDoStoragePathString(src) {
  const serviceAnchor = 'name = "do-storage"';
  const serviceIdx = src.indexOf(serviceAnchor);
  if (serviceIdx === -1) return null;
  // Walk forward from the anchor to find `path = "..."`. Bound the
  // search to the same service entry — terminate if we cross into
  // another `( name = "..."` declaration (which would mean the
  // do-storage entry didn't have a path field, i.e. template drift).
  const pathKeyword = "path";
  let cursor = serviceIdx + serviceAnchor.length;
  while (cursor < src.length) {
    // Cheap early termination on next service-entry boundary.
    const nextService = src.indexOf('( name = "', cursor);
    const nextPath = src.indexOf(pathKeyword, cursor);
    if (nextPath === -1) return null;
    if (nextService !== -1 && nextService < nextPath) return null;
    // Require `path` to be a fresh identifier — preceded by whitespace
    // and followed by ` = "` (the only shape used in this template).
    const before = src[nextPath - 1];
    if (!/\s/.test(before)) {
      cursor = nextPath + pathKeyword.length;
      continue;
    }
    let after = nextPath + pathKeyword.length;
    while (after < src.length && /[ \t]/.test(src[after])) after += 1;
    if (src[after] !== "=") {
      cursor = nextPath + pathKeyword.length;
      continue;
    }
    after += 1;
    while (after < src.length && /[ \t]/.test(src[after])) after += 1;
    if (src[after] !== '"') {
      cursor = nextPath + pathKeyword.length;
      continue;
    }
    // Found `path = "`. Walk past the opening quote to the close.
    const stringStart = after + 1;
    let stringEnd = stringStart;
    while (stringEnd < src.length && src[stringEnd] !== '"') {
      if (src[stringEnd] === "\\") stringEnd += 1; // skip escape
      stringEnd += 1;
    }
    if (stringEnd >= src.length) return null;
    return { stringStart, stringEnd };
  }
  return null;
}

const doPathLoc = locateDoStoragePathString(output);
if (!doPathLoc) {
  die(
    `source template doesn't contain a locatable do-storage \`path = "..."\` ` +
      `field; the template diverged from the script's expectations`,
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

// Sanity: the do-storage path substitution actually landed. The
// resolved DO_PATH must appear inside the do-storage service entry's
// `path = "..."` field. Guards against locator regressions silently
// emitting a config that still points at /data/do.
const doStorageMarker = `name = "do-storage"`;
const doStorageIdx = output.indexOf(doStorageMarker);
const expectedAfter = output.indexOf(`path = "${DO_PATH}"`, doStorageIdx);
if (doStorageIdx === -1 || expectedAfter === -1) {
  die(
    `do-storage path substitution didn't land — expected ` +
      `\`path = "${DO_PATH}"\` after the do-storage service anchor. ` +
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
