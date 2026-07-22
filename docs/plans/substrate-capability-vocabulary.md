# Plan — Substrate capability vocabulary ("lego blocks")

- **Bead:** `cloister-1b59a2` (framing — substrate-as-kernel).
- **Status:** Draft (2026-05-17), **not scheduled**. Landed on `main`
  2026-07-22 to preserve the thinking; the original working branch +
  worktree are gone. Read as reference, not as an active plan.
- **Awaiting:** the framing ADR (drafted via a separate LLM session).
  When it lands, it ratifies + supersedes the enumeration below.
- **Related:** [`docs/proposals/agent-process-v1.md`](../proposals/agent-process-v1.md)
  cites this as its L5 framing layer.

## Status

**Not yet started.** This worktree is the staging area for when the
framing ADR lands. The doc below is the **scoping enumeration** — the
candidate set of cloister's "lego blocks" (k8s CNI/CSI/CRI analogs)
the framing ADR can adopt verbatim, refine, or override.

## Candidate vocabulary — cloister's lego blocks

Mirroring k8s's interface pattern. Each row = one named capability
interface. The substrate publishes the contract; operators plug
v1 reference impls; alternatives accrete.

| k8s analog | Cloister capability | Today's v1 reference impl | Where it lives now | ADR / spec |
|---|---|---|---|---|
| **CRI** (container runtime) | `cloister/compute-substrate/v1` | workerd (default) | `config.capnp` + `wrangler.toml` | ADR-0001, ADR-0009 |
| **CNI** (network) | `cloister/wire-transport/v1` | UDS / serviceBinding / leyline-net / httpForward (the existing `Backend.kind` discriminated union) | `manifest/cloister.capnp` `Backend.kind` | ADR-0002, ADR-0005 |
| **CSI** (storage) | `cloister/persistent-storage/v1` | Durable Objects (BeadStore / TrustStore / BlobStore — one DO per logical store) | `config.capnp` (do-storage service) | ADR-0003, ADR-0012, ADR-0023 |
| **OIDC providers** (identity) | `cloister/identity-provider/v1` | notme (Interlace cert minting, master CA, lease pipeline) | external workerd process, service-binding to cloister-router | ADR-0007, ADR-0018, ADR-0019 |
| **AdmissionWebhook** (policy gate) | `cloister/lease-policy/v1` | Interlace lease middleware (clock skew + cert chain + nonce ledger + scope match + Web Crypto sig) | `src/routes/lease-middleware.ts` | ADR-0007 |
| **ServiceAccount** (bundle identity) | `cloister/bundle-identity/v1` | (No formal v1 yet — ADR-0021 sketches per-bundle vault DO; ADR-0013 enforces slice-grant) | the V8 isolate + service-binding-as-syscall boundary | ADR-0013, ADR-0021 |
| (cluster-wide) | `cloister/credential-isolation/v1` | CredentialVault DO + ADR-0014 KEK source (`keychain://`, `op://`, `apple-password://`, etc.) | `src/vault-store.ts` | ADR-0013, ADR-0014, **ADR-0024** (in progress, `cloister-8f57f0`) |
| (cluster-wide) | `cloister/audit/v1` | TrustStore receipts (`peer_receipts` table; Interlace 0.2.0 chain) | `src/storage/peer-receipts.ts` | ADR-0007, `interlace-spec/0.2.0-draft/` |
| (cluster-wide) | `cloister/bead-storage/v1` | BeadStore DO (per-repo SQLite, content-addressed via BlobStore) | `src/beads.ts` | ADR-0003, ADR-0012 |
| (cluster-wide) | `cloister/capability-registry/v1` | (No v1 yet — proposed `/.well-known/cloister-capabilities/v1/` endpoint per ADR-0024 Phase 8) | future | future ADR |

**Total**: 10 candidate capabilities. The framing ADR may merge,
split, or rename these; this list is the starting material.

## Naming convention

`<namespace>/<capability>/v<N>` — matches OCI artifact convention
+ k8s GroupVersionKind shape. Examples:
- `cloister/credential-isolation/v1`
- `interlace/identity-provider/v1` (would live under the
  `interlace` namespace, not `cloister`, because Interlace is the
  protocol layer; cloister consumes it)
- `notme/oidc-bridge/v1` (notme-specific, layered on top of
  Interlace)

The framing ADR picks the convention; this is the natural-feeling
default.

## What the framing ADR should ratify (or override)

1. **The list above.** Confirm / refine which named capabilities
   cloister publishes. May want to defer some (e.g. cluster-wide
   ones) to v2 of the framing.
2. **The naming convention.** `<namespace>/<capability>/v<N>` or
   something else.
3. **The manifest field shape.** Per `cloister-ae4ed2` Phase 2:
   - `bundle.implements: List(Text)` — capability interfaces this
     bundle fulfills.
   - `wire.requires: Text` — capability interface the wire needs
     (not a bundle name).
   - `route.requiresCapability: Text` — same for routes.
4. **Where specs live.** Sibling `cloister-spec/` subdirectories
   per capability (mirroring `interlace-spec/0.1.0/` shape) OR a
   future neutral repo. Today's ADR-0024 uses
   `cloister-spec/credential-isolation/v1/`.
5. **Capability registry endpoint.**
   `/.well-known/cloister-capabilities/v1/` — what fields, what
   wire shape, who consumes it (operator tooling, /evolve scoping,
   external introspection).

## Once the framing ADR lands

This plan retires and a per-capability rollout plan replaces it.
Each capability's first PR follows the `cloister-8f57f0` template:
- ADR drafted.
- `cloister-spec/<capability>/v1/` scaffold + test vectors.
- Stub module + failing tests (TDD baseline).
- Manifest schema additions (per ADR-0004 append-only).
- Capability registry entry.
- Conformance suite + Python ref-impl.

The bidi TOML pipeline (`cloister-ae06f3`) is the substrate
vocabulary's wire (operators declare `bundle.implements` in TOML;
schema-bridge lowers to capnp). This work depends on bidi being
done.

## Order of operations once the framing ADR lands

1. Confirm vocabulary + naming convention from the ADR.
2. Phase 2 manifest schema additions (`cloister-ae4ed2`).
3. Per-capability spec scaffolding (start with the LOAD-BEARING
   ones — identity-provider, credential-isolation, audit).
4. Capability registry endpoint (`/.well-known/cloister-capabilities/v1/`).
5. Conformance suites (Python ref-impl per capability).
6. Recipe directory per consumer (OpenClaw, Claude Code, Codex,
   etc.) showing how to plug into a given capability.

## /evolve composability (when ready)

```sh
# Once the framing ADR lands and per-capability beads are filed:
/loop 30m /rosary:evolve --focus cloister-1b59a2
```

/evolve picks up the next ready capability bead, dispatches the
phased work, gates via skeptic + staging, ships. Same pattern as
the bidi work (`cloister-ae06f3`).

## What this branch is NOT

- NOT an ADR. The framing ADR comes from elsewhere.
- NOT an implementation. Just the staging area + the candidate
  vocabulary.
- NOT a contract. The framing ADR is the contract; this is
  scoping material.

## Why the worktree exists now

The user wanted the substrate-as-kernel work to have a real
"workspace" (branch + plan doc) so it's findable, not just a bead
in the queue. When the framing ADR lands, the next session opens
this worktree and continues from this plan.
