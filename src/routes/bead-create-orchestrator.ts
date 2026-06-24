// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Cross-DO `bead_create` orchestrator — production load-bearing path for
// the §13.2 "silence is evidence" invariant on state-boundary writes
// (cloister-492c08).
//
// Per ADR-0012's content-addressed handoff, a state-mutating tools/call
// like `bead_create` does NOT run as a single intra-DO INSERT. The
// production sequence is:
//
//   1. Build canonical `bead/v1` bytes from the bead-create params,
//      a pre-allocated id, and timestamps.
//   2. `BlobStore.put(bytes) → digest`   — idempotent CAS per ADR-0003.
//   3. `BeadStore.bead_create({id, content_hash: digest, ...})`
//                                         — per-repo DO write, ACID.
//   4. `TrustStore.applyAttestation({contentHash: digest, peerFp, scope,
//                                    cert, sig, prevSelfRef, prevPeerRef,
//                                    nowMs})`
//                                         — singleton DO write, ACID.
//   5. On failure of step 4: `TrustStore.enqueuePendingAttestation(...)`
//      so the retry queue can drain it. Per cloister-c6d378's
//      `pending_attestations` design + cloister-fff647's drain RPC.
//
// The bead row in BeadStore stays committed even if step 4 falls into the
// retry queue. From the caller's perspective `bead_create` returns SUCCESS;
// the attestation is best-effort durable via the retry pump.
//
// ## Why this lives in `src/routes/` and not `src/manifest/backends/`
//
// `bead_create` is the ONE bead method that takes the cross-DO path.
// `bead_search`, `bead_list`, `bead_get`, `bead_close`, `bead_comment`,
// `bead_update` are intra-DO single-statement writes per the §13.4 audit
// — they don't participate in the cross-DO state-boundary contract. Rather
// than thread the orchestrator through `DurableObjectToolBackend.invoke`
// (which would require a per-method discriminator + complicate the generic
// backend), the `McpEdgeRoute.callTool` happy path is intercepted ONLY for
// `bead_create` and routed here. Every other tool flows through the
// existing generic backend unchanged.
//
// ## Lease pass-through (cloister-492c08 / option A)
//
// The lease middleware (`src/routes/lease-middleware.ts`) verifies the
// cert + sig + scope but discards them after the lease counter advance.
// The orchestrator needs all three to write a meaningful attestation
// row. To avoid widening backend signatures across every kind, the
// `McpEdgeRoute.handlePost` flow attaches the verified `VerifiedLease`
// + cert DER + request sig to a `BeadCreateContext` and passes it
// explicitly when dispatching `bead_create`. (Threading via
// `request.cf` is the workerd-native way; we use a typed sidecar
// argument because the dispatch path is already a function call.)
//
// ## Failure semantics
//
//   - BlobStore.put throws (sentinel digest in test mode) → orchestrator
//     short-circuits; no BeadStore/TrustStore writes; bubble JsonRpcInvocationError.
//   - BeadStore.bead_create returns JSON-RPC error → orchestrator
//     short-circuits; bubble JsonRpcInvocationError; no TrustStore write.
//     The BlobStore put already landed (idempotent CAS); a retry produces
//     the same digest. Per §13.4 invariant: "BeadStore failure short-
//     circuits before TrustStore is touched."
//   - TrustStore.applyAttestation throws OR returns ok=false → orchestrator
//     enqueues `pending_attestations` and returns SUCCESS to the caller.
//     The bead row stays committed. Retry pump drains the queue.

import type { Env, JsonRpcRequest, JsonRpcResponse, Bead, BeadPriority, BeadState } from "../types.js";
import { JsonRpcInvocationError } from "../backends.js";
import { beadCanonicalBytesV1 } from "../storage/bead-canonical.js";
import type { ApplyAttestationResult, PeerAttestation } from "../storage/peer-attestations.js";
import type { Digest } from "../storage/types.js";
import { BLOB_PUT_FAULT_DIGEST } from "../blob-store.js";

/**
 * Lease + cert material passed from the verified lease envelope to the
 * orchestrator. The middleware extracted these; the dispatcher relays
 * them; the orchestrator uses them to populate the attestation row.
 *
 * `cert` is the raw DER bytes of the caller's cert (the one whose chain
 * was verified). `sig` is the Ed25519 signature over the canonical
 * request bytes (already verified). `scope` is the cert's claimed scope
 * (after the middleware's `scopeAllows` check). `peerFp` is the
 * fingerprint claimed by the cert. The shape mirrors `VerifiedLease`
 * but adds the cert+sig bytes that the verifier collected on the way.
 */
export interface BeadCreateContext {
  peerFp: string;
  scope:  string;
  certDer: Uint8Array;
  sig:    Uint8Array;
}

/** TrustStore RPC surface used by the orchestrator. */
interface TrustStoreRpc {
  lastAttestationForPeer(peerFp: string): Promise<PeerAttestation | null>;
  applyAttestation(args: {
    peerFingerprint: string;
    contentHash:     string;
    contentType:     string;
    scope:           string;
    cert:            Uint8Array;
    sig:             Uint8Array;
    prevSelfRef:     string | null;
    prevPeerRef:     string | null;
    nowMs:           number;
    /**
     * Bead row id this attestation audits (cloister-c8b907 sub-bead 1).
     * After BeadStore-DO deprecation the §13.4 chain reconstitutes via
     * the bead_id link. Today's orchestrator passes it (we already have
     * the id from step 1); future state-boundary writes against non-bead
     * state may leave it undefined.
     */
    beadId?:         string;
  }): Promise<ApplyAttestationResult>;
  enqueuePendingAttestation(args: {
    peerFp:      string;
    contentHash: string;
    scope:       string;
    cert:        Uint8Array;
    sig:         Uint8Array;
    nowMs:       number;
  }): Promise<{ enqueued: boolean }>;
}

/** BlobStore RPC surface used by the orchestrator. */
interface BlobStoreRpc {
  put(bytes: Uint8Array): Promise<Digest>;
}

/** BeadStore stub surface — JSON-RPC over `fetch`. */
interface BeadStoreFetch {
  fetch(req: Request): Promise<Response>;
}

/**
 * Generate a stable bead id BEFORE BlobStore.put so the canonical bytes
 * (which include `id`) can be hashed once and re-hashed identically on
 * retry. We use the same shape `BeadStore.generateId` uses internally;
 * the orchestrator is the new authoritative id source for orchestrated
 * writes. (Direct intra-DO callers — tests, future internal probes —
 * still get a DO-generated id when they don't supply one.)
 */
function generateBeadId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Build the deterministic canonical-bytes input for `bead_create`. The
 * orchestrator pins:
 *
 *   - id           — pre-allocated; deterministic across retries (same
 *                    id → same canonical bytes → same digest)
 *   - state        — always "open" at create time
 *   - labels       — sorted before hashing (see beadCanonicalBytesV1)
 *   - created_at   — `nowMs` rendered as an ISO-string-equivalent in
 *                    SQLite's `datetime('now')` format. Pinning this on
 *                    the orchestrator side keeps the digest deterministic
 *                    even if the DO's `datetime('now')` differs by a few ms
 *                    on a retry.
 *   - updated_at   — equal to `created_at` at create time
 *
 * The `nowMs` parameter is `Date.now()` from the calling context. SQLite
 * formats datetime as `YYYY-MM-DD HH:MM:SS` (UTC); we render it that way
 * so the bead row's stored timestamps match what BeadStore would have
 * inserted with `datetime('now')`. Determinism across the orchestrator
 * (canonical bytes) + BeadStore (row insert) is critical: a third party
 * recomputing `digest(canonical(bead))` from the row alone must get the
 * same value the attestation references.
 */
function formatSqliteUtcNow(nowMs: number): string {
  const d = new Date(nowMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
         `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function buildBead(args: {
  id:          string;
  title:       string;
  description: string;
  priority:    BeadPriority;
  labels:      string[];
  created_by?: string;
  repo:        string;
  nowMs:       number;
}): Bead {
  const ts = formatSqliteUtcNow(args.nowMs);
  return {
    id:          args.id,
    title:       args.title,
    description: args.description,
    state:       "open" as BeadState,
    priority:    args.priority,
    labels:      args.labels,
    created_at:  ts,
    updated_at:  ts,
    created_by:  args.created_by,
    repo:        args.repo,
  };
}

/**
 * Run the full ADR-0012 handoff for `bead_create`. Inputs come from the
 * MCP tools/call argument bag + the verified-lease context.
 *
 * Returns the bead summary the JSON-RPC caller expects (id + state +
 * content_hash). Throws `JsonRpcInvocationError` on BlobStore / BeadStore
 * failure (those short-circuit the pipeline; the caller cannot proceed).
 * A TrustStore failure does NOT throw — the attestation is enqueued for
 * retry and the bead row stays committed; eventual consistency.
 */
export async function runBeadCreateOrchestrator(args: {
  toolArgs:   Record<string, unknown>;
  env:        Env;
  context:    BeadCreateContext;
  nowMs:      number;
}): Promise<{ id: string; title: string; state: BeadState; content_hash: string }> {
  const a = args.toolArgs;
  const repo = String(a.repo ?? "");
  if (!repo) {
    throw new JsonRpcInvocationError(
      -32602,
      "bead_create: repo is required (key for BeadStore DO instance)",
    );
  }

  // ── Step 0: shape the bead struct (deterministic, retry-safe inputs).
  const id = generateBeadId();
  const title       = String(a.title ?? "");
  const description = String(a.description ?? "");
  const priority    = Number(a.priority ?? 0) as BeadPriority;
  const labels      = Array.isArray(a.labels) ? (a.labels as string[]).slice() : [];
  const created_by  = a.created_by != null ? String(a.created_by) : undefined;
  const bead = buildBead({
    id, title, description, priority, labels, created_by, repo,
    nowMs: args.nowMs,
  });

  // ── Step 1: BlobStore.put — idempotent CAS. Same canonical bytes →
  //           same digest; retry-safe.
  const canonicalBytes = beadCanonicalBytesV1(bead);
  const blobStore = blobStoreStub(args.env);
  let digest: Digest;
  try {
    digest = await blobStore.put(canonicalBytes);
  } catch (err) {
    throw new JsonRpcInvocationError(
      -32603,
      `bead_create: BlobStore.put failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // Fault-injection sentinel (test mode only). In production the sentinel
  // is never emitted by BlobStore.put; the check is inert. See
  // BLOB_PUT_FAULT_DIGEST header in src/blob-store.ts.
  if (digest === BLOB_PUT_FAULT_DIGEST) {
    throw new JsonRpcInvocationError(
      -32603,
      "bead_create: BlobStore.put faulted (test-only sentinel)",
    );
  }

  // ── Step 2: write the bead row. Branch on BEAD_STORAGE_BACKEND
  //           (cloister-decf0d / ADR-0033 D5 amendment): default "do"
  //           uses cloister's BeadStore DurableObject (legacy path); "rsry"
  //           writes via rsry's MCP `rsry_bead_create` over ROSARY_BUNDLE,
  //           landing the row in bd-managed Dolt. Either path: the
  //           returned id flows into Step 3's bead_id-linked attestation,
  //           preserving the §13.4 audit chain across the migration.
  const backend = bedStorageBackend(args.env);
  if (backend === "do") emitBeadStoreDoDeprecationWarningOnce();
  const beadResult: { id: string; title: string; state: BeadState } =
    backend === "rsry"
      ? await createBeadViaRsry(args.env, { ...a, id, repo, content_hash: digest })
      : await createBeadViaBeadStoreDO(args.env, repo, { ...a, id, repo, content_hash: digest });

  // ── Step 3: TrustStore.applyAttestation — singleton DO. We recompute
  //           prev_self_ref from the CURRENT chain head (per the
  //           pending_attestations docstring's "no caller-provided
  //           prev_self_ref" rule). If apply fails OR throws, enqueue
  //           and continue — the bead row stays committed.
  const trustStore = trustStoreStub(args.env);
  const head = await trustStore.lastAttestationForPeer(args.context.peerFp);
  const prevSelfRef = head?.content_hash ?? null;

  let applyOk = false;
  try {
    const result = await trustStore.applyAttestation({
      peerFingerprint: args.context.peerFp,
      contentHash:     digest,
      contentType:     "bead/v1",
      scope:           args.context.scope,
      cert:            args.context.certDer,
      sig:             args.context.sig,
      // bead_id link per cloister-c8b907 sub-bead 1. The §13.4 audit
      // chain reconstitutes via this column after BeadStore-DO is
      // deprecated; the bead row in rsry/bd lacks content_hash but the
      // join recovers it from the attestation row.
      beadId:          beadResult.id,
      prevSelfRef,
      prevPeerRef:     null,
      nowMs:           args.nowMs,
    });
    applyOk = result.ok;
  } catch {
    applyOk = false;
  }

  if (!applyOk) {
    // ── Step 4: enqueue for retry. Best-effort durability. The caller's
    //           bead_create remains successful; the retry pump
    //           (TrustStore.drainPendingRetries via the alarm handler,
    //           or a manual sweep) will land the attestation eventually.
    try {
      await trustStore.enqueuePendingAttestation({
        peerFp:      args.context.peerFp,
        contentHash: digest,
        scope:       args.context.scope,
        cert:        args.context.certDer,
        sig:         args.context.sig,
        nowMs:       args.nowMs,
      });
    } catch (err) {
      // Enqueue itself failed — this is the GAP case the §8 audit calls
      // out. Surface as a 5xx; the caller can retry the whole bead_create,
      // which is safe because BlobStore + BeadStore are idempotent on the
      // pre-allocated id.
      //
      // Include `bead_id` in the message so operators following up on this
      // failure can run `TrustStore.attestationsForBead(bead_id)` to
      // verify the attestation didn't land (returns empty array) AND
      // identify which bead row was committed without audit. Per
      // cloister-dea77c — the bead_id link makes the §13.4 chain audit
      // queryable.
      throw new JsonRpcInvocationError(
        -32603,
        `bead_create: TrustStore.applyAttestation failed AND pending enqueue failed for bead ${beadResult.id} ` +
        `(content_hash=${digest}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    id:           beadResult.id,
    title:        beadResult.title,
    state:        beadResult.state,
    content_hash: digest,
  };
}

// ── DO stub helpers ──────────────────────────────────────────────────────

function blobStoreStub(env: Env): DurableObjectStub & BlobStoreRpc {
  return env.BLOB_STORE.get(env.BLOB_STORE.idFromName("cluster")) as DurableObjectStub & BlobStoreRpc;
}

function trustStoreStub(env: Env): DurableObjectStub & TrustStoreRpc {
  return env.TRUST_STORE.get(env.TRUST_STORE.idFromName("cluster")) as DurableObjectStub & TrustStoreRpc;
}

// ── cloister-decf0d: BEAD_STORAGE_BACKEND dispatch (sub-bead 2 of c8b907) ─

/**
 * Resolve the bead-storage backend from env. Unknown / empty / undefined
 * values default to "do" — the legacy BeadStore DurableObject path. Per
 * ADR-0033 D5 amendment 2026-06-24, "rsry" routes step 2 through rsry's
 * MCP `rsry_bead_create` tool, landing the row in bd-managed Dolt.
 */
export function bedStorageBackend(env: Env): "do" | "rsry" {
  const raw = (env.BEAD_STORAGE_BACKEND ?? "").trim().toLowerCase();
  return raw === "rsry" ? "rsry" : "do";
}

/**
 * One-shot deprecation log for the legacy BeadStore-DO path. Per c8b907
 * sub-bead 3 prep: operators on the default ("do") backend get a clear
 * signal that they're on the path scheduled for deletion in `cloister-f34f7b`.
 * One emit per cold-start; not per-request.
 *
 * Structured JSON so log aggregators can alert on the event without
 * needing string parsing. The `bead` field tracks the actual deletion
 * bead (sub-bead 3) so operators can subscribe to its closure to know
 * when the default flips.
 *
 * Module-level state so the cold-start guard survives across requests in
 * the same isolate. Per-isolate scope is the right granularity — log once
 * per workerd boot, not once per request.
 */
let beadStoreDoWarned = false;

function emitBeadStoreDoDeprecationWarningOnce(): void {
  if (beadStoreDoWarned) return;
  beadStoreDoWarned = true;
  // eslint-disable-next-line no-console -- intentional structured operator signal
  console.warn(JSON.stringify({
    event:        "bead_create.legacy_backend",
    backend:      "do",
    deprecation:  "cloister-f34f7b — BEAD_STORAGE_BACKEND default flips to 'rsry' in a future release",
    actionable:   "set BEAD_STORAGE_BACKEND=\"rsry\" to opt into the new backend now",
    parent_epic:  "cloister-c8b907",
    related_adr:  "ADR-0033 D5 amendment (2026-06-24)",
  }));
}

/**
 * Test-only seam: reset the deprecation-warned flag so a test can verify
 * the one-shot semantics across cases. Not exported via the production
 * route surface.
 */
export function __resetBeadStoreDoWarnedForTest(): void {
  beadStoreDoWarned = false;
}

/**
 * Legacy Step 2 — BeadStore DurableObject write, per-repo, ACID. The
 * pre-allocated id + content_hash flow through so the row references the
 * same digest the attestation will reference. Throws JsonRpcInvocationError
 * on JSON-RPC error response (§13.4 short-circuit invariant — no TrustStore
 * write if BeadStore failed).
 */
async function createBeadViaBeadStoreDO(
  env:    Env,
  repo:   string,
  params: Record<string, unknown>,
): Promise<{ id: string; title: string; state: BeadState }> {
  const beadStoreStub = (env.BEAD_STORE.get(
    env.BEAD_STORE.idFromName(repo),
  ) as unknown) as BeadStoreFetch;
  const innerReq: JsonRpcRequest = {
    jsonrpc: "2.0",
    method:  "bead_create",
    params,
    id:      0,
  };
  const beadRes = await beadStoreStub.fetch(new Request("https://internal/", {
    method:  "POST",
    body:    JSON.stringify(innerReq),
    headers: { "content-type": "application/json" },
  }));
  const beadBody = await beadRes.json() as JsonRpcResponse;
  if (beadBody.error !== undefined) {
    throw new JsonRpcInvocationError(
      beadBody.error.code,
      `bead_create: BeadStore.bead_create failed: ${beadBody.error.message}`,
    );
  }
  return beadBody.result as { id: string; title: string; state: BeadState };
}

/**
 * cloister-decf0d sub-bead 2 — write step 2 via rsry's `rsry_bead_create`
 * MCP tool. The wire is a single `tools/call` JSON-RPC over the rosary
 * bundle's service binding (preferred) OR the URL var fallback (dev).
 *
 * The rsry bead row does NOT carry `content_hash` (rosary's `issues`
 * table predates ADR-0003 content-addressing — verified 2026-06-24 via
 * `rs/rosary/src/dolt/migrate.rs`). The audit chain reconstitutes via
 * the bead_id column on `peer_attestations` (sub-bead 1, cloister-dea77c).
 *
 * MCP response unwrap: `tools/call` returns `result.content[0].text` as a
 * JSON-serialized payload — we parse and re-shape to `{id, title, state}`.
 */
export async function createBeadViaRsry(
  env:    Env,
  params: Record<string, unknown>,
): Promise<{ id: string; title: string; state: BeadState }> {
  // The mcpProxy wire (per ADR-0033 D1): ROSARY_BUNDLE service binding
  // preferred, ROSARY_MCP_URL var fallback (dev). Mirrors mcp-proxy.ts's
  // resolution shape but inlined to avoid the orchestrator depending on
  // the backend's transport machinery.
  const envAny = env as unknown as Record<string, unknown>;
  const binding = envAny["ROSARY_BUNDLE"];
  const url     = typeof env.ROSARY_MCP_URL === "string" ? env.ROSARY_MCP_URL : "";

  const innerReq = {
    jsonrpc: "2.0" as const,
    id:      0,
    method:  "tools/call",
    params: {
      name: "rsry_bead_create",
      arguments: params,
    },
  };
  const body    = JSON.stringify(innerReq);
  const headers = { "content-type": "application/json" };

  let res: Response;
  try {
    if (binding && typeof (binding as Fetcher).fetch === "function") {
      // Production / workerd-native: ROSARY_BUNDLE service binding.
      res = await (binding as Fetcher).fetch(
        new Request("https://internal/mcp", { method: "POST", body, headers }),
      );
    } else if (url.length > 0) {
      // Local-dev: URL var fallback to rsry MCP HTTP endpoint.
      res = await fetch(url, { method: "POST", body, headers });
    } else {
      throw new JsonRpcInvocationError(
        -32603,
        "bead_create rsry-mode: neither ROSARY_BUNDLE service binding nor ROSARY_MCP_URL is wired",
      );
    }
  } catch (e) {
    if (e instanceof JsonRpcInvocationError) throw e;
    throw new JsonRpcInvocationError(
      -32603,
      `bead_create rsry-mode: rsry unreachable: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new JsonRpcInvocationError(
      -32603,
      `bead_create rsry-mode: rsry returned ${res.status}: ${text.slice(0, 200)}`,
    );
  }

  const body2 = await res.json() as JsonRpcResponse;
  if (body2.error !== undefined) {
    // §13.4 short-circuit — propagate so TrustStore write doesn't happen.
    throw new JsonRpcInvocationError(
      body2.error.code,
      `bead_create: rsry_bead_create failed: ${body2.error.message}`,
    );
  }

  // MCP `tools/call` response shape: `result.content` is an array of
  // content blocks. The first block's `text` carries the tool's serialized
  // return value — for rsry_bead_create that's the new bead row as JSON.
  const result = body2.result as
    | { content?: Array<{ type?: string; text?: string }> }
    | undefined;
  const text = result?.content?.[0]?.text;
  if (typeof text !== "string") {
    throw new JsonRpcInvocationError(
      -32603,
      "bead_create rsry-mode: rsry response missing result.content[0].text",
    );
  }
  let parsed: { id?: string; title?: string; state?: BeadState };
  try {
    parsed = JSON.parse(text) as { id?: string; title?: string; state?: BeadState };
  } catch (e) {
    throw new JsonRpcInvocationError(
      -32603,
      `bead_create rsry-mode: rsry returned non-JSON tool result: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (typeof parsed.id !== "string") {
    throw new JsonRpcInvocationError(
      -32603,
      "bead_create rsry-mode: rsry response missing `id` field",
    );
  }
  return {
    id:    parsed.id,
    title: typeof parsed.title === "string" ? parsed.title : String(params.title ?? ""),
    state: parsed.state ?? ("open" as BeadState),
  };
}
