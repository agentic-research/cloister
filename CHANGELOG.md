# Changelog

All notable changes to cloister are tracked here. Format roughly follows
[Keep a Changelog](https://keepachangelog.com/); the project is pre-1.0,
so we batch changes by month rather than ratcheting semver per release.

## [Unreleased]

Tracking via the bead store (`rsry_list_beads --repo cloister --status open`).

### Shipped 2026-05-13

- **leyline-sign-helper keystore federation + ResolveCache hardening**
  (PR #2, `fix/cloister-2a0faa`, beads `cloister-2a0faa`, `cloister-d95f0d`,
  `cloister-d9a3c6`, `cloister-da4a07`, `cloister-da87da`,
  `cloister-d7674e`) — host-side keystore now federates across
  `keychain://`, `op://` (1Password CLI), `security://` (macOS
  `/usr/bin/security`), and plain `https://` allow-list with byte-identical
  bytes from each backend. Six-specialist adversarial cycle (trust-root,
  dos, oracle, silence, isolation, replay friends + synthesis) ran inline:
  13 of 17 findings fixed pre-merge, 4 carry as follow-ups.
- **`ResolveCache` rewritten** (`cloister-d95f0d`, `cloister-d9a3c6`) —
  replaced `tokio::sync::OnceCell` with `tokio::sync::watch::channel` +
  `std::sync::Mutex` over a bounded `HashMap`/`VecDeque` pair. Two
  invariants closed: (a) **no panic on leader cancellation** — followers
  see `rx.changed().await → Err(_)` and bail with `HelperError::Internal`
  instead of hitting an `unreachable!()` (skeptic-friend P1); (b)
  **bounded growth** under unique-spec floods via FIFO eviction at
  `LEYLINE_SIGN_RESOLVE_CACHE_MAX` (default 1024). New testable entry
  `resolve_with<F, Fut>` separates wiring from the work-fn so unit
  tests can assert the singleflight contract directly.
- **`HelperError::KeystoreLocked` retired** (`cloister-da4a07`) — all
  keystore-side failures collapse to the §17.10 constant-time
  `NotFound` on the wire. Comment block on the removed variant
  warns future devs against re-introducing a distinct 503 (re-opens
  the §17.10 enumeration oracle); a `"keystore_locked"` outcome
  label remains on the operator-side `tracing` log only.
- **Coalescing test sharpened** (`cloister-da87da`) — the
  `concurrent_resolve_for_same_spec_*` HTTP-layer test was a
  wall-clock-budgeted shape check that would have passed even if
  singleflight regressed to N independent fetches. Renamed to
  `_smoke` (kept for HTTP-layer coverage); the actual invariant
  now lives in three unit tests on `ResolveCache` directly: real
  call-count assertion via `AtomicUsize` (16 concurrent callers →
  `counter == 1`), leader-cancellation no-panic, and bounded-flood
  size check.
- **Cargo feature split: `host` vs `host-extras`** — `host-extras`
  pulls in the OS-keystore federation (`keyring`, `secret-service`,
  `dbus-sys`), `host` is the lean default. `task verify` runs both
  feature shapes so the helper compiles + tests on linux-without-dbus
  builds where AGPL `secret-service` is not desired.
- **New env vars on the leyline-sign-helper** —
  `LEYLINE_SIGN_SIGN_ALLOW` (per-helper allow-list overlay for
  `/sign`), `LEYLINE_SIGN_OP_BIN` + `LEYLINE_SIGN_SECURITY_BIN`
  (subprocess paths for 1Password CLI and macOS `security`),
  `LEYLINE_SIGN_RESOLVE_TTL_MS` (positive-cache TTL; `0` disables
  caching), `LEYLINE_SIGN_RESOLVE_CACHE_MAX` (FIFO cap; default
  1024). All documented in ADR-0019 normative reqs 14–18.
- **ADR-0019 normative reqs 14–18** — env-var surface frozen for
  the pre-OSS release: `RESOLVE_CACHE_MAX` bound, `RESOLVE_TTL_MS`
  zero-means-no-cache semantics, subprocess-path overrides, allow-
  list overlay, host-extras feature flag.
- **CI hardening** (commits `7e4c3f1`, `7ef7c61`) — linux runner
  gained `libdbus-1-dev` + `pkg-config` so `keyring`'s
  `sync-secret-service` feature links; `dtolnay/rust-toolchain`
  pinned to `1.95.0` (matches `rust-toolchain.toml`) with a
  pre-warm step to stop the `rs:sign:host`/`rs:sign:wasm` parallel
  fan-out from racing rustup.

### Shipped 2026-05-12

- **Interlace 0.2.0 receipts (Phase 1)** (`cloister-ae713f`) — full
  TypeScript implementation of the six-piece arc. Server emit
  (Interlace-Receipt header on every authenticated 2xx), P-live verify,
  V-archival verify, SSE stream chain (open/close commitments with
  cryptographic pairing via `open_commitment_hash`), archival CA bundle
  endpoint, compromise notice mechanism. 104 new tests. Phase 1
  semantics: `RECEIPT_SIGNING_KEY` unset → no emission; peers verify-
  but-don't-enforce. Phase 2 cutover (peers fail-closed on missing
  receipts) is a future operator action, not a code change.
- **ADR-0018 Accepted** (`cloister-db99cd`) — notme co-location design
  with math-friend dual review synthesis. V8 isolate boundary trades
  memory-isolation for finer-grained policy expression; full
  prerequisite gate chain documented. Implementation gated on
  cloister-99165e + cloister-988589 + cloister-993bef Phase C.
- **ADR-0019 Accepted** (`cloister-98b693`) — sign-only trust-anchor-
  helper protocol. Cross-cutting prerequisite for ADR-0018 + ADR-0014
  v2b. Math-friend dual review synthesized: alg-substitution defense,
  opt-in pubkey return, base64url, 64 KiB MUST, 5s timeout, rate
  limit, ed25519-dalek pin, constant-time error shape, byte-hash-keyed
  SigningKey cache for zero-operator-action rotation propagation.
- **Lint-bundle-isolation gaps closed** (`cloister-988589`) — math-
  friend's 7 specific gaps fixed. New manifest fields
  (`holdsCredential`, `workerdServiceName`, `hypervisorRationale`),
  new Inv 5 (hypervisor-to-hypervisor wires must appear in
  cluster.capnp), Inv 1 extended to flag external-server-backed
  globalOutbound, Inv 3 requires non-empty hypervisorRationale for
  hypervisor-tier bundles. 9 new tests.
- **Threat model §2** — new row for the leyline-sign-helper binary
  trust root (per ADR-0019).
- **ADR-0020 Proposed + adversarial team chartered** (`cloister-1f249f`)
  — 7-role red-team rotation (dos-friend, oracle-friend, isolation-
  friend, replay-friend, trust-root-friend, silence-friend, synthesis-
  lead). Agent definitions in `~/github/jamestexas/agents/agents/`.
  Six specialists read-only; synthesis-lead owns the threat model.
  Origin: 5-why exercise surfaced pioneer-mode-under-resources-ops
  pattern across multiple surfaces.
- **dos-friend pilot dispatched** against `src/vault-store.ts` —
  4 findings: F1 unbounded RPC queue (`cloister-211b68`, open), F2
  identity propagation (`cloister-2140b5`, resolved by ADR-0021 below),
  F3 KEK rejected-promise cache (`cloister-2176e4`, **shipped**), F4
  credential-payload size cap (`cloister-21b5eb`, **shipped**).
- **F3 + F4 shipped in vault** (commit `4499f7c`) — `#getKEK` clears
  rejected promises with race-guard; `HelperKekSource.resolve` bounded
  retry (3 attempts, 100/250ms backoff + jitter, no 4xx retry);
  `validateCredentialPayload` enforces 32-header / 16 KiB / UTF-8-
  byte-counted caps at the input boundary before encrypt + SQL write
  can be triggered. 7 new adversarial tests.
- **ADR-0021 Proposed** — per-bundle vault DO instances. Closes the
  open identity-propagation question from `src/vault-store.ts:92-110`
  by implementing ADR-0013's documented binding-layer identity design
  (per-bundle `idFromName(bundleName)`) rather than adding new
  per-call signature or workerd-caller-name machinery. Gated by
  ADR-0018 (notme-as-bundle) landing. Layered-defense follow-on (per-
  call sig via ADR-0019 helper) noted but out of scope.
- **dos-friend F1 shipped** (commit `835816b`, `cloister-211b68`) —
  per-caller token-bucket budget + concurrency cap in vault DO.
  Math extracted as pure functions in `vault/src/rate-bucket.ts`
  (16 unit tests). DO-integration tests for Response-shaped paths
  in `test/vault-store.test.ts` (2 tests). Structured emit
  `vault.rate_limit_reject` for silence-friend's future audit hook.
- **trust-root-friend pre-merge gate** on PR #1 (cloister-99165e) —
  adversarial cycle 2026-05-12 surfaced 3 P1s + 3 P2s in the
  leyline-sign-helper. Merge held. Findings (one bead each):
  cloister-7aaab1 (/resolve byte exfil), cloister-7afedc (cross-UID
  loopback), cloister-7b5b9d (rate-limit wrong identity),
  cloister-7bb456 (binary integrity), cloister-7c2179 (CSRF simple-
  POST), cloister-7c737a (no-CL body cap bypass), cloister-7cd202
  (ed25519-dalek pin drift).
- **Threat model §15** — "Trust-anchor-helper attack surface" — 7
  new rows (§15.1–15.7) documenting each finding's invariant and
  closing playbook. Adversarial-cycle report at
  `docs/security/adversarial-cycles/2026-05-12.md`.
- **Failing tests on PR #1 branch** (`rs/crates/sign/tests/host_adversarial.rs`)
  — 5 tests that RED initially, each panic message points to a bead +
  threat-model row. PR CI now blocks the merge until they go green.
- **trust-root-friend cycle 1 fixes shipped on PR #1** (commits
  `de51d86` + `cb7ff50`): 5 of 7 findings closed code-side
  (§15.1 `/resolve` allow-list, §15.2 bearer-token auth, §15.3
  per-caller rate-limit, §15.5 strict Content-Type, §15.6
  RequestBodyLimitLayer, §15.7 ed25519-dalek pin). §15.4 (supervisor
  binary integrity) deferred as P2.
- **trust-root-friend cycle 2 verification** — re-dispatched after
  cycle-1 fixes. Headline NEW-1 (`cloister-9bd96c`, P1): supervisor
  templates were dropping operators into `AuthConfig::Disabled` =
  §15.2 restored for any operator following the install instructions
  verbatim. Closed same-cycle in commit `af794fb` via `--require-auth`
  fail-stop flag + `EnvironmentFile=`/`EnvironmentVariables` block in
  launchd plist and systemd unit. NEW-2 (P2, `cloister-9bee1f`) and
  NEW-3 (P3, `cloister-9bfbf6`) filed as non-blocking follow-ups.
- **Threat model §15.A** — cycle-2 per-row verification status +
  NEW-1/2/3 rows + "fix isn't done when code lands; done when the
  artifact operators follow enforces it" lesson captured.
- **PR #1 disposition: MERGE OK** for the trust-root surface. Other
  red-team specialists (oracle, isolation, replay, silence) queued
  for follow-up cycles.

### Arcs in flight

- **leyline-sign-helper Rust binary** (`cloister-99165e`) — implements
  ADR-0019 wire spec; extends existing `rs/crates/sign/` with a host-
  binary target. Multi-day Rust work; produces a PR.
- **kek-helper.mjs → leyline-sign-helper migration** (`cloister-993bef`)
  — depends on 99165e. Phase B (golden-vector parity tests) is the
  load-bearing gate; without byte-exact `/resolve` equivalence,
  derived KEKs drift → unrecoverable wrapped DEKs.
- **Cloister CLI in `rs/crates/cli/`** (`cloister-999532`) — Rust
  binary subsumes `scripts/cli-init.mjs`. Install/bundles/init/status
  subcommands. OCI-annotation-based tool installation per
  cloister-3a3b0d's CAS substrate.
- **External-consumer survey for notme's public surface** — ADR-0018
  prerequisite gate #5. Determines whether full co-location (this ADR)
  or Alternative 4 (split notme surface) is the right shape.
- **Joint benchmark** — `bead_create` burst + `cert_mint` on one
  workerd process. ADR-0018 prerequisite gate #6.
- **Receipts crypto TS → Rust-wasm port** (`cloister-9a1b72`) —
  attack-surface reduction follow-up to ae713f. P2; non-blocking.
- **TOML-derived config DX** (`cloister-277ae7`) — generate the three
  capnp files from extended wrangler.toml.

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
  complete, **cloister-side implementation Phase 1 shipped 2026-05-12**
  (`cloister-ae713f`, commit `a0d3fd3`) — emit-but-don't-enforce mode.
  Phase 2 cutover (peers fail-closed on missing receipts) is an operator
  action (flip `RECEIPT_SIGNING_KEY` env), not a code change. (Self-attested
  via three rounds of LLM adversarial review — no third-party cryptographic
  audit has been performed.)
- **Notme runs as a separate workerd process**. Co-location into
  cloister-router's workerd (`cloister-db99cd`) — ADR-0018 **Accepted
  2026-05-12** with math-friend dual review synthesized. Implementation
  gated on `cloister-99165e` (Rust helper binary) + `cloister-988589`
  (lint gaps, shipped) + `cloister-993bef` Phase C (sign-only helper
  available as opt-in) + external-consumer survey.
