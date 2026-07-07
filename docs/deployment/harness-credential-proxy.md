# Running a harness against cloister (credential proxy + bundled tooling)

How an agent harness — **Claude Code**, **Codex** — runs so that its LLM
credential is held in cloister's vault (never in the harness's
environment) and its tools arrive over the same cloister endpoint. Decided
in [ADR-0040](../adr/0040-harness-in-cloister.md) (the control + credential
+ audit plane) on top of the vault proxy of
[ADR-0013](../adr/0013-slice-grant-enforcement.md) /
[ADR-0024](../adr/0024-credential-isolation-capability.md). This doc is the
operational shape.

## TL;DR

- **Two things move into cloister, one thing stays out.** The LLM
  **credential** (into the vault) and the **audit record** (a receipt per
  call) move in; the **agent process + harness CLI** stay host-side —
  workerd can't contain compute, and cloister doesn't pretend to
  (ADR-0040 "Boundary").
- **Credentials** — the harness points its API base at cloister; the
  vaulted key is injected inside the `CredentialVault` DO and never
  crosses back. Two services ship today:

  | Harness | Base-URL env | cloister route | Injection |
  |---|---|---|---|
  | Claude Code | `ANTHROPIC_BASE_URL` | `/vault/proxy/anthropic` | `x-api-key: <key>` |
  | Codex | `OPENAI_BASE_URL` | `/vault/proxy/openai` | `Authorization: Bearer <key>` |

- **Tooling** — the harness's MCP tools (`rsry_*`, `bead_*`, mache
  `lsp_*`, …) arrive over the same cloister host at `/mcp`, from the
  rosary / mache / llo backends already declared in `cluster.toml`. One
  endpoint, credentials + tools together.
- **Adding a provider is a manifest entry, not code.** The five injection
  strategies in `src/routes/vault-proxy.ts` are exhaustiveness-checked;
  Gemini or a Bedrock/Vertex edge is another `[[gateway.vaultProxyServices]]`
  row.

## Credential wiring

The harness needs two things: its base URL pointed at cloister, and a
lease on the request (the `/vault/proxy` route is lease-gated — see the
caveat below).

```sh
# Claude Code
export ANTHROPIC_BASE_URL="https://<cloister-host>/vault/proxy/anthropic"

# Codex
export OPENAI_BASE_URL="https://<cloister-host>/vault/proxy/openai"
```

The API key itself is **not** an env var on the harness — it is stored in
the vault (`cloister/credential-isolation/v1`, keyed by the service name).
On each call cloister decrypts inside the DO, injects it into the upstream
request per the table above, streams the response back (SSE, un-buffered —
`content-type: text/event-stream` passes the response allowlist and
`new Response(upstream.body)` does not buffer), and writes a receipt
(model, token counts, timestamp, caller lease).

## The lease adapter (why a bare base-URL isn't enough — and what closes it)

`/vault/proxy/<name>` is **lease-gated** and **safe-closed**: an empty
`defaultAllowedSubs` denies all callers until an operator opts a peer
fingerprint in, and every request must carry an Interlace lease header
(`Authorization: Signet <cert>` + `X-Signet-Sig` + `X-Signet-Ts` +
`X-Signet-Nonce`), verified by `verifyAndUpsertLease` — a real Ed25519
signature check over the canonical request bytes, not a bearer compare.
Stock Claude Code / Codex set a base URL but **do not mint Interlace
leases themselves**, so their bare requests bounce `401`. A deployable
setup therefore needs one of the three shapes in ADR-0040's
"Implementation note":

1. a **lease-aware local shim** in front of the harness that signs each
   outbound call — **shipped**: [`tools/harness-shim/`](../../tools/harness-shim/README.md)
   (`cloister-caab2d`). The harness points its base URL at the shim; the
   shim attaches the lease and forwards to cloister;
2. an **mTLS edge** that terminates the harness's channel identity and
   mints/attaches the lease on its behalf (shared/hosted deployments); or
3. an **enterprise gateway** that already terminates that identity.

The proxy is not a bare bearer relay (a leaked bearer is just a bearer);
the shim holds the signing key so the harness process never does. The
signer↔gate contract is proven end-to-end in
`test/routes/vault-proxy-lease-gate.test.ts` (shim-signed → `200` +
vaulted key injected; tampered sig → `401`; bare request → `401`).

## What the claim is (and isn't)

Per ADR-0040 "Scope of the credential claim":

- **API-key / enterprise-gateway shapes:** the key is vaulted; the harness
  holds only a cloister token. Custody claim holds.
- **Max / Pro OAuth subscription:** the OAuth token lives in the client's
  keychain by design — cloister cannot hold what the client mints. That
  shape gets **audit** (receipts), not **custody**.

The receipt claim ("everything's on the record") holds for every shape;
the custody claim ("tools never see the key") holds only where cloister
issues or holds the credential.

## See also

- [ADR-0040](../adr/0040-harness-in-cloister.md) — the three-layer model
  (L0 orchestration mediation, L1 credential proxy, host-side boundary).
- [`docs/reference/backend-kinds.md`](../reference/backend-kinds.md) — how
  the `/mcp` tooling backends are declared.
- [ADR-0039](../adr/0039-local-do-sqlite-security.md) — securing the
  vaulted key at rest for a local deployment.
