---
title: "ADR-0059: The attested ephemeral run — cloister as an execution substrate for derivations"
status: Proposed (2026-07-29)
date: 2026-07-29
tags: [execution, provenance, attestation, apas, microvm, capability, ephemeral, cli]
threat_model: docs/security/threat-model.md
relates_to:
  - 0026-tool-composition-model.md
  - 0040-harness-in-cloister.md
  - 0044-compute-isolation-substrate.md
  - 0046-mediated-capability-core.md
  - 0049-cloister-host-runtime.md
  - 0057-declaration-model.md
external_refs:
  - signet:docs/apas/agent-provenance-standard.md
---

# ADR-0059 — The attested ephemeral run

## Context

Everything cloister executes today belongs to cloister: it proxies MCP for
other tools, verifies leases, emits receipts. It has never run *someone
else's job*.

`〇.day` (`0day`) wants one. It publishes the public index of the ecosystem —
a map derived from every public repository's own manifests. Its collector
(`task deps:collect`, already running regularly in-repo) reads those
manifests and produces `data/sources.lock.json`, from which `graph.json` is
derived. Two rails hold it together: `deps:check` (the graph must be the
lock's derivation — pure and offline) and `deps:verify` (the lock must still
match the repositories).

The claim 0day wants to publish is: **"this map was derived from exactly these
bytes, at this time, by this actor."** Today it cannot. `deps:verify` proves
the lock matches reality *when you run it*, with network access, against live
repos — a reader would have to redo the collection to believe it.

That is a provenance gap, and it is the gap signet's **APAS** exists to close.

### What APAS asks for, and where cloister already sits

APAS (`signet:docs/apas/agent-provenance-standard.md`, 0.2.1-draft) defines
four conformance levels. Two are relevant and both are **[TARGET]**:

| Level | Requirement | Bearing on this ADR |
|---|---|---|
| **L3** Isolated Execution | enforced permission boundary | cloister's confinement is a substrate property, not a promise |
| **L4** Verified Inputs | hash the inputs a derivation consumed | 0day's `sources[]` is *already* content-addressed |

Three facts make this more than an aspiration:

1. **0day's inputs are already hashable.** `sources[]` entries carry
   `ref` (`github://owner/repo/path@<sha>`), `rev`, and `sha256`. That
   satisfies the lesson APAS draws from the March 2026 Trivy/Aqua compromise
   (§1.1): *"Mutable references are attack vectors — content-addressed
   references are required."*
2. **Cloister's resolver is already path-general and digest-verifying.** The
   ref grammar accepts `github://owner/repo/<path>@<ref>` for any path and
   `github://owner/repo@<ref>` for a whole-repo tarball; `sha256` is recorded
   per input and mismatches fail closed (`resolve-inputs.mjs`:
   `digest mismatch — pinned X, got Y`).
3. **ADR-0026 already named the missing piece.** `cluster.lock.toml`'s own
   header says: *"A future ADR-0026 phase will add Interlace receipt
   signatures (`signer` field populated from the input's actor)."*

### Why cloister rather than 0day's own CI

APAS §1.1's third lesson: *"The auditor must not be the audited — split trust
between execution and attestation."* §2's L1 warning is blunter: *"the
orchestrator that writes provenance records is the same entity being audited
… an attacker who compromises the orchestrator can forge records."*

If 0day's CI both collects and signs, that is self-attestation wearing a
signature. If cloister runs the collection and attests it, collector and
attestor are different substrates with different keys. The split is
structural rather than procedural.

## Decision

Add **the attested ephemeral run**: a cloister capability that executes a
declared, confined, content-addressed job and returns a signed receipt over
its inputs and outputs.

Adopt it in **two phases with an explicit boundary**, because the provenance
goal and the platform goal are separable and have very different risk.

### Phase 1 — attest the derivation (no relocation)

Collection stays where it runs today. Cloister resolves and attests the
inputs.

1. 0day declares its sources as cloister inputs, using the existing
   content-addressed ref grammar. Whole-repo pinning
   (`github://owner/repo@<sha>`) is preferred over per-file: one digest
   covering every manifest in a repo is a stronger claim than 35 file pins
   that could each be from a different moment.
2. The `signer` field lands on lockfile entries — the ADR-0026 phase already
   named above.
3. Receipts gain an **actor-attested** shape: cloister asserting *"I produced
   exactly these bytes at time T under my master key"*, with no caller lease
   to bind.

Phase 1 delivers the provenance without depending on anything unshipped.

### Phase 2 — relocate execution into the microVM

The run moves inside cloister's compute substrate, exercising
`host-runtime/v1`, the mediator, bounded storage, and confinement end to end.

Phase 2 is where the platform is flexed. It is deliberately second: doing it
first means debugging provenance semantics and an unproven substrate at the
same time, with nothing to diff against. Phase 1 gives a known-good answer,
and because 0day's runner already executes in-repo, Phase 2 can be compared
against **two** baselines — current CI and Phase 1 — with `deps:check`
(offline, pure) deciding whether the microVM produced the *right* graph rather
than merely *a* graph.

### The four constraints that shape both phases

**1. It is a capability, not a script.**

Per ADR-0046, the core contract is:

```
(subject-lease, verb, resource-ref, args) → (decision, projection, receipt)
```

The receipt is part of the return signature. An attested run is therefore not
a feature bolted onto an executor — it is what a correctly shaped capability
call already returns. The run MUST be expressed as a core capability with
transport adapters, NOT as CLI-local logic.

This is a correction to the current shape, stated plainly: `cloister runtime
run` today is CLI → `spawnSync` → the `cloister-host-runtime` binary, with no
lease and no receipt. That is a transport-specific path of exactly the kind
ADR-0046 replaces. Building `cloister run` the same way would add a second
one. The CLI must be an adapter over the capability, so the same verb is
reachable by RPC without a second implementation.

**2. Tenancy is bundle-shaped, not route-shaped.**

`tenantDispatch` is request routing — SNI or path-prefix to a service
binding. An ephemeral run has no request: no host header, no pathname.
Reusing it would mean synthesising a fake request to carry tenant identity,
which is structurally the mistake notme correctly refused when it declined a
placeholder `{"type":"stdio"}` transport — schema-satisfying and semantically
false.

A run needs an actor identity, a confinement policy, and storage scoping.
Those are bundle concerns, and `perTenant: Bool` on `BundleSpec` plus
Inv 8/9's wiring chain already express them. **No new tenancy concept is
introduced.**

**3. The confined workload gets NO write credentials.**

Outputs are emitted as artifacts; the caller's CI commits them. The runner
never holds a token for the repository it makes claims about.

This is the load-bearing security decision. A write credential inside the
microVM would give the confined workload publish authority over the repo it
is deriving claims about — collapsing APAS §1.1's third lesson and importing
its second (*"long-lived credentials enable persistence"*). It would mean
building isolation and then handing the isolated thing the one capability
that makes isolation moot.

Artifacts-out buys three properties instead:

- Egress narrows to two hosts (`raw.githubusercontent.com`,
  `codeload.github.com`) and one output path — a genuinely restrictive first
  `confinement/v1` policy rather than a permissive one, which is a better
  first proof of the platform.
- `deps:check` gates the commit. It is already pure and offline, so the
  artifact is verified to BE the lock's derivation *before* publication:
  verify-then-publish using a rail that exists.
- Two separately auditable events — cloister's attestation and CI's commit —
  rather than one actor doing both.

**4. Confinement is declared, not inferred.**

The run declares `allowHosts`, `fs.allow`, and `port.bind` per
`confinement/v1`; Inv 11 already validates the facet and fails closed. A run
whose policy cannot be satisfied does not start.

## Consequences

- Cloister acquires its first workload that is not cloister. ADR-0040
  describes a "control + credential + audit plane"; this gives it a concrete
  first tenant.
- 0day gets transferable provenance: a reader verifies a signature rather
  than repeating a collection.
- **APAS conformance is NOT claimed.** §7.5 currently lists cloister receipts
  under *"Adjacent Systems (Not APAS Conformance)"* because they use Interlace
  commitment CBOR rather than in-toto/DSSE predicates. This ADR makes the
  derivation *attestable*; the envelope question is separate and belongs with
  signet, which owns the standard. Claiming L3/L4 here would be asserting
  conformance to someone else's spec by fiat.
- The CMS signing primitive APAS names normatively
  (`ley-line-open/rs/ll-open/sign/src/cms.rs`, Ed25519 CMS/PKCS#7 per
  RFC 5652 + RFC 8419) is already present in cloister's wasm module as
  `leyline_sign_data` — and is **unexercised**, with zero callers. If the
  envelope question resolves toward CMS, that primitive is where it lands.
  Recorded here so the dead export is understood as unused-pending-decision
  rather than dead weight.
- Phase 2 depends on `cloister-66f1ce` (`runtime:doctor` exists but nothing
  invokes it, so host preconditions are validatable and unvalidated) and on
  the mediator's self-described "last-mile integration" — `mount.rs`'s real
  path needs a mache-populated leyline-fs arena, where the demo path serves a
  `MemoryGraph`.

## Open question

**What lease does a run present?**

ADR-0046 invariant 1 requires the caller to present a verified Interlace
lease. A CI-triggered collection has no human caller. The same shape appears
in Phase 1's actor-attested receipt: cloister asserting something under its
own identity rather than on behalf of a caller.

That this gap appears twice, from two directions, suggests it is a real
absence in the model rather than an edge case: **the capability core assumes
every call is on behalf of someone.** Some calls are the substrate acting as
itself.

This ADR does not settle it. Candidate shapes — a self-issued actor lease, an
`actor:` scope class, or an explicit unattributed-call path with its own
audit treatment — each have different blast radii and belong in the threat
model before code. Related: `cloister-ceb57c` (tenant-scope enforcement in
lease middleware) has an unresolved posture question of the same family.

## Alternatives considered

**Serve `〇.day` through cloister and sign responses.** Rejected: it attests
delivery, not derivation. A receipt saying "this reader fetched the map"
answers nobody's question; "this map was derived from these sources at time
N" does. Serve-time signing also requires a caller lease the public site does
not have.

**Have 0day sign its own collection.** Rejected on APAS §1.1 lesson 3 —
the auditor must not be the audited. It is cheaper and would work; it just
does not produce the property being sought.

**Skip Phase 1 and relocate straight into the microVM.** Rejected: no
baseline to diff against, and two unproven things debugged at once. Phase 1
is also independently valuable, so sequencing costs nothing but time.
