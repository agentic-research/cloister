---
title: "ADR-0005: Internal wire = leyline-net (signed capnp); MCP/JSON-RPC only at the public face"
status: Accepted
date: 2026-04-29
tags: [architecture, protocol, capnp, leyline, capability, sidecar, transport]
supersedes_framing: [ADR-0002 §"backend wire = HTTP only"]
---

## Context

Until now cloister has spoken **the same wire format on both faces**: MCP
JSON-RPC over HTTP/SSE for incoming Claude Code traffic *and* for outgoing
calls to backends like ley-line-open and (attempted) rosary. That is a
structural mistake — MCP/JSON-RPC is mandatory only at the **public face**
where the client lives, because that is what Claude Code and curl speak.
Internally, only the **I/O contract** has to be preserved — tool name + args
in, content + isError out. The wire underneath that contract is a free
choice and we picked badly.

The cost arrived during cloister-824849 (rosary passthrough). Rosary's MCP
HTTP transport is *stateful*:

1. Requires `Accept: application/json, text/event-stream` (cheap fix)
2. Requires an `initialize` round-trip to mint a session-id, then
   `Mcp-Session-Id` on every subsequent call (real protocol stack)
3. Surfaces SSE responses for some methods, plain JSON for others

Implementing all of that inside cloister means importing the MCP transport
spec into a place that doesn't need to care about it. Worse, it means
*every* backend has to play the MCP-over-HTTP game even when the backend
and cloister are sitting on the same host with a UDS socket between them.

There is a better wire already in the constellation. The closed
**`ley-line/rs/crates/net/`** ("leyline-net") provides:

- **Cap'n Proto** (capnp 0.20) for serialization — same schema language as
  cloister.capnp (manifest) and config.capnp (runtime), so the toolchain is
  shared.
- **Signed manifests** (`sequence | publicKey | signature | contentHash`,
  Ed25519) — every message authenticates itself. No init dance, no
  per-session secrets, no replay risk inside the sequence window.
- **AEAD-encrypted streams** (ChaCha20-Poly1305 + X25519 key exchange).
- **Content-addressed payloads** (SHA-256 in the manifest — same digest
  shape as ADR-0003's `Digest` type, and ADR-0003-falsifiability's typed-CID
  work).
- **Sender / receiver / handshake / wire / sheaf** modules — capability-shaped
  primitives matching workerd's service-binding model and ADR-0002's
  capability boundary.

Two pieces of leyline-net stay **closed**:

- The **raptorq FEC** layer (proprietary differentiator — enables sqlite-blast
  replication, which is licensable separately).
- The **sqlite-blast** layer above it.

Cloister does not need either: cloister↔companion runs over UDS (reliable,
no FEC needed), and cross-host cloister deployments use TCP at the apko
image's external port (where standard TLS-shaped reliability suffices).
We adopt the **open subset** of leyline-net — signed-capnp manifests,
AEAD streams, handshake, sender/receiver — and leave raptorq out.

### Where the open subset actually lives (ll vs ll-open)

The open subset is **extracted into `ley-line-open`** as a published Rust
crate (working name `leyline-wire`). The closed pieces stay in `ley-line`
proper, depending on `leyline-wire`. License-continuity reasons:

- cloister-companion ships AGPL alongside cloister. It depends on the
  *open* crate, never on `ley-line` proper.
- The ADR for the substrate is a public spec; specs go in the OSS repo
  where every downstream consumer can reference them.
- raptorq + sqlite-blast remain in `ley-line` as licensable differentiators.

Concretely:

| Open subset (target: `ley-line-open/rs/crates/leyline-wire/`) | Closed (stays in `ley-line/`)               |
| ------------------------------------------------------------- | ------------------------------------------- |
| `manifest.rs`, `wire.rs`, `handshake.rs`                      | `fec.rs` (raptorq) + raptorq-aware bits     |
| `bitmap.rs`, `sheaf.rs`                                       | sqlite-blast layer                          |
| `sender.rs` / `receiver.rs` / `server.rs` (open-shaped parts) | raptorq-aware sender/receiver subclasses    |

The extraction itself is tracked as ley-line-3278b4 (the substrate ADR
implementation bead in ll's `.beads/`); its target tree is `ley-line-open/rs/`.

The remaining structural problem: workerd's outbound is HTTP-only. It
cannot dial UDS, cannot speak capnp-RPC, cannot load eBPF. Solving the
"v8 isolate cannot do syscalls" gap is what `notme-proxy` already does
for notme, and what every "v8 + Rust I/O sidecar" architecture looks like
(Deno, Bun, the Cloudflare Workers runtime itself). We give that pattern
a name and a place: **cloister-companion**, a Rust binary that ships in
the apko image and bridges HTTP↔leyline-net.

## Decision

Adopt a **three-layer wire**:

```
                 ┌──────────── public face (MCP-shaped) ─────────────┐
[CC client]  ──MCP / JSON-RPC over HTTP/SSE──▶  cloister  (workerd)
                                                  │
                 ├──────────── internal seam (capability-shaped) ────┤
                                                  │
                                                  ▼  HTTP carrying leyline-net frames
                                              cloister-companion (Rust binary)
                                                  │
                 ├──────────── backend wire (transport-shaped) ──────┤
                                                  │
                                                  ▼  UDS / cosocket / TCP / capnp-RPC
                                              backend (rsry / mache / notme / ll-open / …)
                 └───────────────────────────────────────────────────┘
```

### What each layer owns

**Public face — MCP/JSON-RPC over HTTP/SSE.** Unchanged. This is the
contract Claude Code and the rest of the MCP ecosystem speak; we don't
get to renegotiate it.

**Internal seam (cloister ↔ cloister-companion) — leyline-net frames
inside HTTP.** Workerd's outbound is HTTP-only, so the bytes travel over
HTTP, but the *body* is the leyline-net frame format — signed capnp
manifest + AEAD-encrypted capnp payload. Cloister-companion runs on the
same host (apko image, supervised process); the HTTP "hop" is loopback.
Once cloister-companion holds the bytes, it speaks the real wire to the
backend.

**Backend wire — companion's choice, per backend.** UDS for backends on
the same host. Capnp-RPC for backends that expose it. Plain HTTP for
backends that haven't been migrated yet. The cloister↔companion seam
doesn't care; companion announces what it speaks per upstream.

### What we adopt from leyline-net (open subset)

- `Manifest` struct (sequence, publicKey, signature, contentHash)
- `ToolCall` / `ToolResult` capnp structs (defined here, not in leyline-net,
  because they are MCP-semantic; manifest is leyline-net's contribution)
- AEAD wrap: ChaCha20-Poly1305 with X25519 key exchange
- Handshake / sender / receiver modules — used as-is
- Sheaf module — adopted as it matures (orthogonal; not blocking)

### What we explicitly do NOT adopt (keep closed)

- **raptorq FEC** layer. UDS is reliable; cross-host TCP+TLS is reliable
  enough; cloister has no use case that needs fountain codes. raptorq stays
  in `ley-line` proprietary, licensable separately for the sqlite-blast use
  case.
- **sqlite-blast.** Distinct product, distinct distribution.

### Distribution model

cloister ships in two distinct artifacts:

1. **cloister apko image** — workerd + worker bundle + `cloister.capnp`
   manifest, as today. AGPL-3.0 source, distroless container.
2. **cloister-companion** — Rust binary, AGPL-3.0 source. Built by a
   sibling melange recipe (`melange-companion.yaml`); embedded into the
   same apko image as cloister or shipped as a separate sidecar image
   (deployment choice). Links the open-subset leyline-net crates only.

Shipping a binary whose source is closed-source-licensed is fine when the
distribution license permits it (AGPL-3.0 here permits binary distribution
to anyone; the AGPL network-effect copyleft applies only to *modifications*
served over a network, and applies regardless of which side of the binary
you're on). The closed-source raptorq path stays out of cloister-companion's
public build entirely.

### Migration shape

- **Phase 0 (this ADR)** — architectural commitment.
- **Phase 1** — define the open leyline-net wire schema as a capnp file
  shared between cloister and cloister-companion (`wire/cloister.capnp`).
  This stays small (~50 lines).
- **Phase 2** — implement cloister-companion in Rust:
  - HTTP listener on localhost (loopback from workerd) — accepts cloister's
    forwarded calls
  - Per-upstream pluggable backend transport (UDS/HTTP/capnp-RPC)
  - Embed leyline-net's open subset
  - Apko/melange recipe ships it in the image
- **Phase 3** — add a `leylineNet` backend kind to `manifest/cloister.capnp`
  that points at cloister-companion's localhost endpoint + names the
  upstream-id for the backend to forward to.
- **Phase 4** — migrate the existing rosary backend declaration to
  `leylineNet`. The Accept-header / session-handling pain disappears
  because the seam is now leyline-net, not MCP-over-HTTP.
- **Phase 5** — opt-in for ll-open + mache + notme as their authors choose.
  Backends that haven't migrated keep working through `httpForward` (no
  forced upgrade).

### The eBPF future

User instinct mid-ADR-discussion: replicate raptorq in eBPF + workerd to do
"it all at once." Worth recording as a candidate future direction:

- **Pro**: kernel-side FEC encoding/decoding via AF_XDP would let workerd
  never see encoded packets; near-zero-copy on Linux.
- **Pro**: opens the door to running raptorq + sqlite-blast inside the
  cloister boundary without a userspace cost.
- **Con**: eBPF is Linux-only — breaks the **1:1 local-Mac vs remote-Linux
  invariant** that has been load-bearing through ADRs 0001/0004.
- **Con**: Cloudflare Workers cannot load eBPF (no kernel access).
- **Con**: lots of code; raptorq-in-eBPF is a research project.

**Verdict for now**: out of scope. eBPF is a deployment-target accelerator
on Linux servers, *not* the primitive. The primitive stays
"cloister-companion (Rust) speaks leyline-net wire over UDS." Revisit when
there is a real reason — likely "we want zero-syscall sqlite-blast on a
specific Linux deployment target."

## Consequences

**Positive:**

- **The rsry-Accept / session-handling pain dissolves.** leyline-net
  manifests are per-message; no init dance, no per-session secrets.
- **JSON only at the public face.** Internally everything is capnp. One
  schema language across `cloister.capnp` (manifest), `config.capnp`
  (runtime), `wire/cloister.capnp` (this ADR's wire). One toolchain,
  one error format.
- **Capability semantics match the runtime.** workerd service bindings
  are unforgeable refs; capnp-RPC's central abstraction is unforgeable
  capability; leyline-net's Ed25519-signed manifests are unforgeable
  by tampering. The metaphor isn't a metaphor.
- **The Rust-sidecar question resolves cleanly.** notme-proxy stays where
  it is (its in-memory key never moves); cloister-companion is a NEW
  binary with a generic role. No rename, no extraction, no IP entanglement.
- **Backends keep their existing MCP/HTTP surface for non-cloister clients.**
  Migration to `leylineNet` is per-backend opt-in; nothing forced.
- **The 1:1 local-vs-remote invariant is preserved.** Same cloister-companion
  binary on Mac and Linux apko images; behavior identical.
- **Connects to the existing typed-CID falsifiability work** (cloister-df79a5,
  cloister-dfbe92): leyline-net's manifest IS a typed-CID-with-signature.
  Once the substrate ADR (cloister-df147e, destined for ley-line) lands, the
  same `Cid` shape feeds into both layers.

**Negative / risks:**

- **Cloister-companion is real new code.** Estimated ~600–1000 LOC of Rust
  for Phase 2 (HTTP listener + leyline-net wire + per-upstream transport).
  This is the biggest cost of the decision.
- **Cross-host deployments need TLS at cloister-companion's external face**
  (or a per-backend out-of-band trust setup). Phase 2 design must address
  this; Phase 1 defers it.
- **The HTTP-loopback hop between cloister and cloister-companion is real
  overhead** (parse + dispatch each request twice). Acceptable on the
  same host; matters for absolute latency. UDS-loopback would be cheaper
  but workerd doesn't dial UDS. Future workerd improvement could shrink this.
- **Schema-evolution discipline gets harder.** Three capnp files now
  (manifest, runtime, wire); each has its own ordinal-stability rules.
  Document them in their respective files.

**Out of scope for this ADR:**

- The cloister-companion implementation itself (separate bead, Phase 2).
- The leyline-net wire schema (separate bead, Phase 1 — small).
- Migrating ll-open / rosary / mache / notme to leyline-net upstream (per-
  backend; not coordinated through this ADR).
- The eBPF/raptorq work (deferred until there's a use case).
- Authentication at the public face (still ADR-0001's open work item:
  "notme JWT auth on POST /mcp" — orthogonal).

## Work items

A new bead tracks Phase 1 + 2 (the substrate). Sliced as:

- [ ] **wire/cloister.capnp** — Manifest, ToolCall, ToolResult, AEAD frame.
- [ ] **cloister-companion crate** in `companion/` (Rust). HTTP listener,
      per-upstream transport, leyline-net wire encode/decode.
- [ ] **cloister-companion melange recipe** — packages the binary alongside
      cloister into the apko image (or as a sibling image).
- [ ] **leylineNet backend kind** in `manifest/cloister.capnp` — references
      a companion endpoint + upstream id.
- [ ] **`LeylineNetToolBackend` in src/manifest/backends/** — the workerd-side
      consumer of the new kind.
- [ ] Substrate-equivalence tests against companion: encode manifest →
      verify signature → decode payload → assert round-trip is byte-equal.
- [ ] Migrate `rosary` backend in `cloister.capnp` from `httpForward` to
      `leylineNet` once a rosary leyline-net adapter exists (separate bead
      in the rosary repo).

## Amendment 2026-04-30 — cloister↔companion is IPC, not network wire

After the Phase 2D-codec work shipped (commits `1cf7a73` through `4394a71`,
bead `cloister-5183bc`), the wire wiring (Phase 2D-wire) ran into a real
question that this ADR's original framing hadn't addressed: **what are the
threat-model requirements at the cloister↔companion seam specifically?**

Re-reading the original framing: "cloister-companion runs on the same host
(apko image, supervised process); the HTTP 'hop' is loopback." The trust
boundary is the apko image — anyone with access to that loopback already
has access to the image's process memory, file system, and binaries. AEAD
on a loopback hop within a trust boundary is ceremony, not security.

The real leyline-net wire — with replay defense, identity authentication,
integrity, encryption — belongs at **companion↔backend**, where bytes
actually traverse a network. Cloister↔companion is **IPC**. Treating it
as full leyline-net was over-engineering driven by symmetric-frame
aesthetic, not threat model.

### Workerd capability survey (2026-04-30)

The trigger was a survey of workerd's `crypto.subtle` algorithms:

- **Ed25519** ✓ supported (sign / verify with `name: "Ed25519"`)
- **X25519** ✓ supported (ECDH key agreement)
- **ChaCha20-Poly1305** ✗ NOT supported (only AES-GCM, AES-CBC, AES-CTR)

leyline-net commits to ChaCha20-Poly1305 specifically. To match the wire on
the cloister side we'd need either pure-TS ChaCha (substantial security-
audit surface for what amounts to loopback ceremony) or a wire-format
divergence (AES-GCM instead of ChaCha20-Poly1305 — breaking interop with
leyline-net's actual deployments). Both options are bad answers to a
question we shouldn't be asking.

### Revised wire layers

```
                   ┌──────────── public face (MCP-shaped) ─────────────┐
[CC client]  ──MCP / JSON-RPC over HTTP/SSE──▶  cloister  (workerd)
                                                  │
                   ├──────────── IPC seam (capnp over loopback HTTP) ─┤
                                                  │
                                                  ▼  HTTP body = capnp ToolCall/ToolResult
                                              cloister-companion (Rust binary)
                                                  │
                   ├──────────── full leyline-net wire ────────────────┤
                                                  │
                                                  ▼  Manifest + AEAD + handshake (signed capnp + ChaCha20-Poly1305 + X25519)
                                              backend (rsry / mache / notme / llo)
                   └───────────────────────────────────────────────────┘
```

What changes vs the original three-layer wire:

| Layer | Original ADR-0005 | This amendment |
|---|---|---|
| Public face | MCP/JSON-RPC | unchanged |
| Cloister↔companion | leyline-net frames inside HTTP (signed Manifest + AEAD + capnp payload) | **plain capnp ToolCall / ToolResult as the HTTP body**. No Manifest envelope, no AEAD, no signature. |
| Companion↔backend | per-backend transport choice | unchanged — still uses full leyline-net (Manifest + AEAD + handshake) where the network bytes warrant it |

What stays in the codec:

- The capnp Manifest struct (`wire/cloister.capnp`) and its codec
  (`src/wire/manifest.ts`) remain in this repo as **a publicly-shared
  schema** — the leyline-net wire definition that `cloister-companion`
  emits on its backend face needs the same struct.
  Cloister-side code IMPORTS the schema for tooling consistency but does
  not USE the codec on the IPC face. Removing it from the schema would
  fragment the leyline-wire spec across two locations.
- ToolCall and ToolResult codecs ARE used on the cloister↔companion IPC
  face — they're the HTTP body. No security layer wraps them; the
  loopback transport is the trust boundary.

Phase 2D-wire's implementation (next iteration) is correspondingly
simpler: encode ToolCall, POST to companion, decode ToolResult. No key
management, no signatures, no AEAD on the cloister side.

### What was wrong in the original framing

The honest reading of the original ADR-0005's three-layer wire diagram is
that I conflated two distinct concerns:
1. **The wire format** (capnp, signed manifests, AEAD) — a leyline-net
   property.
2. **Where leyline-net wire is actually deployed** (which hops carry
   network traffic, not loopback IPC) — a deployment-shape property.

The original ADR took (1) and applied it uniformly across all internal
hops. The amendment recognizes that the security guarantees only matter
where they're load-bearing — across networks, between trust domains —
and that "every internal hop must speak full leyline-net wire" was
yak-shaving.

### Out of scope (still)

- Authentication at the public face (notme JWT — ADR-0001 work item)
- Cross-host cloister deployments (TLS at cloister-companion's external
  face)
- The Rust companion implementation (Phase 2B)

## See also

- [ADR-0001](0001-workerd-mcp-gateway.md) — workerd choice + apko packaging
- [ADR-0002](0002-edge-router-protocol-agnostic-backends.md) — EdgeRoute +
  ToolBackend abstractions; this ADR adds a new ToolBackend kind under that
  seam, doesn't change the seam itself
- [ADR-0003](0003-content-addressed-bead-store.md) — content-addressed
  substrate; leyline-net's manifest shares the digest shape
- [ADR-0004](0004-capnp-manifest.md) — declarative routes + backends;
  this ADR adds `leylineNet` to the kind union
- `ley-line/rs/crates/net/` (proprietary) — the source we are adopting
  the open subset from; raptorq + sqlite-blast layers stay closed
- `ley-line-open/rs/crates/leyline-wire/` (PLANNED) — extracted open
  subset; cloister-companion's actual dependency. Tracked in
  ley-line-3278b4.
- Bead `cloister-824849` — rosary passthrough; will migrate from
  `httpForward` to `leylineNet` under this ADR
- Bead `cloister-aedbfb` (closed) — capnp manifest implementation that
  this ADR extends with a new backend kind

## Implementation status (2026-04-30)

Cloister-side stack shipped over 11 disciplined iterations under
bead `cloister-5183bc`. Cumulative diff: ~700 LOC of codec, ~330 LOC
of backends, 100+ tests, full bidirectional substrate-equivalence
proof against the official capnp implementation.

| Phase                     | Commit       | What                                                    |
| ------------------------- | ------------ | ------------------------------------------------------- |
| 2A wire schema            | `573bf2f`    | `wire/cloister.capnp` — Manifest, ToolCall, ToolResult, Content union |
| 2D-skel kind reservation  | `3d1472e`    | Schema add: `Backend.kind.leylineNet @6`; stub TS class |
| 2D-codec strategy         | `aba3c83`    | Decision: hand-rolled, single-segment, unpacked         |
| 2D-codec.A Manifest       | `1cf7a73`    | `src/wire/codec.ts` + `src/wire/manifest.ts`            |
| 2D-codec.B ToolCall       | `8044eda`    | `src/wire/tool-call.ts` (Text NUL-terminated, Data raw) |
| 2D-codec.C ToolResult     | `a05e931`    | `src/wire/tool-result.ts` (composite list + union)      |
| 2D-codec.D Direction 1    | `be542cc`    | capnp CLI → our decoder; null-pointer-as-default fix    |
| 2D-codec.E Direction 2    | `4394a71`    | our encoder → capnp ↔ ours; bidirectional proof         |
| Architectural amendment   | `65de540`    | This ADR's amendment — IPC reframe                      |
| 2D-wire implementation    | `dd8a235`    | `LeylineNetToolBackend.invoke` real, no crypto          |
| End-to-end integration    | `05b3de5`    | McpEdgeRoute → leylineNet → companion stub round-trip   |
| udsForward wire-up        | cloister-46fc1a | `UdsForwardToolBackend` invokes companion with `X-Cloister-Transport: uds` headers; stub-companion proxies to a real `AF_UNIX` socket; same capnp ToolCall/ToolResult bytes. |

Still pending (out-of-scope for this ADR):
- **Phase 2B** — cloister-companion Rust binary; depends on
  `ley-line-3278b4` extracting the open-subset `leyline-wire` crate
  to `ley-line-open`. Includes a UDS-dial path equivalent to the stub's
  `X-Cloister-Transport: uds` handler (cloister-46fc1a installs the
  cloister side; companion-Rust catches up).
- **Phase 2F** — migrate the rosary backend declaration in
  `cloister.capnp` from `httpForward` (currently commented out) to
  `leylineNet` once companion exists.

## Amendment 2026-05-10 — udsForward backend landed (cloister-46fc1a)

The `udsForward` backend kind has stopped being a reservation. Wire path:

```
[Worker] UdsForwardToolBackend.invoke()
    │  capnp ToolCall bytes + headers
    │  X-Cloister-Transport: uds
    │  X-Cloister-Socket-Path: /run/cloister-uds/<sock>
    ▼  HTTP POST → env.COMPANION_URL
[companion]  connect("AF_UNIX", socketPath); write ToolCall; read ToolResult
    │  capnp ToolResult bytes
    ▼
[Worker] decode → MCP edge
```

Why this matches ADR-0005's design and not a workaround:

1. **The Worker still doesn't dial UDS.** workerd has no `AF_UNIX`
   capability, and we deliberately don't add one. The companion sidecar
   is the IPC seam exactly as this ADR promised.
2. **Same wire format.** capnp ToolCall/ToolResult on the wire; no new
   schema, no new codec. The transport indicator is a pair of HTTP
   headers — companion reads them, picks the dial path.
3. **Same trust model.** UDS is intra-pod (inside the apko trust
   boundary); the amendment's "cloister↔companion is plain capnp IPC
   (no AEAD)" guarantee still applies. Companion↔backend on UDS is
   also plain capnp per `docs/deployment/cluster-in-a-pod.md`.
4. **No manifest schema change.** `UdsForwardBackend.socketPath`
   already carried the address. The well-known `COMPANION_URL` binding
   (used by `leylineNet`) is reused for `udsForward` — singleton
   companion per cluster.

The local-dev stub at `scripts/stub-companion.mjs` was extended to
honor the headers: when `X-Cloister-Transport: uds` is present, it
connects to the named UDS socket and acts as a pure byte proxy
between cloister and the responder.

Production cloister-companion (Rust) needs a parallel UDS handler.
Tracked as a follow-up bead in the companion repo (Phase 2B work).

Adding a `leylineNet` backend today is a manifest edit:

```capnp
( name          = "rosary",
  handlesPrefix = "rsry_",
  kind = (leylineNet = (
    companionUrlBinding = "COMPANION_URL",
    upstreamId          = "rosary",
    tools               = [...],
  )),
),
```

The `COMPANION_URL` binding must point at a running cloister-companion
instance speaking the contract documented at the top of
`src/manifest/backends/leyline-net.ts`. Without companion, the backend
returns `-32603 "companion unreachable"` for every tools/call.
