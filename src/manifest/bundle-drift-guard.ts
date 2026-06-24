// src/manifest/bundle-drift-guard.ts
//
// Compile-time drift gate between the two parallel Bundle definitions:
//
//   1. src/manifest/cluster-types.ts (hand-maintained, JSDoc-rich)
//   2. src/generated/cluster.zod.ts  (schema-bridge codegen from
//                                     manifest/cluster.capnp)
//
// They MUST stay structurally identical: cluster.zod.ts is the
// authoritative type at runtime (it gates TOML parse via ClusterSchema)
// while cluster-types.ts holds the JSDoc that explains each field's
// intent. Drift between the two = silent broken assumptions in
// downstream callers (toml-to-cluster.mjs, build-cluster.mjs, the
// emit-* pipelines) that import one or the other.
//
// Until schema-bridge learns to carry capnp `# comments` through as
// JSDoc (cloister-204ac9 followup), this file is the seam that fails
// fast under `task lint`'s tsc pass if either definition gains a field
// the other doesn't have.
//
// Per cloister-204ac9. Zero runtime cost: every export is a type alias.

import type {
  Bundle as HandMaintainedBundle,
  WorkerdBundle as HandMaintainedWorkerdBundle,
  ExternalBundle as HandMaintainedExternalBundle,
} from "./cluster-types.js";
import type {
  Bundle as GeneratedBundle,
  WorkerdBundle as GeneratedWorkerdBundle,
  ExternalBundle as GeneratedExternalBundle,
} from "../generated/cluster.zod.js";

// Normalize ReadonlyArray<X> → X[] AND strip property-level
// `readonly` modifiers. Used so the drift gate compares structural
// shape without flagging readonly-vs-mutable divergence:
// schema-bridge doesn't yet emit `readonly` (followup task), and the
// hand-maintained file adds it as an immutability hint — both are
// valid for the same logical schema.
type Normalize<T> =
  T extends ReadonlyArray<infer U>
    ? Normalize<U>[]
    : T extends object
      ? { -readonly [K in keyof T]: Normalize<T[K]> }
      : T;

// Standard structural-equality trick: two types are equal iff each is
// assignable to the other. The `[T] extends [U]` form preserves
// distributivity-vs-tuple semantics for union types (Bundle.kind has
// a union; without the tuple wrap, distributive conditionals could
// mask drift on individual variants).
type AssertEqual<A, B> = [Normalize<A>] extends [Normalize<B>]
  ? [Normalize<B>] extends [Normalize<A>]
    ? true
    : { error: "B is not assignable to A"; missing: Exclude<keyof A, keyof B> }
  : { error: "A is not assignable to B"; missing: Exclude<keyof B, keyof A> };

// If either definition gains/loses a field, the corresponding line
// below stops resolving to `true` and tsc fails with a structural
// error pointing at the drift.
export type _BundleDriftCheck = AssertEqual<HandMaintainedBundle, GeneratedBundle>;
export type _WorkerdBundleDriftCheck = AssertEqual<HandMaintainedWorkerdBundle, GeneratedWorkerdBundle>;
export type _ExternalBundleDriftCheck = AssertEqual<HandMaintainedExternalBundle, GeneratedExternalBundle>;

// The three sentinels force tsc to actually evaluate the conditionals.
// Without these, the type aliases above would be lazy.
const _bundle: _BundleDriftCheck = true;
const _workerd: _WorkerdBundleDriftCheck = true;
const _external: _ExternalBundleDriftCheck = true;
void _bundle;
void _workerd;
void _external;
