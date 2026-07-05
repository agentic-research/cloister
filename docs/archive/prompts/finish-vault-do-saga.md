# Finish the vault DO saga — credential-isolation/v1 production-readiness

Autonomous-session prompt. Hand this verbatim to a `/rosary:evolve --focus <bead>` run
or to a fresh Claude Code session driving the work directly.

> The cred-iso/v1 capability shipped end-to-end on 2026-05-18 (PRs #29–#37)
> with the `InMemoryCredentialStore` backing. The remaining load-bearing
> piece is making the route production-ready by wiring the
> `CredentialStore` seam to the existing `CredentialVault` DO. This
> document defines that work as parallelizable beads + sequencing rules.

## What "done" looks like

- `cloister-d98db2` (parent) closes.
- The vault-proxy route in production picks `VaultDoCredentialStore` from
  `env.VAULT_STORE` and falls back to `InMemoryCredentialStore` only in
  dev/test.
- Plaintext credential bytes still never cross the vault DO trust
  boundary — the route delegates the entire Request via
  `vaultStub.proxyRequest(...)` rather than fetching plaintext bytes
  itself (preserves ADR-0013 slice-grant invariant).
- 1068+ existing tests stay green; new tests cover both the impl
  and the integration path.
- `docs/STATUS.md` updates: `cloister/credential-isolation/v1` moves to
  **Shipped**; `cloister-8f57f0` parent closes.

## Saga shape (parallelization-aware)

### Track A — Stale-close housekeeping (instant, fully parallel with everything)

| Bead | Action | Blocker |
|---|---|---|
| `cloister-211b68` | F1 token-bucket already shipped. Close as stale. | Auto-mode classifier — needs user-authorized close. |
| `cloister-2140b5` | Close-as-superseded once D1 (`cloister-e26ea8`) lands; the `bundleIdName` parameter in `VaultDoCredentialStore` is the concrete answer to the three identity-propagation options the bead listed. | D1 must land first so the rationale links to real shipped code. |

### Track B — Production CredentialStore (the load-bearing arc)

Three sub-beads under `cloister-d98db2`. **All three are P1.** Dependency graph:

```
D1 (e26ea8) ──→ D2 (e2a12a) ──→ D3 (e2d38a) ──→ d98db2 closes
   │                │                │
   new file         edits 2 files    new file
   no overlap       composition      no overlap
                    root + iface
```

| Bead | Files | Parallel-safe with | Sequencing |
|---|---|---|---|
| **D1 `cloister-e26ea8`** | NEW `src/routes/vault-do-credential-store.ts` + NEW `test/routes/vault-do-credential-store.test.ts` | A1, A2, F1, F2 | Must land **first**. Also adds the optional `forward` method to the `CredentialStore` interface in `src/routes/vault-proxy-credential-store.ts` — that edit is the only shared file with D2. **Strategy**: D1 commits the interface bump alone first (single-line addition), then D2 branches from that commit. Or one developer takes both back-to-back. |
| **D2 `cloister-e2a12a`** | EDIT `src/routes/vault-proxy-route.ts` + EDIT `test/routes/vault-proxy-route.test.ts` | A1, A2, D3 (after interface bump), F1, F2 | Depends on D1's interface bump. Then 5-line composition-root edit + a couple of tests. |
| **D3 `cloister-e2d38a`** | NEW `test/routes/vault-proxy-do-backed.test.ts` | A1, A2, D1 (after D1 lands), F1, F2 | Pure new test file. Author in parallel with D2; merge after D2 wires the composition. |

### Track C — Per-bundle migration polish (deferred until notme-as-bundle ships)

| Bead | Status |
|---|---|
| `cloister-43e55a` (Phase 1 — router idName) | Folded into D1's `bundleIdName: string` constructor param. |
| `cloister-43e55a` (Phase 3 — notme uses `idFromName("notme")`) | Blocked on `cloister-db99cd` (ADR-0018 notme-as-bundle). Reopen at P2 when that bead unblocks. |

### Track D — Phantom-token alternative (deferred decision)

| Bead | Status |
|---|---|
| `cloister-29e0a4` | Mutually exclusive with Track B. **Decide after Track B ships**: does phantom-token still earn its complexity given V8 isolate + slice-grant + VaultDoCredentialStore? If yes, draft a new ADR (next-free number) and file a multi-PR arc. If no, close as alternative-not-pursued. |

### Track E — Conformance + docs (fully parallel)

| Bead | Files | Parallel-safe with | Notes |
|---|---|---|---|
| `cloister-954f21` (P2) | `cloister-spec/credential-isolation/v1/test-vectors/*.json` (NEW) | All B beads, A beads, F2 | Capability spec is stable (ADR-0024). Write JSON vectors against the running route. |
| `cloister-96ac29` (P3) | `cloister-spec/credential-isolation/v1/QUICKSTART.md` (NEW) | All other beads | One-page consumer walkthrough. Pure docs. |

## Recommended parallel dispatch plan

**Single developer, sequential** (lowest coordination cost):

1. Land D1 (`cloister-e26ea8`) — new file + interface bump in one PR.
2. Land D2 (`cloister-e2a12a`) — composition wire-up.
3. Land D3 (`cloister-e2d38a`) — integration tests.
4. Close `cloister-d98db2`, `cloister-43e55a` (Phase 1 portion), `cloister-2140b5`. Reopen `43e55a` as P2 notme-tracker.
5. Update `docs/STATUS.md` — cred-iso/v1 moves to Shipped.
6. Decide on Track D (`cloister-29e0a4`).
7. Track E (conformance vectors + QUICKSTART) is independent — fit in any free cycle.

**Multi-agent parallel dispatch** (when wall-clock matters):

- **Agent α**: D1 (file scope: `src/routes/vault-do-credential-store.ts`, `test/routes/vault-do-credential-store.test.ts`, plus 1-line interface bump in `src/routes/vault-proxy-credential-store.ts`).
- **Agent β** (concurrent): F1 = `cloister-954f21` (file scope: `cloister-spec/credential-isolation/v1/test-vectors/*.json`).
- **Agent γ** (concurrent): F2 = `cloister-96ac29` (file scope: `cloister-spec/credential-isolation/v1/QUICKSTART.md`).
- After D1 lands: **Agent δ** picks up D2; **Agent ε** authors D3 against a local branch with D1 applied (rebase on top of D2 once D2 merges).

rsry's `has_file_overlap()` will refuse to co-dispatch D1+D2 (both touch
`vault-proxy-credential-store.ts`); the interface bump strategy in D1's
description handles this — D1 commits the interface alone first, D2
rebases.

## Required reading before starting

1. **`src/vault-store.ts:1–200`** — read the file header. The `Open: in-cluster bundle identity propagation` section is the design context for D1's `bundleIdName` parameter. The `Cross-bundle isolation: layered defense` section explains why the (subjectFp, service) composite key is load-bearing.
2. **`src/routes/vault-proxy-credential-store.ts`** — current seam definition. D1 extends the `CredentialStore` interface here with an optional `forward` method.
3. **`docs/adr/0013-slice-grant-enforcement.md`** — the slice-grant invariant D1 must preserve (no plaintext crossing the DO trust boundary).
4. **`docs/adr/0021-per-bundle-vault-do.md`** — the per-bundle keying decision D1 encodes.
5. **`docs/adr/0024-credential-isolation-capability.md`** — the v1 capability spec.
6. **`test/vault/multi-tenant-isolation.test.ts`** — the existing per-bundle isolation test pattern. D3 mirrors this shape against the production route.
7. **`test/routes/vault-proxy-route.test.ts`** — current route-handler tests; D2 extends.

## Definition of done (DoD)

For the parent (`cloister-d98db2`):

- [ ] D1, D2, D3 all merged to main; their beads closed.
- [ ] `task lint` + `task test` + `task ci` green.
- [ ] `cloister-spec/credential-isolation/v1/CAPABILITY.md` references `VaultDoCredentialStore` as the production impl.
- [ ] `docs/STATUS.md` Shipped table includes cred-iso/v1 with the vault-DO-backed wiring; `cloister-8f57f0` closed.
- [ ] `cloister-2140b5` closed-as-superseded with a link to the shipped `bundleIdName` parameter.
- [ ] `cloister-43e55a` re-priority to P2, comment links Phase 3 to `cloister-db99cd`.
- [ ] Track D (`cloister-29e0a4`) has a fresh comment: kept open OR closed-as-alternative-not-pursued, with rationale.
- [ ] Threat-model `docs/security/threat-model.md` row updated: vault-DO-backed cred-iso path; binding-layer per-bundle isolation called out.

## Stop conditions

- **Stop and ask** if: the `bundleIdName` parameterization would require schema changes the operator hasn't requested; the route's `forward` delegation needs to violate the no-plaintext-RPC invariant for any test scenario; OR D3's integration tests reveal a substrate-level bug that needs an ADR.
- **Do not stop for**: lint warnings, test refactors, or recipe sprawl. Those are routine work.

## Provenance

- Filed: 2026-05-18, decomposing `cloister-d98db2` for parallel dispatch.
- Parent saga ADRs: ADR-0013, ADR-0021, ADR-0024.
- Predecessor: PRs #29–#37 (cred-iso/v1 with InMemoryCredentialStore).
- This document is the contract; the beads listed above are the discrete units of work.
