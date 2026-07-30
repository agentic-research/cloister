// SPDX-License-Identifier: AGPL-3.0-or-later
//
// cluster-types.ts must not DIVERGE from cluster.zod.ts (cloister-204ac9).
//
// Both mirror the same schema — `manifest/cluster.capnp`. One is generated
// (`src/generated/cluster.zod.ts`), one is hand-written
// (`src/manifest/cluster-types.ts`), and 29 types are declared in both.
//
// ── Why the duplication cannot simply be deleted ──────────────────────────
//
// The obvious fix is to re-export the generated types and delete the hand
// copies. Measured before attempting it: cluster.capnp carries 727 comment
// lines, cluster.zod.ts carries 6. schema-bridge receives the doc comments —
// capnp's schema.capnp declares `docComment` on nodes and members, and
// `capnp compile` populates it — but the emitters discard them.
//
// So the hand file's 137 comment lines across 19 types are the ONLY documented
// version in TypeScript. Deleting it would trade a duplication problem for a
// documentation loss. Filed upstream as ley-line-open-d554a0; when that lands,
// consolidation becomes safe and this rail can be replaced by re-exports.
//
// ── Why this is a divergence rail, not a duplication ban ──────────────────
//
// Until then the real risk is not that two files say the same thing — it is
// that they STOP saying the same thing, silently. So the rail asserts
// agreement rather than forbidding a duplication we cannot yet remove.
//
// ── On the naming, and a correction ───────────────────────────────────────
//
// An earlier reading of this called `McpToolSpec`/`McpTool`,
// `VaultProxyServiceConfig`/`VaultProxyService` and
// `HarnessTargetConfig`/`HarnessTarget` accidental renames to be reconciled.
// They are not, or at least not obviously: cloister has TWO capnp schemas and
// BOTH declare `McpTool` and `VaultProxyService` (cluster.capnp:847,994 and
// cloister.capnp:612,78). `src/manifest/types.ts` mirrors cloister.capnp and
// also declares `McpToolSpec`. The `*Spec` / `*Config` suffix therefore looks
// like deliberate disambiguation between two schemas that reuse struct names —
// renaming to match the generated side would reintroduce the collision the
// suffix avoids. Left alone deliberately.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HAND = resolve(ROOT, "src/manifest/cluster-types.ts");
const GEN = resolve(ROOT, "src/generated/cluster.zod.ts");

/**
 * Interface name → set of field names, for every `export interface` in a file.
 *
 * Field NAMES, not full types: the two files legitimately spell the same shape
 * differently (the hand file names unions the generator inlines, e.g.
 * `kind: BundleKind` vs `kind: { workerd: … } | { external: … }`). Comparing
 * text would flag that as drift when it is not. A field appearing on one side
 * and not the other is unambiguous drift, and is what this catches.
 */
function interfaceFields(path) {
  const src = readFileSync(path, "utf8");
  const out = new Map();
  for (const m of src.matchAll(/^export interface (\w+) \{\n([\s\S]*?)^\}/gm)) {
    const fields = new Set();
    for (const line of m[2].split("\n")) {
      const f = line.match(/^\s{2}(?:readonly\s+)?(\w+)\??\s*:/);
      if (f) fields.add(f[1]);
    }
    out.set(m[1], fields);
  }
  return out;
}

test("hand-maintained and generated cluster types do not diverge", () => {
  const hand = interfaceFields(HAND);
  const gen = interfaceFields(GEN);

  const shared = [...hand.keys()].filter((n) => gen.has(n)).sort();

  // Non-vacuity. If the overlap were empty this test would pass on air, and an
  // empty overlap is itself the thing to know about — it would mean the hand
  // file stopped mirroring the schema entirely.
  assert.ok(
    shared.length > 20,
    `expected the hand file to mirror many generated types, found ${shared.length} shared`,
  );

  const drift = [];
  for (const name of shared) {
    const h = hand.get(name);
    const g = gen.get(name);
    const onlyHand = [...h].filter((f) => !g.has(f));
    const onlyGen = [...g].filter((f) => !h.has(f));
    if (onlyHand.length || onlyGen.length) {
      drift.push(
        `${name}: hand-only [${onlyHand.join(", ")}] generated-only [${onlyGen.join(", ")}]`,
      );
    }
  }

  assert.deepEqual(
    drift,
    [],
    `${drift.length} of ${shared.length} shared type(s) have diverged. The hand file in ` +
      `src/manifest/cluster-types.ts mirrors manifest/cluster.capnp by hand; update it to ` +
      `match the generated projection, or (better) wait for ley-line-open-d554a0 and ` +
      `re-export instead of mirroring.`,
  );
});

test("cluster-types.ts still owns what the projection cannot express", () => {
  // Guards over-correction. `validateCluster` is a runtime check capnp cannot
  // state (no cross-field validation in the schema language), so this module
  // must keep existing. The goal is to stop it MIRRORING types, not delete it.
  assert.match(readFileSync(HAND, "utf8"), /export function validateCluster\b/);
});
