# harness-shim — run a stock agent harness against cloister's credential vault

A tiny host-side proxy that lets an **unmodified** agent harness (Claude Code,
Codex) reach cloister's `/vault/proxy/<name>` route. The harness points its
provider base URL at the shim; the shim attaches a valid Interlace lease to
each request and forwards to cloister, streaming the response back.

The harness ends up holding a **localhost URL only** — not the LLM API key
(vaulted in cloister, injected inside the `CredentialVault` DO) and not the
lease signing key (held here in the shim). That is the credential isolation
[ADR-0040](../../docs/adr/0040-harness-in-cloister.md) asks for.

```
harness ──▶ shim (127.0.0.1) ──▶ cloister /vault/proxy/<name> ──▶ provider
            signs each request      verifies lease, injects       (SSE streamed
            with an Interlace        the vaulted key                back through)
            lease
```

## Why a shim exists

`/vault/proxy/<name>` is **lease-gated and safe-closed**: every request must
carry `Authorization: Signet <cert>` + `X-Signet-Sig` (Ed25519 over the
canonical request bytes) + `X-Signet-Ts` + `X-Signet-Nonce`, verified by
cloister's `verifyAndUpsertLease`. Stock harnesses set a base URL but never
mint a lease, so their bare requests bounce `401`. The shim is the adapter that
signs on the harness's behalf. (This is shape 1 of the three in ADR-0040's
"Implementation note"; the mTLS-edge and enterprise-gateway shapes are for
shared/hosted deployments.)

The per-request signature is **raw Ed25519 over canonical bytes** — see
`lease-signer.ts`. It is *not* `ley-line-sign`'s CMS envelope; `ley-line-sign`
is what cloister uses to verify the *cert chain*, a different operation.

## Run it

Config comes from env:

| Env | Meaning |
|---|---|
| `CLOISTER_BASE_URL` | cloister origin, e.g. `https://cloister.example` (no trailing slash) |
| `HARNESS_SHIM_PORT` | local listen port (default `8799`) |
| `HARNESS_SHIM_CERT_B64` | base64url DER of a notme-minted lease cert |
| `HARNESS_SHIM_PRIV_SEED_B64` | base64url 32-byte Ed25519 private seed (the cert's ephemeral key) |
| `HARNESS_SHIM_PUBKEY_B64` | base64url 32-byte Ed25519 public key (matches the cert) |

```sh
export CLOISTER_BASE_URL="https://cloister.example"
export HARNESS_SHIM_CERT_B64=...        # from notme (see "Cert source" below)
export HARNESS_SHIM_PRIV_SEED_B64=...
export HARNESS_SHIM_PUBKEY_B64=...
node src/harness-shim/index.js        # after `tsc -p src/harness-shim`
```

Then point the harness at the shim (the path segment selects the cloister
`vaultProxyService`):

```sh
# Codex
export OPENAI_BASE_URL="http://127.0.0.1:8799/vault/proxy/openai"
# Claude Code
export ANTHROPIC_BASE_URL="http://127.0.0.1:8799/vault/proxy/anthropic"
```

The harness sets **no API key** — the key lives in the vault, keyed by the
service name, and is injected inside cloister.

## Cert source (v1 vs. deployable)

- **v1 (this build):** a dev cert loaded from env (`envCertSource`). Good for a
  laptop proof against a cloister with `INTERLACE_ROOT_PUBKEY` set. Mint one
  with notme against the cluster master.
- **Deployable follow-up:** a notme-minting `CertSource` that refreshes a
  short-lived cert before expiry. Same `CertSource` interface — `index.ts` does
  not change. Cert lifetime is bounded by `Gateway.policy.maxCertLifetimeSeconds`
  (300s), so the shim must re-mint; wire that when the notme mint client lands.

## Custody vs. audit (be precise)

Per ADR-0040 "Scope of the credential claim":

- **API-key providers:** the key is vaulted; the harness never holds it. Custody
  claim holds.
- **OAuth Max/Pro subscriptions:** the OAuth token is minted into the client's
  keychain by design — cloister can't hold what the client mints. That shape
  gets **audit** (receipts), not **custody**.

The shim doesn't change that boundary; it only carries the lease.

## What's proven

- `lease-signer.ts` — pure Web Crypto signer, unit-tested
  (`test/harness-shim/lease-signer.test.ts`): the signature verifies over
  the canonical bytes and binds the body.
- **The signer against the real gate** —
  `test/routes/vault-proxy-lease-gate.test.ts` drives the *un-stubbed*
  `verifyAndUpsertLease` through `VaultProxyRoute`: a shim-signed request passes
  (200, vaulted key injected upstream), a tampered signature is rejected (401),
  a bare stock-harness request is rejected (401).
- **The Node forwarder** — the request path forwards verbatim, the harness's
  bare `Authorization` is stripped, all four Signet headers are attached, and
  the SSE response streams back with `content-type` preserved (unbuffered).

## Type-checking

The shim is a Node program, outside the workers tsconfig. It type-checks under
its own `tsconfig.json` (`lib: DOM` + `node-shims.d.ts`) via `task lint:shim`,
which `task lint` runs.
