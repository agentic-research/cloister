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
  /**
   * Route declarations the manifest emitter lifts into the generated
   * `cloister.capnp` Gateway value (Phase 2 of "cloister.capnp as
   * build artifact" arc, cloister-345ad1 / ADR-0031). Mirrors the
   * Route + per-kind-spec shape from `manifest/cloister.capnp`. Empty
   * array = no routes declared in cluster.toml (back-compat with
   * pre-Phase-2 cluster.toml that left routes in hand-edited
   * cloister.capnp shells).
   */
  routes:   readonly Route[];
  /**
   * Operator-authored Gateway-level surface (metadata + actor +
   * policy) the emitter lifts into the generated `cloister.capnp`
   * (Phase 4a of the "cloister.capnp as build artifact" arc,
   * cloister-c919d7 / ADR-0031). Mirrors the `Gateway` struct from
   * `manifest/cloister.capnp` (same self-contained-schema rationale
   * as `routes` above).
   *
   * All-empty value (the back-compat default for pre-Phase-4a
   * cluster.toml) signals the emitter to fall through to the
   * ART-default template + emit a warning to stderr; see
   * `scripts/emit-cloister-capnp.mjs:emitCloisterCapnp`.
   */
  gateway:  Gateway;
  /**
   * Cross-tenant edge declarations (ADR-0030 §A2 + §A4 /
   * cloister-0e3004). Each entry names a `from` → `to` tenant pair
   * and the `app_protocol` label classifying the traffic shape.
   * Empty array = no cross-tenant edges (single-tenant deployments
   * are the back-compat default).
   *
   * Optional in the TS mirror so pre-ADR-0030 cluster.toml continues
   * to parse + type-check. When absent, the substrate treats it as
   * an empty list.
   */
  edges?:   readonly EdgeSpec[];
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
  /**
   * Composable tenancy declaration (ADR-0030 §A5 / cloister-0e3004).
   * Operator-set fields override the input's server.json
   * `_meta.art.cloister/v1.tenancy` defaults. All-empty value = inherit
   * server.json defaults (or "co-located" if the server.json doesn't
   * declare tenancy either).
   *
   * Optional in the TS mirror so pre-ADR-0030 cluster.toml continues to
   * parse + type-check. When absent, downstream emitters treat it as
   * an all-empty TenancySpec (the inherit-defaults shape).
   */
  tenancy?: TenancySpec;
}

/**
 * Composable tenancy declaration (ADR-0030 §A5 / cloister-0e3004).
 * Mirrors `manifest/cluster.capnp` `TenancySpec` struct.
 *
 * Operator's `cluster.toml [inputs.*].tenancy.*` block OVERRIDES the
 * input's server.json `_meta.art.cloister/v1.tenancy` defaults. Empty
 * fields inherit from server.json (or substrate defaults if absent).
 */
export interface TenancySpec {
  /**
   * Tenancy mode:
   *   - `"co-located"` — share workerd with siblings of same workerdId
   *   - `"external"`   — own process/container, reached over wire
   *   - `"per-tenant"` — own workerd per declared tenant (strongest)
   *   - `""`           — inherit server.json default
   */
  mode?: string;
  /** Workerd process name. Empty = emitter assigns from input name. */
  workerdId?: string;
  /**
   * Trusted-tier hint. True = may carry hypervisor-layer bindings +
   * co-locate with router workerd. False (or absent) = tool-bundle.
   * Substrate fails closed: only explicit true grants the tier.
   */
  trustedTier?: boolean;
  /**
   * Explicit co-tenancy edges. Non-empty asserts these inputs share
   * a workerd with this one (resolver enforces). Empty = no explicit
   * co-tenancy beyond `workerdId`.
   */
  sharesWorkerdWith?: readonly string[];
}

/**
 * Cross-tenant edge declaration (ADR-0030 §A2 + §A4 / cloister-0e3004).
 * Mirrors `manifest/cluster.capnp` `EdgeSpec` struct.
 *
 * Used for routing (§A2) + observability/policy via app_protocol (§A4).
 * Transport is operator-wired; substrate is intentionally transport-
 * agnostic (raptorq from ley-line explicitly out of scope per ADR-0030
 * §A4 / "What this is NOT").
 */
export interface EdgeSpec {
  /** Source tenant — references TenancySpec.workerdId or InputSpec.name. */
  from: string;
  /** Destination tenant — same resolution rules. */
  to: string;
  /**
   * Hybrid-namespace label per ADR-0030 §A4:
   *   - `"art.*"`   — substrate-blessed canonical handling
   *   - `"x-<v>-*"` — operator-extensible opaque pass-through
   *   - other shapes rejected by `lint-app-protocol` (cloister-0fa3d7)
   */
  appProtocol: string;
  /** Transport hint (e.g. `"loopback-http"`, `"uds:/path"`). Empty = default. */
  transport: string;
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
  /**
   * When true, the emit-compose pipeline (Phase 2 piece 2, deferred)
   * emits one bundle instance per tenant declared in `tenantDispatch`
   * route, instead of a single cluster-wide bundle. Lint Invariants 8 + 9
   * (`scripts/lint-bundle-isolation.mjs`) enforce that `perTenant=true`
   * is paired with a `tenantDispatch` route + binding chain to the
   * bundle. Default false for back-compat. Per ADR-0034 §Sequencing
   * item #3 / cloister-cedcf3 Phase 1.
   */
  perTenant: boolean;
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

// ── Routes (Phase 2 of "cloister.capnp as build artifact" arc) ────────────
//
// Mirror of `manifest/cluster.capnp:Route` + per-kind specs. Same shape
// (modulo any post-Phase-2 schema additions) as `src/manifest/types.ts`'s
// `Route` so the emitter can lift these declarations into the generated
// `cloister.capnp` Gateway value without per-variant translation.
//
// Per cloister-345ad1 / ADR-0031.

/**
 * One route in the cluster's gateway. The `kind` discriminator picks the
 * route variant; the runtime dispatches by `path` + first-match-wins.
 */
export interface Route {
  /** Path prefix (or sentinel marker for routes that match internally). */
  path: string;
  /** Discriminated union: exactly one variant key present. */
  kind: RouteKind;
}

/**
 * Capnp unions encode in JSON as a single sibling field whose name is
 * the active variant. The TS shape mirrors that with object-with-single-
 * key. Void variants carry `null` as the payload (matches the zod side).
 */
export type RouteKind =
  | { health:                  null }
  | { mcp:                     McpRouteSpec }
  | { serviceBindingProxy:     ServiceBindingProxySpec }
  | { httpProxy:               HttpProxySpec }
  | { wellKnownInterlace:      null }
  | { disclosure:              null }
  | { wellKnownIdentityBridge: null }
  | { ociRegistry:             null }
  | { wellKnownMcpRegistry:    null }
  | { caBundle:                null }
  | { vaultProxy:              VaultProxySpec };

/** Per-route config for the `vaultProxy` Route.kind. */
export interface VaultProxySpec {
  /** Logical bundle name passed to `env.VAULT_STORE.idFromName(...)`. */
  bundleIdName: string;
}

/** Per-route config for the `mcp` Route.kind. */
export interface McpRouteSpec {
  backends: readonly Backend[];
}

export interface Backend {
  /** Human-friendly id, must be unique within the McpRouteSpec. */
  name:          string;
  /** Tool-name prefix. Two backends sharing a prefix is a build error. */
  handlesPrefix: string;
  /** Discriminated union picking the backend transport. */
  kind:          BackendKind;
}

export type BackendKind =
  | { durableObject:  DoBackend }
  | { mcpProxy:       HttpForwardBackend }
  | { serviceBinding: ServiceBindingBackend }
  | { udsForward:     UdsForwardBackend }
  | { leylineNet:     LeylineNetBackend };

export interface DoBackend {
  binding: string;
  keyArg:  string;
  tools:   readonly McpToolSpec[];
}

export interface HttpForwardBackend {
  urlBinding:      string;
  tools:           readonly McpToolSpec[];
  dynamicTools:    boolean;
  stripPrefix:     string;
  requiresSession: boolean;
  protocolMode:    string;
  serviceBinding:  string;
  claims:          readonly string[];
}

export interface ServiceBindingBackend {
  binding: string;
  tools:   readonly McpToolSpec[];
}

export interface UdsForwardBackend {
  socketPath: string;
  tools:      readonly McpToolSpec[];
}

export interface LeylineNetBackend {
  companionUrlBinding: string;
  upstreamId:          string;
  tools:               readonly McpToolSpec[];
}

export interface ServiceBindingProxySpec {
  binding:      string;
  upstreamHost: string;
  stripPrefix:  string;
}

export interface HttpProxySpec {
  urlBinding:  string;
  stripPrefix: string;
}

export interface McpToolSpec {
  name:            string;
  description:     string;
  /** JSON Schema text, parsed once at boot. */
  inputSchemaJson: string;
}

// ── Gateway-level surface (Phase 4a of "cloister.capnp as build artifact" arc) ─
//
// Mirror of `manifest/cluster.capnp:Gateway` + `Actor` + `InterlacePolicy` +
// `GatewayMetadata`. Same shape as the cloister.capnp-side Gateway struct
// (the cloister.capnp emitter projects from this into the generated
// `Cloister.Gateway` value). Mirroring (instead of importing) the
// cloister.capnp shape keeps cluster.capnp self-contained — consumers
// depend on one schema file, not two.
//
// Per cloister-c919d7 / ADR-0031 Phase 4a.

/**
 * Operator-authored Gateway-level fields. An all-empty value (every
 * string `""`, every list `[]`, every bool `false`, every uint `0`)
 * means "use the emitter's ART-default template" — preserved as a
 * back-compat fall-through for pre-Phase-4a `cluster.toml` files.
 */
export interface Gateway {
  metadata: GatewayMetadata;
  actor:    Actor;
  policy:   InterlacePolicy;
  /**
   * `cloister/credential-isolation/v1` service declarations that the
   * cloister.capnp emitter projects into `Cloister.Gateway`.
   * Empty array = no services declared; vaultProxy routes stay
   * safe-closed until the operator opts services in.
   */
  vaultProxyServices: readonly VaultProxyServiceConfig[];
}

export interface VaultProxyServiceConfig {
  name:                string;
  upstreamBaseUrl:     string;
  defaultAllowedSubs:  readonly string[];
  rateLimitPerMinute:  number;
  injection:           VaultProxyInjection;
}

export type VaultProxyInjection =
  | { authorizationBearer: null }
  | { authorizationBasic:  null }
  | { headerNamed:         { name: string } }
  | { queryParam:          { name: string } }
  | { bodyField:           { path: string } };

/**
 * Logical manifest name + version. Distinct from `ClusterMetadata`:
 * cluster.metadata.name = deployment identity ("art-default");
 * gateway.metadata.name = manifest identity ("cloister-art",
 * "cloister-agent-cluster"). Per ADR-0004 + ADR-0009.
 */
export interface GatewayMetadata {
  /** e.g. "cloister-art". Empty ⇒ fall through to emitter default. */
  name:    string;
  /** Semver. Empty ⇒ fall through. */
  version: string;
}

/**
 * Interlace actor identity (ADR-0007). Empty `fingerprint` means
 * Interlace discovery is disabled — the recipe that ships without a
 * `.well-known/interlace/` doc.
 */
export interface Actor {
  /** SHA-256 fingerprint of the master pubkey, "sha256:<hex>". */
  fingerprint:     string;
  /** "ed25519" or "ml-dsa-44". */
  algorithm:       string;
  /** Env-var binding holding the master pubkey (e.g. "INTERLACE_MASTER_PUBKEY"). */
  pubkeyBinding:   string;
  /** Off-platform attestation chain location, or empty for in-DO storage. */
  attestationRepo: string;
  /** Optional CF Tunnel / off-platform endpoint. */
  tunnelEndpoint:  string;
}

/**
 * Interlace policy declared in the `.well-known/interlace/` discovery
 * doc — peers learn the actor's requirements before initiating
 * (ADR-0007).
 */
export interface InterlacePolicy {
  /** Max ephemeral cert lifetime in seconds (defaults to 300). */
  maxCertLifetimeSeconds: number;
  /** Whether peer interactions must carry interlock peer-refs (§6.2). */
  requireInterlock:       boolean;
  /** Minimum signature algorithm accepted on incoming certs. */
  minAlgorithm:           string;
}
