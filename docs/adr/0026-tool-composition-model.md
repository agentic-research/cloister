# ADR-0026 — Tool composition model (Nix-flakes-shaped, registry-resolved, content-addressed)

- **Status:** Proposed (2026-05-18)
- **Tracking bead:** `cloister-cf7a3b` (filed alongside this ADR)
- **Pairs with:**
  - ADR-0007 (Interlace identity + receipts — provides the signing layer)
  - ADR-0009 (Compute substrate portability — declares the bundle deployment model)
  - ADR-0016 (Cloister as private MCP Registry — already speaks `server.json` server-side)
  - ADR-0024 (Credential-isolation/v1 capability — first reference impl under the substrate-as-kernel framing)
  - ADR-0025 (Bidi TOML ↔ capnp pipeline — `cluster.toml` is the operator surface this ADR extends)
  - `cloister-1b59a2` (Substrate-as-kernel framing — every capability is a v1 reference impl)

## Context

Cloister composes heterogeneous upstream tools (rosary, mache, ley-line-open,
notme, third-party MCP servers like `zen`) into a single deployment. Today
that composition is **declared by hand** in `cluster.toml`:

```toml
[[bundles]]
name = "mache"
kind = "external"
binary = "mache"
ipc_socket = "/run/mache/mache.sock"

[[wires]]
to = "mache"
binding = "MACHE_MCP"
transport = "uds"

# … plus per-tool MCP backend declarations in cloister.capnp
```

Three problems with hand-coded composition:

1. **The contract lives in the wrong repo.** When mache adds a new tool or
   changes its IPC socket, the operator's `cluster.toml` + `cloister.capnp`
   need parallel edits. Cross-repo coordination is brittle — drift is
   silent (mache renames a tool; cloister still advertises the old name)
   until traffic hits the gap.

2. **No reproducibility.** "Add rosary to my cluster" today means *which*
   rosary? Whatever's at `~/remotes/art/rosary` on the operator's laptop.
   Re-running on a CI host produces different behavior. There's no
   lockfile pinning resolved versions + integrity hashes.

3. **No portability.** A `cluster.toml` referencing `binary = "../rosary/target/release/rosary"`
   only works if the operator has rosary checked out at that exact relative
   path. Two clusters using the same tools require redundant declarations.

The substrate to fix this **already exists in tree**:

- **MCP Registry endpoint** (ADR-0016) — cloister serves `server.json` per the
  MCP spec; could also CONSUME them
- **OCI Registry endpoint** (ADR-0009) — content-addressed artifact store on
  the same router
- **BlobStore + ley-line content-addressing** — per-byte integrity, hash-keyed
- **Interlace signed receipts** (ADR-0007) — actor-keyed signatures over manifests
- **Bidi TOML ↔ capnp pipeline** (ADR-0025) — declarative operator surface

The model the ecosystem has settled on is `server.json` (MCP Registry spec,
schema `2025-12-11`). It's the standardized way for an MCP server to
declare its own contract: name, version, transports, declared tools,
package install info, plus a reverse-DNS `_meta` extension point for
consumer-specific hints.

## Decision

**Cloister adopts MCP `server.json` as the canonical repo-side tool contract.
`cluster.toml` references tools by namespaced name + version range. Cloister
resolves at build time against its registry, fetches the signed `server.json`
artifact, verifies integrity + signature, composes the wiring into
`cluster.capnp` → `cloister.capnp`.**

Operator-facing surface:

```toml
# cluster.toml

[inputs]
# Each input is a tool that ships server.json at its source.
rosary = { ref = "io.github.jamestexas/rosary",       version = "^0.1" }
mache  = { ref = "io.github.jamestexas/mache",        version = "^0.3" }
llo    = { ref = "io.github.jamestexas/ley-line-open", version = "^0.2" }

[[mcp_servers]]
input = "rosary"
# optional override of any _meta.art.cloister/v1 field

[[mcp_servers]]
input = "mache"

[[mcp_servers]]
# Escape hatch: tool with no server.json published — inline manual wiring
name = "zen"
command = "uvx zen-mcp-server"
transport = "stdio"
```

```toml
# cluster.lock.toml — generated, committed
[inputs.rosary]
resolved   = "0.1.3"
sha256     = "abc123..."
signer     = "sha256:rosary-actor-fingerprint"
fetched_from = "https://registry.example.com/io.github.jamestexas/rosary/0.1.3"

[inputs.mache]
resolved   = "0.3.7"
sha256     = "def456..."
# ...
```

Cloister's `task cluster:expand` step:

1. **Resolve** — for each `[inputs.*]` entry, hit the configured registry
   (cloister-as-registry per ADR-0016 OR the official
   `registry.modelcontextprotocol.io`) and pick the highest version
   matching the range
2. **Fetch** — pull the `server.json` + manifest from the OCI artifact
   store (cloister-as-OCI per ADR-0009) keyed by the resolved version's digest
3. **Verify** — signature against the input's declared signer pubkey;
   integrity against the artifact digest
4. **Compose** — for each `[[mcp_servers]] input = ...` entry, render the
   appropriate `Backend` kind in `cloister.capnp` (mcpProxy / udsForward /
   serviceBinding) based on the `server.json` transports + the optional
   `_meta.art.cloister/v1` hints
5. **Lock** — write `cluster.lock.toml` with pinned versions, fetched-from
   URLs, content digests, signer fingerprints

`cluster.lock.toml` is committed. `task cluster:up` requires the lock to
match the current `cluster.toml` (or `cluster:expand` re-renders).

### Where the `_meta` extension lives

Each tool's `server.json` declares its standard MCP surface (top-level
fields) AND can include cloister-specific hints under reverse-DNS
namespacing:

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": "io.github.jamestexas/rosary",
  "version": "0.1.3",
  "packages": [{ "registry_type": "npm", "identifier": "@jamestexas/rosary-mcp", ... }],
  "_meta": {
    "art.cloister/v1": {
      "tier": "cluster",
      "bundle_kind": "external",
      "preferred_transport": "uds",
      "uds_socket": "/run/rosary/rosary.sock",
      "service_binding_hint": "ROSARY_MCP"
    }
  }
}
```

Other consumers (Claude Desktop, Cursor, smithery, etc.) see the standard
fields + ignore the `_meta.art.cloister/v1` block. Per the MCP spec, `_meta`
is the official extension surface using reverse-DNS namespacing.

## Rationale

### Why MCP `server.json` (not a cloister-specific format)

The ecosystem has settled on `server.json` (current schema `2025-12-11`).
Inventing `cloister.fragment.toml` or similar:

- Forces tool authors to maintain two parallel descriptors (one for
  cloister, one for Claude Desktop / Cursor / etc.)
- Doesn't fit smithery / `registry.modelcontextprotocol.io` discovery
- Asks the user to learn two formats

The `_meta` extension point is the principled answer: keep the portable
contract portable, push cloister-specific hints into a namespaced
sub-object. **One canonical descriptor per tool, multiple consumers.**

Cloister already speaks `server.json` server-side per ADR-0016. This ADR
extends to the consumer side — same format, opposite direction.

### Why Nix-flakes-shaped inputs (not Terraform modules)

The user-facing pattern of Terraform / Nix flakes / Cargo / npm is
identical in shape: **named modules + version ranges + lockfile with
hash pinning**. All four solve the same composition problem. Cloister
needs that shape — but Terraform is wrong scale (cloud-resource-oriented,
HCL, state-managed), Cargo/npm are language-specific package managers
(not deploy composition), Nix flakes is the closest fit but its full
machinery (derivations, garbage collection, evaluator) is more than
cloister needs.

What cloister adopts from Nix flakes:
- `[inputs]` block naming + version range
- `cluster.lock.toml` shape (parallel to `flake.lock`)
- Inputs can be registry refs, file paths (`path:../mache`), or git URLs
- Lockfile pins resolved + integrity hashes

What cloister doesn't adopt:
- Derivations / nix-store / GC roots — cloister's substrate is workerd
  bundles + OCI images, addressed via cloister-as-OCI-registry
- Nix evaluator — cluster.toml is the declarative surface, not Nix

### Why content-addressing + signatures (defense in depth)

Each layer of the resolution stack catches a different attacker:

| Layer | Catches |
|---|---|
| Name (`io.github.org/tool`) | Wrong tool entirely |
| Version range (`^0.1`) | Incompatible API version |
| Resolved version (`0.1.3`) | Drift between runs |
| Content digest (`sha256:...`) | Modified-in-transit artifact |
| Signature (`sha256:actor-fp`) | Compromised registry |

The signing layer reuses cloister's Interlace receipts (ADR-0007 / RECEIPTS.md
§2.1) — same Ed25519 actor identity that signs MCP responses today.
Tools publish `server.json` signed by their actor; cloister verifies on
fetch. ley-line is the content-addressing primitive that pins the digest.

### Why filesystem `from = "../rosary"` is the dev-loop escape only

Operator's prod `cluster.toml` MUST reference named inputs (portable,
reproducible). Local dev iteration needs the filesystem escape (operator
is editing rosary + cloister simultaneously); supported via
`task cluster:expand --override io.github.jamestexas/rosary=../rosary`.

The override is CLI-only — never committed to `cluster.toml` itself, never
ends up in `cluster.lock.toml`. CI rejects manifests with filesystem
inputs (defense against accidentally shipping a path-coupled cluster).

## Bootstrap & migration

**Phase 1 — Shape (this ADR + the implementation arc):**
- Cloister `cluster.toml` accepts `[inputs.*]` blocks with `ref = "..."` + `version = "..."`
- Resolver fetches by URL (https or file) only; no registry hit yet
- Lockfile generated + committed
- Signature verification deferred (Phase 3)

**Phase 2 — Registry resolution:**
- Resolver hits the configured registry (default
  `registry.modelcontextprotocol.io`; operators can point at their
  own cloister-as-registry)
- Lockfile records `fetched_from` URL

**Phase 3 — Signature verification:**
- Each tool's actor publishes its signing pubkey at
  `<actor-base>/.well-known/interlace/index.json` (already cloister's
  endpoint shape — ADR-0007)
- Resolver verifies `server.json` signature against the resolved actor's
  current epoch pubkey
- Refuses to load on signature failure

**Migration for jamestexas's own tools:**
1. Drop `server.json` at root of rosary, mache, ley-line-open, notme
2. Convert existing recipe `cluster.toml`s to use `[inputs.*]` blocks
3. Generate initial `cluster.lock.toml`
4. Existing inline `[[mcp_servers]]` entries continue to work as the
   escape hatch (no forced migration)

## Alternatives considered

- **Inline-only `cluster.toml`** (status quo). Rejected: drift surface
  every time a tool changes; no reproducibility.
- **`cloister.fragment.toml` per tool repo** (initial proposal in design
  conversation). Rejected after MCP-spec research: `server.json` already
  solves this with broader ecosystem fit.
- **Terraform / Pulumi / Bazel**. Rejected: wrong scale for the
  problem; HCL/TS/Starlark are additional substrates to learn; cloud-
  resource bias.
- **npm packages per tool fragment** (`@rosary/cloister`). Rejected:
  ties cloister composition to the JS package ecosystem; non-TS tools
  (mache=Go, rosary=Rust) would need to publish JS shims.

## Consequences

**Positive:**
- Operators declare cluster topology by name, not by filesystem path
- Tools own their own contract (`server.json` in tool's repo)
- Reproducible — lockfile pins everything
- Defense-in-depth via signatures + content-addressing
- Fits MCP ecosystem (Claude Desktop, Cursor, smithery can all read the
  same `server.json`)
- Cloister-as-registry (ADR-0016) becomes load-bearing for operator
  workflows (positive: validates the existing architecture)

**Negative:**
- New surface area: resolver, lockfile, signature verification
- Bootstrap problem: registry needs to be running somewhere to resolve
  refs (mitigated: filesystem + https fallbacks in Phase 1)
- Tool authors must publish `server.json` to benefit from this — manual
  config inline still works (escape hatch)

## Coordinated with

- `cloister-1b59a2` — substrate-as-kernel framing; this is the first
  composition mechanism under that framing
- `cloister-8f57f0` — credential-isolation/v1; vault-proxy services
  could eventually be declared via `server.json` `_meta.art.cloister/v1`
  too (separate bead — out of scope for this ADR)
- `cloister-339a22` — agent-process/v1 design proposal; analogous
  composition shape for agent processes (out of scope here)

## Status

Proposed. Implementation tracked by the new bead filed alongside this
ADR. Phases land as separate PRs; Phase 1 (input resolution, no
registry, no signatures) is the smallest fire-shaped first step.
