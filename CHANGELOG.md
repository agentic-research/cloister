# Changelog

All notable changes to cloister are tracked here. Format roughly follows
[Keep a Changelog](https://keepachangelog.com/); the project is pre-1.0,
so we batch changes by month rather than ratcheting semver per release.

## [Unreleased]

Tracking via the bead store (`rsry_list_beads --repo cloister --status open`).
The substantive arcs in flight:

- **Phase 1 of the MCP spec-alignment arc** (`cloister-a3ae4c`) — current-spec
  lifecycle compliance + rename `httpForward` backend kind → `mcpProxy`. Closes
  the visible-on-fresh-clone `mache_*`/`lsp_*` empty `tools/list` bug
  (`cloister-91e5d4`).
- **Interlace 0.2.0 receipts implementation** (`cloister-ae713f`) — internal
  spec text complete after three rounds of math-friend review. Cloister-side
  implementation (server emit + client verify + DO storage + SSE stream chain +
  archival CA bundle + compromise-notice handling) decomposes into child beads.
- **Notme co-location** (`cloister-db99cd`) — fold notme into cloister-router's
  workerd process as a tenant Worker; master_sk isolation via V8 boundary per
  ADR-0013 rather than process boundary.
- **MCP `roots` primitive** (`cloister-65a30f`) — thread client-declared
  filesystem scope through cloister to upstream MCP servers.
- **TOML-derived config DX** (`cloister-277ae7`) — generate the three capnp
  files (cloister.capnp, cluster.capnp, config.capnp) from extended wrangler.toml.

## [0.1.0] — 2026-05 (current)

The substrate baseline. Everything below is in `main` and gated by CI's
`task lint` + `task verify`.

### Hypervisor + cluster topology

- **v8-isolate hypervisor on `workerd`**. Same TypeScript bundle runs locally
  on `workerd serve` and on Cloudflare Workers in production.
- **Declarative routing** via `cloister.capnp`. Adding a route, backend, or
  bundle is a manifest edit; nothing in `src/` changes.
- **Per-tier bundle classification** per ADR-0011 — `hypervisor` (cloister-router,
  notme-identity, the singleton DOs) vs `cluster` (mache, rosary, ley-line-open).
- **Cluster runtime**: `task cluster:dev` (mac-native), `task cluster:up`
  (docker/podman/nerdctl compose). Boot-to-200-on-`/health` metric reported
  in `task cluster:test`.

### MCP face

- **`/mcp` Streamable HTTP** endpoint serves `bead_*`, `lsp_*`,
  `reparse`/`enrich`/`status`, and (with dynamic-tools) `mache_*`.
- **Sessionless protocol support** per SEP-2575 + SEP-2567 — cloister speaks
  both the current `2024-11-05` lifecycle and the next sessionless protocol
  concurrently. `MCP-Protocol-Version` header switches dispatch path. (`cloister-a35fdb`)
- **Spec-compliance test fixture** at `test/spec/fixture-mcp-server.ts` —
  asserts P-live verifier and V-audit invariants against both protocol versions.
- **MCP Registry** OpenAPI surface at `/.well-known/mcp-registry/v0.1/`
  exposes cloister's upstream catalog (`art.agentic-research/cloister/<id>`).
  Single-server lookup returns constant-time 404 for filtered-out backend
  kinds (`durableObject`, `serviceBinding`, `udsForward`). (`cloister-a30e40`,
  `cloister-ec7a52`)
- **Identity bridge** at `/.well-known/identity-bridge` — proxies WebFinger,
  Nostr NIP-05, OAuth2 client_credentials grant, OIDC discovery, JWK Set.
  (`cloister-c9922f`)

### Identity & trust

- **Interlace lease verification** in `src/routes/lease-middleware.ts` —
  full pipeline: header parse → clock-skew bound → wasm32 cert-chain verify
  → claims required → epoch + validity-window check → Web Crypto Ed25519
  request-sig verify → scope match → seen-nonces replay check → TrustStore
  RPC upsert. Active when `INTERLACE_ROOT_PUBKEY` is set; skipped when unset
  (deployment-binding granularity, not per-request bypass).
- **TrustStore + BeadStore + BlobStore** singleton/per-repo Durable Objects
  per ADR-0012. Cross-DO writes via ADR-0003 content-addressed handoff;
  `bead_create` orchestrator at `src/routes/bead-create-orchestrator.ts`.
- **Per-bundle credential namespacing** in CredentialVault DO — composite
  primary key `(subject_fp, service)` derived from `VerifiedLease.peerFp`,
  not from caller input. Cross-bundle write attempts fail at the SQL layer
  in addition to the binding layer. (`cloister-26546a`)
- **Pluggable KEK source** — vault DO resolves the KEK from a URL spec
  (`env://`, `file://`, `keychain://` via the kek-helper sidecar, etc.).
  macOS Keychain dogfood-validated end-to-end. (`cloister-268a01`)

### Wire codecs

- **leyline-net wire** at `src/wire/` — signed capnp manifests with AEAD;
  cross-implementation byte-equality maintained via test vectors and a
  Python reference implementation.
- **Wasm cert-chain verifier** — `rs/crates/sign/` compiles to
  wasm32-unknown-unknown; loaded by `src/wire/signet-verify.ts`. Build via
  `task rs:sign:wasm`.

### OCI distribution

- **`task image`** builds a distroless OCI image via melange + apko (Wolfi
  base). `task image:load` retags after apko's per-arch tar emit so
  `cluster.compose.yaml`'s bare `cloister:0.1.0` reference resolves.
- **OCI registry Phase 1** at `/v2/` — read-only pull path (manifests +
  blobs). Tags live in TrustStore's `registry_tags` table. (`cloister-cabd57`)

### Specifications + drafts

- **Interlace protocol** at `interlace-spec/0.1.0/` — FINAL. 6 test-vector
  files; Python ref impl passes the same 27 conformance vectors as
  cloister's runtime.
- **Interlace 0.2.0 draft** at `interlace-spec/0.2.0-draft/` — signed
  receipts amendment closing the §13.2 response-side non-repudiation gap;
  URL canonicalization (Option 5: sign path-suffix after operator-declared
  prefix); paired test vectors. Three rounds of math-friend review.
  Cloister's internal protocol — the rigor exists to make cloister itself
  defensible, not as a campaign to standardize externally.
  (`cloister-ae713f` + `cloister-aecd26` + `cloister-770464`)
- **MCP Proxy Server design note** at `docs/mcp-seps/SEP-XXXX-mcp-proxy-server-formalization.md` —
  internal design documentation. Describes what a first-class MCP Proxy
  Server data-layer concept could look like (a `proxy` capability +
  `proxy/upstreams` introspection RPC). Cloister implements this shape
  as a working prototype. No upstream submission planned — per the MCP
  SEP guidelines (modelcontextprotocol.io/community/sep-guidelines),
  protocol changes derive from community + working-group consensus, not
  from cold spec drops. Kept here so the design rationale survives.

### Substrate properties (load-bearing)

- **§9.4 constant-time 404** at the disclosure endpoint — verified via
  `docs/perf/2026-05-10-disclosure-endpoint.md` bench-pinned at 60µs
  post-fix (was 17× delta pre-fix).
- **Slice-grant via V8 isolate + service-binding-as-syscall** per ADR-0013.
  19-case prompt-injection demo at `test/security/prompt-injection.test.ts`.
- **Substrate-property lint** (`scripts/lint-bundle-isolation.mjs`) — enforces
  ADR-0013 invariants at manifest level (no `globalOutbound` on cluster-tier;
  credential bindings only on the allow-list; every bundle declares a tier;
  cluster-tier bindings must have matching wires). (`cloister-ac30e7`)

### Build + CI

- **`.npmrc`** pins `package-import-method=hardlink` for pnpm. Without it,
  pnpm's default `auto` silently falls back to copy mode on macOS APFS;
  fix saves ~400MB per worktree (verified empirically).
- **`task ci`** mirrors GitHub Actions exactly (`task lint` + `task verify`).
  `scripts/git-hooks/pre-push` available for opt-in local enforcement.
- **CI drift gate** for interlace-spec vectors at
  `.github/workflows/interlace-spec-drift.yml` — pinned SHA-256 set
  refuses silent vector mutations. (`cloister-af1290`)

### Documentation

- README load-bearing claims table is honest about §13.2's current state
  (response-side non-repudiable only at Phase 2 cutover of receipts impl).
- ADRs 0001–0017 cover every substrate decision. ADR-0017 documents the
  workerd-config generator rationale (so reviewers don't keep asking why
  `[[wasm_modules]]` doesn't work).
- Navigability READMEs at 9 subsystem directories. (`cloister-be36ea`)
- MCP-client onboarding at `docs/integration/mcp-client.md`.

### Known gaps (the OSS-launch caveat list)

- **`mache_*` / `lsp_*` tools/list** is empty against `task cluster:up` —
  cloister-router doesn't complete the spec-mandated `notifications/initialized`
  handshake with upstream MCP servers. Tracked as `cloister-91e5d4`; fixed by
  Phase 1 of the spec-alignment arc (`cloister-a3ae4c`).
- **§13.2 chain-completeness** is currently honest-actor-at-admission only on
  the response side. interlace-spec 0.2.0 receipts close the gap; spec text
  complete, cloister-side implementation in flight. (Self-attested via three
  rounds of LLM adversarial review — no third-party cryptographic audit has
  been performed.)
- **Notme runs as a separate workerd process**. Co-location into
  cloister-router's workerd (`cloister-db99cd`) is in design phase.
