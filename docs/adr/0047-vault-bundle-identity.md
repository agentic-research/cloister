---
title: "ADR-0047: Vault bundle-identity — per-bundle DO instances + notme DPoP-token verify (closing the identity-propagation open question)"
status: Proposed (2026-07-14)
date: 2026-07-14
tags: [vault, identity, credential-isolation, dpop, notme, trust-boundary, capability]
threat_model: docs/security/threat-model.md
relates_to:
  - 0007-interlace-substrate.md
  - 0010-vault-and-bundle-clusters.md
  - 0013-slice-grant-enforcement.md
  - 0021-per-bundle-vault-instances.md
  - 0024-credential-isolation-capability.md
  - 0034-multi-tenant-access-spec.md
  - 0046-mediated-capability-core.md
---

## Context

`src/vault-store.ts` (L30–113) documents a deliberately-deferred open question:
**in-cluster bundle identity propagation.** The vault DO takes an explicit
`subjectFp` (and `callerSub`) positional argument and **trusts what's passed** —
it does not independently authenticate the caller. This is safe *today* only
because the sole caller is cloister-router, which threads `VerifiedLease.peerFp`
from post-verify lease state, and no in-cluster tool bundle reaches the vault yet.
When the first tool-bundle Worker gets a direct vault binding, that trust is a gap.

Two prior decisions bear on it, and **new facts change the calculus:**

1. **ADR-0021** selected *per-bundle DO instances* (`env.VAULT_STORE.idFromName(bundleName)`)
   — the binding *is* the identity, because each bundle reaches exactly one DO. It
   explicitly **rejected** the three mechanisms `vault-store.ts` lists — (a) a
   pre-issued DPoP token verified via notme, (b) a workerd caller-correlation
   surface, (c) router-proxies-on-behalf — on the grounds that they "add machinery
   to retain a singleton."

2. **That rejection premise is now stale.** notme already *built* the machinery:
   `signing-authority.ts:mintDPoPToken({ sub, scope, audience, jkt })` mints an
   **Ed25519-signed, `cnf.jkt` DPoP-bound access token** with an audience allowlist,
   a JWKS endpoint (`/.well-known/jwks.json` / `getPublicKeyPem`), `keyId`, and
   revocation (epoch/keyId/seqno via a `RevocationAuthority` DO). Option (a) is no
   longer "machinery to add" — it is a shipped, verifiable surface.

3. **ADR-0046** reframes the vault as the **rpc adapter** of the mediated-capability
   core: a caller presents a lease/token, the mediator *verifies* it (never trusts a
   passed identity), scope-checks, and receipts. A bundle-caller's "lease" is
   naturally a scoped notme DPoP token.

## Decision

Adopt a **hybrid** of ADR-0021's structural isolation and option (a)'s cryptographic
verification. The two compose; neither alone is sufficient.

1. **Structural — per-bundle DO instances (ADR-0021).** Each bundle is wired to its
   own vault DO namespace via the manifest. If the manifest is correct, a bundle
   cannot even *reach* another bundle's vault DO. This is the primary isolation and
   is manifest-enforced (ADR-0013 binding layer). Partially shipped via `bundleIdName`.

2. **Cryptographic — the vault VERIFIES a notme DPoP token (option a, now unblocked).**
   A bundle presents a scoped notme access token; the vault **derives `subjectFp`
   from the *verified* `sub`, not from a trusted positional argument.** This makes
   the vault a proper ADR-0046 rpc adapter. The verify (cloister-side) is:

   - fetch notme's authority JWK (cached, from `/.well-known/jwks.json` or
     `env.AUTH.getPublicKeyPem`), matched by `keyId`;
   - verify the token's Ed25519 signature;
   - check `aud` == the vault's audience, `scope` ⊇ the requested `vault:proxy:<service>`
     scope, and `exp`;
   - verify the **DPoP proof-of-possession**: the presented proof is signed by the key
     whose thumbprint equals the token's `cnf.jkt`;
   - check **revocation** (epoch/keyId/seqno via notme's `RevocationAuthority`);
   - on success, `subjectFp` = fingerprint of the verified `sub`; **on any failure,
     deny** (fail-closed).

**Why both.** Per-bundle DO alone is structural — it still trusts the router-threaded
`subjectFp` *within* a DO, and degrades to trust if a manifest misconfiguration shares
a DO. DPoP-verify alone is per-call cryptographic auth but doesn't isolate storage.
Together: the binding isolates *which* DO, and the verified token authenticates *who*
is calling — defense-in-depth in the exact ADR-0046 shape (adapter verifies, never
trusts). The ADR-0021 (a)/(b)/(c) rejection is superseded: (a) is now cheap because
notme shipped it.

## The token (grounded in notme)

`mintDPoPToken({ sub, scope, audience, jkt })` → an access token carrying `sub`,
`scope`, `aud`, `cnf.jkt`, signed Ed25519 with `keyId`. A bundle obtains one scoped to
`vault:proxy:<service>` with `aud` = the vault audience and `jkt` = the thumbprint of
its own DPoP key. notme validates the audience against its allowlist at mint time; the
vault re-checks it at verify time (audience confusion defense).

## Consequences

- **Closes "the DO trusts what's passed."** `subjectFp` becomes cryptographically
  derived from a verified token, not a trusted positional argument — for both the
  bundle-caller case and (unchanged) the router case.
- **The vault becomes a real ADR-0046 rpc adapter** — verify → scope → (receipt) →
  serve-projection → no-raw-egress. The DPoP token is the bundle-caller analog of the
  Interlace lease the router already carries.
- **Per-tenant scope (ADR-0034) rides the same token** — `scope` carries the tenant;
  no separate mechanism. This also unblocks the `cloister-ceb57c` tenant-scope work
  without waiting on a bespoke per-tenant path.
- **New trust seam** → the threat model gains a section (§18 extension) for the vault
  DPoP-verify: replay (nonce/`htu`/`htm` DPoP binding), audience confusion, scope
  over-grant, notme CA-key rotation, JWKS availability, revocation lag.
- **No live change today** — no bundle calls the vault yet; this settles the design so
  the first bundle (e.g. the `multi-tenant-smoke` recipe) lands on a verified path, not
  the trusted-positional one.

## Alternatives considered

- **Per-bundle DO alone (ADR-0021 as-is).** Rejected as *insufficient*, not wrong:
  structural isolation without per-call auth still trusts the threaded `subjectFp`. Kept
  as the load-bearing *isolation* half of this hybrid.
- **Option (b) — workerd caller-correlation.** Still "unclear today" (workerd may not
  surface which Worker is calling). Not chosen; revisit only if the DPoP path can't ship.
- **Option (c) — router-proxies-on-behalf.** Puts the router in the credential path — a
  substrate-isolation regression (ADR-0013). Rejected.
- **Status quo (trust the router-threaded `subjectFp`).** Correct only while the router
  is the sole caller. Rejected as the answer for the first real bundle.

## Open questions

- **DPoP replay.** Bind the proof to method+URI (`htm`/`htu`) + a nonce/jti with a
  short window; decide where the seen-nonce ledger lives (the vault DO, mirroring
  lease-middleware's replay check).
- **Vault → notme reachability.** `env.AUTH` service-binding RPC (`getPublicKeyPem`) vs
  an HTTP JWKS fetch with cache — pick per deployment; both exist.
- **Token issuance flow.** Who calls `mintDPoPToken` for a bundle, and when
  (deploy-time vs per-request)? Must respect ADR-0010 (tokens ride a vault slice, not a
  raw `[vars]` credential — CLAUDE.md "no env-var bindings for new credentials"). A
  short-lived, PoP-bound token is not a raw credential, but the *issuance* path still
  goes through the vault-slice substrate.
- **Migration order.** The per-bundle-DO migration (ADR-0021) still lands *alongside*
  the first second-caller (ADR-0018 / `cloister-db99cd`); the DPoP-verify path can land
  first, gated on `INTERLACE_ROOT_PUBKEY`-style deployment binding (off until a bundle
  presents a token).

### Composition constraints from the 2026-07-14 foundational review (must hold in the wiring)

- **Mode-selection is by topology, not token presence (finding #1, threat-model §20.9).**
  The bundle-facing entrypoint must be **token-or-deny by binding/deployment topology**;
  it must have NO branch that trusts a positional `subjectFp`. Absence of a token must
  never fall through to the router-trusted path — that would be `INTERLACE_DEV_BYPASS`
  reshaped as "absence of a field."
- **The two hybrid layers must cross-check (finding #2, §20.10).** The vault DO pins its
  expected `sub` at construction (from `idFromName`/manifest) and asserts
  `token.sub == expectedSub`, so a shared-DO manifest misconfig is **caught** by the
  crypto layer, not silently masked. Without this, per-bundle-DO isolation and DPoP
  verify are two single points of failure painted as two layers, not defense-in-depth.
- **Name the lease-vs-token deltas (finding #5).** Unlike the Interlace lease (epoch +
  `peer_fp` + nonce ledger bound *in-band*, trust root cloister-owned), the token's
  epoch/replay/trust-root move partly to notme: revocation is an *online* call (a
  `RevocationAuthority`-down availability coupling, sibling to §20.8), and the trust
  root widens cloister's TCB. The "token = lease" analogy is sound in shape but not in
  these three properties — the follow-on must not inherit an over-strong mental model.

## References

- `src/vault-store.ts` L30–113 — the open question + the (a)/(b)/(c) options.
- notme `worker/src/signing-authority.ts:mintDPoPToken`, `auth/token.mintAccessToken`,
  `allowed-audiences.ts`, `revocation.ts` (`RevocationAuthority`), JWKS via
  `getPublicKeyPem`.
- ADR-0021 (per-bundle DO — amend: its (a)/(b)/(c) rejection is superseded here),
  ADR-0024 (cred-iso/v1 — this authenticates its bundle-caller case), ADR-0034
  (per-tenant scope rides the token), ADR-0046 (vault = rpc adapter).
- `cloister-2b98c0` (this work), `cloister-ac30e7` (the lint that accompanies the choice).
