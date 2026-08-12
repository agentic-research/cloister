---
title: "ADR-0068: Confinement is a lattice, so the ratchet is its meet — and the runner should check refinement, not equality"
status: Proposed
date: 2026-08-07
tags: [confinement, isolation, trust, lattice, llo-boundary]
tracking-bead: cloister-b4a98e
---

## Context

Cloudflare's Agent Access Model (August 2026) names a control cloister does not
have, the **Trust Ratchet**: trust becomes stateful *within a single run*, so a
protected event — the agent reads something classified — narrows the capability
set, and it can never widen again for the rest of the task. Their summary is
*"like a ratchet, its capability state can only narrow during the task."* The
point is that a prompt injection arriving afterward cannot exfiltrate, because
the capability to do so no longer exists, whatever the model decides to attempt.

Cloister's confinement is computed **once**, at launch, and committed to via the
confinement/v1 §8 identity commitment. That is exactly right for attestation —
the digest names precisely what was granted — and it means the grant is static
for the whole run. A harness that reads a secret at minute 1 keeps its network
grant at minute 40.

This is the gap the isolation spine does not close. S0–S4 constrain what a run
*can* reach. Nothing constrains what it may *still* reach after it has touched
something sensitive.

## The observation

Cloister does not need a new mechanism, because **confinement/v1 is already a
lattice**. Its own schema says so without using the word:

> Every dimension defaults to DENY; the manifest names only what is allowed, so
> an omitted block is a refusal and never an escape hatch.

Five dimensions, each default-deny, is a *product* of five component
semilattices:

| §  | Dimension | Component order | Meet |
|---|---|---|---|
| §2 | `fs.allow` | prefix containment × rights `{read, write}` | longer path, intersected rights |
| §3 | `network.allowHosts` | pattern subsumption (`*.d` over `x.d`) | the more specific pattern |
| §4 | `port` | absent < bound; `0.0.0.0` over a concrete address | same port or nothing |
| §6 | `unixSocket.allow` | exact path × rights `{connect, bind}` | intersected rights |
| §5 | `credentialSource` | absent < one URI | same URI or nothing |

Bottom is `{version}` alone — total denial — and note that **⊥ is an ordinary
valid document**, which is what lets fail-closed be a state rather than an error
condition.

A ratchet step is then `meet(current, restriction)`, and the properties AAM has
to specify and enforce become theorems instead:

| AAM requires | The algebra gives |
|---|---|
| "can only narrow" | meet is decreasing: `a ∧ b ≤ a`. Widening is not *expressible* — there is no operation for it. |
| fail-closed on conflict | ⊥ is absorbing. |
| "synchronized acknowledgment across all enforcement points before responses are released" | **not needed.** Associativity + commutativity + idempotence make this a state-based CRDT: enforcement points may apply the same events in any order, or twice, and converge. |

That third row is the substantive win. AAM needs distributed agreement because
its ratchet state is a mutable variable components must agree on. Here the state
is a lattice element and transitions are meets, so points need to agree on an
event **set**, never an event **order**. The consensus problem does not get
solved; it stops existing.

## Decision

1. **The ratchet is `meet`.** `cli/lib/harness/confinement-lattice.mjs` implements
   it componentwise over the five dimensions.
2. **The order is defined *via* meet** — `a ≤ b` iff `a ∧ b = a` — so there is
   one implementation of the ordering and no second opinion to drift from it.
3. **Nothing is rewired yet.** This ADR ships the algebra and its properties. It
   does not change what `cloister run` emits, because that would change the
   `confinementDigest` committed into every minted cert.

### The commitment argument, and the ask for LLO

Because narrowing is monotone, **the set of reachable states is contained in the
down-set of the initial document.** A cert committing to the initial confinement
therefore already bounds every state the run can reach. A verifier does not need
to know which events fired, or in what order, or re-mint anything — it needs to
check that the effective policy is **≤** the committed one.

So the ask is a one-word change to the equality contract:

> A carried confinement document must **equal** the compiled policy after the
> §4/§6 fold, refused by dimension name otherwise.

becomes **"must be a refinement of"** — `carried ≤ compiled`. That preserves
exactly the guarantee equality was protecting (nothing may widen past what was
compiled) while admitting the narrowed states, and it keeps the by-dimension
refusal message, since `leq` fails per dimension.

There is a second, independent reason to want this, which holds *even with no
ratchet at all*: **byte equality is already the wrong comparison.** `meet` sorts
grant arrays and drops subsumed entries, so `normalize(d) ≠ d` byte-wise for
every document cloister ships today — `confinementManifest()` emits neither
sorted nor deduplicated. Two byte-different documents can denote the same grant
set. Equality-on-bytes conflates the representation with the thing represented.

Each dimension needs a stated ≤ for this to be implementable on LLO's side, and
this ADR's table is the proposal. §7 canonical serialization is unaffected — it
still defines the bytes a digest is taken over, and this changes only what two
documents are compared *with*.

## What is built

- `cli/lib/harness/confinement-lattice.mjs` — `meet`, `ratchet`, `leq`,
  `normalize`, `bottom`. Beside the emitter, under the same
  `lint:harness-types` strictness, per ADR-0067's finding that a check agreeing
  with a document nobody emits proves nothing.
- `scripts/test/confinement-lattice.test.mjs` — 21 tests. The laws are
  quantified over a corpus that includes the **real emitted documents**; the
  closure property drives each meet through the vendored confinement/v1 schema
  using ADR-0067's L1 validator, so a narrowed state no runner would accept
  fails here rather than at exec time.

### Two findings from mutation-testing the properties

Thirteen deliberate mutations were introduced to check the tests could fail.
Three initially survived, and both lessons generalise.

**The corpus was doing less work than it appeared to.** Deleting the sort inside
`meet` passed all seventeen properties, because no two corpus documents listed
the same subtrees in different orders — every multi-grant meet inherited its
ordering from one operand and agreed with itself. Likewise, degrading segment-wise
path containment to `String.startsWith` changed nothing until a path without a
trailing slash existed, and subsumption-dropping was never reached until one
document nested grants inside its own allow-list. A property is only as strong
as the corpus's ability to distinguish it.

**Quantified laws cannot check semantics.** `leq` is computed with the same
`meet` it is checking, so a `meet` that is wrong *consistently* — unioning
rights instead of intersecting them — satisfies every law, because both sides of
each comparison are wrong in the same direction. Inverting the fs-path and
rights meets left all the algebra green; only named example tests caught them.
The two kinds of test are not redundant and neither subsumes the other: the laws
check that the algebra is **consistent**, the examples check that it is
**correct**.

## Alternatives considered

**Re-mint the confinement on each transition.** Honest, and it makes the receipt
chain the record of narrowing, which is arguably where it belongs. Rejected as
the primary mechanism because it puts a mint on the hot path of every protected
event, and the down-set argument shows it is unnecessary — the initial
commitment already bounds the reachable set. Worth revisiting if a *receipt* of
each narrowing turns out to be wanted for the §13.4 audit, which is an ADR-0065
question rather than this one.

**Keep the ratchet state outside the attested document,** as host-runtime state.
Cheapest, and gives up the property that made the commitment worth having: an
auditor could no longer tell from the cert what the run was permitted.

**Put the ratchet on ADR-0027's capability lattice instead.** Wrong layer twice
over. That lattice is build-time — which inputs wire to which — and it is
currently uninhabited (no input declares `provides`/`requires` yet). It is also
documented as *coarse*: a capability grants a provider's whole tool surface, so
the only narrowing available would be "drop an entire provider". The confinement
lattice is per-dimension and already fine-grained. Same mathematics, and the
confinement layer is where a meet means something operational.

**Adopt AAM's design as specified,** with synchronized acknowledgment across
enforcement points. That machinery exists to make a mutable shared variable
safe. Having the algebra, adopting the machinery would be paying for a
consensus problem we do not have.

## Consequences

- Narrowing becomes expressible and testable before any enforcement exists,
  which is the order this repo's rails have repeatedly wanted and not got.
- The LLO ask is small, precise, and independently justified. It is also
  **blocking**: without refinement-checking, a narrowed run fails the §8
  commitment check at exec time.
- Enforcement is still absent. Nothing computes a restriction from a protected
  event, and nothing hands a narrowed document to a running sandbox. Wiring that
  means deciding **which events narrow what**, which is a policy question this
  ADR deliberately does not answer.
- `normalize(d) ≠ d` for shipped documents is now a stated fact rather than a
  latent surprise. Normalizing the emitter's output would change the digest and
  invalidate every minted cert, for no gain.

## What this does not fix

- **Enforcement mid-run.** Seatbelt and Landlock apply a policy at spawn.
  Whether either can *tighten* a live sandbox — Landlock's layered rulesets can,
  Seatbelt is a harder question — is unresolved and belongs in the harness
  substrate thread, not here.
- **Multiplayer access control.** AAM explicitly declines this, citing 15.8%–50.9%
  privacy-violation rates in simulated shared-agent workflows. A lattice is the
  right frame for it — per-principal authority glued over overlaps is a sheaf
  condition, which ADR-0027 already names as its federation extension — but
  naming the mathematics is not having built it.
- **Anything about what the model did inside the isolate.** ADR-0065's limit
  applies unchanged.
