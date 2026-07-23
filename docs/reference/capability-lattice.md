# Capability lattice — declaring `provides` / `requires`

How to wire cluster inputs by **capability** instead of by hand. Per
[ADR-0027](../adr/0027-substrate-as-kernel-capability-matchmaker.md); the
resolver lives at `scripts/capability-matchmaker.mjs` and runs as part of
`task cluster:toml`.

> **Status:** the resolution core (steps 1, 2, 4 of ADR-0027) ships and is
> enforced at build time. **No input declares a lattice yet**, so today the check
> is a no-op — it is wired now so the *first* declaration is validated rather
> than the check arriving after a broken graph has already shipped. Steps 3
> (capability-typed route binding) and 5 (emit the wired manifest) are not built.

## The model

Each input is a node with **studs out** (`provides`) and **anti-studs in**
(`requires`). The matchmaker connects them:

```toml
[inputs.mache]
ref      = "github://agentic-research/mache/server.json@<sha>"
provides = ["cloister/code-intelligence/v1"]

[inputs.openclaw]
ref      = "github://…/server.json@<sha>"
requires = ["cloister/code-intelligence/v1"]
```

Run `task cluster:toml`. If the lattice resolves, `openclaw` is bound to
`mache` and the build proceeds. If it doesn't, **the build fails** — the point
is that an unsatisfiable declaration is rejected, never silently approximated.

Capability refs are reverse-DNS + major version: `cloister/<name>/v1` for
first-party, your own DNS root for third-party (`io.github.org/<org>/<name>/v1`).
Versioning is major-only; `v1` stays indefinitely for back-compat.

## What gets rejected, and why

All four are build failures, with the consumer and capability named:

| code | when | example message |
|---|---|---|
| `unsatisfied` | nothing provides a required capability | `input "openclaw" requires "cloister/code-intelligence/v1" but no input provides it` |
| `ambiguous` | two or more inputs provide it | `input "openclaw" requires "cap/v1"; ambiguous between mache, llo — set an explicit binding override` |
| `self-provided` | an input requires what only it provides | `input "solo" requires "cap/v1" but only provides it to itself` |
| `cycle` | the require-graph loops | `cycle in capability graph: a → b → a` |

`self-provided` is rejected because self-satisfaction isn't wiring — it
degenerates the lattice into a node with no real edge. `cycle` renders the
offending path rather than just asserting one exists, so you can see what to cut.

## The substrate is a provider too

Not every capability comes from an input. cloister implements some **itself** —
[ADR-0024](../adr/0024-credential-isolation-capability.md)'s
`cloister/credential-isolation/v1` (the vault proxy) and `cloister/confinement/v1`
are the live examples. An input may `require` those without any input providing
them:

```toml
[inputs.rosary]
requires = ["cloister/credential-isolation/v1"]   # satisfied by the substrate
```

Such a binding resolves with the provider `<substrate>`. Two consequences worth
knowing:

- A substrate capability never trips the `self-provided` check — the substrate
  is always external to an input.
- If an **input also declares** a substrate capability, that is `ambiguous`, not
  silently shadowed. Two implementations of one capability is a decision an
  operator must make explicitly.

The list lives in `scripts/toml-to-cluster.mjs` (`SUBSTRATE_CAPABILITIES`). When
ADR-0027's `cloister-spec/cloister/<name>/v<n>/` directory convention lands, it
should be derived from the filesystem instead of maintained by hand.

> This gap was found by *wiring* the matchmaker rather than reasoning about it:
> the build gate immediately rejected a real fixture declaring
> `requires = ["cloister/credential-isolation/v1"]`, because the original model
> only treated inputs as providers. The declaration was correct; the model was
> wrong.

## Breaking ambiguity

When more than one input provides a capability, the matchmaker will not guess.
Name the winner explicitly:

```js
matchCapabilities(inputs, { overrides: { "cloister/code-intelligence/v1": "mache" } });
```

An override naming an input that does **not** provide the capability is itself
rejected (`bad-override`) — otherwise a typo would silently reinstate the
ambiguity it was meant to resolve.

## Why the build fails instead of picking one

This is the symbolic half of [ADR-0054](../adr/0054-neuro-symbolic-dispatch.md).
The whole argument there is that dispatch decisions must be **adjudicated
against a committed manifest**, not guessed — and that an unsatisfiable request
must produce a *precise error naming what is missing* rather than a
plausible-looking wrong answer. A matchmaker that picked arbitrarily when two
inputs collide would reintroduce exactly the failure mode ADR-0054 exists to
prevent, just moved from the model into the resolver.

## Adding a new capability

Per ADR-0027, a new capability is drop-in — no core edits:

1. Add `cloister-spec/cloister/<name>/v1/` (README + wire docs, optional vectors).
2. Add `src/capabilities/<name>/v1/handler.ts` exporting `{ register, dispatch, verify }`.
3. Operators declare `provides` on the input that implements it.
4. Operators declare `requires` on inputs that consume it.
5. `task cluster:toml` wires them.

## Known limitation

The lattice is **coarse**: a capability grants a provider's whole tool surface.
An input providing 12 tools (10 read, 2 write) grants all 12 — the per-tool
`readOnly` annotation MCP servers publish is dropped at ingest, because the
governing spec (`leyline-schema-spec/mcp-tool/v1`, LLO-owned) defines a group's
tools as a flat `upstreamNames` string list with nowhere to hang it. Tracked in
`cloister-5a4eb3`; fixing it starts with an LLO spec change, not a cloister one.
