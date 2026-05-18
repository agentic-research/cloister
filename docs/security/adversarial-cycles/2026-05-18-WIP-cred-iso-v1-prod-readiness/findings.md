# Adversarial Cycle WIP — cred-iso/v1 production-readiness (2026-05-18)

> **STATUS: IN PROGRESS.** This is a shared scratchpad. Four specialists
> write here in parallel; synthesis-lead reads it and produces the
> dated cycle report at `docs/security/adversarial-cycles/2026-05-18.md`.
> When the cycle closes this WIP directory is removed.

## Cycle metadata

- **Date:** 2026-05-18
- **Triggering ships:** PRs #40-#42 (DO saga: VaultDoCredentialStore + auto-select composition + e2e tests), #44 (cred-iso QUICKSTART), #47 (wire/* spec gaps)
- **main SHA:** `ae917f2` (do not advance during cycle)
- **Branch under audit:** `main` (NOT the in-flight `chore/substrate-idl-cloister` / PR #46 surface — that's a separate substrate-IDL workstream owned elsewhere)
- **Specialists deployed (Wave 1, parallel):**
  - `bundle-isolation-tester`
  - `dos-resilience-auditor`
  - `enumeration-oracle-hunter`
  - `observability-gap-auditor`
- **Skipped this cycle:**
  - `trust-root-adversary` — full cycle on 2026-05-12, helper unchanged
  - `protocol-replay-adversary` — lease envelope unchanged since prior cycle
- **Synthesis lead:** pending (Wave 2)

## Master problem statement (all specialists read)

The just-shipped DO saga moves `cloister/credential-isolation/v1` from
draft to production-ready. The load-bearing change shape:

**Before (D-prefix):**
- `CredentialStore` interface had a single method: `resolve(peerFp, service) → CredentialLookup | null`
- Production composition wired `InMemoryCredentialStore` (a Map) at the route level
- Plaintext credential bytes lived in the route handler's memory after resolve

**After (D-suffix, shipped today):**
- `CredentialStore` interface gains optional `forward(peerFp, service, callerSub, request) → Response`
- `VaultDoCredentialStore` implements `forward` by delegating to `env.VAULT_STORE.idFromName(bundleIdName).proxyRequest(...)` — plaintext stays inside the DO trust boundary (ADR-0013)
- `VaultProxyRoute` constructor accepts deps; at request time `selectCredentialStore(env)` picks via three-branch priority:
  1. Explicit `deps.credentials` override → use verbatim
  2. `env.VAULT_STORE` present → lazily construct + memoize `VaultDoCredentialStore({env, bundleIdName: "router"})`
  3. Otherwise → `InMemoryCredentialStore` fallback (dev)
- Route handler branches on `credentialStore.forward` — when defined, delegate the full Request; otherwise resolve+inject as before
- Per-bundle isolation seam is the `bundleIdName: string` constructor parameter (default `"router"` until notme-as-bundle wires `"notme"` per ADR-0021)

### Files in scope

Production path:
- `src/routes/vault-do-credential-store.ts` (NEW, D1)
- `src/routes/vault-proxy-credential-store.ts` (interface bump, D1)
- `src/routes/vault-proxy-route.ts` (selectCredentialStore + forward branch, D2)
- `src/routes/vault-proxy.ts` (handler + InjectionStrategy + ProxyCallReceipt + CONSTANT_TIME_ERROR_BODY — unchanged this session, but composes with D-track)
- `src/vault-store.ts` (CredentialVault DO + proxyRequest + #consumeBudget + #checkInflight)
- `vault/src/vault.ts` (buildErrorResponse + checkAccess + globMatch)
- `vault/src/crypto.ts` (envelope encrypt/decrypt + KEK derivation)
- `vault/src/rate-bucket.ts` (F1 token-bucket)
- `vault/src/kek-source.ts` (KEK URL spec resolver)

Tests:
- `test/routes/vault-do-credential-store.test.ts` (NEW, D1, 8 unit)
- `test/routes/vault-proxy-route.test.ts` (D2-extended, +5 wiring tests)
- `test/routes/vault-proxy-do-backed.test.ts` (NEW, D3, 6 e2e)
- `test/vault-store.test.ts` (vault DO under workerd)
- `test/vault/multi-tenant-isolation.test.ts` (per-bundle keying)
- `test/routes/vault-proxy.test.ts` (handler unit, 34 tests)

Spec:
- `cloister-spec/credential-isolation/v1/README.md`
- `cloister-spec/credential-isolation/v1/QUICKSTART.md` (NEW this session)
- `cloister-spec/credential-isolation/v1/wire/proxy-envelope.md`
- `cloister-spec/credential-isolation/v1/wire/injection-strategies.md` (NEW)
- `cloister-spec/credential-isolation/v1/wire/receipt-commitment.md` (NEW)
- `cloister-spec/credential-isolation/v1/wire/error-responses.md` (NEW)

Composition surfaces this depends on:
- `src/routes/lease-middleware.ts` (`verifyAndUpsertLease`, threads `VerifiedLease.peerFp` into the route)
- `src/manifest/runtime.ts:187` (instantiates `VaultProxyRoute` from manifest; does NOT pass env, so auto-select fires per-request)
- `src/manifest/vault-proxy-services.ts` (service registry builder + manifest validation)
- `wrangler.toml` / `config.capnp` (env.VAULT_STORE binding)

### What "load-bearing" means here

The five claims this code now defends (see `README.md§"Load-bearing claims"`):

1. **Plaintext credentials never cross the response boundary** — caller observes request/response/error/log/metric, MUST NOT reconstruct credential value
2. **Identity-scoped access** — `allowedSubs` glob enforced before injection
3. **Audit by receipt** — every proxy call commits to `peer_receipts` row; receipt MUST NOT carry credential value
4. **§9.4.b constant-time 404** — peer-existence + credential-existence non-distinguishable from the wire (status code + body bytes collapse)
5. **Per-bundle isolation via `idFromName`** — bundle A's `bundleIdName: "X"` cannot reach bundle B's `bundleIdName: "Y"` storage (ADR-0021)

Findings that break any of these are P1. Findings that erode them under specific edge cases are P2. Findings that are theoretical-but-not-exploitable are P3.

## Cross-references (specialists add as they discover overlaps)

> _Use this section to flag when your finding overlaps with another
> specialist's. Format: "Bundle-iso F2 ⇄ DoS F3 — both stem from
> selectCredentialStore() memoization race." Synthesis lead uses these
> as cross-cut input._

(empty — populated during cycle)

---

## Findings — bundle-isolation-tester

> **Scope reminder:** ADR-0013 slice-grant invariant preserved across
> D1-D3? `selectCredentialStore` three-branch priority correct under
> all dep + env combos? Optional `forward` method on the interface — can
> a misconfigured composition cause plaintext to leak via a `resolve`
> fallback that should never fire? Per-bundle keying — what's the
> attacker shape for forcing `bundleIdName` collision or substitution?

(specialist writes here)

---

## Findings — dos-resilience-auditor

> **Scope reminder:** New lazy + memoized `VaultDoCredentialStore`
> construction per `VaultProxyRoute` instance — can an attacker force
> repeated construction? F1 token-bucket interaction with the new
> forward path — does 429 propagate? Inflight cap on vault DO (which
> the new forward path now feeds) — does the route layer's
> rate-limiting compose correctly with the DO's? Memoization
> correctness under burst — first-call wins the construction, but
> what about concurrent first-calls?

(specialist writes here)

---

## Findings — enumeration-oracle-hunter

> **Scope reminder:** Can the InMemory-vs-VaultDo selection itself
> become an oracle (different timing, different error shapes)? Route's
> pre-forward service-declaration 404 (Shape R per `wire/error-responses.md`)
> vs vault DO's post-forward 404 (Shape V) — they're INTENDED to be
> distinguishable for operators but indistinguishable to a probing
> attacker who lacks credential context; verify the timing + size
> profile actually matches the claim. The forward path's 502
> (Shape U) on RPC throw — does the byte-equal collapse hold under
> all failure modes the catch{} block hits? `bundleIdName` is
> currently a literal `"router"` — is there ANY caller-controllable
> input that influences it? `VaultDoCredentialStore.resolve()` always
> returns null — does that constant-return shape leak relative to
> InMemoryCredentialStore.resolve()'s Map lookup?

(specialist writes here)

---

## Findings — observability-gap-auditor

> **Scope reminder:** Forward delegation — do `ProxyCallReceipt`s
> still emit when the route delegates to vault DO instead of running
> the handler's own inject + fetch loop? Do metrics tag the path
> taken (via=vault-do vs via=in-memory)? Does §13.2 silence-is-evidence
> remain intact when the response comes from vault DO? When
> `VaultDoCredentialStore.forward()` catches an RPC throw and returns
> 502 with `{error: "upstream_unavailable"}`, is there a log + alert
> path, or does the failure disappear silently? If `env.VAULT_STORE`
> is misconfigured at deploy time (binding absent), the route silently
> falls back to InMemoryCredentialStore — is that visible to operators
> or does the substrate quietly run unauthenticated dev-mode in prod?

(specialist writes here)

---

## Synthesis (Wave 2 — adversarial-synthesis-lead)

> Fills after all four specialists complete. Produces:
> 1. Prioritized findings (attacker-cost-asymmetry)
> 2. Cross-cuts (per ADR-0020 convention)
> 3. Threat-model patches (which §§ get new rows, which existing rows update)
> 4. New `red-team:*` bead filings
> 5. Recommendation: which findings ship now vs queue
>
> Output lands as `docs/security/adversarial-cycles/2026-05-18.md`
> (matching the existing convention). This WIP file gets deleted at
> cycle close.

(synthesis lead writes here)
