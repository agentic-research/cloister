# ADR-0040 — Harness-in-cloister: cloister as the audited control + credential plane for agent harnesses

- **Status:** Proposed (2026-07-06)
- **Tracking bead:** `cloister-f3e3ae` (L1 vault-proxied harness credentials — this ADR frames it)
- **Pairs with:**
  - ADR-0007 (Interlace substrate — the lease + attestation chain every mediated call rides)
  - ADR-0013 / ADR-0024 (slice-grant + `credential-isolation/v1` — the vault pattern the L1 proxy reuses)
  - ADR-0019 (sign-only helper — the same "hold the secret, expose only the operation" shape)
  - ADR-0009 (compute substrate portability — where agent-process *sandboxing* would live; explicitly out of scope here)
  - ADR-0033 (bd substrate binding — establishes workerd has no process-spawn, so dispatch is host-side)

## Context

An agent harness — Claude Code, Codex, Gemini CLI — does two things a
substrate should care about: it **spawns agent processes** (via an
orchestrator like rosary) and it **makes LLM API calls** with a
credential (an Anthropic API key, an OAuth token). Today both happen on
the developer's host, in the clear: the API key sits in the harness's
environment, and every LLM call + every dispatch is unaudited.

Cloister already hosts rosary's MCP face as a bundle (`[inputs.rosary]`,
`cloister-cf7a3b`), so `rsry_dispatch` is reachable through `/mcp` —
auth'd by the lease gate, receipted by the §13.4 chain. The question
this ADR answers: **what does "the harness runs in cloister" mean, given
that workerd cannot spawn processes** (ADR-0033: "no filesystem and no
process-spawn primitive")?

The naive reading — "run Claude Code inside a workerd isolate" — is
impossible. A v8 isolate has no `exec`, no fork, no host filesystem. So
the honest formalization is not *compute* containment; it is **control +
credential + audit** containment.

## Decision

Cloister is the harness's **control plane, credential plane, and audit
plane** — not its compute sandbox. Three layers, with a hard boundary:

**L0 — Orchestration mediation (shipped).** rosary's MCP face runs as a
cloister bundle. Dispatch requests (`rsry_dispatch`) traverse `/mcp`, so
they inherit the lease gate (who may dispatch) and the attestation chain
(every dispatch on the record). The *decision to spawn* is mediated by
cloister; the *spawn itself* is not.

**L1 — Credential proxy (the `cloister-f3e3ae` build).** The harness's
LLM credential lives in the `CredentialVault` DO, never in the harness's
environment. The harness points its API base at a cloister route
(`ANTHROPIC_BASE_URL` → cloister); cloister injects the vaulted key,
forwards to Anthropic, streams the response back (SSE, un-buffered), and
writes a **receipt per call** (model, token counts, timestamp, caller
lease). Plaintext key bytes never cross back to the harness — the same
decrypt-inside-the-DO discipline as the vault proxy (ADR-0013). Channel
auth is mTLS + an Interlace lease, not a bearer token.

Implementation note: the existing `vaultProxy` route is lease-gated.
Stock Claude Code can use an `ANTHROPIC_BASE_URL`, but it does not mint
Interlace lease headers by itself. A deployable Claude Code L1 therefore
needs either a lease-aware local shim in front of Claude Code, an mTLS
edge that mints/attaches the lease on behalf of the harness identity, or
an enterprise gateway that already terminates that channel identity.
Without that adapter, cloister can host the proxy surface but must reject
the request safe-closed.

**Boundary (explicit, not a gap).** The agent processes and the harness
CLI **run host-side.** workerd can't contain them; cloister doesn't try.
Sandboxing the *compute* is a different substrate (ADR-0009 —
Firecracker / microVM), deferred until there is a real signal for it.
What cloister contains is the **secrets** (vault) and the **record**
(every dispatch + every LLM call attested).

## Scope of the credential claim (honesty)

The "harness never sees the key" claim is precise:

- **API-key + enterprise-gateway shapes:** TRUE — the key is vaulted;
  the harness holds only a cloister token.
- **Max / Pro OAuth subscription:** the OAuth token lives in the
  *client's* keychain by design; cloister cannot hold what the client
  mints. For that shape cloister provides **audit** (receipts) but not
  **custody**. The receipt claim ("everything's on the record") holds
  for all shapes; the custody claim ("tools never see the key") holds
  only where cloister issues or holds the credential.
- **Codex / non-Anthropic providers:** provider routing is a harness
  concern, not a new proxy primitive. Cloister declares services by
  upstream shape (`authorizationBearer`, `headerNamed`, etc.) and should
  reuse the same provider-selection pattern the harness already uses
  rather than forking an Anthropic-only path.

## Consequences

- A harness configured against cloister gets **credential custody + a
  signed, offline-verifiable audit trail** of its LLM usage, without
  changing the harness's code — just its `ANTHROPIC_BASE_URL`.
- The main technical risk is **SSE streaming fidelity**: cloister must
  forward the token stream without buffering (latency + memory), which
  the L1 build must prove against a real Claude Code session.
- It does **not** sandbox the agent. A compromised agent process can
  still do anything the host allows; cloister only ensures it cannot
  *exfiltrate the LLM key* and cannot act *un-recorded*.
- Extends the trust boundary: the vaulted LLM credential + the LLM-call
  receipt chain are new seams. The threat model gains a section before
  the L1 code lands (house rule).

## Alternatives considered

- **Run the harness inside cloister (compute containment).** Impossible
  on workerd; would require ADR-0009's microVM substrate. Deferred.
- **Bearer-token proxy.** Simpler, but a leaked bearer is just a bearer;
  mTLS + lease binds the channel to an attested identity.
- **Do nothing (status quo).** The key stays in the harness env, calls
  stay unaudited. This ADR exists to replace that.
