---
status: Proposed
date: 2026-07-22
amends: ADR-0042
tracking-bead: cloister-220c9d
---

# ADR-0053 — Unified lease-gate authority resolution

- **Status:** Proposed (2026-07-22)
- **Tracking bead:** `cloister-220c9d`
- **Amends:** ADR-0042 (turnkey dev seams) — keeps its safety rail verbatim,
  collapses its scattered gate checks into one resolver.
- **Pairs with:** ADR-0007 (Interlace lease), `cloister-d2db6d` (`resolveCABundle`,
  which is step 1 of this — it already centralizes the *bundle-source* axis).

## Context

The lease gate is configured by three env inputs — `INTERLACE_ROOT_PUBKEY`,
`CLOISTER_MODE`, `DEV_CA_MASTER` — read independently at **five** route call
sites (`mcp.ts`, `oci-registry.ts`, `disclosure.ts`, `vault-proxy-route.ts`,
plus `resolveCABundle`) and set by **two** launchers (`dev-bootstrap.mjs`,
`cluster-dev.mjs` via `CLUSTER_DEV_INTERLACE_ROOT_PUBKEY`).

A 5-whys (bead `cloister-220c9d`) traced the sprawl to a single root cause: the
gate **conflates three orthogonal concerns** into an overloaded
`INTERLACE_ROOT_PUBKEY` presence/value plus an ad-hoc `CLOISTER_MODE`/
`DEV_CA_MASTER` pair:

- **(A) enforce?** — encoded by whether `INTERLACE_ROOT_PUBKEY` is truthy.
- **(B) which trust anchor?** — encoded by the *value* of `INTERLACE_ROOT_PUBKEY`.
- **(C) how is the CA bundle obtained?** — fetch-notme-and-verify vs local static
  bundle, encoded by `CLOISTER_MODE=dev` + `DEV_CA_MASTER`.

These were safe to fuse when production guaranteed one reality (notme is always
the reachable, pinned authority, so A/B/C always moved together). Dev decouples
them, and every dev entrypoint invented a knob to express a combination the
fused model couldn't. Two concrete harms:

1. **The empty-value footgun.** `if (env.INTERLACE_ROOT_PUBKEY)` treats an
   *empty string* as "gate off." A production deploy that accidentally leaves it
   empty **silently serves unauthenticated** — indistinguishable from an
   intentional dev opt-out.
2. **Fragmentation.** Adding notme-in-the-loop (`cloister-d2e89a`) or a new
   route means re-deriving A/B/C by hand, inconsistently.

## Decision

Introduce **one pure resolver** — `resolveLeaseGate(env): LeaseGate` — that every
lease-gated route calls. It derives the whole gate decision from an **explicit
authority source**, so A/B/C fall out of one choice and "off" is never an
accidental empty value.

```ts
type LeaseGate = { mode: "off" | "enforce" };
```

The resolver owns **axis A only** (enforce vs off). Axes B (which anchor) and C
(bundle source) already live in `resolveCABundle` (`cloister-d2db6d`), which the
`enforce` path calls unchanged and which already fails closed on a missing
anchor. Carrying a bundle thunk on the gate would just re-wrap `resolveCABundle`,
so the gate stays a pure mode decision — no redundant indirection.

### Derivation rules (the load-bearing part)

Evaluated in order; the first match wins:

| # | Condition | Result |
|---|---|---|
| 1 | `CLOISTER_MODE=dev` **and** `DEV_CA_MASTER` set | `enforce`, static dev bundle (self-mint — harness:dev) |
| 2 | `CLOISTER_MODE=dev` **and** `INTERLACE_ROOT_PUBKEY` set | `enforce`, fetch notme + verify (dev + local notme) |
| 3 | `CLOISTER_MODE=dev` **and** neither set | `off` — the **only** silent off, and it required the explicit dev flag |
| 4 | not dev **and** `INTERLACE_ROOT_PUBKEY` set | `enforce`, fetch notme + verify (production) |
| 5 | not dev **and** no authority | **misconfigured → `enforce` with a null anchor that fails every request closed** + a loud one-shot warning — never silent off |
| 6 | not dev **and** `DEV_CA_MASTER` set | reject: dev key material outside dev mode (also caught by `lint:no-dev-mode`) |

Rule **5** is the empty-value fix: in production an absent/empty authority is a
configuration error that fails **closed** (503, `no CA trust anchor`), not an
open door. "Auth off" is reachable **only** through the explicit
`CLOISTER_MODE=dev` opt-out (rule 3). This is the same discipline ADR-0007 used
to kill `INTERLACE_DEV_BYPASS`: relax *where the trust root comes from*, never
*whether* it is checked.

### What collapses

- The five `if (env.INTERLACE_ROOT_PUBKEY)` route checks become
  `const gate = resolveLeaseGate(env); if (gate.mode === "off") …` — one shape,
  one place to reason about enforcement.
- `resolveCABundle` becomes the body of the `enforce` branch's `bundle` thunk.
- `cluster-dev.mjs`'s `CLUSTER_DEV_INTERLACE_ROOT_PUBKEY` and `dev-bootstrap`'s
  provisioning keep *producing* the env; they stop being a fourth/fifth
  independent notion of "the gate."

### Axes, now separated

- **(A) enforce** = `gate.mode`, derived once — empty is not "off".
- **(B) anchor** = internal to `resolveCABundle` (pinned pubkey or dev master).
- **(C) bundle source** = internal to `resolveCABundle`.

### Two layers: condition *and* flow

Naming the condition (`leaseEnforced`) is necessary but not sufficient — every
route still hand-wrote the *flow* around it:

```
gate on? → verify → on-fail: reject (route-specific) → on-pass: proceed (with lease)
```

That flow is where auth bugs hide (verify-after-acting, or forgetting to verify).
So a second layer owns it: **`gateAndVerify(env, nowMs, verifyArgs, {denyWhenOff?})`
→ `GateVerdict`** (`off` | `pass{lease}` | `reject{code}`). It runs, in one place:
gate → `resolveCABundle` (fail closed) → `verifyAndUpsertLease` → verdict. Each
route maps the verdict to its own response shape (JSON-RPC error / OCI `DENIED` /
401-503 / the disclosure constant-time 404) — the genuinely diverse part stays
route-local; the security-critical *ordering* is centralized. `denyWhenOff` lets
the credential vault deny even under the dev opt-out.

**Audit heuristic (feeds `cloister-bd7210`/`21e42e`).** A "consistent way to
consume" a scattered condition is a *tell*, not a fix. For each such condition,
classify by **action-diversity**:

- consumers act the **same** → hoist the *flow* to an owner (middleware / policy
  table). Stopping at a named predicate is one layer short.
- consumers act **differently** → a named condition + local action is correct.

The lease gate is the borderline that proves the rule: the **flow is shared**
(→ `gateAndVerify`), the **reject shape is diverse** (→ route-local mapping).

## Safety rail (unchanged from ADR-0042)

- `CLOISTER_MODE=dev` remains the single dev signal; `lint:no-dev-mode` still
  fails the strict gate if any committed prod-tier artifact enables a dev seam.
- Dev relaxes only the *source* of the trust root. The cert-chain verify,
  request-sig check, scope match, replay ledger run identically. **No
  per-request bypass** — `mode: "off"` is a deployment-granularity dev choice,
  not a request-level skip, exactly as today.
- Production (rule 4/5) always fetches from notme and verifies the signature.

## Consequences

- **Migration (shipped):** `src/routes/lease-gate.ts` (`resolveLeaseGate` +
  `leaseEnforced`) for the condition; `gateAndVerify` in `lease-middleware.ts`
  for the flow. All four routes (`mcp`, `oci-registry`, `disclosure`,
  `vault-proxy`) call `gateAndVerify` and map the verdict; the `verifyLease`
  methods in `mcp`/`disclosure` are deleted. `resolveCABundle` is unchanged.
  Behaviour is identical for every *currently valid* config; the only behaviour
  *change* is rule 5 (prod + empty anchor now fails closed instead of serving
  open) — a strict improvement. The test suite's implicit "gate off" default is
  made explicit via `CLOISTER_MODE=dev` in `vitest.config.ts`.
- **Testable:** `resolveLeaseGate` is a pure function over `env`; the six rules
  get a table-driven unit test (no workerd needed).
- **Unblocks:** the config-hygiene work (`cloister-21e42e`/`21f273`) inherits the
  lease-gate empty-value case as *done* here; only non-gate empty-values remain.
```
