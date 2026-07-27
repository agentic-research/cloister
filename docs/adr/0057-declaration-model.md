---
title: "ADR-0057: The declaration model — intent is authored once, settled everywhere"
status: Proposed (2026-07-27)
date: 2026-07-27
tags: [declaration, capability-lattice, harness, composition, projection, intent, acl]
threat_model: docs/security/threat-model.md
relates_to:
  - 0016-cloister-as-private-mcp-registry.md
  - 0026-tool-composition-model.md
  - 0027-substrate-as-kernel-capability-matchmaker.md
  - 0028-capability-scheme.md
  - 0036-schema-bridge-multi-output.md
  - 0043-delivery-plane-skills-agents-tools.md
  - 0048-unified-tool-primitive.md
  - 0054-neuro-symbolic-dispatch.md
---

# ADR-0057: The declaration model

Tracking bead: `cloister-742e19`.

## Context

Four surfaces in this substrate already let something declare *how it works*.
They grew independently, they overlap, and none of them agrees on a shape.

**1. The project's own registry document.** `server.json` with
`_meta."art.cloister/v1"` — canonical-hours declares its tenancy mode, its
trusted tier, and its tool groups in its own repo, and cloister's resolver
consumes it (`scripts/resolve-inputs.mjs`; ADR-0016, ADR-0038).

**2. The capability lattice.** An input declares `provides` / `requires` and the
matchmaker (`scripts/capability-matchmaker.mjs`) resolves them at
`task cluster:toml` (ADR-0027, ADR-0028). Unsatisfied, ambiguous, self-provided,
and cyclic declarations fail the build. **No input declares a lattice today** —
the gate is wired so the first one is checked, and nothing has been first.

**3. Harness configuration.** `scripts/harness-dev.mjs` hardcodes one vendor.
Codex and Claude Code are both legitimate targets and they consume MCP
differently (`cloister-742e19`).

**4. Egress and credential reach.** Which component may reach which host with
which credential — `cloister/credential-isolation/v1` in this repo,
`globalOutbound` injection in rig (`rig-c1ba88`), provider credentials at the
egress boundary in canonical-hours (`canonical-hours-81723e`).

These look like four different problems. They are one problem seen from four
sides. Every one of them is a component saying: *this is what I am, this is what
I need, this is what I may touch.*

The cost of not naming that is visible in surface 3. "Support Codex" was read as
a code task and answered with a code path. A second vendor means a second
branch, a third means a third, and the substrate accumulates vendor knowledge it
has no business holding. The same pressure exists at every other surface: each
consumption point is tempted to re-author the declaration in its own idiom.

## Decision

**Intent is authored once, at the site that holds it, and settled — never
re-authored — everywhere downstream.**

"Settling" is the operative word. A declaration is a statement of intent. What
happens downstream is resolution, merging, and projection: mechanical
transformations that may *fail*, but may never *invent*. The moment a consumer
adds intent the author did not state, the declaration has stopped being the
source of truth and the substrate has forked.

Three properties follow.

### A. The declaring site is the site that knows

A project declares its own surface in its own repo. Cloister resolves; it does
not author. canonical-hours already works this way and it is the pattern, not
the exception: `server.json` lives in canonical-hours, and cloister reads it.

The negative form matters more. Cloister must not accumulate a table of facts
about components it does not own. A per-project branch inside cloister is the
smell that a declaration is missing upstream.

This extends to contracts. The `credential-isolation/v1` wire spec is authored
in ley-line-open (`rs/ll-core/schema-spec/`), not here — cloister bridges, never
reimplements (ADR-0035). Cloister's `InjectionStrategy`
(`src/routes/vault-proxy.ts:21`) is a hand-mirror of that spec and is therefore
a declaration authored in the wrong place; `ley-line-open-e7f466` replaces it
with generated bindings.

### B. A harness is a lattice participant, not a target

Codex and Claude Code declare `requires`. They do not get branches.

The substrate already has the machinery: `provides` / `requires` with a
fail-closed matchmaker. A harness declaring `requires: mcp-transport/stdio` and
another declaring `requires: mcp-transport/streamable-http` is two rows in a
lattice, resolved by the same code path that resolves everything else — and
failing the build if nothing satisfies them, rather than silently picking one.

This is the answer to "make it configurable, Codex or Claude Code is a target."
Neither is a target. Both are participants, and adding a third is a declaration,
not a patch.

It also gives the lattice its first real inhabitant. A gate with no traffic is
untested; the harness rows exercise it against a case that genuinely has two
incompatible options, which is exactly the case a fail-closed matchmaker exists
to catch.

### C. Per-harness divergence is a projection, not a fork

MCP in Codex is not MCP in Claude Code. That difference is real and it is not
going away. It is also not a *semantic* difference — the same tool, the same
scopes, the same credentials, emitted into two configuration dialects.

That is ADR-0036's multi-output IR, applied to configuration: one settled
declaration, N emitted projections. The divergence lives in the emitter, where
it is mechanical and testable, not in the declaration, where it would multiply.

The test for whether something belongs in the declaration or the projection:
**would a reader of the declaration be surprised to learn it?** Transport
framing, file layout, and key casing are projection concerns. What a tool may
reach is not.

### D. Composition is declaration over declared units

A toolset is composed from units that have already declared themselves, plus a
statement of what may access what.

That access statement is itself a declaration, settled by the same matchmaker,
with the same fail-closed property: an ACL naming a tool that does not exist, or
granting reach nothing provides, fails the build rather than resolving to
nothing. Per-tool ACL is the granularity, because the tool is the unit the
operator reasons about and the unit ADR-0048 already made primitive.

Affinity ("works well with") is a declaration too, and a weaker one — it informs
resolution when several candidates satisfy a requirement, and it must never be
load-bearing for correctness. A composition that only works because of an
affinity hint is a composition with an undeclared requirement.

## Consequences

**The lattice gets used.** Its first inhabitants are the harness rows. Until
now, the fail-closed guarantee has been asserted rather than exercised.

**Vendor knowledge leaves the substrate.** Harness-specific behavior moves from
code branches to declared rows and emitter projections. Adding a harness stops
touching cloister's logic.

**Failures move to build time.** An unsatisfiable harness, a missing tool in an
ACL, an ambiguous capability: all become build failures with a named cause,
which is the symbolic half of ADR-0054 — the model parses, the substrate
decides.

**Declaration sites must be enforced.** A rule about *where* intent is authored
is exactly the kind of invariant this repo has repeatedly discovered rotting
after being written down once. It needs a rail, in the same change: cloister
must not contain per-project or per-vendor tables that upstream should own.
Without one, this ADR is a comment.

**Migration is incremental.** Each surface converges independently. Surface 3
(harness) is the natural first, because it has a live motivating bead and
because it supplies the lattice's first declarations.

## Alternatives considered

**A harness abstraction layer in cloister.** An interface with a Codex
implementation and a Claude Code implementation. Rejected: it puts vendor
knowledge in the substrate and grows linearly with vendors. It is surface 3's
current shape, generalized — the thing that prompted the correction.

**One declaration format to replace all four.** A single schema every surface
adopts. Rejected as premature: the four surfaces have genuinely different
authors and lifecycles, and forcing one document would relocate authorship away
from the site that holds the intent, violating property A. Convergence is on the
*model*, not the file format. The formats may converge later, once more than one
input has actually declared a lattice.

**Leave declarations advisory and resolve at runtime.** Rejected: it forfeits
the fail-closed property. A declaration that cannot fail the build is a comment,
and the substrate already has enough of those.

## Open questions

- **Does the ACL bind at the tool or at the group?** `server.json` already
  groups tools (`_meta."art.cloister/v1".groups[]`), and canonical-hours
  declares one unprefixed group of four tools. Per-tool is the stated
  granularity; whether groups are a projection over per-tool ACLs or a distinct
  declaration is unresolved.
- **How does affinity resolve ties deterministically?** "Works well with" must
  not make the build order-dependent. It likely needs a total order, not a
  preference set.
- **Where does a harness declaration live?** Property A says the site that knows
  — but a third-party harness has no incentive to declare into this substrate.
  Vendored declarations may be unavoidable, and if so they need to be visibly
  marked as such.
