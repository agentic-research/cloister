#!/usr/bin/env node
// scripts/validate-cluster-zod.mjs
//
// End-to-end semantic check for the schema-bridge codegen.
//
// Imports both halves of the migration anchor:
//   - src/generated/cluster.ts        (the real cluster values, from
//                                      `capnp eval -o json` on
//                                      cluster.capnp)
//   - src/generated/cluster.zod.ts    (the zod schema, from
//                                      schema-bridge on
//                                      manifest/cluster.capnp)
// …and asserts that the schema actually accepts the values. If
// schema-bridge ever regresses on the real schema (e.g. emits a shape
// that doesn't match capnp's JSON encoding), this script lights up.
//
// This is the test that surfaced the original union-shape bug
// (`{ kind: "external", external: ... }` flat-tagged form vs capnp's
// actual `{ kind: { external: ... } }` nested form). Committed so the
// proof stays locked in.
//
// Not part of `task verify` yet — invoke via `task cluster:zod:verify`
// or directly: `pnpm exec tsx scripts/validate-cluster-zod.mjs`.
//
// Exit codes:
//   0 — ClusterSchema accepts the cluster const
//   1 — validation failed; issues printed to stderr

import { cluster } from "../src/generated/cluster.js";
import { ClusterSchema } from "../src/generated/cluster.zod.js";

const result = ClusterSchema.safeParse(cluster);
if (!result.success) {
  console.error(
    "FAIL — ClusterSchema does not accept the cluster const:",
  );
  console.error(JSON.stringify(result.error.issues, null, 2));
  process.exit(1);
}
console.log(
  `OK — cluster validates against ClusterSchema (${cluster.bundles.length} bundle(s), ${cluster.wires.length} wire(s))`,
);
