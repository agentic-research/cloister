# ADR-0022 — schema-bridge as the substrate-IDL codegen pipeline

- **Status:** Accepted (2026-05-18)
- **Tracking bead:** `cloister-9443f0` (this ADR, dispatched as L4 of the
  `substrate-IDL` decomposition under `cloister-ae587d`)
- **Framing:** `cloister-1b59a2` (substrate-as-kernel). This ADR is the
  hole-filler between ADR-0021 and ADR-0023 — the prior-art entries
  (`smithy.md`, `buf.md`, `wit.md`) cross-reference an "ADR-0022 —
  schema-bridge positioning" that the directory has been waiting on.
- **Pairs with:** ADR-0004 (capnp manifest, append-only ordinal rules),
  ADR-0024 (`credential-isolation/v1` — the first capability spec the
  pipeline serves), ADR-0025 (bidi TOML ↔ capnp — the operator surface
  that consumes the zod target).

## Context

`tools/schema-bridge/` is a Rust crate that runs as a Cap'n Proto compiler
plugin (`capnpc-schema-bridge`). It reads a capnp `CodeGeneratorRequest`
on stdin, lowers each node into a small intermediate representation
(IR), and emits zod TypeScript. It is the seam between the cloister
capnp schemas (`manifest/*.capnp`, `cloister-spec/**/*.capnp`,
`interlace-spec/0.1.0/`) and the runtime validation surface
(`src/generated/*.zod.ts`).

Today it is **one input, one output, one consumer**:

- Input: capnp schemas under the cloister repo.
- Output: zod TS.
- Consumer: cloister itself (cluster manifest, manifest schemas,
  eventually the bidi TOML pipeline of ADR-0025).

The README in `tools/schema-bridge/README.md` is honest about the
shape: "single source of truth, fail-fast codegen, designed to be
extracted to its own crate once it stabilises." It also enumerates
the deliberately-unmapped constructs (`interface`, `const`,
`anyPointer`, generics, annotations) as hard errors rather than
silent `z.unknown()` fallbacks. That invariant — *every gap is loud* —
is the one property that lets us treat the tool as a substrate seam
instead of a hand-rolled converter.

Three forces have made the positioning question unavoidable:

1. **The substrate-IDL framing landed.** The
   `~/github/jamestexas/agents/docs/problems/substrate-idl.md`
   decomposition names the substrate as "vendor-neutral capnp +
   canonical traits + diff tooling + multi-target codegen." Every
   leaf in that lattice (L1 const support, L2 `_traits.capnp`, L3
   `diff` subcommand, L5 `art.lock` schema) points at schema-bridge
   as the artifact it modifies. Without an anchor ADR, every one of
   those leaves hangs on prose-only justification.
2. **The capability-spec pattern needs a codegen story.** ADR-0024's
   `cloister-spec/credential-isolation/v1/` ships a `wire/` + `ref-impl-py/`
   pair; the second-implementation property only holds if non-Python
   consumers can generate validators from the same source. Today they
   can't — schema-bridge's zod target is TS-only.
3. **The prior-art board (`_baseline.md` Axis 4) is unambiguous.** No
   Rust target, no Go target, no JSON Schema target, no plugin model,
   no breaking-change detection. The gap is *connection*, not
   primitives. The Cap'n Proto plugin protocol already exists; the
   IR already exists; what is missing is the commitment that
   schema-bridge is **the** place the new targets and the new tooling
   land — not a parallel `capnp-to-go.ts` hand-mirror in a sibling
   repo, not a fork, not a rewrite.

This ADR is that commitment.

## Decision

**schema-bridge is the canonical capnp → {target} codegen pipeline for
the art substrate.** Cap'n Proto is the IDL of record. New targets,
new annotations, and breaking-change detection all land in
`tools/schema-bridge/` and ride the existing IR.

Concretely, this ADR commits to four positions:

### 1. Cap'n Proto stays the IDL of record

We do not migrate to Smithy, WIT, Protobuf, or any other IDL. The
ADR-0004 guarantees (append-only fields, monotonically-increasing
ordinals, never renumber) are the substrate's schema-evolution contract,
and they ride on capnp's own ordinal rules. Migrating would either drop
those guarantees or re-derive them on a foreign schema engine; neither
is worth it for the marginal gains a different IDL would bring.

### 2. schema-bridge is the codegen seam

Every consumer-side validator derived from a cloister capnp schema
goes through schema-bridge. No hand-mirrored zod schemas, no hand-
written Go structs against the wire format, no parallel "capnp-to-X"
scripts. The IR is the choke point. The fail-fast invariant
(every unmapped construct throws `UnmappedConstruct`) carries forward.

Today schema-bridge ships one emit target (zod TS). This ADR commits
to the **plugin shape** the prior-art entries (`smithy.md` Decision
§Borrow, `buf.md` Decision §Borrow, `wit.md` Decision §Borrow) all
recommend: refactor `outputs/` into a registry of named emit targets,
each implementing a small trait. The first additional target lands
when a real consumer surfaces — almost certainly Rust (for the
ref-impl crates) or Go (for signet / mache / notme). Premature
target-fanout is rejected; the plugin shape is the rail, not the
fanout.

### 3. Canonical traits land in L2 (`cloister-spec/_traits.capnp`)

Annotations are how capability specs carry vocabulary — `$Sensitive`,
`$Scope(value)`, `$Capability(scheme, scope)`, `$Op(input, output,
errors)`, `$Since`, `$Deprecated`, `$Unstable` (see L2 of the
substrate-IDL decomposition for the full list and rationale). The
trait library is a separate dispatchable (`cloister-9443f0` blocks L2;
once this ADR lands L2 ships next). schema-bridge propagates trait
values into the emit IR so every target can lower them consistently —
zod metadata today, Rust `#[deprecated]` later, JSON Schema
`description` later still.

This ADR does **not** enumerate the trait names; that belongs to L2.
The commitment here is that the trait library is real, lives at
`cloister-spec/_traits.capnp`, and is what schema-bridge teaches its
targets to honor.

### 4. Breaking-change detection lands as `schema-bridge diff`

Per the L3 dispatchable and the Smithy/Buf Decision §Borrow items,
schema-bridge grows a `diff <old> <new>` subcommand that walks two
capnp schemas at the IR level and reports `Added` / `Removed` /
`Renamed` / `Retyped` per Buf's FILE / PACKAGE / WIRE tier model.
The existing `interlace-spec-drift.yml` workflow gates *data* drift
(SHA-256 vector digests + ref-impl-py byte equality); `schema-bridge
diff` is the *schema* drift gate that pairs with it.

This is what makes the ADR-0004 append-only contract enforceable
mechanically instead of by review discipline. Today it is enforced
only by the "don't renumber" social rule.

### What this ADR does NOT decide

- **The full trait list.** L2 (`cloister-9443f0`'s child) names them.
- **The plugin manifest shape** (`schema-bridge.gen.yaml` per Buf's
  `buf.gen.yaml`). Lands when the second target ships; premature
  before then.
- **When Rust / Go / JSON Schema targets ship.** "When a real
  consumer surfaces" is the rule. See §Open questions.
- **Whether schema-bridge eventually extracts to its own crate /
  repo.** The README says "designed to be extracted once it
  stabilises." That decision waits on (a) the plugin shape landing,
  (b) at least one non-cloister consumer existing. See §Open
  questions.

## Consequences

- **L2 (`_traits.capnp`) is unblocked.** Its problem statement
  references "ADR-0022 establishes the framing this library
  implements"; that ADR now exists. L2 can ship.
- **L3 (`schema-bridge diff` subcommand) is unblocked** on the same
  ground. The Smithy and Buf prior-art entries reference this ADR
  as the position commit.
- **L5 (`art.lock` capnp manifest schema in
  `cloister-spec/substrate-manifest/v0/`) is unblocked** — the
  framing doc that says "yes, the substrate-wide release manifest
  is a capnp artifact, derived through schema-bridge like every
  other consumer-facing schema" is this ADR.
- **L1 (top-level `const` support) and other construct gaps**
  (`cloister-9f54d6`, `cloister-9ea507`, `cloister-aea8a7`) become
  load-bearing for the substrate-IDL story, not just nice-to-haves.
  Each gap is a place where schema-bridge fails-loud today; closing
  them is the path to claiming "schema-bridge can emit every
  cloister-spec schema."
- **`schema-bridge.gen.yaml` becomes a candidate file** the first
  time a second target lands. Per Buf's `buf.gen.yaml` shape; folds
  into `tools/schema-bridge/` or sits at repo root next to other
  task entrypoints.
- **`task verify` is the eventual home for `schema-bridge diff`** —
  per the README's "wire `cluster:zod:check-drift` into `task verify`
  once mapping coverage stabilises" note. The drift gate becomes a
  hard CI failure once the diff subcommand lands and the trait
  coverage is stable.
- **External consumers of cloister-spec schemas** get a documented
  path: install `capnpc-schema-bridge`, run it against the spec dir,
  consume the emitted validator in their target language. No more
  "clone cloister, hand-mirror the struct."
- **`@notme/contract`** (the cross-ecosystem TS constants pin) gets
  a clean path to consuming capnp as source-of-truth via the const
  support in L1. This is the precise gap `_baseline.md` Axis 7
  flagged as the adoption-cost wall.

## Alternatives considered

| Alternative | Why skipped |
|---|---|
| **Smithy** as substrate IDL | Migrating means dropping ADR-0004's append-only ordinal guarantees (Smithy has its own evolution rules; they don't compose with capnp's). The trait library and `$Op` shape are the parts we want — and we *can* borrow them as capnp annotations through schema-bridge, without inheriting the JVM toolchain or the Smithy-specific identity descriptors. See `prior-art/smithy.md` §Decision §Skip. |
| **WIT + WebAssembly Component Model** | WIT is wasm-coupled by construction; our substrate runs across workerd, Firecracker, native Linux, and (eventually) unikernels per ADR-0009. Tying the IDL to one of those targets is the wrong shape. The `@since` / `@deprecated` / `@unstable` annotation pattern is the borrow; the IDL is the skip. See `prior-art/wit.md` §Decision §Skip. |
| **Buf / Protobuf** | Same trade as Smithy: Buf's tooling story is excellent, but adopting it means migrating off capnp. Buf's `breaking --against`, FILE/PACKAGE/WIRE rule tiers, and `buf.gen.yaml` shape are the borrows; BSR-as-a-service and protobuf-the-IDL are the skips. See `prior-art/buf.md` §Decision §Skip. (Buf turned out closer than expected on the tooling axis — see §Open questions.) |
| **Hand-mirrored zod schemas (status quo before schema-bridge)** | What notme's `capnp-to-ts.ts` did before this tool existed: silently emit `z.unknown()` for unrecognised constructs. The precise failure mode schema-bridge exists to prevent. Rejecting this is what schema-bridge already does; naming it here makes the rejection explicit. |
| **One repo per target** (separate `capnp-to-rust`, `capnp-to-go`, etc.) | Fragments the IR. Every fix to a capnp-construct mapping has to land in N repos. Concentrating the IR in `tools/schema-bridge/` and letting each target be a plugin against the same IR is what the prior-art entries (Smithy, Buf, WIT) converge on. |
| **Defer the positioning ADR until a second target lands** | Then L2, L3, L5 stay blocked on prose-only justification (the prior-art entries already cite a not-yet-existing ADR-0022). Cost of writing this now: one ADR. Cost of waiting: every substrate-IDL leaf stays pre-dispatchable until the trigger event. The asymmetry says write it now. |

## Open questions

1. **When does the Rust target ship?** The first non-TS consumer is
   probably the ref-impl crates under `cloister-spec/**/ref-impl-rs/`
   (does not exist today; ADR-0024's `ref-impl-py/` is the precedent).
   Trigger: someone wants to write a second-implementation conformance
   check in Rust and runs into the hand-mirror wall. File a bead at
   that point; do not pre-empt.
2. **When does the Go target ship?** signet / mache / notme are
   Go-stack; today they don't consume cloister capnp schemas
   directly. The likely trigger is the `art.lock` substrate manifest
   (L5) — a Go-side tool that reads the lockfile to drive multi-repo
   release coordination would be the first real consumer. File a bead
   then.
3. **Does schema-bridge extract to its own repo?** Per the README's
   "designed to be extracted once it stabilises" note. The criteria
   should probably be: (a) the plugin shape lands and at least two
   targets ship, (b) at least one external consumer (not in the art
   ecosystem) exists. Until both are true, extraction is busywork.
   File a follow-up ADR when the criteria trigger.
4. **What is the canonical home for substrate-wide specs?**
   `cloister/cloister-spec/` today; `cloister/interlace-spec/` is the
   asymmetric outlier. L6 (`cloister-spec/LAYOUT.md`) is the
   documentation half of this; the *move* (NL5 in the decomposition)
   waits on L6 deciding the canonical home. This ADR does not pre-empt
   that decision; schema-bridge consumes whatever path the spec dirs
   end up on.
5. **Workload-identity vocabulary alignment** (the SPIFFE / WIMSE arc
   from L10/L11 of the decomposition) will eventually want a vendor-
   neutral name for our identity-token shape. Whether that lands as a
   future ADR (separate number, not reserving 0026 — ADR-0026 was
   taken by the tool-composition-model decision two days ago) or as a
   layer inside `_traits.capnp` is undecided. The decomposition's
   bead spec referenced "ADR-0026 reserved for WIMSE/SPIFFE
   (`cloister-2f021f`)" — that reservation is stale; ADR-0026 is now
   `tool-composition-model`. Re-number the WIMSE decision when it
   lands.
6. **How does schema-bridge handle annotations from
   `capnp/compat/json.capnp`** (`$Json.flatten`, `$Json.discriminator`,
   `$Json.name`, etc.)? Today they are in the deliberately-unmapped
   list (the README enumerates them as fail-loud). Once L2's trait
   library lands and the plugin shape is real, the JSON-compat
   annotations are the natural second-class citizens — they affect
   emit, not just metadata. Whether they land as part of L2 or as a
   separate construct-coverage bead is undecided.

## Tracking

- Bead: `cloister-9443f0` (this ADR; L4 of the substrate-IDL
  decomposition).
- Decomposition: `~/github/jamestexas/agents/docs/problems/substrate-idl.md`.
- Framing: `cloister-1b59a2` (substrate-as-kernel).
- Parent meta-bead: `cloister-ae587d` (schema-bridge positioning ADR
  — this is its execution).
- Unblocks: `cloister-9f54d6` (construct coverage meta), `cloister-9ea507`
  (L1 const support), L2 (`_traits.capnp` — bead TBD), L3 (`diff`
  subcommand — bead TBD), L5 (`art.lock` schema — bead TBD).
- Sibling first-wave leaves: L1, L6, L7 (running in parallel; this
  ADR is each of their framing anchor).
- Prior-art consulted (all read end-to-end):
  - `~/github/jamestexas/agents/docs/prior-art/smithy.md` §Decision
  - `~/github/jamestexas/agents/docs/prior-art/buf.md` §Decision
  - `~/github/jamestexas/agents/docs/prior-art/wit.md` §Decision
  - `~/github/jamestexas/agents/docs/prior-art/_baseline.md` Axis 4
