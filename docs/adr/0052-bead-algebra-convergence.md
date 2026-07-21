---
title: "ADR-0052: Bead merge algebras converged twice — unify into one specification"
status: Proposed (2026-07-20)
date: 2026-07-20
tags: [beads, content-addressing, merkle-dag, crdt, lattice, cross-repo, rosary, equivalence]
relates_to:
  - 0003-content-addressed-bead-store.md
---

# ADR-0052: Bead merge algebras converged twice — unify into one specification

Working-tree-only note: this file is intentionally untracked; the operator
commits it. Ecosystem decision-of-record: **rosary ADR-0020**
(`rosary/docs/adr/0020-findability-by-identity.md`), backed by the full
analysis in `rosary/docs/design/findability-by-identity.md`.

## Context

Two accepted ADRs in two repos independently derived the same mathematics
for "a structured record whose fields merge by per-field join":

- **cloister ADR-0003** (Accepted 2026-04-29): beads as an immutable
  content-addressed DAG + CAS refs, with **per-field merge lattices** —
  set-union tags, max priority, LWW description, MV-register-vs-flat state,
  append-dedup comments.
- **rosary ADR-0010** (Accepted; built, shadow-folding): an append-only
  G-set of authenticated observations + **per-field deterministic fold** —
  chain-max, LWW-register, OR-set, flat-lattice. Same observation set →
  same derived view, any order.

These are the same algebra discovered twice. Independent derivation is
strong evidence the shape is right — and a standing liability: two
implementations of "what does status mean under merge" that can silently
drift apart would fork the meaning of bead state across the ecosystem.

Rosary ADR-0020 now adopts cloister ADR-0003's substrate (blob monoid +
CAS refs) as the storage answer for beads ecosystem-wide: BeadId = genesis
digest, state = ref-addressed DAG tip, facts = content-addressed signed
observations, stores demoted to rebuildable caches. ADR-0003 is the
**substrate half** of that decision; the field algebras are the shared
semantic half — and there must be exactly one of them.

## Decision

1. **One algebra specification, two implementations.** The per-field merge
   lattices of ADR-0003 and the field algebras of rosary ADR-0010 are
   unified into a single normative specification (canonical serialization,
   digest rules, per-field join/fold semantics). Rust (rosary) and
   TypeScript (cloister/workerd) each implement it; neither is the spec.

2. **Pinned by a cross-substrate equivalence test.** The contract is
   executable: the same set of observations must produce the same blob
   digests and the same fold result on both implementations
   (same observations → same digests → same fold). This extends ADR-0003's
   existing substrate-equivalence obligation from blobs/refs to the field
   algebras themselves. Divergence fails CI in both repos, loudly.

3. **Division of authority.** cloister ADR-0003 remains authoritative for
   the substrate (BlobStore/RefStore, canonical blob form, CAS
   discipline). Rosary ADR-0020 is the ecosystem decision-of-record for
   bead identity, role, and what derives from them. The unified algebra
   spec serves both and belongs to neither repo's private internals.

## Consequences

- "Status" (and every merged field) means the same thing in-cluster
  (workerd DO), on native rosary, and across sync — by test, not by intent.
- ADR-0003's lattice tables stop being a cloister-local design detail and
  become one half of a shared, versioned contract; changes require updating
  the spec and passing the equivalence test on both sides.
- The OCI-registry BlobStore sharing (ADR-0003 amendment) now also carries
  rosary's bead blobs: one content-addressed monoid, three consumers
  (images, cloister beads, rosary beads).
- New work: the spec document itself, the equivalence-test harness, and a
  digest-algorithm decision (SHA-256 addressing vs BLAKE3 interior — rosary
  ADR-0020 open question 1) that both repos must adopt together.
