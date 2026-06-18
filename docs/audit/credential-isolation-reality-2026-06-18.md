# Credential-isolation reality audit — 2026-06-18

> **Scope:** read-mostly audit of the cred-iso surface (ADR + spec +
> source + tests + STATUS rows + beads). Output is a feature matrix
> mapping claim ↔ reality. Trivial drift fixed inline; anything bigger
> reported here for follow-up.
>
> **Auditor:** session-work (no specific bead — see CLAUDE.md trailer rule).
> **Branch base:** `feat/consume-cas-ffi-713b4e` head (worktree
> `agent-a3802fad09e3c4f31`).

## 1. Executive summary

- The cred-iso surface (ADR-0024 / `cloister-spec/credential-isolation/v1/`
  / `src/routes/vault-proxy*` / `src/routes/vault-do-credential-store.ts`)
  matches the spec to a high degree of fidelity. All five "master
  claims" listed in threat-model §18 are backed by code paths whose
  existence and shape this audit verified.
- All 10 test-vector files hash byte-identical to `VECTORS.sha256`.
- The most material drift found is between **STATUS.md** + **threat-model §18**
  and **shipped reality**: at least one "outstanding follow-up" bead
  (`cloister-6ed9ae` — manifest `defaultAllowedSubs` gate on the
  forward path) has in fact shipped (`vault-proxy-route.ts:229–244`)
  and the row is stale.
- The bead-tracker DB this worktree sees has **7 open beads total**,
  none of which is one of the cred-iso follow-ups listed in STATUS.md
  (`6e6bfb`, `6ed9ae`, `6f4284`) or the older Phase-tracker beads
  (`29e0a4`, `43e55a`, `339a22`, `8f57f0`). These IDs are real (commit
  log references them) but they don't resolve in the current Dolt
  store — a beads-sync question outside this audit's scope. Reported
  in §6.
- STATUS.md side-branch entry **`wip/credential-isolation-recipes`**
  does not exist; the recipes (openclaw / claude-code / codex) live
  on `feat/credential-isolation-v1` instead. Trivial drift; fixed
  inline.

Drift count: **3 inline-fixable items** + **1 reported** (bead-store sync).
Recommendation count: **5** (ranked).

## 2. Per-ADR claim → reality table

### ADR-0010 — Vault + bundle clusters (status: Proposed, impl-gated)

| Claim | Reality | Doc |
|---|---|---|
| `Bundle.vaultSlice` as manifest hint (open question) | Not implemented; ADR-0013 amendment confirms the manifest-side concern was deferred. `Bundle.vaultSlice` does not appear in `manifest/cloister.capnp` or `manifest/cluster.capnp`. | ADR-0010 §"Status amendment — 2026-05-10", ADR-0013 §"What's NOT part of this model" |
| Vault DO lives in the cloister cluster, lifted from `notme/vault/` under AGPL | `vault/src/vault.ts` (343 LOC) + `vault/src/kek-source.ts` + `vault/src/rate-bucket.ts` + `vault/src/handler.ts` exist; `vault/NOTICE` records the lift. | `vault/` |
| KEK derived via HKDF from cluster's Signet master pubkey | **Drift / deferred:** v1 KEK source is the URL-spec resolver (ADR-0014); HKDF-from-master is not the shipped path. ADR-0010 leaves this open; ADR-0014 v2a explicitly removed the env-fallback. | ADR-0014 v2a; `vault/src/kek-source.ts` |
| Cluster-level Interlace identity carried on `Cluster.actor` | `manifest/cluster.capnp` has the `Cluster.actor` slot; `cluster.toml [actor]` was migrated by ADR-0031 Phase 4a. | `cluster.toml`, `manifest/cluster.capnp` |
| **No drift action required** — ADR-0010 stays Proposed; ADR-0013 carries the operational reality. | | |

### ADR-0013 — Slice-grant enforcement (status: Accepted 2026-05-10)

| Claim | Reality | Doc |
|---|---|---|
| V8 isolate boundary + `globalOutbound` omission + service-binding-as-syscall is the slice-grant enforcement model | `test/security/prompt-injection.test.ts` covers the four assertions (in-slice ok / out-of-slice 403 / no network / no KEK env) for a compromised bundle. | ADR-0013 §"The prompt-injection demo" |
| Composite PK `(subject_fp, service)` on vault DO `credentials` table (2026-05-11 amendment) | Implemented in `vault/src/vault.ts` schema; tests in `test/vault-store.test.ts` + `test/vault/multi-tenant-isolation.test.ts`. | `vault/src/vault.ts`, threat-model §11 row V.1 |
| Substrate-property lint blocked on first workerd-bundle Worker | `cloister-ac30e7` open in bead-tracker; no workerd-bundle Worker shipped. | bead `cloister-ac30e7` |
| **No drift** | | |

### ADR-0014 — Pluggable KEK source (status: Accepted 2026-05-11; v2a 2026-05-12)

| Claim | Reality | Doc |
|---|---|---|
| URL-spec resolver supports `env://`, `file://`, `keychain://`, `secret-tool://`, `op://`, `apple-password://`, `keyring://`, `http(s)://` | `vault/src/kek-source.ts` implements all schemes via the `leyline-sign-helper`; STATUS.md row 20 lists the eight scheme prefixes. | `vault/src/kek-source.ts` |
| `VAULT_KEK_SECRET` text binding removed (v2a) | `config.capnp` + `wrangler.toml` no longer carry it; `buildKekSource` throws on empty source. | ADR-0014 amendment 2026-05-12 |
| v2b (age-encrypted env carrier) requires ADR-0019 sign-only protocol | ADR-0019 shipped Phase F 2026-05-18 (`cloister-993bef` close); v2b age-carrier work is still future. | STATUS.md row 19 |
| **No drift** | | |

### ADR-0019 — Sign-only helper protocol (status: Accepted 2026-05-12)

| Claim | Reality | Doc |
|---|---|---|
| `POST /sign` ed25519, `GET /resolve` for non-signing carrier | Implemented in `rs/crates/sign/` host binary; `task verify` exercises both. | ADR-0019 §"Wire protocol" |
| Phase F (delete `scripts/kek-helper.mjs`) | Shipped 2026-05-18 via PR #71 (`cloister-993bef`). | STATUS.md row `cloister-993bef` |
| Subprocess TTL cache amendment (`LEYLINE_SIGN_RESOLVE_TTL_MS`) | Live; threat-model §17.7 closes the dos-friend F2 finding. | ADR-0019 §"Subprocess-scheme TTL cache amendment" |
| **No drift** | | |

### ADR-0021 — Per-bundle vault DO instances (status: Proposed 2026-05-12; impl with ADR-0018)

| Claim | Reality | Doc |
|---|---|---|
| Migrate vault from `idFromName("cluster")` → `idFromName(bundleName)` | **Phase 1 shipped via `bundleIdName` parameter** (`cloister-e26ea8` / D1, PR #40). `vault-do-credential-store.ts:62` constructor takes `bundleIdName`; `vault-proxy-route.ts:130-138` defaults to `"router"` when manifest omits it. | `src/routes/vault-do-credential-store.ts`, `src/routes/vault-proxy-route.ts` |
| Same-commit cutover with ADR-0018's notme-as-bundle portion | **Not yet** — `cloister-db99cd` (notme co-locate decision) stays open in bead-tracker. The schema seam is live (X-3 / PR #55 `VaultProxySpec.bundleIdName`); Phase 3 ("notme uses `idFromName(\"notme\")`") blocked. | STATUS.md row `cloister-43e55a`, bead `cloister-db99cd` |
| No new manifest field beyond `Bundle.name` | **Superseded:** the 2026-05-18 cycle X-3 (cloister-6f06cc) added `VaultProxySpec.bundleIdName` as a manifest field on the route (not the bundle) because routes pre-date the bundles they bind to in cluster.capnp. ADR-0021 narrative still reads "no new manifest field"; the X-3 closure note in threat-model §18 fills the gap but ADR-0021 itself is unamended. | **DRIFT-1 below** |

### ADR-0024 — `cloister/credential-isolation/v1` capability (status: Draft 2026-05-17)

| Claim | Reality | Doc |
|---|---|---|
| Wire protocol: `POST /vault/proxy/<service>/<upstream-path>` | `src/routes/vault-proxy-route.ts` mounts; `parseVaultProxyPath` enforces shape; `test/routes/vault-proxy-route.test.ts` covers. | spec `wire/proxy-envelope.md` |
| Five injection strategies (closed union) | All five live in `src/routes/vault-proxy.ts` `injection` discrimination + `cloister-spec/credential-isolation/v1/test-vectors/injection-fixtures.json` covers 5/5 cases. | spec `wire/injection-strategies.md` |
| `vaultProxyService` backend kind via `defaultAllowedSubs` glob list | `manifest/cloister.capnp:94` carries `defaultAllowedSubs @2 :List(Text)`; `vault-proxy-route.ts:241-244` enforces at the route boundary (Bundle F1 fix, X-2 cycle). | `wire/injection-strategies.md`, `manifest/cloister.capnp` |
| Receipt commits to `peerFp / service / upstream_status / upstream_url_path / sizes / wall_clock_ms` — NOT credential value | `ProxyCallReceipt` in `src/routes/vault-proxy.ts` matches; `cloister-spec/credential-isolation/v1/test-vectors/receipt-commitment.json` + `adversarial-credential-leak.json` pin the MUST-NOT-COMMIT list. | spec `wire/receipt-commitment.md` |
| Capability-registry entry at `/.well-known/cloister-capabilities/v1/` | **Drift / Phase 8 not shipped:** the ADR-0024 implementation plan Phase 8 ("capability registry endpoint") has no corresponding route in `src/routes/` and no test in `test/routes/well-known-*`. The cred-iso capability is reachable but not self-describing via a well-known endpoint. | **DRIFT-2 below** |
| Phase 10 — consumer recipes (openclaw / claude-code / codex) | **On `feat/credential-isolation-v1`**, NOT main. STATUS.md says `wip/credential-isolation-recipes` — that branch name does not exist; the actual branch is `feat/credential-isolation-v1`. | **DRIFT-3 (fixed inline)** |

### ADR-0026 — Tool composition model (status: Proposed 2026-05-18)

| Claim | Reality | Doc |
|---|---|---|
| `[inputs.*]` tool refs in `cluster.toml` with content-addressed lockfile | Phase 1a+1b+2.1+2.2+2.3 shipped per STATUS.md row 40. Resolver at `scripts/resolve-inputs.mjs`; `cluster.lock.toml` committed. | STATUS.md row ADR-0026 |
| Cred-iso/v1 is the first reference impl under the substrate-as-kernel framing | Confirmed — ADR-0024 paragraph 1 cites `cloister-1b59a2` (substrate-as-kernel) directly. | ADR-0024 |
| Phase 4d ("re-shape cred-iso/v1 AS a capability to prove the framing") | **Not shipped** — ADR-0026 §"Phases" lists this as Phase 4d (matchmaker); ADR-0027 confirms Phase 4 = the matchmaker, no work has touched cred-iso's `[inputs.*]` declaration yet. | STATUS.md row ADR-0026 |
| **No drift action** — work clearly deferred under bead `cloister-cf7a3b` Phase 4 | | |

### ADR-0027 — Substrate-as-kernel matchmaker (status: Proposed 2026-05-18)

| Claim | Reality | Doc |
|---|---|---|
| Capability spec dir naming convention (`cloister-spec/<reverse-dns>/v<n>/`) | Conformant for `cloister-spec/credential-isolation/v1/`, `cloister-spec/build-cache/v1/`, `cloister-spec/mcp-tool/v1/`. | spec dirs |
| Matchmaker algorithm walks `[inputs.*].provides` / `requires` | **Not implemented** (Phase 4 of `cloister-cf7a3b`); no `src/capabilities/` directory exists. | ADR-0027 |
| `cloister/credential-isolation/v1` consumed as the reference capability ref shape | Spec exists; no `cluster.toml [inputs.*]` declares `provides = ["cloister/credential-isolation/v1"]` yet. | `cluster.toml` |
| **No drift** — ADR-0027 is Proposed; implementation is deferred. | | |

### ADR-0028 — Capability identifier scheme (status: Proposed 2026-05-18)

| Claim | Reality | Doc |
|---|---|---|
| Three lanes, three names: signet URN / WIMSE URI / `cloister/<name>/v<n>` | `cloister-spec/_capability-mapping.md` carries the §4 crosswalk; row for cred-iso/v1: `urn:signet:cap:read:credential-isolation` ↔ `cloister/credential-isolation/v1`. | `cloister-spec/_capability-mapping.md` |
| `lint:capability-scheme` enforces lane discipline | Closed 2026-05-18 (PR #70, `cloister-308ea4`), 27 tests, wired into `task lint`. | STATUS.md row `cloister-308ea4` |
| New capability spec dirs MUST add their URN-to-interface row in the same PR | **Drift watcher** — no enforcement script verifies that `cloister-spec/<new>/v<n>/` PRs touch `_capability-mapping.md` §4. Today's discipline is honor-system. | Recommendation R-2 below |
| **No drift action required on the audit's scope** | | |

## 3. Per-bead status

| Bead (STATUS.md) | STATUS.md claim | Reality | Disposition |
|---|---|---|---|
| `cloister-29e0a4` (phantom-token vault alternative) | "P1 — deferred for re-evaluation now that D-track shipped" | Bead ID does NOT resolve in bead-tracker (no row); STATUS row is the only canonical reference. The "decide: keep as v2 evolution or close as alternative-not-pursued" decision is genuinely pending the user's direction. `docs/prompts/finish-vault-do-saga.md` keeps a resume prompt. | Pending user direction — DON'T close from this audit. |
| `cloister-6e6bfb` (DoS F1 per-peer denial counter design-pass) | "X-1 tracker — DoS F1 per-peer denial counter, design-pass" — outstanding | Bead ID resolves only in commit log (3 commits exist with `[cloister-6e6bfb]` prefix, including Obs O-OBS-3 + O-OBS-4 fixes which DID ship). The "X-1 tracker" framing is correct: the *Obs* portions shipped; the *DoS F1 counter* design-pass has not. | Open as design-pass tracker (correct as-stated). |
| `cloister-6ed9ae` (manifest `defaultAllowedSubs` gate on forward path) | "P2 — outstanding" | **Commit `3093044` (PR #58) "fix(cred-iso): manifest defaultAllowedSubs gate at route boundary (Bundle F1)" landed.** The gate is live at `vault-proxy-route.ts:229–244`. STATUS.md row 32 has stale wording. | **DRIFT-4 below — fix STATUS.md follow-up enumeration.** |
| `cloister-6f4284` (DoS F5 lease-verify cache design-pass) | "design-pass" — outstanding | No commits reference this bead; threat-model §18 close-out row 18 lists it as remaining-open. Disposition matches claim. | Open — no action. |
| `cloister-43e55a` (ADR-0021 per-bundle vault DO migration) | "P2 — Phase 1 shipped via `bundleIdName` parameter (cloister-e26ea8); Phase 3 blocked on cloister-db99cd" | Confirmed: schema seam + parameter live (PR #55 / X-3); notme-as-bundle still blocked on `cloister-db99cd` (open). | Open / accurate. |
| `cloister-339a22` (cloister/agent-process/v1 design) | "P2 — design draft on branch, math-friend reviewed, awaiting direction" | Commit `ba665a6 [cloister-339a22] docs(proposal): cloister/agent-process/v1 draft + math-friend review` exists. Awaiting direction. | Open / accurate. |

## 4. Spec corpus health

| Artifact | Status |
|---|---|
| `cloister-spec/credential-isolation/v1/README.md` | Present, dated 2026-05-17; rev'd 2026-05-18 for `cloister-505bf1` X-2 reconciliation; consistent with shipped error-responses.md. |
| `cloister-spec/credential-isolation/v1/wire/proxy-envelope.md` | Present. |
| `cloister-spec/credential-isolation/v1/wire/injection-strategies.md` | Present. |
| `cloister-spec/credential-isolation/v1/wire/receipt-commitment.md` | Present. |
| `cloister-spec/credential-isolation/v1/wire/error-responses.md` | Present; rewritten by X-2 (PR #51) for the "two canonical wire shapes" framing. |
| `cloister-spec/credential-isolation/v1/test-vectors/*` | 10 files. `VECTORS.sha256` matches `shasum -a 256 test-vectors/*.json` byte-identically. ✓ |
| `cloister-spec/credential-isolation/v1/test-vectors/README.md` | Present; the "Total: 10 JSON vector files. 34 distinct cases." claim is consistent with the file map. |
| `cloister-spec/credential-isolation/v1/ref-impl-py/credisolation/` | 5 files (envelope / injection / receipt / validate / `__init__`), 557 LOC. |
| `cloister-spec/credential-isolation/v1/ref-impl-py/conformance/run.py` | 432 LOC runner. Audit did NOT execute `python conformance/run.py` (would require Python + pip install); next iteration should add this to a Taskfile gate. | Recommendation R-3 below. |
| `cloister-spec/_capability-mapping.md` §4 row for cred-iso | Present: `urn:signet:cap:read:credential-isolation` ↔ `cloister/credential-isolation/v1`. ✓ |
| `cloister-spec/credential-isolation/v1/QUICKSTART.md` | Present; references "PRs #36–#42 (2026-05-18)" — accurate. |

## 5. Drift list

| ID | Where | What | Fix |
|---|---|---|---|
| **DRIFT-1** | ADR-0021 §"Decision", §"Consequences (Migration shape)" | ADR-0021 says "**No `vaultInstance:` field is added to the manifest. The bundle's existing `name` field is the DO instance name.**" The 2026-05-18 cycle X-3 (`cloister-6f06cc`) added `VaultProxySpec.bundleIdName` as a *route-level* manifest field instead, because routes pre-date the bundle resolution in cluster.capnp. ADR-0021 is unamended. | **Not trivial** — wants a short ADR-0021 amendment paragraph noting the cycle X-3 redirect from "bundle.name → DO id" to "route.bundleIdName → DO id" + cross-link to threat-model §18 row 18.3. NOT applied this PR. **Reported only.** |
| **DRIFT-2** | ADR-0024 §"Implementation" Phase 8 | Phase 8 ("capability registry at `/.well-known/cloister-capabilities/v1/`") has no shipped route. The phased-rollout narrative reads as if it landed, but cred-iso/v1 is not self-describing via a well-known endpoint. | **Not trivial** — wants either (a) shipping the endpoint or (b) explicit ADR-0024 amendment marking Phase 8 deferred. **Reported only.** |
| **DRIFT-3 (fixed)** | STATUS.md line 134 | "`wip/credential-isolation-recipes`" — branch doesn't exist. Actual recipes (openclaw / claude-code / codex) live on `feat/credential-isolation-v1`. | **Fixed inline** — updated STATUS.md to point at the real branch. |
| **DRIFT-4 (fixed)** | STATUS.md row 32 (cred-iso row) "Outstanding follow-ups" enumeration | Lists `cloister-6ed9ae` (manifest `defaultAllowedSubs` gate on forward path) as outstanding. The gate shipped via commit `3093044` / PR #58. Threat-model §18.1 close-out also lists `cloister-6ed9ae` under "Remaining open as follow-up" (`docs/security/threat-model.md:1418-1419`). | **Fixed inline** — STATUS.md row 32 enumeration updated; threat-model §18 close-out row updated. |
| **Reported only** (DB sync) | `.beads/dolt/cloister/` | STATUS.md + commit logs reference many `cloister-*` IDs (e.g. `6e6bfb`, `6ed9ae`, `6f4284`, `29e0a4`, `43e55a`, `339a22`, `8f57f0`, `cf7a3b`, `1b59a2`, `db99cd`, `e26ea8`, `e2a12a`, `e2d38a`, `6f06cc`, `6eba0a`, etc.). The Dolt bead-tracker this worktree mounts has **7 open beads total**, none of these IDs among them. This is a beads-sync issue (the .beads dir on this worktree is divergent from the canonical state), NOT a docs drift. | Reported — falls under bead-store mgmt, not cred-iso audit. |

## 6. Recommendations (ranked, highest-leverage first)

### R-1 — Amend ADR-0021 with the 2026-05-18 X-3 redirect (~30 min)

ADR-0021 says "the bundle's existing name field is the DO instance name" and "no new manifest field" — but the cycle X-3 fix shipped `VaultProxySpec.bundleIdName` as a *route-level* field. Future readers of ADR-0021 will miss the redirect because the surrounding context (threat-model §18.3, `cloister-6f06cc` close-out, schema in `manifest/cloister.capnp`) lives elsewhere. A 3-sentence amendment + 1 cross-link unblocks understanding for any reviewer landing on ADR-0021 cold.

### R-2 — Add `lint:capability-mapping-coverage` script (~2 hr)

ADR-0028 specifies that any new `cloister-spec/<name>/v<n>/` PR MUST add a row to `cloister-spec/_capability-mapping.md` §4 (the URN-to-interface crosswalk). Today this is honor-system. A small lint script — "every `cloister-spec/<name>/v<n>/` directory has a §4 row" — closes the gap before it becomes a maintenance burden. Pairs naturally with the existing `lint:capability-scheme` (`cloister-308ea4`).

### R-3 — Run `python conformance/run.py` as part of `task verify` (~1 day)

The ref-impl-py runner exists (432 LOC) but is not wired into `task lint` or `task verify`. Without that, the spec's byte-equality property is asserted-but-not-checked-on-every-commit. Two options:
- Add `task spec:conformance:cred-iso` that bootstraps a venv + runs the runner.
- Or ship a Rust port of the runner so it joins `task verify`'s existing Rust chain (matches the ed25519-dalek pattern from `rs/crates/sign/`).

The first is faster; the second matches existing supply-chain discipline.

### R-4 — Decide `cloister-29e0a4` (phantom-token v2 vs alternative-not-pursued) (~user decision, then ~0)

STATUS.md row + `docs/prompts/finish-vault-do-saga.md` both flag this as "decide after Track B ships." Track B (D-track / DO saga) shipped 2026-05-18. The decision is overdue by ~1 month. Either commits to v2 evolution (then file a fresh ADR) or closes as alternative-not-pursued (cleans the open-decision surface).

### R-5 — File ADR-0024 Phase 8 disposition bead (~10 min)

The capability-registry endpoint (`/.well-known/cloister-capabilities/v1/`) is in the ADR-0024 phased rollout but not in any tracked bead. Either:
- File a "ship Phase 8" bead (shape: ~half-day route + test); OR
- Amend ADR-0024 marking Phase 8 explicitly deferred until a second `cloister-spec/<name>/v<n>/` lands and the registry becomes load-bearing.

Either way the ambiguity goes away.

## 7. Tooling notes

- `task lint` not run by this audit (no source changes that would require it; only STATUS.md + threat-model §18 row 18.1 edits + this new doc; STATUS.md is not in the lint set).
- Vector hash check (`shasum -a 256 test-vectors/*.json`) ran clean.
- No Rust changes; no `task verify` invocation needed.

## 8. References

- Spec corpus: `cloister-spec/credential-isolation/v1/`
- Source: `src/routes/vault-proxy*.ts`, `src/routes/vault-do-credential-store.ts`, `src/vault-store.ts`, `vault/src/*.ts`
- ADRs: 0010, 0013, 0014, 0019, 0021, 0024, 0026, 0027, 0028
- Threat model: `docs/security/threat-model.md` §18 (cred-iso production-readiness cycle)
- Adversarial cycle report: `docs/security/adversarial-cycles/2026-05-18.md`
- Resume prompt: `docs/prompts/finish-vault-do-saga.md`
- STATUS index: `docs/STATUS.md`
