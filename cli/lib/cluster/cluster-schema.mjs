// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference path="../bundle-globals.d.ts" />
//
// The generated zod schema for cluster.capnp (`src/generated/cluster.zod.ts`).
//
// It is TypeScript, and plain Node does not load TypeScript, so a checkout
// loads it through tsx. A bundle cannot follow that: the path is a runtime
// value. So a bundle build defines `globalThis.__CLOISTER_BUNDLE__` as `true`
// (gen/bundle-plan.mjs): the bundler folds the test, keeps only the literal
// import, and drops the tsx branch, so the bundle needs no tsx. The two
// branches load the same file.

/** @returns {Promise<typeof import("../../../src/generated/cluster.zod.ts")>} */
export async function loadClusterSchema() {
  if (globalThis.__CLOISTER_BUNDLE__ === true) {
    return import("../../../src/generated/cluster.zod.ts");
  } else {
    const { tsImport } = await import("tsx/esm/api");
    return tsImport(new URL("../../../src/generated/cluster.zod.ts", import.meta.url).href, { parentURL: import.meta.url });
  }
}
