/**
 * GET /.well-known/interlace/index.json — Interlace discovery doc
 * (ADR-0007). The body is synthesized at request time from the typed
 * manifest's `actor`, `policy`, and mcp-route capabilities. Manifest is
 * the single source of truth — capabilities flow from `cloister.capnp`,
 * never hand-maintained alongside.
 *
 * Schema follows Interlace §4.1 (extended Cloudflare Agent Skills RFC).
 * The actor's master public key bytes are loaded from the env binding
 * named in `actor.pubkeyBinding` and emitted as base64url at request
 * time; the binding name itself is in the manifest, the key bytes are
 * not.
 *
 * Empty `actor.fingerprint` opts the cloister out of Interlace
 * discovery — the route returns 404 in that case so peers fall back to
 * out-of-band configuration.
 */

import type { EdgeRoute } from "../router.js";
import type { Env } from "../types.js";
import { resolveActorFingerprint } from "./actor-fingerprint.js";
import type {
  Backend,
  Gateway,
  InterlacePolicy,
  McpToolSpec,
  Route,
} from "../manifest/types.js";
import type { ActorCaBundleEntry } from "../storage/actor-ca-bundle.js";

// ── Public route ──────────────────────────────────────────────────────────

export class WellKnownInterlaceRoute implements EdgeRoute {
  constructor(
    private readonly path:     string,
    private readonly manifest: Gateway,
  ) {}

  match(request: Request): boolean {
    return (
      request.method === "GET" &&
      new URL(request.url).pathname === this.path
    );
  }

  async handle(_request: Request, env: Env): Promise<Response> {
    if (!resolveActorFingerprint(this.manifest, env)) {
      return new Response("interlace discovery disabled", { status: 404 });
    }

    // Fetch CA bundle epochs from TrustStore for the §2.3 epoch index.
    // Unreachable / empty TrustStore degrades to an empty array — the
    // index still emits the 0.2.0 shape so clients can rely on
    // `epochs: []` as a feature signal vs schema-missing.
    const epochs = await fetchEpochSummaries(env);
    const body = synthesize(this.manifest, env, epochs);

    return new Response(JSON.stringify(body, null, 2), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        // The doc reflects build-time pinned identity + manifest-derived
        // capabilities — stable across the lifetime of a deploy. Long
        // browser cache + ETag for cheap revalidation.
        "cache-control": "public, max-age=300, must-revalidate",
        "etag":          weakEtag(body),
      },
    });
  }
}

// ── Body synthesis ────────────────────────────────────────────────────────

interface CapabilityDoc {
  readonly name:        string;
  readonly description: string;
  readonly scopes:      readonly string[];
}

interface EpochDoc {
  readonly epoch:                number;
  readonly pubkey:               string;       // base64url no-pad — matches storage's `signing_key_pubkey_b64u`
  readonly status:               "active" | "retired";
  readonly issued_at_ms:         number;
  readonly retired_at_ms:        number | null;
  readonly compromise_notice:    string | null; // §2.7 signed-notice blob (b64u opaque); null if none
  readonly external_anchor_uri?: string;        // omitted when null (no key noise)
}

interface InterlaceDoc {
  readonly version:      string;
  readonly actor: {
    readonly fingerprint:        string;
    readonly master_public_key:  string;  // base64 SPKI/raw, or "" if env unset
    readonly algorithm:          string;
    readonly attestation_repo?:  string;
    readonly tunnel?: {
      readonly endpoint: string;
    };
  };
  readonly capabilities: readonly CapabilityDoc[];
  readonly policy: {
    readonly max_cert_lifetime_seconds: number;
    readonly require_interlock:        boolean;
    readonly min_algorithm:            string;
  };
  // ── Interlace 0.2.0 receipts (RECEIPTS.md §2.3) ─────────────────────────
  // The epoch index lets archival verifiers (V-archival) resolve
  // historical pubkeys when replaying receipts against retired epochs.
  // `current_epoch` is the entry with status='active'; null when no
  // active epoch is registered (e.g. fresh deploy with no key rotated
  // yet). `epochs[]` carries every archived entry, most-recent first.
  readonly current_epoch: number | null;
  readonly epochs:        readonly EpochDoc[];
}

/**
 * Build the discovery doc body. Pure function over (manifest, env,
 * epochs) so tests don't need a Request or a live TrustStore. The
 * route handler does the TrustStore RPC and passes the projection
 * in via `epochs`.
 */
export function synthesize(
  manifest: Gateway,
  env: Env,
  epochs: readonly ActorCaBundleEntry[] = [],
): InterlaceDoc {
  const actor       = manifest.actor;
  const policy      = manifest.policy;
  const masterKeyB64 = readEnvString(env, actor.pubkeyBinding) ?? "";

  const capabilities = manifest.routes.flatMap(routeCapabilities);

  const actorDoc: InterlaceDoc["actor"] = {
    fingerprint:       actor.fingerprint,
    master_public_key: masterKeyB64,
    algorithm:         actor.algorithm,
    ...(actor.attestationRepo ? { attestation_repo: actor.attestationRepo } : {}),
    ...(actor.tunnelEndpoint  ? { tunnel: { endpoint: actor.tunnelEndpoint } } : {}),
  };

  const epochDocs = epochs.map(toEpochDoc);
  const active    = epochDocs.find((e) => e.status === "active");

  return {
    version:        "0.2.0",
    actor:          actorDoc,
    capabilities,
    policy:         toPolicyDoc(policy),
    current_epoch:  active?.epoch ?? null,
    epochs:         epochDocs,
  };
}

function toEpochDoc(entry: ActorCaBundleEntry): EpochDoc {
  const base: EpochDoc = {
    epoch:              entry.epoch,
    pubkey:             entry.signing_key_pubkey_b64u,
    status:             entry.status,
    issued_at_ms:       entry.issued_at_ms,
    retired_at_ms:      entry.retired_at_ms,
    compromise_notice:  entry.compromise_notice_b64u,
  };
  return entry.external_anchor_uri
    ? { ...base, external_anchor_uri: entry.external_anchor_uri }
    : base;
}

function toPolicyDoc(p: InterlacePolicy): InterlaceDoc["policy"] {
  return {
    max_cert_lifetime_seconds: p.maxCertLifetimeSeconds,
    require_interlock:         p.requireInterlock,
    min_algorithm:             p.minAlgorithm,
  };
}

// ── Capability extraction ─────────────────────────────────────────────────

function routeCapabilities(route: Route): CapabilityDoc[] {
  if (!("mcp" in route.kind)) return [];
  return route.kind.mcp.backends.flatMap(backendCapabilities);
}

function backendCapabilities(backend: Backend): CapabilityDoc[] {
  const tools: readonly McpToolSpec[] = pickTools(backend);
  return tools.map((tool) => ({
    name:        tool.name,
    description: tool.description,
    scopes:      [scopeFor(tool.name, backend.handlesPrefix)],
  }));
}

function pickTools(backend: Backend): readonly McpToolSpec[] {
  const k = backend.kind;
  if ("durableObject"  in k) return k.durableObject.tools;
  if ("mcpProxy"       in k) return k.mcpProxy.tools;
  if ("serviceBinding" in k) return k.serviceBinding.tools;
  if ("udsForward"     in k) return k.udsForward.tools;
  if ("leylineNet"     in k) return k.leylineNet.tools;
  return [];
}

/**
 * Map an MCP tool name to its Interlace scope string. Default rule:
 * `<tool-name>:*` — peers must request a scope that ⊇ the tool name when
 * minting an ephemeral cert. Per-tool scope refinement happens at the
 * verifier middleware (ADR-0007), not here — this doc just advertises
 * the coarsest scope that covers the tool.
 */
function scopeFor(toolName: string, _prefix: string): string {
  return `${toolName}:*`;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function readEnvString(env: Env, binding: string): string | undefined {
  if (!binding) return undefined;
  const v = (env as unknown as Record<string, unknown>)[binding];
  return typeof v === "string" ? v : undefined;
}

function weakEtag(body: InterlaceDoc): string {
  // Cheap stable hash — fingerprint ⊕ capability count ⊕ current epoch
  // is plenty for cache validation; anything finer-grained would
  // require crypto.subtle (async, not great inside a synthesize+respond
  // path). Including current_epoch ensures a fresh ETag on key rotation.
  const epochTag = body.current_epoch ?? "none";
  return `W/"${body.actor.fingerprint}-${body.capabilities.length}-${epochTag}"`;
}

// ── TrustStore epoch fetch ────────────────────────────────────────────────

interface TrustStoreRpc {
  listCaBundleEpochs(): Promise<ActorCaBundleEntry[]>;
}

/**
 * Fetch the actor's CA bundle epochs from TrustStore. Returns an
 * empty array on any error (TrustStore binding missing, RPC throws,
 * etc.) — the index doc still emits the 0.2.0 shape with empty
 * epochs[] so clients can rely on the field's presence.
 */
async function fetchEpochSummaries(env: Env): Promise<readonly ActorCaBundleEntry[]> {
  const trustBinding = (env as unknown as { TRUST_STORE?: DurableObjectNamespace }).TRUST_STORE;
  if (!trustBinding) return [];
  try {
    const stub = trustBinding.get(trustBinding.idFromName("cluster")) as DurableObjectStub & TrustStoreRpc;
    return await stub.listCaBundleEpochs();
  } catch {
    // TrustStore unreachable — degrade gracefully. The 0.2.0 shape
    // still lands; downstream readers see epochs: [].
    return [];
  }
}
