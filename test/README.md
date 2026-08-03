# `test/` — vitest-pool-workers test suite

Tests run inside a real workerd instance via
`@cloudflare/vitest-pool-workers`, so DOs, SQL, Web Crypto and the
service-binding plumbing are exercised against the same runtime that
ships in production. `task lint` runs the full suite (currently
**766 passed | 8 skipped (774)**); `task test` is the same gate with
verbose output.

Top-level files cover cross-cutting surfaces:

| File | Surface |
|------|---------|
| `router.test.ts` | The `Router` dispatch chain — match-and-claim semantics, CORS interaction, fall-through. |
| `cors.test.ts` | `pickAllowedOrigin` + the OPTIONS preflight policy. |
| `contracts.test.ts` | Cross-component contracts not owned by any one module. |
| `mcp.test.ts` | `McpEdgeRoute` JSON-RPC lifecycle (initialize, ping, tools/list, tools/call). |
| `mcp-auth.test.ts` | End-to-end auth path: lease middleware + edge interaction. |
| `blob-store.test.ts` | `BlobStore.put` / `BlobStore.get` round-trip + digest stability. |
| `trust-store.test.ts` | TrustStore DO RPCs: lease-and-chain advance, attestation apply, pending enqueue/drain. |
| `vault-store.test.ts` | CredentialVault DO: storage, identity gating, KEK source dispatch. |
| `helpers/` | Shared test fixtures — `signed-request.ts` builds a valid lease envelope for any test that hits `/mcp`. |

## Subdirectories

### `security/` — threat-model conformance

| File | What it asserts |
|------|----------------|
| `cross-do-recovery.test.ts` | End-to-end fault injection of the BlobStore → BeadStore → TrustStore handoff. Closes the test-coverage gap acknowledged in threat-model §13.4. Per `cloister-fff647`. |
| `disclosure-attestation-smoke.test.ts` | Production cross-DO `bead_create` orchestrator + the disclosure endpoint: signed envelope → orchestrator runs → JSONL chain returned. Per `cloister-492c08`. |
| `prompt-injection.test.ts` | A fully-compromised bundle (attacker code in its own V8 isolate) cannot exfiltrate credentials outside its slice grant. Demonstrates the ADR-0013 enforcement claim. Per `cloister-74ce00`. |
| `orchestrator-rsry-mode-integration.test.ts` | Full bead_create orchestrator with `BEAD_STORAGE_BACKEND="rsry"`: BlobStore.put → rsry stub → TrustStore.applyAttestation lands an attestation row with bead_id linking to rsry's synthetic id. Pins the §13.4 audit-chain reconstitution through the rsry mode + the do-mode bead_id symmetry + the rsry §13.4 short-circuit + the deprecation-warning one-shot semantics. Per `cloister-decf0d` + `cloister-f34f7b`. |

### `vault/`

| File | What it asserts |
|------|----------------|
| `multi-tenant-isolation.test.ts` | Two layers of vault isolation: manifest-enforced distinct DO IDs per bundle (binding layer) + crypto-enforced KEK derivation (envelope layer). Per `cloister-26546a`. |

### `spec/` — MCP spec compliance fixture

| File | What it asserts |
|------|----------------|
| `fixture-mcp-server.ts` | A strict-assert MCP server fixture that surfaces spec violations as recorded assertion targets. Phase 0 of ADR-0015. |
| `mcp-proxy-server-compliance.test.ts` | The Phase 1/2/3 acceptance contract for cloister-as-MCP-Proxy-Server. All tests are `.skip` intentionally — they encode obligations the current `McpProxyToolBackend` does not yet satisfy. Per `cloister-a2b76f`. |

### `routes/` — per-route handler tests

`disclosure.test.ts`, `lease-middleware.test.ts`, `oci-registry.test.ts`,
`well-known-identity.test.ts`, `well-known-mcp-registry.test.ts`,
`well-known.test.ts` — one suite per file under
[`src/routes/`](../src/routes/) (the `mcp.ts` and `bead-create-orchestrator.ts`
suites are at the top level because they touch multiple surfaces).
Also `tenant-dispatch.test.ts` (per-tenant SNI + path-prefix routing
per ADR-0030 §A2; full-walk constant-time scan + WeakMap match cache
per `cloister-92e846` §13.7.6 b/c; unwired-binding throttle per
`cloister-9339c0` §13.7.6(d)), `vault-do-credential-store.test.ts`
(rsry/bd vault forward with bundleIdFp redaction per `cloister-938b32`),
and `bead-create-orchestrator-backend.test.ts` (BEAD_STORAGE_BACKEND
resolver + createBeadViaRsry MCP wire + deprecation-warning seam per
`cloister-decf0d`).

### `integration/` — pipeline-level e2e (added 2026-06-22 cycle)

| File | What it asserts |
|------|----------------|
| `multi-tenant-dispatch.test.ts` | Multi-tenant reality smoke through `instantiate()` → TenantDispatchRoute → real fetch probes across 3 tenants (mixed SNI + path-prefix), byte-equivalent 404 across every "did not dispatch" path, concurrent probe stress on the WeakMap cache + unwired-binding throttle. Per `cloister-92e846` + `cloister-9339c0`. |
| `recipe-multi-tenant-instantiate.test.ts` | Portable Gateway fixture → `instantiate()` → `TenantDispatchRoute.match()` semantics. `scripts/test/recipe-multi-tenant-bridge.test.mjs` proves the fixture still equals the validated `recipes/multi-tenant-smoke/cluster.toml`, without importing Node-only CLI code into workerd. Per `cloister-c2bd47` + `cloister-6a19bc`. |
| `rsry-backend-e2e.test.ts` | rsry_* mcpProxy backend tools/list passthrough (no double-prefixing per `cloister-8ede3f`), claim-routing logic, instantiate() integration, ADR-0033 Open Q #2 (prefix collision with bd_/bead_/mache_/lsp_). Per `cloister-c2bd47`. |

### `manifest/` — runtime + backends

`runtime.test.ts` (the `instantiate()` pipeline), `cluster.test.ts`
(cluster-manifest validation), and one suite per backend kind:
`leyline-net-backend.test.ts`, `uds-forward-backend.test.ts`,
`mcp-proxy-dynamic.test.ts`, `leyline-net-edge-integration.test.ts`,
`tool-schemas.test.ts`. Also `rsry-backend.test.ts` (structural pin
for the rsry_* mcpProxy backend declared in `cluster.toml` per
`cloister-c2bd47` — handlesPrefix, serviceBinding=ROSARY_BUNDLE,
claims, coexistence with bead_* BeadStore DO).

### `wire/` — codec tests

`manifest.test.ts`, `tool-call.test.ts`, `tool-result.test.ts` (per-
struct round-trip), `signet-verify.test.ts` (wasm32 cert verifier),
`cross-check.test.ts` (Direction 1 of the cross-substrate proof:
capnp CLI bytes → our decoder), and the `fixtures/` data.

### `storage/` — DO storage helpers

One suite per file in [`src/storage/`](../src/storage/) — canonical
encoding stability, table CRUD, cross-DO content-hash equality,
falsifiability tests for the typed-CID stub. `falsifiability.test.ts`
is the witness that the storage-substrate hypothesis can be proven or
refuted by test, not just by inspection. See `cloister-df79a5`.

### `perf/` — benchmark harnesses (opt-in)

| File | Task target | What it measures |
|------|-------------|-------------------|
| `lease-pipeline.test.ts` | `task bench:lease` | Per-step latency of the lease verifier pipeline. |
| `tools-call-dispatch.test.ts` | `task bench:dispatch` | `tools/call` dispatch overhead, per backend kind. |
| `trust-store-contention.test.ts` | `task bench:trust-store` | TrustStore singleton-DO RPC contention under N concurrent peers. |
| `disclosure-endpoint.test.ts` | `task bench:disclosure` | JSONL throughput on chain replay. |

These are **excluded from `task lint` / `task test`**. They run under
`vitest.bench.config.ts`. Result writeups live in
[`docs/perf/`](../docs/perf/).

## How the suite maps to claims

The threat-model contract document
[`docs/security/threat-model.md`](../docs/security/threat-model.md) §11
holds the test-vs-claim accounting table — every row links a security
claim from ADR-0007 / 0011 / 0012 to the specific test that witnesses
it. If you're adding a new seam (cert mint, bundle fetch, lease step,
counter write, cross-DO handoff, disclosure endpoint, compute
substrate), extend the model first and add the witnessing test before
the implementation.
