// SPDX-License-Identifier: AGPL-3.0-or-later
//
// cluster-types.ts — TypeScript mirror of `manifest/cluster.capnp`
// (ADR-0009 Phase 1 / cloister-be0607).
//
// Same pattern as `src/manifest/types.ts` (which mirrors
// `manifest/cloister.capnp`). The TS types are hand-written, kept in
// sync with the capnp schema by convention + the manifest-validator
// tests. The build pipeline emits a typed `cluster` const into
// `src/generated/cluster.ts` that the deployment emitters consume.
//
// Three deployment emitters live downstream of this:
//
//   scripts/emit-compose.mjs  → docker-compose.yaml
//   scripts/emit-pod.mjs      → k8s Pod manifest
//   scripts/emit-dev.mjs      → task dev:all launcher (mac native)

/** Top-level cluster value — one per deployment. */
export interface Cluster {
  metadata: ClusterMetadata;
  bundles:  readonly Bundle[];
  wires:    readonly Wire[];
  storage:  StoragePolicy;
  /**
   * Composable external inputs (ADR-0026 / cloister-cf7a3b). Each
   * entry names a tool / skill / agent-def / bundle by `ref` +
   * `version` (optionally `digest` for content-addressed pin or
   * `from` for dev-loop filesystem override). The optional
   * `provides`/`requires` lists carry the lego-blocks capability
   * declarations the matchmaker uses to wire inputs together at
   * compose time. Empty array = no external inputs (back-compat
   * with pre-Phase-1a cluster.toml). Resolver lands in Phase 1b.
   */
  inputs:   readonly InputSpec[];
}

/**
 * One composable input. Phase 1a is schema-only — operators can
 * declare these in cluster.toml without erroring; resolver is a
 * no-op until Phase 1b ships. Per ADR-0026.
 *
 * The `provides`/`requires` fields anticipate ADR-0027's lego-blocks
 * capability matchmaker — operators can declare capability intent
 * ahead of the substrate that consumes the declarations; the
 * matchmaker reads these directly without schema change.
 */
export interface InputSpec {
  /** Logical name (the `[inputs.<name>]` block key). Must be unique. */
  name:     string;
  /** Addressable ref — `file://`, `https://`, or registry id. */
  ref:      string;
  /** Semver range or exact version. Empty = no constraint. */
  version:  string;
  /** Optional content-addressed pin (`sha256:<hex>`). Empty = no pin. */
  digest:   string;
  /** Optional dev-loop override (`file:///abs/path`). Empty = use ref. */
  from:     string;
  /** Capabilities this input PROVIDES (`cloister/<name>/v<n>` shape). */
  provides: readonly string[];
  /** Capabilities this input REQUIRES. */
  requires: readonly string[];
  /**
   * Optional name of the env-var binding holding the upstream URL
   * (e.g. `"LLO_MCP_URL"`). Threaded through to the
   * `[[generated_backends]]` row in `cluster.lock.toml` so the
   * downstream manifest emitter can wire the resulting `mcpProxy`
   * backend to the right binding. Empty string = unset (the resolver
   * still emits the generated backend but with `urlBinding=""`).
   * Per cloister-05334b (Phase 1 of LLO arc).
   */
  urlBinding: string;
  /**
   * Optional name of a workerd `Fetcher` Service binding that resolves
   * to the upstream (e.g. `"LSP_MCP"`). Same precedence rules apply as
   * in `HttpForwardBackend.serviceBinding` — when set + bound, the
   * runtime calls `env[serviceBinding].fetch(...)` and bypasses the
   * `internet` ACL. Per cloister-05334b.
   */
  serviceBinding: string;
}

export interface ClusterMetadata {
  /** e.g. "art-default" — visible in container labels. */
  name:    string;
  /** e.g. "0.1.0" — pinned at deploy time. */
  version: string;
}

/**
 * Tier classification per ADR-0011's three-criterion test.
 *
 * - `hypervisor` — mediates between bundles or to the outside;
 *   compromise blast radius is multi-bundle; singleton per cluster.
 *   Cannot be removed without breaking the cluster.
 * - `cluster` — user-deployable; removing one disables a feature but
 *   leaves the cluster otherwise functional.
 *
 * The emitters treat both tiers identically at the runtime layer — the
 * classification is documentation + audit, not a runtime gate.
 */
export type Tier = "hypervisor" | "cluster";

/**
 * One process within the cluster. The `kind` discriminator picks the
 * substrate (workerd in-process v8 isolate vs subprocess container).
 */
export interface Bundle {
  /** e.g. "cloister-router", "mache", "rosary". Unique within a cluster. */
  name:        string;
  /** One-line description; surfaces in container labels. */
  description: string;
  /** Tier classification per ADR-0011. */
  tier:        Tier;
  /** Discriminated union: workerd (in-process) or external (subprocess). */
  kind:        BundleKind;
  /**
   * Workerd binding NAMES this bundle is allowed to hold as credential
   * material (e.g. `["VAULT_KEK_SOURCE", "VAULT_STORE"]`). The bundle-
   * isolation lint reads its allow-list from this field. Cluster-tier
   * bundles MUST leave this empty (the lint enforces). Per math-friend
   * review of ADR-0018, gap 2.
   */
  holdsCredential: readonly string[];
  /**
   * Workerd `services[].name` in config.capnp that corresponds to this
   * bundle. Bridge between workerd-service-naming (e.g. "cloister") and
   * cluster-bundle-naming (e.g. "cloister-router"). Empty for bundles
   * with no workerd Worker (mache, rosary). Per math-friend gap 3.
   */
  workerdServiceName: string;
  /**
   * Free-form rationale for tier=hypervisor classification (ADR-0011
   * three-criterion test). MUST be non-empty when `tier === "hypervisor"`;
   * lint refuses unjustified tier promotion. Per math-friend gap 1.
   */
  hypervisorRationale: string;
}

export type BundleKind =
  | { workerd:  WorkerdBundle }
  | { external: ExternalBundle };

/**
 * In-process v8 isolate inside cloister-router's workerd. Phase 1
 * doesn't ship any of these; reserved for future TS/JS tool bundles.
 */
export interface WorkerdBundle {
  /** Path to bundle entry point, relative to cloister source tree. */
  entryPoint: string;
}

/**
 * Subprocess container running its own OCI image. Most Phase 1
 * bundles use this kind (cloister-router itself, mache, rosary, notme).
 */
export interface ExternalBundle {
  /** OCI image ref, e.g. "cloister:0.1.0". */
  image:     string;
  /**
   * UDS socket path the bundle listens on for capnp ToolCall traffic.
   * Convention: `/run/cloister-uds/<bundle>.sock`.
   */
  ipcSocket: string;
  /**
   * Optional TCP port — for bundles that ALSO want HTTP reach (e.g.
   * cloister-router exposes /mcp on TCP). 0 = no TCP listener.
   */
  httpPort:  number;
  /** Container entrypoint args spliced by the emitters. */
  args:      readonly string[];
  /** Container environment variables. */
  env:       readonly EnvVar[];
}

export interface EnvVar {
  name:  string;
  value: string;
}

/**
 * Service-binding relationship: bundle `from` reaches bundle `to`
 * through env var `binding`. The emitters inject the env var into
 * `from`'s container and ensure both bundles share the volume mount
 * holding the UDS file.
 *
 * Wires are directional. Bidirectional comms = two wires.
 */
export interface Wire {
  /** Source bundle name (must reference a declared `Bundle.name`). */
  from:      string;
  /** Target bundle name (must reference a declared `Bundle.name`). */
  to:        string;
  /** Env var name on `from`'s container, set to `to`'s ipcSocket. */
  binding:   string;
  /** Transport kind. Intra-cluster is UDS; cross-cluster (future) is leylineNet. */
  transport: WireTransport;
}

export type WireTransport =
  | { uds:        null }   // capnp ToolCall over UDS, intra-cluster (default)
  | { leylineNet: null };  // signed capnp + AEAD, cross-cluster (future)

/**
 * Where Durable Object SQLite files live. Mounted into the
 * cloister-router container so DO state survives container restarts.
 */
export interface StoragePolicy {
  /**
   * Host path. Defaults to `/data/do` (matches apko image + config.capnp).
   * Resolves to a Docker named volume / k8s PVC / mac local dir
   * depending on the emitter.
   */
  doStoragePath: string;
}

// ── Validation helpers (consumed by build-cluster.mjs + tests) ───────────

/**
 * Validate a `Cluster` value's referential integrity. Throws
 * `TypeError` with a precise message on any structural error:
 *
 *   - duplicate bundle names
 *   - wire references undeclared bundle (in `from` or `to`)
 *   - empty bundle name / empty wire binding
 *   - bundle with unknown tier
 *
 * Called by `scripts/build-cluster.mjs` BEFORE writing the TS output;
 * also called by the emitters defensively.
 */
export function validateCluster(c: Cluster): void {
  if (!c.metadata.name) throw new TypeError("cluster: metadata.name is required");
  if (!c.metadata.version) throw new TypeError("cluster: metadata.version is required");

  const names = new Set<string>();
  for (const b of c.bundles) {
    if (!b.name) throw new TypeError("cluster.bundles[]: name is required");
    if (names.has(b.name)) {
      throw new TypeError(`cluster.bundles[]: duplicate name "${b.name}"`);
    }
    names.add(b.name);
    if (b.tier !== "hypervisor" && b.tier !== "cluster") {
      throw new TypeError(`cluster.bundles["${b.name}"]: unknown tier "${b.tier}"`);
    }
    // Per math-friend ADR-0018 review gap 1: tier=hypervisor requires
    // explicit rationale. validateCluster runs both at build time
    // (build-cluster.mjs) and at runtime in the emitters, so this gate
    // is independent of the lint script.
    if (b.tier === "hypervisor" && !b.hypervisorRationale) {
      throw new TypeError(
        `cluster.bundles["${b.name}"]: tier=hypervisor requires non-empty ` +
        `hypervisorRationale (ADR-0011 three-criterion test)`,
      );
    }
  }

  for (const w of c.wires) {
    if (!w.from || !w.to || !w.binding) {
      throw new TypeError(`cluster.wires[]: from/to/binding all required (got from=${w.from} to=${w.to} binding=${w.binding})`);
    }
    if (!names.has(w.from)) {
      throw new TypeError(`cluster.wires[]: from "${w.from}" references undeclared bundle`);
    }
    if (!names.has(w.to)) {
      throw new TypeError(`cluster.wires[]: to "${w.to}" references undeclared bundle`);
    }
    if (w.from === w.to) {
      throw new TypeError(`cluster.wires[]: self-wire on "${w.from}" not allowed`);
    }
  }
}
