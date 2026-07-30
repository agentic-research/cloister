# notme-proxy (cloister-companion)

**Not a tenant on the public face.** Every other page in this directory
describes a surface a caller can reach. `notme-proxy` is the opposite: it is
the bundle every *outbound* call leaves through, and nothing outside the
cluster addresses it. It has a page here because `lint:tenant-docs` keys on
services in [`cluster.compose.yaml`](../../cluster.compose.yaml), and a
hypervisor-tier bundle that mediates all egress is worth a page regardless of
which direction it faces.

It fills two roles, both stated in the bundle's `hypervisorRationale` in
[`cluster.toml`](../../cluster.toml):

1. **UDS bridge for workerd.** Workerd cannot dial a Unix socket. Requests
   carrying `X-Cloister-Transport: uds` are handed to this bundle, which does
   the dial. This is how `ROSARY_BUNDLE` reaches
   `/run/cloister-uds/rosary.sock` (ADR-0051).
2. **mTLS forward proxy holding the bridge cert.** It holds the bridge
   certificate and its private key in process memory and presents them on
   outbound TLS, so **no Worker ever holds a credential** — the two-plane
   model from notme/proxy. Per ADR-0047, bundle identity is the vault's unit;
   the credential lives with the mediator, not the workload.

## Declaration

```toml
[[bundles]]
kind = "external"
name = "notme-proxy"
tier = "hypervisor"

  [bundles.external]
  ipcSocket = "/run/cloister-uds/companion.sock"
```

One wire reaches it, and it is the only one:

```toml
[[wires]]
binding = "COMPANION"
from = "cloister-router"
to = "notme-proxy"
transport = "uds"
```

Per the ADR-0005 amendment, cloister ↔ companion is **plain capnp IPC with no
AEAD** — both ends are inside the trust boundary, so the wire encryption that
protects companion ↔ backend would be protecting a hop that never leaves the
host. `src/wire/codec.ts` is the cloister-side codec.

## Why hypervisor tier

The three-criterion test (ADR-0011) is satisfied on all three counts, and the
`hypervisorRationale` field records it because Inv 3 of
`lint:bundle-isolation` refuses a hypervisor bundle that does not:

| Criterion | Why it holds |
|---|---|
| Mediates trust | Holds the bridge cert + key and presents them on outbound TLS |
| Blast radius | Its compromise reaches **every upstream the cluster can reach** |
| Singleton | One socket, one cert, one per host |

## Operational notes

- **Singleton, deliberately.** Pool-based load balancing across companions is
  a separate primitive and is deferred to ADR-0008; Interlace itself is
  per-relationship, not pool-aware.
- **No image is declared** for this bundle and none is derived: it is built
  locally and no linked input publishes an OCI package for it. Inv 10
  (ADR-0038) is warn-level precisely so a locally-built bundle is not forced
  to invent a registry reference. Publishing it per ADR-0041 would let the
  image become digest-pinned the way `mache` and `rosary` already are.
- Tracked in beads `cloister-46fc1a` and `cloister-4cdba5`.

## What lives elsewhere

- The bridge-cert format, its single-use/ephemeral properties, and the
  `token capabilities ⊆ bridge cert capabilities` rule are signet's, in
  `docs/design/004-bridge-certs.md`.
- The GitHub-OIDC → bridge-cert exchange is notme's, in `action/action.yml`.
- The attested-egress trust surface is
  [`docs/security/threat-model.md`](../security/threat-model.md).
