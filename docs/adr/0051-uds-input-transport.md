---
title: "ADR-0051: Same-host UDS as an input transport — structured connection components, not connection strings"
status: Accepted (2026-07-28)
date: 2026-07-20
tags: [inputs, transport, uds, companion, connection, credentials, vault, schema-evolution]
threat_model: docs/security/threat-model.md
relates_to:
  - 0004-capnp-manifest.md
  - 0005-internal-wire-leyline-net.md
  - 0010-vault-and-bundle-clusters.md
  - 0019-sign-only-helper-protocol.md
  - 0025-bidi-toml-pipeline.md
  - 0026-tool-composition-model.md
  - 0027-substrate-as-kernel-capability-matchmaker.md
  - 0035-cloister-llo-boundary.md
---

# ADR-0051: Same-host UDS as an input transport

Tracking bead: `cloister-797f0a`.

## Context

cloister supports Unix Domain Sockets at the **backend** layer but not at
the **input** layer. The asymmetry is concrete:

- `udsForward` is a backend kind (`src/manifest/types.ts:297`). workerd/V8
  cannot dial `AF_UNIX`, so cloister POSTs a capnp `ToolCall` over loopback
  HTTP to **cloister-companion** with `X-Cloister-Transport: uds` +
  `X-Cloister-Socket-Path`, and companion — a Rust process with kernel
  access — performs the `connect(AF_UNIX, socketPath)`
  (`src/manifest/backends/uds-forward.ts:4-24`). This works today.
- An `InputSpec` (`manifest/cluster.capnp:374`, mirrored at
  `src/manifest/cluster-types.ts:83`) resolves **only** to an `mcpProxy`
  (HTTP) backend, via `urlBinding` / `serviceBinding`
  (`manifest/cluster.capnp:455-456`).

So a same-host MCP server that already speaks MCP over a UDS cannot be
declared as a consumable input. Today the operator must either promote it
to a hand-declared cluster bundle, or make it listen on a loopback TCP
port so the existing `mcpProxy` input path applies.

**Scope boundary.** This ADR covers **same-host** only. A Unix socket is a
filesystem object requiring a shared kernel and filesystem; it cannot span
hosts or IPs. Cross-host peers use `streamable-http` over CF Tunnel / WARP
per [`docs/deployment/off-platform-peers.md`](../deployment/off-platform-peers.md)
and ADR-0007. Nothing here changes that.

## The trust question, and why it dissolves

The initial framing assumed a same-host UDS input would need a *weaker*
trust treatment than a network input (trusted-by-colocation), and that
this would create a dev↔prod divergence — the same class of problem that
caused `INTERLACE_DEV_BYPASS` to be removed.

Reading the code shows the premise does not hold:

- **No outbound backend presents a lease or attestation.** `verifyAndUpsertLease`
  (`src/routes/lease-middleware.ts`) is exclusively **inbound** — it
  authenticates *callers* at the MCP edge. Grepping `lease|attest` across
  `src/manifest/backends/*.ts` returns nothing.
- **The cloister→companion hop is plain capnp for every transport.** Even
  the network-bound backend states this explicitly: *"cloister↔companion
  IPC over loopback HTTP, NOT full leyline-net wire … No Manifest
  envelope, no AEAD, no signing — those guarantees live at"* the companion
  hop (`src/manifest/backends/leyline-net.ts:2-8`).
- **cloister holds no signing key by design.** `src/wire/README.md` on
  `signet-verify.ts`: *"Verification only — no signing in cloister, no key
  custody."* ADR-0019's sign-only trust-anchor-helper exists precisely to
  keep signing out of cloister.

Therefore a UDS input and a network input take an **identical cloister-side
code path**. Adding UDS as an input transport introduces **no new trust
surface and no dev↔prod divergence**, because there is no outbound trust
step that a local transport could skip. Transport differentiation happens
downstream, inside companion, exactly as it already does for UDS *bundles*.

**Corollary (explicitly out of scope).** "Attest outbound calls" would mean
*inventing* outbound attestation, which exists for no backend today, would
apply equally to network backends, and would require giving cloister a
signing key — contradicting ADR-0019 and the no-key-custody stance. That is
a **signing-locus** question, not a wire-format one, and it is orthogonal
to this ADR. The wire format itself already exists (the 176-byte
leyline-net `Manifest` envelope, `src/wire/manifest.ts`, pinned in
`interlace-spec/0.1.0/`, reference encoders in LLO `rs/ll-open/sign/` per
ADR-0035). No new protocol is needed in cloister or in LLO.

### What actually protects a same-host UDS peer

Filesystem permissions on the socket path (convention `/run/cloister-uds/`),
companion mediation (companion is the only component that can dial
`AF_UNIX`), and the input's `digest` pin (`manifest/cluster.capnp:393`).
Signing a loopback hop would not mitigate socket-squatting: an attacker who
can bind the path is also the party you would be signing *to*. This
preserves the existing reasoning that intra-pod AEAD is *"ceremony, not
security"* (`src/manifest/backends/uds-forward.ts:28-34`).

## Decision

**1. Model a connection as structured, independently-governed components —
never a connection string.**

A connection is `transport` + endpoint + an *optional* credential that is
**always a vault slice, never inline** (ADR-0010: vault slices are the
credential substrate; no env-var/inline credential bindings). A
`postgres://user:pass@host:5432/db` blob is rejected as a design shape
because it fuses transport, endpoint, credential, and options into one
opaque, ungovernable string.

**2. Add UDS as the first non-network `transport` variant on `InputSpec`.**

Expressed as a nested `connection` struct appended at the next free
ordinal, per the append-only / monotonically-increasing / never-renumber
rules of ADR-0004. An unset `connection` preserves today's behavior
exactly (resolve to `mcpProxy` via `urlBinding` / `serviceBinding`), so the
change is fully backward-compatible.

```toml
[inputs.rosary]
ref     = "github://agentic-research/rosary/server.json@73f41c5…"
version = "0.7.0"

  [inputs.rosary.connection]
  transport  = "uds"
  socketPath = "/run/cloister-uds/rosary.sock"
  # no vaultSlice — a same-host MCP needs no credential
```

The transport union mirrors the existing wire-transport idiom already in
the schema (`manifest/cluster.capnp:333`).

**3. Resolution: a UDS input emits a `udsForward` generated backend.**

Where an input with no `connection` (or a network transport) emits an
`mcpProxy` row into `cluster.lock.toml`'s `[[generated_backends]]`, an
input with `transport = "uds"` emits a `udsForward` row carrying
`socketPath`. All downstream machinery — companion dial, capnp
`ToolCall`/`ToolResult` codec — is reused unchanged.

**4. No signing, attestation, or lease work is in scope.** See the
corollary above.

## Why this shape (alternatives considered)

- **A flat `socketPath` scalar with transport inferred.** Rejected: it
  encodes one transport structurally and gives the future data-backend case
  nowhere to put host/port or a credential without another schema change.
- **A bare `transport` union with no enclosing struct.** Rejected: the
  credential has no natural home, inviting exactly the connection-string
  fusion this ADR forbids.
- **A nested `connection` struct (chosen).** Transport, endpoint, and
  credential are separate first-class fields. A future data-backend input
  adds a transport variant and a `vaultSlice` with **no schema break** and
  no connection string:

  ```toml
    [inputs.metrics-db.connection]
    transport  = "tcp"
    host       = "db.internal"
    port       = 5432
    vaultSlice = "vault/metrics-db/v1"    # never an inline password
  ```

- **Do nothing; require a loopback TCP port.** Rejected, but it is the
  honest baseline. The win is not throughput — it is that a same-host MCP
  needs **no listening TCP port at all**, so its exposure is scoped by
  filesystem permissions rather than by a port reachable to anything that
  can reach loopback. That is a real attack-surface reduction, and the
  implementation cost is small because the companion dial already exists.

## Consequences

- `InputSpec` gains one appended `connection` field; existing manifests
  parse unchanged (ADR-0004 evolution rules hold).
- The input resolver gains one branch (emit `udsForward` vs `mcpProxy`).
- Same-host MCP servers can drop their TCP listener entirely.
- The "structured components, not connection strings" tenet is now recorded
  and enforceable at the schema level for every future resource type.
- Cross-host inputs are unaffected and still use `streamable-http`.
- Deferred, tracked separately: outbound attestation (a signing-locus
  question), and the data-backend transport variant (no consumer yet).
