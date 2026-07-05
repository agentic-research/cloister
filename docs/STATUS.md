# cloister STATUS — what's shipped, what's drafted, what's blocked

This is the project's reality index. Every capability, ADR, and
substrate decision should be findable here with a one-line status.
Updated as PRs merge / beads close / drafts ship.

For the why-and-shape of each entry, follow the linked ADR. For the
work-tracking, follow the linked bead.

## Shipped (running in main today)

| Capability | Reference | Bead | Status |
|---|---|---|---|
| Workerd substrate (v8-isolate hypervisor) | ADR-0001, ADR-0011 | — | shipped |
| Declarative routing via `cloister.capnp` | ADR-0002, ADR-0004 | — | shipped |
| Per-tier bundle classification (hypervisor / cluster) | ADR-0011 | — | shipped |
| Interlace lease verification | ADR-0007, `src/routes/lease-middleware.ts` | — | shipped |
| TrustStore + BeadStore + BlobStore DOs | ADR-0012 | — | shipped |
| Slice-grant enforcement (V8 isolate + service-binding-as-syscall) | ADR-0013 | — | shipped |
| Pluggable KEK source (`keychain://`, `op://`, `apple-password://`, `keyring://`, `secret-tool://`, `file://`, `env://`, `http(s)://`) | ADR-0014 | — | shipped |
| Sign-only trust-anchor-helper (`leyline-sign-helper`) | ADR-0019, `rs/crates/sign/` | `cloister-99165e` | shipped |
| Per-bundle vault DO instances | ADR-0021 | — | shipped (manifest-side via ADR-0013 enforcement) |
| schema-bridge (capnp → zod for `cluster.capnp`) | `tools/schema-bridge/` | — | shipped (cluster.capnp only — see `cloister-aea8a7`) |
| `CLOISTER_DO_PATH` host path resolution (macOS unblocker) | ADR-0023 | `cloister-addcdd` | shipped 2026-05-16 |
| Interlace 0.2.0 receipts (Phase 1: emit-but-don't-enforce) | `interlace-spec/0.2.0-draft/`, `cloister-ae713f` | — | shipped 2026-05-12 |
| Adversarial red-team rotation charter | ADR-0020 | `cloister-1f249f` | charter shipped; cycles ongoing |
| Notme co-location design (Alternative 4 split surface) | ADR-0018 | `cloister-db99cd` | design accepted; impl pending |
| Compute substrate portability (Phase 1: OCI + workerd) | ADR-0009 | — | Phase 1 shipped; Phase 2+ (Firecracker / WASI / unikernel) future |
| `task image:run` composable OCI image launcher | `cloister-a3681d` | closed | shipped 2026-05-16 |
| DO SQLite unencrypted-at-rest disclaimer | `cloister-a3681d` | closed | shipped 2026-05-16 |
| **Bidi TOML ↔ capnp pipeline (Phase 1)** — `cluster.toml` operator surface; `cluster:toml` / `:export` / `:roundtrip` Taskfile entries; drift gate in `task verify` | **ADR-0025**, `cluster.toml`, `scripts/toml-to-cluster.mjs`, `scripts/cluster-to-toml.mjs` | `cloister-ae06f3`; default-omission cleanup `cloister-146b50` | shipped 2026-05-17 (PR #9). 2026-07-04 follow-up: canonical TOML now omits schema-zero bundle defaults while the reader restores them before validation. |
| **`cloister/credential-isolation/v1`** capability — first reference impl under the substrate-as-kernel framing. Operator declares services in `cloister.capnp` via `vaultProxyServices`; route mounts via `vaultProxy` Route.kind with `VaultProxySpec.bundleIdName`; production `VaultDoCredentialStore` auto-selects when `env.VAULT_STORE` is bound; plaintext credential bytes never cross the vault DO trust boundary (ADR-0013); per-bundle DO keying via `bundleIdName` schema field (ADR-0021); forward path emits `ProxyCallReceipt` + `vault_proxy_call` metric (audit claim #3); wire-shape collapse closes substrate/registry/binding oracles (claim #4); `Cache-Control: no-store` on every error site; per-peer sharded inflight cap. | **ADR-0024**, `cloister-spec/credential-isolation/v1/`, `src/routes/vault-proxy*`, `src/routes/vault-do-credential-store.ts`, [`docs/security/threat-model.md` §18](security/threat-model.md) | `cloister-8f57f0` | **Shipped 2026-05-18** (initial PRs #29-#34, #36-#37, #40-#42; 2026-05-18 adversarial cycle remediation PRs #50-#56). 1118 tests green. All five master claims restored after the 2026-05-18 cycle (report [`docs/security/adversarial-cycles/2026-05-18.md`](security/adversarial-cycles/2026-05-18.md); threat-model §18). Outstanding follow-ups (non-blocking): `cloister-6e6bfb` (X-1 tracker — DoS F1 per-peer denial counter, design-pass), `cloister-6f4284` (DoS F5 lease-verify cache, design-pass). `cloister-6ed9ae` (manifest `defaultAllowedSubs` gate on forward path) shipped via commit `3093044` / PR #58 — gate lives at `vault-proxy-route.ts:229-244`. |

## Drafted / in-flight (ADR design — many rows already have shipped code)

> **ADR status ≠ implementation status.** An ADR labeled "Proposed"
> means the *design decision* isn't formally ratified yet — it does
> **not** mean unimplemented. Several rows below are shipped and tested
> in `main` today (e.g. **ADR-0026** tool composition, **ADR-0033** bd
> substrate, **ADR-0034** multi-tenant lint + dispatch + compose emit,
> **ADR-0038** image derivation). The **Notes** column is the source of
> truth for what's actually running — docs lag code here, so read the
> Notes, not the ADR label.

| Capability | Reference | Bead | Notes |
|---|---|---|---|
| Substrate-as-kernel framing (every concrete subsystem → v1 reference impl of a named Capability Interface, k8s CNI/CSI/CRI shape) | — | `cloister-1b59a2` | Framing direction; formalizing ADR is **pending from user's other LLM session** (network-identity ADR). Don't pre-empt. Phase 1 of the substrate-schema-neutral rail shipped via `cloister-ae06f3` 2026-05-17. |
| ADR-0022 — schema-bridge positioning + bidi pipeline framing | — (ADR not yet drafted) | `cloister-ae587d` | Overdue. ADR-0025 ships the bidi rail without it; ADR-0022 still wanted to close out the schema-bridge narrative. |
| **ADR-0026** — Tool composition model (Nix-flakes-shaped, MCP-registry-resolved, content-addressed, Interlace-signed) | **ADR-0026**, `cluster.toml` `[inputs.*]` block (Phase 1a + 1b + Phase 2 subpieces 1+2+3 shipped) | **`cloister-cf7a3b`** | Operator declares tools by `ref = "io.github.org/tool"` + `version = "^0.1"`; cloister resolves via registry, fetches signed `server.json`, composes wiring. **Phase 1a (PR #62)** + **Phase 1b (PR #63)** shipped — `[inputs.*]` schema seam + file/https resolver + `cluster.lock.toml`. **Phase 2 subpiece 1 (PR #76)**: github:// scheme in resolver. **Phase 2 subpiece 2 (PR #77)**: `task add -- <ref>` CLI. **Phase 2 subpiece 3 (PR #79)**: io.github.org/ → github:// sugar. Yardstick decade closed end-to-end: `task add -- io.github.org/anthropics/skills@main` and `task add -- github://anthropics/skills@main` both resolve through one shared github:// path (byte-identical sha256). Remaining: Phase 3 (signature verify via Interlace receipts), Phase 4 (matchmaker — per ADR-0027). Subpiece 3b (registry-backed io.github.org/ resolution per ADR-0016) deferred — needs MCP-registry consumer protocol + canonical public registry URL pinned upstream first; sugar layer ships URL convention with zero infra so future swap is non-breaking. |
| **ADR-0027** — Substrate-as-kernel: capability matchmaker (n-dimensional builder) | **ADR-0027** | **`cloister-1b59a2`** | The matchmaker that walks `[inputs.*].provides`/`[inputs.*].requires` DAG from ADR-0026, binds capability studs to anti-studs across N heterogeneous inputs. Generalizes cred-iso/v1 + slice-grant + per-bundle DO into one capability frame. Implementation = Phase 4 of `cloister-cf7a3b`; Phase 4d re-shapes cred-iso/v1 AS a capability to prove the framing. Pairs with future ADR for scope-typed capability calculus (ComfyUI-shape visual × provable info-flow). |
| **ADR-0028** — Capability identifier scheme: three concerns, three names | **ADR-0028**, `docs/cross-repo-audit.md` finding #1 | **`cloister-224917`** | Reconciles `urn:signet:cap:...` (capability grant on cert) + `wimse://...` (workload identity) + `cloister/<name>/v<n>` (capability interface contract). Three lanes, three concerns; mapping document at `cloister-spec/_capability-mapping.md` is the crosswalk. Blocks `cloister-963a5c` (Sigstore workflow); unblocks ADR-0027 matchmaker (operates entirely in lane 3). |
| **ADR-0030** — Multi-workerd substrate (process-level tenant isolation) | **ADR-0030** | **`cloister-f289c8`** (epic — vault first) | Status: Proposed (2026-06-21). Substrate direction: workerd-process-per-tenant adds an outer kernel-enforced isolation ring atop ADR-0013's V8 inner ring. Four properties: (D1) per-tenant workerd process, (D2) polymorphic tenant boundary — per-peer, per-bundle, or operator-declared `[[tenants]]`, (D3) typed cross-tenant edges (Istio AppProtocol pattern; substrate transport-agnostic; NOT raptorq from ley-line), (D4) vault as first migration; hybrid model preserved (trusted-tier bundles like notme MAY still co-locate). Hybrid model keeps `cloister-db99cd` (notme co-locate) + `cloister-18f456` (mache co-locate) open as "which tenants share a workerd" deployment-shape questions. Implementation incremental; no code shipped yet. (Note: an earlier-session bead `cloister-153b18` for this work didn't persist due to the active rosary-ea0e3a sync bug — `cloister-f289c8` supersedes that lineage.) |
| **ADR-0031** — `cloister.capnp` as build artifact | **ADR-0031** | **`cloister-345ad1`** (P2), **`cloister-6b572a`** (P3), **`cloister-c919d7`** (P4a) | Phases 2 + 3 + 4a shipped. Phase 2: `cluster.toml [[routes]]` + emitter (`scripts/emit-cloister-capnp.mjs`) make root-level `cloister.capnp` a derived artifact. Phase 3 (2026-06-17): per-recipe migration with Hybrid Model A — each of agent-cluster + oss-launch-minimal + rosary-dev shipped `cluster.toml` alongside hand-edited `cloister.capnp` (the emitter pinned `gateway.metadata`/`actor`/`policy` to ART-default, forcing the dual-file shape). Phase 4a (2026-06-17, `cloister-c919d7`): closes the gap — `[gateway]` table added to `cluster.toml` schema (manifest/cluster.capnp `Cluster.gateway @6 :Gateway`), emitter consumes it with ART-default fall-through + stderr warning for pre-Phase-4a back-compat, root + all 3 recipes migrated, **Pure Model A invariant live at recipe level via `scripts/lint-recipes.mjs` drift gate**: `emit(cluster.toml) == committed cloister.capnp` byte-for-byte. Phase 4b (per-upstream backend retirement to lockfile pattern; mache + BEAD_STORE + vault-proxy + lsp/lifecycle) deferred to `cloister-c9686f`. Pairs with ADR-0025 (bidi pipeline) + ADR-0026 (lockfile `[[generated_backends]]` overlay layer). |
| **ADR-0033** — bd as cloister-mediated bead substrate | **ADR-0033** (Proposed 2026-06-23; **Amendment 1 + D5 amendment 2026-06-24**) | **`cloister-9d19e3`** (design, closed), **`cloister-c2bd47`** (Phase 1 impl, closed), **`cloister-c8b907`** (BeadStore-DO migration epic, closed across 3 sub-beads) | Status: Proposed. **Amendment 1 (2026-06-24)** corrected the original draft after verifying against a real `bd 1.0.0` install — bd has NO MCP server. Corrected architecture: **rsry IS the MCP server** for the bead substrate; bd is the storage layer rsry reads underneath (`.beads/dolt/<repo>/`). D1 (revised): `mcpProxy` backend with `handlesPrefix=rsry_` + `claims=[rsry_bead_create, rsry_bead_search, ...]` (~35 tools) + `serviceBinding=ROSARY_BUNDLE`. D2 (revised): the rosary bundle (already a cluster-tier sidecar) is the MCP server; bd's dolt sql-server runs inside it. D3: Wire is HTTP MCP over UDS via ROSARY_BUNDLE service binding. D4: Auth — Phase 1 unauthenticated UDS (mirrors mache + llo posture); Phase 2 bearer-token via vault per ADR-0024 deferred. D5 (amended): explicit BeadStore-DO migration framing via `BEAD_STORAGE_BACKEND` env var — `cloister-c8b907` delivered the path (sub-bead 1 `dea77c`: bead_id column + audit-chain reconstitution via JOIN; sub-bead 2 `decf0d`: feature flag + rsry-mode wire; sub-bead 3 `f34f7b` prep: deprecation warning shipped, default flip deferred for operator decision). D6: multi-substrate framing — cloister is substrate-of-substrates; rsry slots into the existing pattern (mache, llo, notme). **Phase 1 fully shipped + tested**; operators opt into rsry-mode today via `BEAD_STORAGE_BACKEND=rsry`. |
| **ADR-0034** — True multi-tenant access spec across rosary / mache / ley-line / notme / signet | **ADR-0034** (Proposed 2026-06-24) | **`cloister-cbfd7f`** (tracker, closed), **`cloister-ce936e`** (Inv 7 + tenancy-model doc, closed), **`cloister-cedcf3`** (perTenant + Inv 8 + Inv 9, ongoing), **`cloister-ceb57c`** (lease-middleware tenant-scope, blocked on notme-cf2676), **`notme-cf2676`** (notme cross-repo), **`mache-cf51d6`** (mache cross-repo) | Status: Proposed. Classifies the five-tool surface into three buckets: **in-scope for ADR-0030 multi-workerd deployment** (rosary per-tenant sidecar + per-tenant `BEADS_DIR`; mache + per-tenant LLO; notme per-tenant scope minting), **deferred** (ley-line UDP substrate; signet CLI-only flow), **already shipped** (notme per-tenant disclosure routing — landed in C1 of the 2026-06-22 adversarial cycle). Phase 1 schema field (`perTenant: Bool` on BundleSpec) + Phase 2 lint pieces 1 + 3 (Inv 8 route-existence + Inv 9 binding-correlation) + Phase 2 piece 2 first-cut (emit-compose per-tenant container fanout — `<bundle>-<tenant>` naming + `cloister.tenant` / `cloister.dispatch-mode` / `cloister.dispatch-match` labels + `TENANT_ID` / `TENANT_MODE` / `TENANT_MATCH_VALUE` env, commit `b623668`) all shipped via `cloister-cedcf3`. Phase 3 follow-ups deferred: per-tenant ipcSocket fanout + per-tenant DO storage volume + per-tenant wire-env rewriting. Tenancy-model documented at [`docs/reference/tenancy-model.md`](reference/tenancy-model.md). |
| **ADR-0035** — cloister↔LLO boundary (bridge crates in cloister, leyline-* names in LLO) | **ADR-0035** (Proposed 2026-06-24) | (no in-flight beads — design ratification) | Status: Proposed. Names the boundary that the leyline-sign 2026-05-09 lift implicitly established: bridge crates (build-time, codegen) stay cloister-side under cloister-owned names; `leyline-*` names belong in LLO. Cited by ADR-0036 as the rationale for Phase 1-vs-Phase 2 sequencing of schema-bridge. |
| **ADR-0036** — schema-bridge multi-output IR (Phase 1 in cloister, Phase 2 lift to LLO) | **ADR-0036** (Proposed 2026-06-25; **Amendment 2026-06-25** — C required, MarshalCBOR out-of-scope, IR gaps from E recorded) | **`cloister-7536e7`** (Phase 1 epic, **closed**), all 5 sub-beads closed: **`cloister-7585bc`** (A — multiplexer), **`cloister-75f6d5`** (B — Go emitter v1), **`cloister-76a9ea`** (D — task cluster:go + verify), **`cloister-77172d`** (E — second schema + anonymous-inline union), **`cloister-765d83`** (C — Void Marshal/Unmarshal). Phase 2 (lift to LLO) is a follow-up bead to file when the IR + emitter shape stabilises further. | Status: Proposed (Phase 1 fully shipped). Generalizes `tools/schema-bridge/` from single-input single-output (capnp → zod TS) to multi-output (capnp → zod TS + Go), proven on a second schema (notme's `identity.capnp`, vendored). Per-binary-name dispatch (`capnpc-schema-bridge-{zod,go}`) mirrors the capnpc-rust/go/c++ ecosystem pattern. Void Marshal/Unmarshal closes the wire-fidelity gap where Go's default encoder turned `*struct{}{}` into `{}` instead of capnp's canonical `null`. Anonymous-inline union support + annotation-declaration skip landed in E to handle identity.capnp's `Proof` + `$Go.*` annotations. 4 emit drift gates + 1 round-trip verify gate live; all green. |
| **ADR-0038** — Derive bundle image from `server.json` `packages[].oci` | **ADR-0038** (Accepted 2026-07-04; consumer side shipped via `cloister-505fb9`) | **`cloister-3c4b0c`** (design + STATUS row); consumer side via **`cloister-505fb9`**; producer side via **`cloister-31a988`** (mache constellation) | Extends ADR-0026's input→manifest derivation from *backends* (`_meta.art.cloister/v1`) to the *runtime image*: a bundle's `image` may be derived from the linked input's resolved `server.json` `packages[]` entry where `registryType == "oci"`. Precedence, loud: operator `ext.image` wins → else derive `<identifier>:<version>` (or `@<digest>`) from `packages[].oci` → else stderr warning naming bundle+input (no silent empty image). Consumer side is in-tree: `resolve-inputs` records the oci ref into `cluster.lock.toml`, `emit-compose` derives images for image-less external bundles, and bundle-isolation Inv 10 warns when neither operator image nor linked OCI exists. The bundle↔input link reuses ADR-0030 §A5 tenancy resolution, including gateway fallback, so lint and compose agree. Producer side (mache `server.json` gains an `oci` `packages[]` entry via `tools/server-json-gen`) lands independently and is standard-MCP-valid on its own. Open: publish-pipeline verification (declared ref must be pullable) + digest-pin recommendation. Note: ADR-0037 reserved for secure MCP ingress transports (`cloister-22a5ca`, per `docs/deployment/secure-art-tools.md`). |
| **ADR-0039** — Securing local Durable Object SQLite at rest | **ADR-0039** (Proposed 2026-07-05) | **`cloister-ffd17b`** (research + ADR) | Status: Proposed. Local `workerd serve` / miniflare DO SQLite sits plaintext (mode 0644) — bead/trust/blob/vault state — and workerd's `durableObjectStorage` union (none/inMemory/localDisk) has no encryption hook. Refines the §13.7.4 operator-tier disk boundary for the local case: on an AI-agent machine any same-UID process is de-facto operator-tier (the ADR-0024 adversary). Three composable layers, Mac-first: (1) at-rest encryption via OS-keystore KEK — the vault schemes (`keychain://`/`apple-password://` Mac, `secret-tool://`/`keyring://` Linux) already provide custody; Phase 1 = encrypted APFS volume mounted at `CLOISTER_DO_PATH` + Keychain passphrase, covers WAL/-shm; (2) BLAKE3 integrity manifest over canonical rows, anchored outside the FS → silent tamper becomes detected-at-boot; (3) selective column sealing (generalize the §18 vault envelope, HKDF sub-keys). Phase 0 (`chmod 700` + Time Machine exclusions) is zero-code today. Closes two gaps: missing `KEK_HELPER` binding in `config.capnp`; plaintext `vault_state` KEK-pin re-pin (`cloister-fbc6eb`). Threat model §13.9 seeds the seam. Linux twin = fscrypt/LUKS + `secret-tool://`. |

## Blocked

| Capability | Bead | Blocked on |
|---|---|---|
| Layer 2 addressability schema (`bundle.implements`, `wire.requires`, `route.requiresCapability`) | `cloister-ae4ed2` | User's incoming network-identity / "lego blocks" ADR |
| Port `@notme/contract` → schema-bridge | `cloister-9f03ed` | Trigger-gated: needs (a) top-level `const` mapping in schema-bridge OR (b) a non-TS consumer OR (c) contract growing past ~10 shapes |
| `interface`/generics/annotations/etc. in schema-bridge | `cloister-9f54d6` (meta) | First real schema hits the gap |
| schema-bridge: top-level `const` support | `cloister-9ea507` | None — ready |
| schema-bridge: cover `cloister.capnp` + `cli-config.capnp` | `cloister-aea8a7` | None — ready |
| Bot-author identity governance | — | Decision deferred; revisit when needed |
| Framing ADR (the OSS-front-door "add-type" lede direction) | — (no bead — captured in memory as `cloister-normie-framing`) | User authoring via separate LLM session |

## Pending follow-ups (have beads, deferred priority)

| Bead | Title | Priority |
|---|---|---|
| `cloister-ae8dac` | Re-incorporate 6 Copilot fixes onto main | closed (PR #6) |
| `cloister-ae587d` | ADR-0022 schema-bridge positioning | closed 2026-05-18 — ADR-0022 shipped via cloister-9443f0 (PR #43); landed `docs/adr/0022-schema-bridge-substrate-positioning.md`. Bead in tracker was already closed; STATUS row was stale. |
| `cloister-aea8a7` | schema-bridge: cover `cloister.capnp` + `cli-config.capnp` | P3 |
| `cloister-9f03ed` | port `@notme/contract` → schema-bridge | P3 (trigger-gated) |
| `cloister-9f54d6` | schema-bridge construct-coverage gaps (meta) | P3 |
| `cloister-cf519b` | lint:bundle-isolation: read cluster.ts (not cluster.capnp) after ADR-0025 | closed (PR #10, 2026-05-17) |
| `cloister-cf2e6a` | schema-bridge: emit .strict() on generated zod objects | closed (PR #14, 2026-05-17) |
| `cloister-fe891f` | cluster:toml chains canonicalize step (operator UX) | closed (PR #12, 2026-05-17) |
| `cloister-0d5e0f` | `task done` pre-PR readiness gate (drop-in rules, mache smell-rules shape) | closed (PR #13, 2026-05-17) |
| `cloister-339a22` | cloister/agent-process/v1 design (ACP server-side hosted in workerd) | P2 — design draft on `feat/cloister-339a22-agent-process-v1-design`, math-friend reviewed, awaiting direction |
| `cloister-9bfbf6` | CI lint: ed25519-dalek tilde-pin enforcement (ADR-0019 §15.7) | closed (PR #15, 2026-05-17) |
| `cloister-ff437f` | README §13.2 row unreadable — split into two rows + tighten | closed (PR #16, 2026-05-17) |
| `cloister-963bf6` | doc-polish + reorg: doc-friend audit findings (B1-B8 + P-fixes + archive shipped plans) | closed (PR #17, 2026-05-17) |
| `cloister-ff58d4` | docs/ surface lacks top-level index — orientation map | stale-closed (docs/README.md shipped via commit 201e8a1) |
| `cloister-9cd506` | doc-restructure: per-module READMEs to one voice + one template | P3 — follow-up from 963bf6 doc-friend audit |
| `cloister-9d14f2` | lint:doc-counts — assert "N tests" / "N ADRs" claims | closed (PR #23, 2026-05-17) |
| `cloister-c1691c` | receipts: pruneExpiredReceipts retention sweep | Phase 1+2 shipped (PR #24 + PR #25, 2026-05-17); bead stays open as Phase 3 tracker (per-actor `ca_decommission_after_ms` override, deferred until a real second actor lands) |
| `cloister-0719da` | substrate: TrustStore DO alarm scaffolding (closes pruneSeenNonces + pruneExpiredReceipts orphans) | closed (PR #25, 2026-05-17) |
| `cloister-449f82` | CI: recipe smoke validation (parse + emit + canonical-link drift gate) | Phase 1 shipped (PR #35, 2026-05-18); Phase 2 (parse validation) + Phase 3 (local boot smoke) deferred |
| `cloister-8e40ad` | Taskfile-as-source-of-truth audit + e2e manifest pipeline validation | Phase 1+2 shipped (PR #37 fixture-driven e2e, 2026-05-18; PR #39 generated-drift.yml `task <name>` refactor, 2026-05-18); Phase 3 (docs audit + `lint:task-invocation.mjs` drift gate) deferred until a trigger arrives |
| `cloister-d9347e` | LSP tool ownership: move `lsp_*` tool definitions from cloister to ley-line-open | P2 — filed 2026-05-18 from ADR-0026 conversation; predecessor pattern for cloister-cf7a3b |
| `cloister-d98db2` | cred-iso/v1: vault-DO-backed `CredentialStore` (production impl) | closed 2026-05-18 — DO saga complete via D1 PR #40 + D2 PR #41 + D3 PR #42. Resume prompt left at [`docs/prompts/finish-vault-do-saga.md`](archive/prompts/finish-vault-do-saga.md) for posterity. |
| `cloister-e26ea8` | D1 — `VaultDoCredentialStore` impl | closed 2026-05-18 (PR #40) |
| `cloister-e2a12a` | D2 — wire `VaultDoCredentialStore` into vault-proxy route composition | closed 2026-05-18 (PR #41) |
| `cloister-e2d38a` | D3 — end-to-end vault-DO-backed integration tests | closed 2026-05-18 (PR #42) |
| `cloister-2140b5` | vault DO: no internal-calling-bundle identity | closed 2026-05-18 — superseded by ADR-0021 per-bundle `bundleIdName` parameter shipped in D1 (cloister-e26ea8) |
| `cloister-43e55a` | implement ADR-0021 per-bundle vault DO migration | P2 — Phase 1 shipped via `bundleIdName` parameter (cloister-e26ea8); Phase 3 (notme uses `idFromName("notme")`) blocked on cloister-db99cd |
| `cloister-29e0a4` | phantom-token vault (alternative direction) | P1 — deferred for re-evaluation now that D-track shipped. Decide: keep as v2 evolution or close as alternative-not-pursued. |
| `cloister-9d4555` | doc-restructure: canonical "Backend kinds" page | closed (PR #26, 2026-05-17) |
| `cloister-9d602f` | doc-restructure: canonical "Bundle topology" page | closed (PR #27, 2026-05-17) |
| `cloister-c18eb3` | receipts followup: wire P-live verification into mcp-proxy outbound | Phase 1 shipped (PR #28); bead stays open as Phase 2 tracker (live wire-in + upstream CA-bundle fetcher + integration tests) |
| `cloister-da0f35` | host_adversarial.rs: unsafe env var mutation races with parallel tests | closed (PR #18, 2026-05-17) |
| `cloister-d9da67` | keystore: run_subprocess_with_trim reads stdout with no size cap | closed (PR #19, 2026-05-17) |
| `cloister-9bee1f` | /resolve allow-list: startup-time validator rejects prefixes that could match signing-key URLs | closed (PR #20, 2026-05-17) |
| `cloister-aa9376` | vault DO: collapse 403/404 status-code enumeration oracle (mirror disclosure §9.4.b) | closed (PR #21, 2026-05-17) |
| `cloister-d9a3c6` | keystore: TTL cache map grows unboundedly under unique-URL probe flood | stale-closed (shipped under cloister-2a0faa, commit a29dd88; pinned by `resolve_cache_bounded_under_unique_spec_flood`) |
| `cloister-211b68` | vault DO: unbounded RPC queue allows self-DoS (no per-caller budget) | closed 2026-05-18 — F1 token-bucket shipped at commit `4499f7c` (`vault/src/rate-bucket.ts` + `src/vault-store.ts:#consumeBudget`) |
| `cloister-2176e4` | vault DO: KEK source path is cached per-DO but cold-start is amplification-amenable | stale-closed (clear-on-rejection at `src/vault-store.ts:524-528` + bounded retry in `vault/src/kek-source.ts:203`; commit 4499f7c) |
| `cloister-21b5eb` | vault DO: write-side has no rate-distinct cost from read-side | stale-closed (credential-payload caps in `vault/src/vault.ts:CREDENTIAL_LIMITS` + write=3/read=1 in RATE_LIMITS.COST; commit 4499f7c) |
| `cloister-d816a0` | ADR-0019 normative-req consolidation (18 → 15; move impl/log invariants to "Implementation pins") | closed (PR #22, 2026-05-17) |
| `cloister-182ba2` | Cross-repo overlap audit (signet / notme / cloister / ley-line) | closed 2026-05-18 (PR #65) — five overlap surfaces enumerated; informs ADR-0028 + cloister-12b062 |
| `cloister-224917` | ADR-0028 — capability identifier scheme (three concerns, three names) + `cloister-spec/_capability-mapping.md` crosswalk | closed 2026-05-18 (PR #66 + PR #67) — Proposed. Lane discipline doc + normative crosswalk for `urn:signet:` vs `wimse://` vs `cloister/<name>/v<n>` |
| `cloister-94cf13` | L2: canonical trait library `cloister-spec/_traits.capnp` + `_traits.md` | closed 2026-05-18 (PR #68) — 7 annotations ($Sensitive / $Scope / $Capability / $Since / $Deprecated / $Unstable / $Op); ADR-0022 §3 commit |
| `cloister-308ea4` | `lint:capability-scheme` — ADR-0028 §6 lane discipline enforcement on `[inputs.*].provides/requires` | closed 2026-05-18 (PR #70) — 27 tests, no regex per project convention, wired into `task lint` + `test:lint-scripts` |
| `cloister-993bef` | ADR-0019 Phase F — delete `scripts/kek-helper.mjs` (last load-bearing leaf of the sign-only-helper-protocol ship arc) | closed 2026-05-18 (PR #71) — JS sidecar deleted; 4 dangling doc/error refs updated to leyline-sign-helper. Phase E skipped (Phase D had moved every caller already) |
| `cloister-8d933d` | leyline-sign-helper `/healthz` deep-probe + auth-gate the platform field | closed 2026-05-18 (4 sub-pieces across 3 PRs: #3 platform-strip PR #61, #2 CLI-presence PR #74, #1+#4 deep-probe PR #75). Closes silence Gap 4 from 2026-05-13 adversarial cycle. |
| `cloister-5f5aee` | ADR-0026 Phase 2 subpiece 1 — github:// scheme in resolver | closed 2026-05-18 (PR #76) — codeload tarball + raw-file URL transformation; @<git-ref> required (no default-branch sniffing); inherits singleflight + TTL cache from resolve_bytes |
| `cloister-66b6a6` | ADR-0026 Phase 2 subpiece 2 — `cloister add <ref>` CLI | closed 2026-05-18 (PR #77) — `task add -- <ref> [...]` mutates cluster.toml + invokes resolver; 29 tests; auto-name derivation from ref basename. With #76, yardstick is end-to-end demoable. |
| `cloister-771364` | ADR-0026 Phase 2 subpiece 3 — `io.github.org/` → `github://` sugar | closed 2026-05-18 (PR #79) — parse-time rewrite, falls through to existing github:// resolver; 10 new tests (41 total in resolve-inputs); byte-identical sha256 to github:// form proves shared resolution path. Subpiece 3b (registry-backed resolution) deferred until MCP-registry consumer protocol is settled upstream. |
| `cloister-d0f0f3` | §15.6 `sign_must_enforce_body_size_cap` flake — de-flake test + boundary sibling | closed 2026-06-17 (commits `2834759` + `6e15f9d`) — agent verified Part A (`RequestBodyLimitLayer`) already shipped; Part B widens assertion to accept 413 OR connection-reset; threat-model §15.6 amended; supersedes dead `cloister-7c737a` ref. Daemon trust thread `daemon-trust-and-transport/T1-mcp-auth-hardening`. |
| `cloister-db0740` | `task verify` broken: `cas-hash.ts` missing from `tsconfig.verify.json` exclude | closed 2026-06-17 (commit `a2fbcf8`) — one-line tsconfig fix (same shape as `signet-verify.ts` exclusion). |
| `cloister-de6870` | `task lint` 61 failures: `.env.local` leaks `INTERLACE_ROOT_PUBKEY` into vitest-pool-workers | closed 2026-06-17 (commit `62769d6`) — `vitest.config.ts` `bindings` explicitly empty `INTERLACE_*` env so `task dev:bootstrap` doesn't break `task lint`. Original ADR-0029 hypothesis was wrong (route is correct; test isolation was incomplete). GETTING-STARTED's "tests don't read .env.local" claim is now actually true. |
| `cloister-eefd45` | `task verify` final blocker: cargo-deny 3 issues | closed 2026-06-17 (commit `4daafdf` + sibling LLO `ley-line-open-f2239c` SHA `593ee61`) — LLO `leyline-core`/`leyline-cas-ffi` got `AGPL-3.0-or-later`; cloister bumped git-rev pin + added `version="0.4.5"` to break wildcard; `cpufeatures` duplicate skipped in `rs/deny.toml`. `task verify` cold-clone green. |
| `cloister-204ac9` | Bundle type drift gate (hand-maintained ↔ generated) | partial-shipped 2026-06-24 (commit `66484e5` drift gate + `eac436e` schema-bridge readonly emit via `cloister-818f2b` half 1). Full consolidation (delete `cluster-types.ts`) deferred until `cloister-818f2b` half 2 (JSDoc carry-through) lands. Bead stays open as P3 tracker. |
| `cloister-818f2b` | schema-bridge: emit `readonly` for array fields + carry capnp `# comments` as JSDoc | half-1 shipped 2026-06-24 (commit `eac436e`) — readonly emission landed; `cluster.zod.ts` regen carries `readonly` on all List fields. Half 2 (JSDoc carry-through) requires capnp-rust to surface source-span info for `# comment` blocks adjacent to field decls; the parser doesn't today. Bead stays open as half-2 tracker. |
| `cloister-a495bb` | LLO contract recovery + lockfile-drift forward guard | closed 2026-06-24 — cluster.lock.toml had drifted to a 3-group/bytes=1_213 snapshot while LLO v0.5.0 carries 7 groups / 31 tools (`query` group's 16 nodes-surface tools, `wire`, `validate`, `hdc` entirely; `lifecycle`+`sheaf` partially). Recovered via `task cluster:resolve` (commit `a062dd0`). Forward-guard: `scripts/lint-lockfile-drift.mjs` + 6 node:test cases + `task lint:lockfile-drift` (commits `33c140b` + `baacdd7`). |
| (doc-links lint, no bead) | Markdown link drift gate | shipped 2026-06-24 (commit `fd1d905`) — `scripts/lint-doc-links.mjs` walks `docs/**/*.md` + canonical top-level docs, asserts every relative URL resolves. Strips fenced + inline code blocks so example URLs don't false-flag. 7 node:test cases. Wired into `task lint:doc-links` + `task lint` deps + `task test:lint-scripts`. 77 files clean on current main. Forward-guard for the PR-#94 dangling-link class (`[lsp-mcp](lsp-mcp.md)` after file deletion). |

## Convention

- **Shipped** = code is on `main`, tests green, deployable.
- **Drafted** = ADR / spec / plan exists, no shipped behavior. May
  have failing tests on a side branch as the executable plan.
- **Blocked** = work scoped, can't start until the named blocker
  lands.
- **Pending follow-ups** = beads filed, work not urgent, scheduled
  by priority.

Every entry links the canonical ADR / bead / path. If you find yourself
unsure whether something is real on `main`, this is the index — if
it's listed under Shipped, it ships; if it's listed under Drafted, it
doesn't.

## Side branches (entry points for work-in-progress)

- `tdd/credential-isolation-v1` — failing-test baseline for
  `cloister-8f57f0`. Impl PRs for Phases 1-11 branch from here.
- `feat/credential-isolation-v1` — speculative operator recipes
  (OpenClaw / Claude Code / Codex) at
  `recipes/credential-isolation/{openclaw,claude-code,codex}/`. Lands
  as part of Phase 10 of `cloister-8f57f0`. (Prior STATUS.md listed
  this as `wip/credential-isolation-recipes`; the recipes were
  consolidated onto the cred-iso work branch under commit `678aa79`.)

## Updating this file

When a PR merges that changes a capability's status:

- Shipped → leave under Shipped; update the reference column.
- Drafted → moves to Shipped; bead closes.
- Blocked → moves to Drafted or Shipped depending on what landed.
- New capability → add under Drafted with the bead reference.

The convention isn't enforced by a lint script today; just write down
what's true. The bead store + git log are the authoritative sources;
this is the human-readable summary.
