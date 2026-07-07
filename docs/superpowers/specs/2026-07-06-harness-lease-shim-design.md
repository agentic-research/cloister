# Design — lease-aware harness signing shim (`cloister-caab2d`)

- **Date:** 2026-07-06
- **Bead:** `cloister-caab2d`
- **Goal it unblocks:** harnesses (Claude Code, Codex) run against cloister with
  credentials fully isolated — the LLM key vaulted, the harness process holding
  neither the LLM key nor the signing key.
- **ADRs:** ADR-0040 (harness-in-cloister; "Implementation note" names this
  adapter), ADR-0013/0024 (the vault proxy it fronts), ADR-0019 (sign-only
  helper — the hardening path for key custody), ADR-0007 (the lease protocol
  the shim speaks).

## Problem

`/vault/proxy/<name>` is lease-gated and **safe-closed**: every request must
carry a valid Interlace lease — `Authorization: Signet <cert-DER>`,
`X-Signet-Sig` (Ed25519 over canonical bytes), `X-Signet-Ts`, `X-Signet-Nonce`
— verified server-side by `verifyAndUpsertLease` (real cert-chain + Ed25519 +
epoch + scope + replay). Stock Claude Code / Codex set only a base URL. They
never mint a lease, so their un-signed requests bounce `401` and the proxy is
inert for them. Cloister *checks* signatures; nothing on the harness side
*produces* one.

Verified in code before this build:

- Server gate is real and wired for the proxy: `VaultProxyRoute.handle` →
  `defaultLeaseVerifier` → `verifyAndUpsertLease` (step 6 = Web Crypto Ed25519
  verify over `canonicalRequestBytes`). Unset `INTERLACE_ROOT_PUBKEY` ⇒ `401`
  deny-all, not bypass.
- The per-request signature is **raw Ed25519 over canonical bytes**, *not*
  `ley-line-sign`'s CMS/PKCS#7 envelope. `ley-line-sign` is the crypto library
  cloister already uses to *verify the cert chain*; it is not the shim and not
  the per-request signer.
- The client-side signing logic already exists as a test helper
  (`test/helpers/signed-request.ts`). The shim needs transport + cert
  acquisition + header-attach, **not** new crypto.

## Decision — shape 1: lease-aware local signing shim

A host-side localhost HTTP listener. The harness points its base URL at the
shim; the shim signs each call with a valid lease and forwards to cloister.

```
harness ── OPENAI_BASE_URL=http://127.0.0.1:PORT/vault/proxy/openai
   │        (harness appends /v1/chat/completions, streams SSE)
   ▼
shim  ── canonical-bytes(method, CLOISTER_URL, ts, nonce, body)
   │      → Ed25519 sign (ephemeral key) → Signet headers
   ▼
cloister /vault/proxy/openai  ── verifyAndUpsertLease ✓ → inject vaulted key
   ▼                              → api.openai.com (SSE streamed back through)
```

The harness holds a **localhost URL only** — not the LLM key (vaulted in
cloister) and not the signing key (held by the shim). That is the credential
isolation the goal asks for.

### Components

1. **`lease-signer.ts`** — pure Web Crypto (Node 20+ *and* workerd). Given
   `(method, url, body, identity, ts?, nonce?)` returns the four Signet
   headers. Canonical bytes byte-identical to `lease-middleware.ts`
   `canonicalRequestBytes`. No Node deps → importable by the Gap-2 test so the
   *exact signer the shim uses* is proven against the *real* verifier.
2. **`index.ts`** — Node `http` listener. Per request: buffer body, rewrite the
   path onto `CLOISTER_BASE_URL`, sign over the **cloister** URL (what the
   server observes), forward, **stream the response body back** (SSE fidelity —
   never buffer). Node-only; lives outside the workers tsconfig by design.
3. **`CertSource`** — where the ephemeral cert + key come from.

### Sub-decisions (v1)

| Decision | v1 | Hardening path |
|---|---|---|
| Cert source | Loaded dev cert + ephemeral seed from env, behind a `CertSource` interface | Live notme mint (drop-in `CertSource` impl) |
| Key custody | In-process in the shim | ADR-0019 sign-only helper (shell out; shim never holds raw key) |
| Provider first | Codex/`openai` (this branch), then `anthropic` | manifest entry per provider |

### Non-goals (v1)

- Live notme cert minting (interface stub only).
- OAuth Max/Pro custody (ADR-0040: that shape gets audit, not custody).
- Sandboxing the harness process (ADR-0009 microVM — deferred).

## Proof (Gap 2 — closes ADR-0040's named risk)

`test/routes/vault-proxy-lease-gate.test.ts` drives the **real**
`verifyAndUpsertLease` through `VaultProxyRoute` (only the CA-bundle *fetch* is
injected as a test bundle — crypto, scope, replay, TrustStore DO are all real),
signing with `lease-signer.ts` + the admin fixture cert:

- valid signature → `200`, and the mock upstream observes the injected
  `Authorization: Bearer <vaulted-key>`;
- tampered signature → `401` constant-shape (gate rejects).

This proves the signer↔gate contract independent of the Node binary.

## Follow-ups (file as beads when rsry MCP is back — discovered-from `cloister-caab2d`)

1. **notme-minting `CertSource`.** v1 loads a dev cert from env. Deployable
   path: a `CertSource` that mints a short-lived lease cert from notme against
   the cluster master and re-mints before the `maxCertLifetimeSeconds` (300s)
   TTL. Same interface — `index.ts` unchanged. ADR-0019 sign-only helper is the
   further hardening (shim never holds the raw ephemeral key).
2. **Per-service lease scope granularity.** `defaultLeaseVerifier` passes
   `method: "vaultProxy"`, so `verifyAndUpsertLease` derives scope
   `unknown:vaultProxy` for *every* service — a cert can't be scoped to `openai`
   vs `anthropic` (only an admin `*` cert passes; the gate test uses
   `CERT_ADMIN_B64`). Not an auth hole (`defaultAllowedSubs` + per-row
   `allowedSubs` still isolate callers), but scope can't express "this cert may
   use openai only." Fix: derive a service-specific `requestedScope` (e.g.
   `vaultProxy:<service>`) via the `requestedScope` override.

## Done when

- `lease-signer.ts` unit test: canonical bytes + headers correct.
- Gap-2 integration test green (valid → 200 + injected key; tampered → 401).
- Shim README documents the two-env wiring + the custody-vs-audit honesty.
- `task lint` green.
