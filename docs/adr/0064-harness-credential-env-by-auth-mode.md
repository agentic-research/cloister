---
status: Proposed
date: 2026-08-05
amends: ADR-0040
tracking-bead: cloister-67f767
---

# ADR-0064 — A harness credential env var belongs to an auth mode, not to a target

- **Status:** Proposed (2026-08-05)
- **Tracking bead:** `cloister-67f767`
- **Amends:** ADR-0040 (harness control/credential/audit plane) — keeps its
  custody/audit split, gives `stripEnv` the mode-awareness that split implies.
- **Pairs with:** ADR-0024 (`cloister/credential-isolation/v1`), ADR-0042
  (turnkey dev run).

## Context

`HarnessTarget.stripEnv` states its own purpose in `manifest/cluster.capnp`:

> Credential env vars scrubbed before exec, so a confined harness cannot see a
> key even if the operator exported one — **which would otherwise let it bypass
> the proxy by calling the provider directly.**

For `claude-code` the list is `["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]`.

`claude setup-token` mints a long-lived subscription credential in
`CLAUDE_CODE_OAUTH_TOKEN`. It is a credential env var by exactly the definition
above, and it is not in the list — it appears nowhere in the tree.

So an operator who runs `setup-token` and launches in **custody** mode gets the
API key vaulted and stripped as designed, and the OAuth token handed to the
confined harness.

### What that is, precisely

Narrower than first filed, and the correction matters because it changes the
priority. `src/harness-shim/index.ts` strips the `authorization` header unless
`HARNESS_SHIM_PRESERVE_AUTH` is set, and `launch.mjs` sets that **only in audit
mode**. So the token cannot reach the provider through cloister's proxy: the
header is removed and the vaulted key is injected. The request that leaves is
the authorized one, and it is receipted.

What remains is a least-privilege violation rather than a bypass: a confined
process is handed a live subscription credential it was never granted and has no
use for. Inert alone. Exfiltrable in combination with `cloister-2d420c`, where a
macOS harness could open a listener — which is why fixing either breaks the
chain, and why this ADR is not urgent on its own.

### Why one flat list cannot express the fix

Audit mode **requires** that variable in the harness environment. `vaultProxy`'s
`passthrough` injection exists for it: *"inject NOTHING. Forward the caller's own
request + auth headers to the upstream and emit the receipt. For
OAuth-subscription harnesses (Claude Code Max) where there is no key to vault —
cloister provides audit (receipts), not custody."*

So the same variable must be **stripped in custody and kept in audit**.
`launch.mjs` applies `env_strip: target.stripEnv` unconditionally, with no
knowledge of the resolved `AuthPlan`. Adding the token to `stripEnv` breaks
audit; leaving it out breaks custody. The list is asking the wrong question — it
asks *which target* rather than *which mode*.

## Decision

**A credential env var is declared against the auth mode that legitimately uses
it, and `env_strip` is computed from the resolved `AuthPlan`.**

Add one field to `HarnessTarget`, at a new ordinal, per the append-only rule:

```capnp
# Env var carrying a SUBSCRIPTION credential — one the harness authenticates
# with directly, rather than one cloister vaults on its behalf.
#
# Distinct from apiKeyEnv, and the distinction is the whole field: a key in
# apiKeyEnv is vaulted and injected at the proxy, so the harness never holds
# it. A subscription token cannot be vaulted — there is nothing for cloister
# to inject, because the credential IS the caller's own identity. Audit mode
# exists for exactly that case.
#
# STRIPPED in custody: the harness has a vaulted key and this would let it
# reach the provider on a second, unreceipted path.
# RETAINED in audit: it is the only credential the run has.
subscriptionTokenEnv @N :Text;
```

`resolveAuth` already returns `{mode: "custody", apiKey} | {mode: "audit"}`.
`buildPolicy` computes:

- **custody** — `stripEnv ∪ {apiKeyEnv} ∪ {subscriptionTokenEnv}`
- **audit** — `stripEnv ∪ {apiKeyEnv}`, retaining `subscriptionTokenEnv`

For `claude-code`, `subscriptionTokenEnv = "CLAUDE_CODE_OAUTH_TOKEN"`. `codex`
declares none and is unaffected — it is `authModes = ["custody"]` only.

### The rail

A field that must be listed somewhere is a field someone forgets. `task lint`
gains a check: **every credential-shaped env var a declared harness understands
appears in exactly one of `apiKeyEnv`, `subscriptionTokenEnv`, or `stripEnv`.**

The bug this ADR fixes was never the missing string — it was that nothing
related the list to the invariant the schema comment states. A rail that only
checked "is the token in stripEnv" would pass the moment someone added it and
say nothing about the next credential.

## Alternatives considered

**Add it to `stripEnv` and drop audit mode.** Smallest change, and it deletes
the only path a Claude subscription can take through cloister. Audit is a
deliberate ADR-0040 posture — receipts without custody — not a gap.

**Strip it in both modes and have cloister vault the OAuth token.** Tempting:
the vault proxy already supports `authorizationBearer`, `credentialHeaders` is
generic over the credential string, and custody with a subscription would be
strictly better than audit. **Unverified, and it is the deciding fact** — nobody
has established that a `setup-token` credential authenticates as
`Authorization: Bearer` against the API rather than being Claude-Code-client
scoped. One request settles it. If it works, this ADR is superseded by a better
one and audit becomes a fallback rather than the subscription path. Recorded
here so that check is not lost.

**Leave it and document.** What the tree does today. Acceptable while the
composite risk needs `cloister-2d420c` too, and 2d420c is now fixed — so the
argument for leaving it has weakened rather than strengthened.

## Consequences

- One schema field, append-only, no ordinal renumbering.
- `env_strip` becomes a function of the auth plan, which is where the
  custody/audit distinction already lives.
- Targets declaring no subscription token are unaffected.
- The README claim *"You need an API key, not a Claude subscription"* becomes
  false and should be corrected in the same change — audit mode already shipped,
  and `setup-token` completes it.
