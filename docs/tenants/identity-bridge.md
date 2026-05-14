# identity-bridge

The identity bridge is cloister's **first non-MCP tenant**. It surfaces
the cluster's native Interlace identity (`actor.pubkey` + capabilities)
under the well-known paths every off-the-shelf identity client already
knows how to read — OIDC discovery, JWKS, WebFinger, Nostr NIP-05 — plus
a minimal `client_credentials` OAuth2 token endpoint.

One Route declaration covers **five concrete paths** because they all
project the same identity surface (`manifest.actor` + master pubkey at
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
| `GET /.well-known/openid-configuration` | OIDC discovery document |
| `GET /.well-known/jwks.json` | JWK Set (Ed25519 / EdDSA) — the master public key |
| `GET /.well-known/webfinger` | JRD; query `?resource=acct:cluster@host` |
| `GET /.well-known/nostr.json` | NIP-05 names + relays |
| `POST /oauth/token` | minimal `client_credentials` grant |

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
| `INTERLACE_ROOT_PUBKEY` | env var | when set, lease-gates writes (e.g. `/oauth/token`). Unset = open posture (dev/test). |
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

- The well-known **read** paths (`openid-configuration`, `jwks.json`,
  `webfinger`, `nostr.json`) are unauthenticated. They publish only
  what the manifest declares public.
- The `POST /oauth/token` write path is lease-gated when
  `INTERLACE_ROOT_PUBKEY` is set.
- Auth failures on the bridge follow the constant-time-404 convention
  used by the disclosure endpoint (threat model §9), to avoid existence
  + validity oracles.

## Cross-references

- [ADR-0007](../adr/0007-interlace-substrate.md) — Interlace identity + attestation + discovery; the bridge is the OIDC/WebFinger/Nostr face on this
- [ADR-0011](../adr/0011-hypervisor-bundle-boundary.md) — the bridge is hypervisor-tier (singleton, mediates trust)
- [ADR-0013](../adr/0013-slice-grant-enforcement.md) — `notme-bot` co-location is safe because of V8-isolate + Service-binding-as-syscall
- Tracking bead `cloister-c9922f` — implementation
- Companion: `/.well-known/interlace/index.json` (substrate, not a tenant) publishes the gateway's `actor` + `policy` + aggregated MCP capabilities; see [`src/routes/well-known-identity.ts`](../../src/routes/well-known-identity.ts)
