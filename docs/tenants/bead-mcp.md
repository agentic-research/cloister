# bead-mcp

The `bead_*` tools are cloister's only **first-party MCP tenant**: an
intra-cluster Durable Object, not a proxied upstream. They give MCP
clients CRUD + full-text-search over per-repo bead (work-item) storage,
backed by the `BeadStore` DO on hypervisor-managed SQLite. Per-repo
isolation comes from `idFromName(args.repo)` — each repo string lands on
its own DO instance.

## Wire (current as of 2026-05-12; see [`cloister.capnp`](../../cloister.capnp) for source of truth)

```capnp
( name          = "bead",
  handlesPrefix = "bead_",
  kind = (durableObject = (
    binding = "BEAD_STORE",
    keyArg  = "repo",
    tools = [
      ( name = "bead_create",  description = "...", inputSchemaJson = "" ),
      ( name = "bead_update",  description = "...", inputSchemaJson = "" ),
      ( name = "bead_search",  description = "...", inputSchemaJson = "" ),
      ( name = "bead_list",    description = "...", inputSchemaJson = "" ),
      ( name = "bead_close",   description = "...", inputSchemaJson = "" ),
      ( name = "bead_comment", description = "...", inputSchemaJson = "" ),
    ],
  )),
),
```

Tool input schemas are sourced from
[`src/tool-schemas/bead.ts`](../../src/tool-schemas/bead.ts) (zod);
`inputSchemaJson = ""` is the explicit "use the TS schema" marker.
Drift between the two is a build error.

## Required bindings

| Binding | Kind | Where declared | Purpose |
|---|---|---|---|
| `BEAD_STORE` | `durableObjectNamespace = "BeadStore"` | [`config.capnp`](../../config.capnp) | DO namespace for per-repo bead storage |
| `BLOB_STORE` | `durableObjectNamespace = "BlobStore"` | [`config.capnp`](../../config.capnp) | content-addressed substrate (ADR-0003); used by the cross-DO `bead_create` orchestrator |
| `TRUST_STORE` | `durableObjectNamespace = "TrustStore"` | [`config.capnp`](../../config.capnp) | lease counters + attestation rows; written on every `bead_create` when the lease gate is on (ADR-0012) |

No env-var URL — the DO is in-process. No vault slice — the tool is
substrate-managed.

## Version pin

Not applicable — `bead-mcp` is in-process inside cloister-router. It
ships with the cloister image (currently `cloister:0.1.0` per
[`cluster.compose.yaml`](../../cluster.compose.yaml)).

## Cross-DO orchestration

The `bead_create` tool is the one bead method that participates in the
ADR-0012 §13.4 audit handoff. Per
[`src/routes/bead-create-orchestrator.ts`](../../src/routes/bead-create-orchestrator.ts):

1. `BlobStore.put(canonicalBytes)` — content-address the bead
2. `BeadStore.bead_create(repo, ..., contentHash)` — write the row
3. `TrustStore.applyAttestation(certDer, peerFp, scope, sig)` — attest
4. Optional pending-attestation enqueue if step 3 saw a contention 409

`McpEdgeRoute.callTool` intercepts `tools/call bead_create` and
delegates to the orchestrator when the lease gate is on. Other bead
methods stay intra-DO. See [CLAUDE.md](../../CLAUDE.md) §"Cross-DO
`bead_create` orchestration."

## Auth

- **Lease-gated** when `INTERLACE_ROOT_PUBKEY` is set on the deployment
  (production posture). The `VerifiedLease` (peerFp + scope + cert DER
  + sig) is threaded into `callTool` so the orchestrator can write
  attestation rows against the same cert that authorized the call.
- **Open** when `INTERLACE_ROOT_PUBKEY` is unset (dev/test). This is
  deployment-binding granularity, NOT a per-request bypass.

See [`src/routes/lease-middleware.ts`](../../src/routes/lease-middleware.ts)
and `docs/security/threat-model.md` for the full pipeline.

## Upstream project

In-tree. Implementation lives at
[`src/storage/bead-store.ts`](../../src/storage/bead-store.ts).
Schema at
[`src/tool-schemas/bead.ts`](../../src/tool-schemas/bead.ts).

## Cross-references

- [ADR-0003](../adr/0003-content-addressed-bead-store.md) — content-addressed bead storage (Phase 1 shipped)
- [ADR-0004](../adr/0004-capnp-manifest.md) — the manifest schema (`durableObject` is one of the kind variants)
- [ADR-0011](../adr/0011-hypervisor-bundle-boundary.md) — why `BeadStore` is **bundle-tier** while `BlobStore` / `TrustStore` are hypervisor-tier
- [ADR-0012](../adr/0012-truststore-vs-beadstore.md) — the DO classification and the cross-DO handoff
- [ADR-0013](../adr/0013-slice-grant-enforcement.md) — V8-isolate + Service-binding-as-syscall enforcement
