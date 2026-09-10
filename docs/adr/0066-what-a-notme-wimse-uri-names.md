---
title: "ADR-0066: What a notme WIMSE URI names — cloister's acceptance criteria, and the question only notme can answer"
status: Proposed
date: 2026-08-05
tags: [identity, trust-boundary, wimse, interlace, notme, adr-0028]
threat_model: docs/security/threat-model.md
tracking-bead: cloister-f2338f
---

## The inversion, stated first because it constrains everything below

ley-line-open's ADR-0037 established a shape this ecosystem now uses: Proposed,
decision open, questions pointed at the counterparty, build nothing until a
consumer exists. This document takes that shape with **the direction reversed**.
ADR-0037 was the *implementer* asking the *consumer*. This is the **consumer
asking the implementer**.

That inversion changes what the document may do, and notme named the failure
mode precisely: *"you can bind cloister's acceptance criteria; you can't bind
notme's naming. Make that split explicit, or notme reads a decided section as a
demand and cloister reads an asked section as settled."*

So this ADR has two parts and they are not the same kind of thing:

- **§Decided** binds cloister and nothing else. It is a trust-boundary decision,
  which belongs to the party extending trust, and cloister can make it today
  without notme first answering anything.
- **§Asked** binds nobody. It is a question notme cannot answer from inside its
  own implementation, recorded so the answer has somewhere to land.

A reader who takes §Decided as a demand on notme, or §Asked as settled, has
mis-read the document.

## Context

[ADR-0028](0028-capability-scheme.md) decided that three identifier families
name three different concerns, and that treating them as interchangeable causes
cross-seam confusion. Its rule for one of them:

> **WIMSE URIs** name a **workload identity.** … their semantics are "this is
> the identity I am as a workload."

Cloister then never applied that rule to the authority it depends on. What
follows is that omission, closed.

### The asymmetry, verified at notme HEAD

notme mints two WIMSE shapes. They differ in arity **and** in what the segment
after the trust domain means:

| source | construction | segment after domain |
|---|---|---|
| `/cert/gha` (`worker.ts:753`) | `wimse://<domain>/gha/<owner>/<repo>` | `gha` — a **workload class**, followed by what is running |
| session certs (`worker.ts:2331`) | `wimse://<domain>/<authMethod>/<principalId>` | the **authentication ceremony**, followed by a UUID |

One names *what is running*. The other names *how a person proved they were
there*. Both are presented to consumers as the same kind of identifier.

### The implementation already knows they are different kinds

This is the strongest evidence, and it is not an argument — it is two lines:

- GHA cert TTL is **configurable**: `ghaCertTtlMs: Number(env.GHA_CERT_TTL_MS ?? 300_000)` (`worker.ts:567`).
- Session cert TTL is **hardcoded and unexplained**: `ttlMs: 5 * 60 * 1000` (`worker.ts:2336`).

A workload's lifetime is a deployment parameter. A human-presence binding's
lifetime is a security property that should not be tunable by whoever runs the
deployment. The code already treats them as different kinds of thing. Only the
naming insists they are the same.

### And fixing `notme-ebc9af` made it visible

`notme-ebc9af` — the cert hardcoding `authMethod: "passkey"` regardless of how
the session was obtained — is fixed: `worker.ts:2153` records that the cert's
authMethod and WIMSE identity are now **derived** from the session.

That fix is correct and it sharpens this problem rather than relieving it,
because the ceremony now appears *in the identity*. One human registering by
invite and later by passkey receives **two different workload identities** for
the same principal:

```
wimse://notme.bot/invite/<uuid>
wimse://notme.bot/passkey/<uuid>
```

Nothing about the workload changed. A field that should be stable across
authentications varies by authentication.

## Decided — binds cloister only

These are cloister's acceptance criteria as a relying party. They are true of
cloister today or become true with this ADR; none requires notme to act.

**D1. Cloister does not derive authorization from a WIMSE URI.**
The gate is the verified peer fingerprint plus scope match
(`verifyAndUpsertLease`), and it stays that way. This is already true and is
stated here so it cannot quietly stop being true: it is what bounds the blast
radius of every question below to *naming* rather than *access*.

**D2. Cloister treats a URI whose post-domain segment is an authentication
ceremony as a human-bootstrapped credential, not a workload identity.**
Concretely: acceptable for obtaining a short-lived cert (which is what
`cloister-f2338f` wants), never recorded as an attestation of *what is running*.

**D3. Cloister keys attestation and disclosure on the peer fingerprint, never
on the URI.** Already true — `peer_attestations.peer_fingerprint`,
`GET /interlace/peers/{fp}` — and now a commitment. A fingerprint is stable
across the ceremony that produced it; the URI demonstrably is not.

**D4. Cloister will not parse WIMSE URIs into segments for any
security-relevant decision.** notme's own mitigation for the arity mismatch is
a verifier comment telling consumers never to split the string. A comment is
the correct short-term treatment and the wrong long-term contract, so cloister
declines the capability rather than relying on the instruction: if the shape
must be parsed to be used safely, cloister does not use it.

**D5. If notme adds a human-shaped identity alongside the existing one,
cloister consumes the new one and treats the old as legacy** — no coordinated
cut required from us. See the constraint below.

## Asked — binds nobody, and cloister cannot answer these

**Q1. Is this authority naming humans, or workloads?**
Every question below is downstream of it. Cloister's *use* is
human-bootstraps-machine — a person at a laptop, one passkey touch, producing a
short-lived cert a harness then uses unattended — so our stake argues for
"human authority that bootstraps workload identity." But what the authority
*is* is notme's to say.

**Q2. If human-bootstraps-machine: should the URI say so, and by which route?**
This is a real cost question, not a style one. Per notme's ADR-018
compatibility matrix, changing the *existing* session-minted shape is a
**blocking cross-repo change** affecting cloister and signet, requiring a
coordinated cut. Adding a human-shaped identity **alongside** does not.
**Cloister's preference is add-alongside**, and D5 commits us to consuming it —
unless notme wants the shape change for reasons of its own, in which case we
will schedule the cut.

**Q3. Is the hardcoded session TTL the human-presence binding?**
If it is, it should say so and stay non-configurable, and that is a load-bearing
fact currently expressed only as an unexplained literal. If it is not, it is an
undocumented divergence from the configurable GHA path.

**Q4. Registration policy (`notme-2c4209`).**
Cloister previously offered a conditional answer. We withdraw it: the question
is not answerable before Q1. If this authority names workloads, open
registration is clearly wrong and passkey is the wrong gate. If it names humans
who bootstrap workloads, open registration is survivable — cloister gates on
scope, and freely-registered principals receive only `bridgeCert`, which matches
no cloister tool scope — but that makes cloister's safety rest on one gate
rather than two, which is a thing to decide rather than inherit.

## Not decided here

- notme's naming, in any form. §Decided binds cloister only.
- Whether registration is open. That is `notme-2c4209`, blocked on Q1 with the
  edge recorded on `notme-600df1`.
- Any coordinated cut. D5 exists specifically so that no answer to Q2 obliges
  cloister to schedule one.

## Consequences

- Cloister's acceptance criteria become explicit and testable rather than
  emergent from what the lease pipeline happens to do. D1 and D3 are already
  true; writing them down is what stops them drifting.
- `cloister-f2338f` (passkey-minted dev certs) proceeds under D2 without waiting
  on Q1 — a human-bootstrapped short-lived cert is exactly what it needs, and
  that reading is stable under either answer to Q1.
- If Q1 answers "workload authority", D2 becomes a refusal rather than a
  classification, and f2338f needs a different mint path. That is the one
  outcome that would cost us rework, and it is why the question is worth asking
  before we build more on the current shape.

## Notes — the pattern this came from

notme found this by applying a gate worth recording verbatim, because it is
sharper than cloister's own:

> For every self-describing artifact, is there something that would fail if the
> description stopped being true?

Cloister's formulation — *an invariant with no rail is a comment* — tells you to
add rails. notme's tells you **where to look**. It found four instances in notme
alone this session, four in cloister (including
`lint:sibling-bead-refs`, whose error message documented a clearance path the
code did not implement — a rail describing itself falsely, green for months),
and one in ley-line-open. Nine across three repos, none found by tests or by
reading code for correctness.

A WIMSE URI is a self-describing artifact: it asserts *this is the identity I am
as a workload*. Nothing fails when that stops being true. This ADR is that
question asked of one artifact; the general gate deserves a rail of its own.
