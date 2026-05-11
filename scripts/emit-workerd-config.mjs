// emit-workerd-config.mjs — generate dist/config.capnp from the source
// template + the wrangler-emitted bundle.
//
// Why this script exists:
//   - wrangler 3.x bundles `.wasm` imports with content-hashed filenames
//     (e.g. `307bfb…-leyline_sign.wasm`). The hash changes whenever the
//     wasm source changes.
//   - workerd has no module-glob: every module embedded in a Worker
//     must be declared explicitly in config.capnp with `( name = ...,
//     wasm = embed ... )`.
//   - For `workerd serve dist/config.capnp` (the OCI image's runtime
//     path), we therefore need a config that names every wasm file
//     emitted by wrangler. The source-of-truth `config.capnp` at the
//     repo root holds a stable template; this script copies it into
//     `dist/`, rewrites `embed "dist/<X>"` → `embed "<X>"` (paths are
//     relative to the config file, which now lives in `dist/`), and
//     injects one `wasm` module entry per `*.wasm` found in `dist/`.
//   - For local dev, `task dev` uses `wrangler dev` which internally
//     handles all of this — this script only runs for `task build:local`
//     and the melange OCI build pipeline.
//
// Failure modes (intentional — silent-pass would mask real breakage):
//   - No `dist/` directory → exit 1.
//   - No `*.wasm` files in `dist/` → exit 1 (the worker imports at least
//     one wasm module via `src/wire/signet-verify.ts`; zero means
//     wrangler is misconfigured).
//   - The source template's modules block doesn't match the expected
//     shape → exit 1 (drift between this script and the template).
//
// Per cloister-0854b7.

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DIST = path.join(ROOT, "dist");
const SOURCE = path.join(ROOT, "config.capnp");
const TARGET = path.join(DIST, "config.capnp");

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

let config = fs.readFileSync(SOURCE, "utf8");

// The template's modules block is the worker-only baseline:
//   modules = [
//     ( name = "worker",
//       esModule = embed "dist/index.js",
//     ),
//   ],
//
// We replace it with the worker module + one wasm module per file in
// dist/. Important naming detail: the bundled JS imports as
// `import x from "./<filename>"`, but workerd's module resolver
// normalizes the `./` away when the importer ("worker") has no path
// prefix of its own. The module *must* be registered with the bare
// name (no `./`) — registering as `./<filename>` results in workerd
// erroring with `No such module "<filename>"` at first request.
// (Confirmed empirically against workerd 1.20250718; if a future
// workerd changes resolution semantics, both forms can be registered
// to be safe.)
const TEMPLATE_MODULES_RE =
  /modules = \[\s*\(\s*name = "worker",\s*esModule = embed "dist\/index\.js",\s*\),\s*\],/;

if (!TEMPLATE_MODULES_RE.test(config)) {
  die(
    `source template ${SOURCE} doesn't contain the expected modules block; ` +
      `the script's regex needs updating (or the template diverged)`,
  );
}

const wasmEntries = wasmFiles
  .map((wasm) => `    ( name = "${wasm}",\n      wasm = embed "${wasm}" ),`)
  .join("\n");

config = config.replace(
  TEMPLATE_MODULES_RE,
  `modules = [
    ( name = "worker",
      esModule = embed "index.js",
    ),
${wasmEntries}
  ],`,
);

// Embed paths were template-relative (`dist/<X>`); now they're
// dist-relative (just `<X>`). Strip the prefix everywhere it appears
// — currently only on the worker entry, but defensive in case future
// template entries pick up the same pattern.
config = config.replace(/embed "dist\//g, 'embed "');

// Sanity: assert at least one wasm entry made it into the output.
for (const wasm of wasmFiles) {
  if (!config.includes(`wasm = embed "${wasm}"`)) {
    die(
      `output didn't include wasm entry for ${wasm} — replacement regex ` +
        `or template drift; aborting before writing a broken config`,
    );
  }
}

fs.writeFileSync(TARGET, config);
console.log(
  `emit-workerd-config: wrote ${TARGET} (${wasmFiles.length} wasm module(s): ${wasmFiles.join(", ")})`,
);
