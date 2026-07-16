---
title: "ADR-0048: The unified tool primitive — cloister defines tooling (definition-inside-the-boundary)"
status: Proposed (2026-07-16)
date: 2026-07-16
tags: [tool, capability, sandbox, provenance, substrate, mediation, generic]
threat_model: docs/security/threat-model.md
relates_to:
  - 0011-hypervisor-bundle-boundary.md
  - 0013-slice-grant-enforcement.md
  - 0026-tool-composition-model.md
  - 0038-derive-bundle-image-from-packages.md
  - 0043-delivery-plane-skills-agents-tools.md
  - 0044-compute-isolation-substrate.md
  - 0046-mediated-capability-core.md
---

## Context

Five ADRs each describe part of "what a tool is" in cloister, but none names the
whole:

- **ADR-0026** — tool *composition* (content-addressed, MCP-registry-resolved,
  Interlace-signed).
- **ADR-0043** — tool *delivery* (skills / agents / tools as signed artifacts,
  via cloister not the ambient filesystem).
- **ADR-0046** — tool *mediation* (the capability core: a caller presents a
  lease/token, the adapter verifies + scope-checks + receipts, never trusts a
  passed identity).
- **ADR-0044** — tool *sandbox* (compute-isolation substrate: V8 isolate or
  libkrun microVM).
- **ADR-0013** + the `confinement` facet (`cloister-a34edc`, lint Inv 11) — tool
  *capability declaration* (which credentials, which FS/syscalls, which peers).

These are facets of a single primitive we have been building without naming.
Naming it is not new construction — it gives the roadmap a spine and states the
security principle the whole substrate already depends on.

**The security principle (the reason to write this down).** The vault taught the
lesson at the credential layer (ADR-0047, threat-model §20): *the vault never
trusts a passed identity — it derives identity from a definition it verifies
inside its own boundary.* This ADR is that principle generalized to tooling:

> **cloister must never trust a passed *capability*. What a tool may do is
> derived from a definition cloister holds inside the trust + sandbox boundary —
> never asserted by the tool, the caller, or the agent prompt.**

If the definition lives *outside* the boundary (in rosary, in a config file, in
an agent's prompt), a tool's capabilities are *asserted* — ambient authority,
positional trust: the exact hole ADR-0046/0047 close one layer down. The
definition-inside-the-boundary is what makes tooling secure, not a wrapper added
after the fact.

## Decision

Adopt the **unified tool primitive**. A cloister *tool* — of any kind — is four
**declared** facets, resolved and enforced inside the boundary:

| Facet | What it declares | Where it already lives |
|---|---|---|
| **Identity** | who the tool is, provably — content-addressed + Interlace-signed | ADR-0026, ADR-0043 |
| **Capability** | what it may do — vault slices (creds), `confinement` (FS/syscalls), service bindings (peers), egress | vault / ADR-0013 / `a34edc` Inv 11 |
| **Sandbox** | where it runs — V8 isolate (cluster-tier) or microVM (untrusted / native) | ADR-0044 |
| **Invocation** | how it is called — mediated `/mcp`, service-binding-as-syscall, vault-proxy; every call emits a receipt | ADR-0046, ADR-0043 receipts |

**Generic by construction.** The same four facets describe every kind:

- **GitHub / Linear / Slack** — an `mcpProxy` tool with a scoped credential facet.
- **An LLM** — a tool whose capability is a vault-credentialed egress.
- **A skill** — a signed FS artifact whose invocation is a mediator load-event.
- **An agent** — a sandboxed dispatch (rosary), invoked through the mediated plane.

There is no per-vendor special-casing. Because GitHub and an agent are the *same
primitive*, one event stream, one policy surface, one timing/attestation ledger
covers all of them uniformly. (This is why the event-trigger work below is a
single generic mechanism, not N integrations.)

### Definition vs implementation (what keeps it generic, and not a monolith)

cloister owns the **definition** — the capability grant, the sandbox assignment,
the signature/identity. cloister does **not** own the **implementation** — the
code may come from anywhere: an OCI image (ADR-0038 `server.json` `packages[].oci`),
an external MCP server, a git ref, a native binary. *Any* implementation becomes a
secure tool by acquiring a cloister-held definition. cloister is the **resolver +
enforcer** of tool definitions, never the author of tool code. This split is what
keeps the primitive open and general instead of turning cloister into a monolith
that must contain every tool.

### The security property, stated precisely

Given a tool whose definition is resolved inside the boundary, cloister
guarantees:

1. **No ambient authority** — the tool cannot exercise a capability its
   definition did not grant (creds, FS, peers, egress are all declared + mediated).
2. **No sandbox escape by assertion** — the tool runs in the sandbox its
   definition assigns; it cannot re-declare its own isolation.
3. **Attested invocation** — every call through the mediated plane emits a
   receipt, so *what a tool did* is provable (ADR-0046 §receipt, signet/APAS).

All three hold **only because the definition is inside the boundary.** Move the
definition out and each collapses to positional trust.

## Consequences

- **Roadmap spine.** Every substrate increment is now legible as "make one more
  facet converge on the tool primitive." The sandbox facet (ADR-0044 / libkrun,
  S3) is the one not yet shipped and remains the near-term focus — it is a
  *facet*, so this ADR does not reorder it.
- **First concrete increment — event-triggers / hooks.** The Invocation facet
  already emits typed events (SkillLoadReceipt ADR-0043; `ProxyCallReceipt`;
  vault-access attestation §13.4). Add a declarative `trigger`/`hook` manifest
  kind — `on: <typed event predicate> → do: <mediated action>` — generalizing
  `Route` from HTTP-ingress to *internal* tool events. This turns receipts from
  audit-only into **policy** (`on skillLoad matching <sensitive> →
  require-attestation | alert | deny`) and makes cloister the single mediated
  chokepoint where every tool's timing + policy lives in one stream. Rails:
  hook actions go through the mediated plane (no raw-egress side-channel, §20.9);
  cycle/depth bounds (ADR-0046 inflight-cap); append-only schema (ADR-0004).
  Tracked as the first tool-primitive bead; supersedes/absorbs the scattered
  timing bead (`cloister-9cbf6c`).
- **Differentiation, sharpened.** Vercel Connect defines a *connector* (a
  credential broker). The tool primitive defines a *capability-sandboxed-signed-
  attested unit* — a category deeper. "Durable execution, but every step
  capability-mediated and provable" is the event-trigger facet's external face.
- **No big-bang.** This ADR names an *emergent* abstraction; it is realized by
  making the existing facets share one `tool` declaration incrementally, not by a
  rewrite. Existing `Backend`/`Route` kinds are already facet-shaped; convergence
  is additive.

## Non-goals

- cloister does **not** become the home for tool *implementations* (see the
  definition/implementation split). Tool code stays in its own repos/registries.
- This is **not** a new manifest schema in one shot — the `trigger` kind (first
  increment) is; the broader `tool` unification is a framing that guides
  append-only evolution of the existing kinds, each behind its own ADR amendment
  when it lands.

## Open questions (for the increments, not this ADR)

- The exact `trigger`/`hook` predicate + action schema (its own ADR when the kind
  is added — new kind + new internal-event-bus seam per the CLAUDE.md "write an
  ADR first" rule).
- Whether `Backend.kind` and a future `Tool` become one declaration or stay
  parallel-but-aligned — decide at the point the second facet converges, not now.
