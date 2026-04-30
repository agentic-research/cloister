---
title: "ADR-0003: Bead store as content-addressed DAG + CAS refs"
status: Accepted
date: 2026-04-29
tags: [architecture, storage, beads, content-addressing, merkle-dag, crdt, workerd, portability]
supersedes_framing: [ADR-0001 §"DoltLite WASM evaluation" work item]
---

## Context

ADR-0001 listed a research item:

> *Add DoltLite evaluation — if DoltLite WASM ships stable, replace BeadStore
> SQLite with version-controlled prolly-tree storage for branch-per-agent bead
> isolation.*

This framing is wrong on two independent counts:

1. **Substrate impossibility.** WASM in workerd cannot reach Durable Object native
   SQLite. WASM is a guest with limited host imports; the DO SQL API
   (`ctx.storage.sql`) is a TypeScript host interface not exposed to guest code.
   So even if DoltLite-in-WASM existed, embedding it in cloister would *replace*
   the DO storage rather than version-control it — losing per-DO physical
   isolation in the process.

2. **Wrong altitude.** The problem we want to solve is "branch-per-agent bead
   isolation with mergeable history." That is a structural property, not a
   database-engine property. Embedding a database engine to get a structural
   property is the heaviest possible answer.

The hidden architectural conflation in the original framing: a single mental
object called "branch" that mixed two distinct algebraic concerns. Once those
are separated, the substrate question collapses, and the implementation works
identically on three runtimes we care about:

- **workerd** (Cloudflare Workers in prod, `workerd serve` locally) — v8 isolate,
  no native binaries, only DO SQLite as durable storage
- **native** Mac/Linux — regular SQLite, or `ley-line`'s content store
- **edge / future KV** — anything supporting `kv.get(digest) → bytes` + CAS

This ADR locks the structural decomposition. Implementation is in
[`cloister-82a851`](#).

## Decision

Replace `BeadStore`'s flat-table SQLite schema with a **two-layer abstraction**
that any of the three substrates can implement identically.

### Layer 1 — Immutable content-addressed monoid (the DAG)

Beads, comments, edges, trees, and commits are **immutable blobs keyed by
digest**. The operation over the blob set is union over reachable digests; it
is associative, commutative, and idempotent. Writes are deterministic functions
of content — there is no consistency story to engineer at this layer.

This is exactly the factoring git, OCI/containerd, and IPFS use. *Containerd's
image-as-DAG is the right mental model; etcd/Raft is the wrong one.*

### Layer 2 — Mutable single-writer registers (the refs)

Branches, tips, and named pointers are entries in a **small array of mutable
linearizable cells**, each holding one digest, updated by `compare-and-swap`.
Single-writer-per-register is the easy case of consensus: no Paxos, no Raft.
On workerd this comes free — a Durable Object is single-threaded per instance,
so the DO **is** the consensus boundary for its refs. On native it's the
SQLite write transaction. On edge KV it's the `cas`/`ifMatch` semantics.

"Branch" is just an indexing convention over the ref namespace
(`refs/agents/<id>`, `refs/main`). It is not a primitive.

### Substrate interface — five primitives

Anywhere these five ops exist, the abstraction is implementable identically:

```ts
interface BlobStore {
  put(bytes: Uint8Array): Promise<Digest>;          // idempotent
  get(digest: Digest): Promise<Uint8Array | null>;
  has(digest: Digest): Promise<boolean>;            // for GC reachability scans
}

interface RefStore {
  cas(name: string, expected: Digest | null, next: Digest): Promise<boolean>;
  list(prefix: string): Promise<Array<[string, Digest]>>;
}
```

Atomic multi-blob commit is **not** required. Content-addressing makes blob
writes idempotent and order-insensitive; the ref CAS is the single
linearization point. The writer must order: *write all reachable blobs first,
then CAS the ref.* This is git's loose-objects-then-update-HEAD invariant,
restated.

Substrate mappings:

| Substrate | `BlobStore`                          | `RefStore`                         |
| --------- | ------------------------------------ | ---------------------------------- |
| workerd   | DO SQLite `(digest BLOB, bytes BLOB)` table | DO SQLite `(name TEXT, digest BLOB)` table; DO single-threadedness gives per-ref linearizability |
| native    | regular SQLite (same schema), or `ley-line` content store | regular SQLite write txn |
| edge KV   | `kv.get/put` keyed by digest         | KV with `cas` / `ifMatch`          |

### Merge is two operations, not one

Treating "merge" as one op is the third hidden conflation. It is two:

1. **DAG-level LCA discovery** — pure graph theory over the immutable monoid.
   Substrate-free; it's just walks over `parent` pointers. Same algorithm
   everywhere.

2. **Per-field reconciliation** — a join on a small lattice defined per bead
   field. This is strictly cleaner than git's textual 3-way merge because
   beads are *structured*:

   | Field         | Lattice                       | Join                       |
   | ------------- | ----------------------------- | -------------------------- |
   | `tags`        | set-union                     | `a ∪ b`                    |
   | `priority`    | total order, `max`            | `max(a, b)`                |
   | `description` | LWW (last-writer-wins by ts)  | `latest(a, b)`             |
   | `state`       | MV-register                   | retain both, surface conflict |
   | `comments`    | append-only list (CRDT)       | concatenate, dedup by id   |

   Each lattice is associative, commutative, idempotent, so the merge
   operator `(base, a, b) → commit` is well-defined and substrate-free.

The merger has CRDT semantics where they help (no spurious conflicts on tag
addition) and explicit history where the workflow needs it (the LCA gives you
"the snapshot agent X saw when they branched"). You cannot get this hybrid
from a pure CRDT (no history-as-object, no veto on concurrent edits) or from
pure git (no structured field-aware merge, requires text reconciliation).

### Bead canonical form

A bead blob's bytes are a deterministic canonical serialization (e.g. JSON
with sorted keys + UTF-8 + LF) of:

```ts
{
  schema:    "bead/v1",
  parents:   Digest[],          // 0 (root) | 1 (linear) | 2+ (merge)
  fields: {
    title, description, state, priority, labels, repo, created_by, ...
  },
  ts:        ISO8601,
  author:    string,
}
```

Comments are separate blobs referencing their owning bead's digest. Trees and
ref tips compose them. Deterministic serialization is the only way two
substrates can produce identical digests for the same logical bead — a
testable substrate-independence property.

## Consequences

**Positive:**

- Branch-per-agent isolation is real, not an aspiration. `refs/agents/<id>`
  is one row in a CAS-able table; agents can write concurrently with no
  coordination beyond their own ref.
- Substrate independence is mechanically testable: write a bead via
  `WorkerdBlobStore`, write the same bead via `SqliteBlobStore`, assert the
  digests match. No per-substrate bead-shape divergence is possible.
- Sync between cloister instances becomes containerd-style: "do you have
  this digest? no? send it." Out of scope for this ADR but trivially layered
  on top of the primitives.
- Per-field merge lattices give CRDT-quality concurrent editing for the
  fields that benefit (tags, comments) without giving up explicit history
  for the fields that need it (state).
- No new runtime dependency. No DoltLite, no embedded DB engine, no WASM. The
  storage *is* the abstraction; the abstraction is just data structures.
- Same code path on Mac, Linux, and edge — the constraint that motivated
  rejecting the WASM path.

**Negative / risks:**

- Migration: existing beads in the current flat-table schema must be
  converted to root-commit blobs. Implementable as a one-shot script;
  testable against a known fixture.
- Garbage collection is now a real concern (unreachable blobs). Mitigated by
  `blob_has` + `ref_list` enabling mark-and-sweep; can be lazy.
- Querying ("show all open beads in repo X") requires either an index built
  off ref tips, or a full traversal. The current SQL `WHERE state='open'` is
  trivially fast; we'll need indexes maintained inside the DO at write time.
  Index correctness becomes a test obligation.
- The MCP tool surface (`bead_create`, `bead_update`, etc.) stays identical
  for callers, but the implementations become 2× longer (write blob, then
  CAS ref). Worth it for the structural payoff.

**Out of scope for this ADR:**

- Network sync between cloister instances (the containerd "fetch missing
  digests" protocol)
- A UI for visualizing the branch DAG
- Replacing the bead schema itself (`schema: "bead/v1"` is for future
  evolution; not part of this restructure)
- Conflict resolution UX when MV-register fields surface a conflict
- ley-line integration as an alternative `BlobStore` (worth a follow-up bead;
  `ley-line` is content-addressed by design)

## Work items

Tracked in [`cloister-82a851`](#) (re-scoped 2026-04-29 from "DoltLite WASM
evaluation" to this ADR's structural work). Sliced as:

- [ ] Define `BlobStore` + `RefStore` interfaces in `src/storage/`
- [ ] Implement `WorkerdBlobStore` + `WorkerdRefStore` (DO SQLite-backed)
- [ ] Bead canonical-bytes serializer + digest function (must round-trip
      identically across substrates — testable)
- [ ] Migrate `BeadStore` DO's `fetch` handler to write-blob-then-CAS-ref
- [ ] Per-field merge lattice for the existing bead schema
- [ ] LCA + 3-way merge driver (substrate-free; pure graph)
- [ ] Index-on-write inside the DO so `bead_list?state=open` stays fast
- [ ] Migration: convert existing flat-table beads to root commits
- [ ] Substrate-equivalence test: same bead → same digest on workerd vs
      native SQLite

## See also

- [ADR-0001](0001-workerd-mcp-gateway.md) — workerd choice; this ADR
  retires its DoltLite WASM work item
- [ADR-0002](0002-edge-router-protocol-agnostic-backends.md) — the edge
  router seam this storage layer plugs under
- [ADR-0004](0004-capnp-manifest.md) — declarative manifest for routes +
  backends (orthogonal to this ADR; storage and registration are independent)
- [ADR-0005](0005-internal-wire-leyline-net.md) — internal wire format;
  shares the digest shape this ADR defines (manifest contentHash = same SHA-256)
- [../ARCHITECTURE.md](../ARCHITECTURE.md) — runtime model
- [../../GETTING-STARTED.md](../../GETTING-STARTED.md) — hands-on setup
- Math-friend analysis (theoretical-foundations-analyst, 2026-04-29):
  `_agent_log/theoretical-foundations-analyst_2026-04-28_agent_log.md`
- Bead `cloister-82a851` — implementation tracking
- Bead `ley-line-3278b4` — sibling substrate ADR in ley-line (Merkle DAG +
  typed ports + (code-root, state-root) pair); this ADR is its bead-store
  application at smaller scale
