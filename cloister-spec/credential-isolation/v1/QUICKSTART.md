# `cloister/credential-isolation/v1` — QUICKSTART

A one-page consumer walkthrough for operators wiring the capability into
a real cloister cluster. The full specification + invariants live in
[`README.md`](README.md); this doc skips ahead to "make it work."

## Prerequisites

- A running cloister (v0.1.x or later) with the `vaultProxy` route kind
  available — verify with `task --list-all | grep manifest`. Live since
  PRs #36-#42 (2026-05-18).
- Interlace identity wired up: `INTERLACE_ROOT_PUBKEY` is set and at
  least one peer fingerprint you'll authorize.
- `env.VAULT_STORE` binding present (Cloudflare Workers binding **or**
  workerd-local Durable Object) — see [`wrangler.toml`](../../../wrangler.toml)
  for the canonical shape.

## Five-minute wiring

### 1. Declare the service in `cloister.capnp`

Add an entry to the gateway's `vaultProxyServices` list. Each entry is
the service config the route consumes: upstream base URL, injection
strategy, default `allowedSubs` glob list, per-(peerFp, service) rate
limit.

```capnp
# cloister.capnp (gateway-level field)
vaultProxyServices = [
  (
    name              = "openai",
    upstreamBaseUrl   = "https://api.openai.com",
    injection         = (authorizationBearer = void),  # → Authorization: Bearer <cred>
    defaultAllowedSubs = ["bundle:rosary:*"],          # which peers may use this credential
    rateLimitPerMinute = 60,
  ),
]
```

Then run:

```sh
task manifest          # regenerate src/generated/manifest.ts
```

Five injection strategies are supported — see
[`wire/injection-strategies.md`](wire/injection-strategies.md) for the
discriminated-union shape. Pick the one the upstream API expects.

### 2. Mount the route

In the same `cloister.capnp`, add a route entry with `kind: vaultProxy`:

```capnp
routes = [
  (path = "/vault/proxy/", kind = (vaultProxy = void)),
  # … your other routes …
]
```

The route handles `/vault/proxy/<service-name>/<upstream-path>` —
anything matching that pattern. Path parsing is in
`src/routes/vault-proxy.ts:parseVaultProxyPath`.

### 3. Put a credential into the vault DO

Outside cloister, in a deploy-time script or a one-off `wrangler` admin
shell, populate the credential. The DO method is
`putCredential(subjectFp, service, cred)`:

```ts
// scripts/seed-openai-credential.ts (operator one-shot)
const stub = env.VAULT_STORE.get(env.VAULT_STORE.idFromName("router"));
await stub.putCredential(
  /* subjectFp  */ "1111…peerFp-32-byte-hex",
  /* service    */ "openai",
  /* cred       */ {
    upstream:    "https://api.openai.com",
    headers:     { "Authorization": "Bearer sk-real-key" },
    allowedSubs: ["1111…peerFp-32-byte-hex"],  // narrowest: just this peer
  },
);
```

**Why `idFromName("router")`** — the route uses `bundleIdName: "router"`
by default per [ADR-0021](../../../docs/adr/0021-per-bundle-vault-instances.md).
Each in-cluster bundle that calls vault gets its own DO instance via
`idFromName(<bundleName>)`. Seeding must match the bundle that will
later read.

### 4. Issue an authenticated request

The caller presents an Interlace lease for the same `subjectFp` that
holds the credential:

```sh
curl -X POST 'http://localhost:8787/vault/proxy/openai/v1/chat/completions' \
  -H "X-Interlace-Cert: $(cat lease.cert)" \
  -H "X-Interlace-Sig: $(cat lease.sig)" \
  -H "Content-Type: application/json" \
  --data '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```

The lease's `peerFp` must match the credential's `subjectFp` AND match
one of the credential's `allowedSubs` globs. Cloister:

1. Verifies the lease via the standard middleware
2. Auto-selects `VaultDoCredentialStore` (because `env.VAULT_STORE` is
   bound) — see [`src/routes/vault-do-credential-store.ts`](../../../src/routes/vault-do-credential-store.ts)
3. Delegates the entire Request to vault DO's `proxyRequest`
4. Vault DO decrypts, injects the credential header, fetches upstream
5. Returns the upstream's response — **plaintext credential bytes never
   leave the DO**

That's the load-bearing property: plaintext stays inside the trust
boundary at every step. The route handler doesn't see the credential.
Audit observers don't see it. Logs don't see it.

### 5. (Optional) Verify the audit receipt

Every proxy call commits to a `peer_receipts` row signed by the master
key. To verify offline:

```sh
curl 'http://localhost:8787/interlace/peers/<peerFp>' > chain.jsonl
# Pipe through an Interlace verifier (interlace-spec/0.1.0/verifier-impl/)
```

See [`wire/receipt-commitment.md`](wire/receipt-commitment.md) for the
field shape; the receipts NEVER include the credential value (pinned
by the no-leak Phase 5 tests in `test/routes/vault-proxy.test.ts`).

## Common failure modes

| Symptom | Likely cause |
|---|---|
| `404 {error:"not_found", service:"<svc>"}` | Vault DO has no row for `(subjectFp, service)`. Re-run step 3. |
| `404 {error:"unauthorized", reason:"..."}` | Service not declared in `vaultProxyServices`. Step 1 missed. |
| `403` | `peerFp` not in `allowedSubs` glob list. Tighten the credential's allowedSubs OR fix the caller's identity. |
| `429` with `retry-after` | Per-(peerFp, service) rate budget exhausted. Tune `rateLimitPerMinute` in the service config. |
| Route falls back to `InMemoryCredentialStore` | `env.VAULT_STORE` binding missing. Check wrangler.toml + config.capnp. |

The 404 shape distinction is intentional: vault DO's `{error:"not_found", service:"<svc>"}` vs the route's `{error:"unauthorized", reason:"..."}` are wire-distinct so operators can debug, but a caller without credential metadata sees one of two byte-equal 404 shapes for every "you don't have access" outcome. Preserves the §9.4.b enumeration-oracle closure from [`cloister-aa9376`](https://github.com/agentic-research/cloister/pull/21).

## Two-bundle (notme + router) setup

When `notme` ships as a workerd-bundle tenant ([cloister-db99cd](https://github.com/agentic-research/cloister) — ADR-0018 phase),
each bundle binds its own VaultDoCredentialStore:

```ts
// notme bundle composition
new VaultProxyRoute({
  // (other deps unchanged)
});
// → auto-selects VaultDoCredentialStore({ env, bundleIdName: "notme" })
```

Distinct `bundleIdName` → distinct DO instance → independent SQLite
storage. Bundle A cannot read bundle B's credentials, even with a
shared `env.VAULT_STORE` binding. ADR-0021's per-bundle isolation.

## Conformance

If you're implementing this capability in a different language /
substrate:

- Pass the test vectors in `vectors/` (when shipped — see
  [cloister-954f21](#)) on the same inputs
- Match the wire envelope shape in `wire/proxy-envelope.md`
- Match the receipt commitment shape in `wire/receipt-commitment.md`
- Match the byte-equal 404 collapses in
  `wire/error-responses.md`

Then you're conformant.

## Where to read next

- **Full spec:** [`README.md`](README.md) — invariants + non-goals + dependencies
- **Wire shapes:** [`wire/`](wire/) — injection strategies, proxy envelope, receipt commitment, error responses
- **ADR:** [`docs/adr/0024-credential-isolation-capability.md`](../../../docs/adr/0024-credential-isolation-capability.md) — why this capability shape
- **Slice-grant enforcement:** [`docs/adr/0013-slice-grant-enforcement.md`](../../../docs/adr/0013-slice-grant-enforcement.md) — the V8 isolate + service-binding seam
- **Per-bundle DO:** [`docs/adr/0021-per-bundle-vault-instances.md`](../../../docs/adr/0021-per-bundle-vault-instances.md) — `bundleIdName` parameter rationale
