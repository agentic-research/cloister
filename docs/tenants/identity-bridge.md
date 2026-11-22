# identity-bridge

The identity bridge is cloister's **first non-MCP tenant**. It surfaces
the cluster's native Interlace identity (`actor.fingerprint` + the master
pubkey) under two well-known paths that off-the-shelf clients already know
how to read: WebFinger and Nostr NIP-05.

**Cloister issues no tokens** ([ADR-0086](../adr/0086-cloister-issues-no-tokens.md)).
The bridge used to serve a `client_credentials` token endpoint, with the
OIDC discovery and JWKS documents that described it. notme is the token
authority: a client gets a token from notme's `POST /token`.

One Route declaration covers **both paths** because they project the same
identity surface (`manifest.actor` + master pubkey at
`env[actor.pubkeyBinding]`). The handler in
[`src/routes/well-known-identity.ts`](../../src/routes/well-known-identity.ts)
inspects the URL pathname and dispatches internally.

Tracked in bead `cloister-c9922f`.

## Wire (current as of 2026-05-12; see [`cloister.capnp`](../../cloister.capnp) for source of truth)

```capnp
( path = "/.well-known/identity-bridge",
  kind = (wellKnownIdentityBridge = void) ),
```

The `path` is a **sentinel** — the actual served paths are:

| Path | What it serves |
|---|---|
| `GET /.well-known/webfinger` | JRD; query `?resource=acct:cluster@host` |
| `GET /.well-known/nostr.json` | NIP-05 names + relays |

The upstream identity authority that **mints** the master key
(`SigningAuthority` DO) is `notme-bot` — reachable through the
`/identity/*` `serviceBindingProxy` route, which is a substrate seam,
not a tenant. The bridge is read-only over that material.

## Required bindings

Identity material is sourced from the gateway's `actor` block in the
manifest, not from worker bindings directly:

| Binding | Where declared | Purpose |
|---|---|---|
| `INTERLACE_MASTER_PUBKEY` | env var, referenced by `actor.pubkeyBinding` in [`cloister.capnp`](../../cloister.capnp) | master public key bytes (SPKI / raw). Empty disables Interlace discovery entirely (per ADR-0007). |
| `NOTME` | `service = "notme-bot"` in [`config.capnp`](../../config.capnp) | the upstream Signet master CA that **mints** the material the bridge **publishes**. Reachable via `/identity/*`. |

The bridge does NOT read a vault slice — public-key material is
manifest-declared (`actor.pubkeyBinding`), not vault-managed.

## Version pin

Not applicable — the bridge is in-process inside cloister-router and
ships with the cloister image (currently `cloister:0.1.0` per
[`cluster.compose.yaml`](../../cluster.compose.yaml)). The
`notme-identity` upstream is pinned at `notme:0.1.0`.

## Upstream project

In-tree handler:
[`src/routes/well-known-identity.ts`](../../src/routes/well-known-identity.ts).
Identity material originates in `notme-bot` (cluster bundle
`notme-identity`).

## Auth

- Both paths are unauthenticated reads. They publish only what the
  manifest declares public: the actor's fingerprint and public key.
- The bridge has no write path. Tokens come from notme's `POST /token`,
  which authenticates its caller (ADR-0086).

## Cross-references

- [ADR-0007](../adr/0007-interlace-substrate.md) — Interlace identity + attestation + discovery; the bridge is the WebFinger/Nostr face on this
- [ADR-0086](../adr/0086-cloister-issues-no-tokens.md) — cloister issues no tokens; notme's `POST /token` does
- [ADR-0011](../adr/0011-hypervisor-bundle-boundary.md) — the bridge is hypervisor-tier (singleton, mediates trust)
- [ADR-0013](../adr/0013-slice-grant-enforcement.md) — `notme-bot` co-location is safe because of V8-isolate + Service-binding-as-syscall
- Tracking bead `cloister-c9922f` — implementation
- Companion: `/.well-known/interlace/index.json` (substrate, not a tenant) publishes the gateway's `actor` + `policy` + aggregated MCP capabilities; see [`src/routes/well-known-identity.ts`](../../src/routes/well-known-identity.ts)
