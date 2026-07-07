# ADR-0042 — Turnkey local harness run (`task harness:dev`): dev-mode seams for the credential-isolation plane

- **Status:** Proposed (2026-07-07)
- **Tracking bead:** `cloister-caab2d` follow-on (turnkey run — file a dedicated bead when rsry MCP is reachable)
- **Pairs with:**
  - ADR-0040 (harness-in-cloister — this makes L1 *runnable*, not just declared)
  - ADR-0013 / ADR-0024 (the vault proxy + `credential-isolation/v1` this drives)
  - ADR-0007 (the Interlace lease the run must present)
  - ADR-0014 / ADR-0019 (KEK source + sign-only helper — the same "dev relaxes the source, not the shape" discipline)
  - ADR-0039 (local DO-at-rest security — the vault this seeds)

## Context

ADR-0040 established cloister as the credential plane for agent harnesses, and
`cloister-caab2d` shipped the lease-signing shim + a real-gate proof. But the
end-to-end run is **proven, not turnkey**: a developer cannot yet point Claude
Code / Codex at cloister and go. Four pieces require operator setup that has
**no path today**:

1. **A lease cert** — the shim's `CertSource` v1 reads a dev cert from env, but
   nothing *produces* one. Production mints via notme (`cloister-c3c7b9`).
2. **A CA bundle** — `verifyAndUpsertLease` verifies the cert against a bundle
   fetched by an injected `BundleFetcher`, hardcoded in `defaultLeaseVerifier`
   to `notmeBundleFetcher`. Local dev has no notme.
3. **Credential ingestion** — the vault DO has `putCredential`, but **no
   operator-facing route or CLI** puts a key into it. The Gap-2 test only works
   via the in-memory test seam.
4. **Authz opt-in** — `defaultAllowedSubs = []` (deny-all by design); the
   caller's `peerFp` must be opted in.

None of these should require standing up notme for a laptop run. But three of
the four are **trust-boundary surfaces** (cert issuance, CA-bundle trust,
credential ingestion), so a turnkey path must relax them *without* opening a
surface that could exist in production. Hence this ADR (per the repo rule:
trust-boundary changes get a numbered ADR first).

## Decision

Ship **`task harness:dev`** — a one-command local run — built as **one system
with the dev/production difference behind seams**, selected by a single
`CLOISTER_MODE=dev` flag. Dev is *never* a fork of the code; it is a different
implementation behind the same interface, the way `CertSource` already splits
env-cert (dev) from notme-mint (prod).

| Seam | Interface | Dev impl (`CLOISTER_MODE=dev`) | Prod impl |
|---|---|---|---|
| Identity | `CertSource` | generate a fresh ephemeral Ed25519 **dev master** + mint a short-lived dev lease cert (`rs/crates/sign` `mint_test_cert`, random seeds); `INTERLACE_ROOT_PUBKEY` = dev master | notme mint (`cloister-c3c7b9`) |
| CA bundle | `BundleFetcher` | **static dev bundle** built from the dev master (`{epoch, keys:{active: devMaster}, keyId}`), no notme fetch | `notmeBundleFetcher` |
| Key → vault | `CredentialIngest` (new) | **boot-time seed**: the vault DO ingests a `DEV_VAULT_SEED` entry via existing `putCredential` — in-boundary, no external write route | designed ingestion surface (future ADR) |
| Authz | `defaultAllowedSubs` | dev **overlay** sets the target service's subs to the dev `peerFp` (not committed to the shared `cluster.toml`) | operator-managed |

`task harness:dev` orchestrates: mint the dev master+cert → write the dev env
(`CLOISTER_MODE=dev`, `INTERLACE_ROOT_PUBKEY`, static bundle, `DEV_VAULT_SEED`,
authz overlay) → boot `serve:local` + the shim → print the
`export ANTHROPIC_BASE_URL=…` line. After that, running a harness in cloister is
one command.

### The load-bearing safety rail

Every dev relaxation — dev master, static bundle, boot seed, authz overlay — is
gated behind the single `CLOISTER_MODE=dev` flag, and:

- **A lint guard (`lint:no-dev-mode`) fails the strict gate if any production-
  tier artifact enables a dev-mode seam.** `CLOISTER_MODE` must be unset/`prod`
  in every committed prod config; the dev bundle / seed env vars must not appear
  in any `hypervisor`/`cluster`-tier bundle. Dev convenience is structurally
  incapable of shipping.
- **Dev key material is ephemeral** — the dev master + cert + ephemeral key are
  generated per run into a gitignored dev dir (or `.env.local`), never
  committed. The static bundle is dev-only; production always fetches from
  notme + verifies the signature.
- **The pipeline is otherwise real.** Dev changes only the *source* of the cert,
  bundle, and credential — the cert-chain verify, Ed25519 request-sig check,
  scope match, replay ledger, and vault AEAD are the same code paths production
  runs. A dev run that passes proves the real gate, not a bypass.

This is the same principle as ADR-0007's rejection of `INTERLACE_DEV_BYPASS`:
**no per-request bypass.** Dev mode relaxes *where the trust roots come from*
(local, ephemeral) at deployment-binding granularity — it never weakens the
per-request verification.

## Consequences

- A developer runs Claude Code / Codex in cloister with **one command**, key
  vaulted, on a laptop, no notme.
- The `CredentialIngest` seam is new trust surface. The **dev** impl is safe by
  construction (in-boundary boot seed, no external write route); the **prod**
  impl is explicitly deferred to its own ADR + threat-model section — this ADR
  does *not* authorize a production credential-write route.
- The threat model gains a "dev-mode boundary" subsection before the code lands
  (house rule): what dev relaxes, why each relaxation is local-only-safe, and
  the lint invariant that keeps it out of production.
- `task harness:dev` is the reference that later swaps to production impls
  (notme `CertSource`, real ingestion) with **no change to the orchestration** —
  only which seam impl is wired.

## Alternatives considered

- **Reuse the committed test fixture cert.** Fastest, but puts repo-committed
  key material (scope `*`) in a run path. Rejected for the default; a fresh
  per-run dev master is cleaner and closer to prod shape.
- **Run notme locally for the dev run.** Most faithful, but pulls
  `cloister-c3c7b9` forward and adds a service to boot for a laptop run.
  Deferred — it's the *production* `CertSource`, available behind the same seam.
- **An open `POST /vault/put` credential-write route for dev.** Rejected — an
  ingestion *route* (even dev-gated) is a bigger, riskier surface than an
  in-boundary boot seed. The prod ingestion surface deserves its own ADR, not a
  dev shortcut that hardens into production.
- **Do nothing (status quo).** The run stays proven-but-unrunnable. This ADR
  exists to close that gap.
