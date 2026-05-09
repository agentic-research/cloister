// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Ambient type declaration for `*.wasm` module imports.
//
// wrangler bundles `.wasm` files via the `[[rules]] type = "CompiledWasm"`
// rule in wrangler.toml; the import resolves to a `WebAssembly.Module`
// at runtime. TypeScript needs this declaration to type-check the import
// statement.
//
// Used by `src/wire/signet-verify.ts` to import the leyline-sign wasm
// build output (cloister-bd5241).

declare module "*.wasm" {
  const wasmModule: WebAssembly.Module;
  export default wasmModule;
}
