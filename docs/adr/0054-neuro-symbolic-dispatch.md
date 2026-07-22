---
status: Proposed
date: 2026-07-22
tracking-bead: cloister-1b59a2
pairs-with: ADR-0027
---

# ADR-0054 — Neuro-symbolic dispatch: the model parses, the substrate decides

- **Status:** Proposed (2026-07-22)
- **Tracking bead:** `cloister-1b59a2` (substrate-as-kernel framing — same
  bead as ADR-0027, because this ADR is the runtime consumer of the
  matchmaker that ADR specifies)
- **Pairs with:**
  - ADR-0027 (capability matchmaker — the symbolic engine this ADR dispatches through)
  - ADR-0028 (capability identifier scheme — the formal language the parser targets)
  - ADR-0031 (`cloister.capnp` as build artifact — the phase separation this ADR leans on)
  - ADR-0040/0042 (mediated harness — the delivery vehicle for the neural half)
  - ADR-0053 (lease-gate authority resolution — the fail-closed discipline this ADR extends to dispatch)
- **Supersedes in spirit:** the dispatch portion of
  [`docs/proposals/agent-process-v1.md`](../proposals/agent-process-v1.md)
  (`cloister-339a22`, not scheduled — see Alternatives (b))

## Context

`docs/proposals/agent-process-v1.md` proposed that cloister host the
**server** side of ACP (Agent Client Protocol) in workerd — cloister *is*
the agent, invoking a model from inside a V8 isolate. That proposal is
blocked by a hard constraint, recorded in its own adoption note
(2026-07-22): the shape requires **programmatic API-key model access**,
and the operator's Claude Code Max subscription is **seat/session-authed,
not API-key-authed**. It is also the *inverse* of what cloister actually
shipped: ADR-0040/ADR-0042 have cloister **mediate** a harness (Claude
Code) running on the host — vaulting the credential and proxying the
call — which works with a subscription-authed harness precisely because
cloister never invokes the model itself.

The operator's counter-proposal from the 2026-07-22 working session: a
small, *in-boundary* local agent that dispatches other things — "like
how some tools spawn a subshell for you to operate in" — so it isn't a
weird out-of-boundary thing. The stated priority: **"the more
determinism the better."**

This ADR records what we learned trying to satisfy that priority the
obvious way, why the obvious way is wrong, and what the right shape is.
The right shape turns out to be mostly built already — cloister is
~80% of a neuro-symbolic production system that nobody had named as
one. The decision here is to name it, and to place the neural component
in the one slot where its failure modes cannot become dispatch
decisions.

## The failed first attempt (and why it is the most instructive part)

We tried to get determinism by making a small local LLM emit
tool-dispatch decisions directly, under **schema-constrained decoding**
(token-level grammar masking — llama.cpp GBNF / ollama structured
outputs) with `temperature: 0`, fixed `seed`, `top_k: 1`. The theory:
grammar masking guarantees schema-valid output, greedy seeded decoding
guarantees run-to-run stability, therefore the dispatcher is
"deterministic."

Measured on an Apple M3 Max / 36 GB, ollama 0.20.5:

| model | size | byte-identical over 5 runs | schema-valid | tool discrimination (3 cases) | latency |
|---|---|---|---|---|---|
| `functiongemma:270m` | 0.3 GB | yes (5/5) | 100% | **1/3** | 0.67 s |
| `llama3.2` (3B) | 2.0 GB | — | 100% | **1/3** (degenerate — always picked `search`) | — |
| `qwen3.5:4b` | 3.4 GB | yes (5/5) | 100% | **3/3**, args also clean | ~1.3 s |
| `gemma3:4b` | 3.3 GB | — | 100% | 3/3 tools, **2/3** args | — |

Caveats, stated plainly: **three** test cases, over a convenience sample
of locally-cached models. This is indicative, not a benchmark.
Operational footnote: `qwen3.5:4b` is a thinking model and needs
`think: false`, otherwise it returns an empty `response`.

Two damning details from the runs:

1. `functiongemma:270m` was **perfectly deterministic and perfectly
   schema-valid while being confidently wrong** — it leaked the prompt
   into an argument
   (`path='/path/to/documents/adr/Emit one tool call'`). Five identical
   runs of a wrong answer.
2. `gemma3:4b` picked the right tool but **hallucinated an argument** —
   `/tmp/search_results.txt` as the path for what was a search query.
   Schema-valid, plausible-looking, wrong.

### Why it was wrong

The experiment measured **repeatability, not determinism**. Seeded
greedy decoding reproduces the same output for the same input tokens;
the *decision* remains an opaque forward pass, and a paraphrase of the
same intent can flip it arbitrarily. There is no invariant, no proof,
no explanation — nothing a reviewer can check and nothing a receipt can
attest to beyond "the weights said so, twice."

Structurally, we had put the **symbolic** decision (which tool, which
capability, which arguments) *inside* the **neural** system, and then
guarded only the **syntax** of its answer. Grammar masking constrains
the shape of the output, not its truth. The fatal property is that a
wrong-but-schema-valid answer is **undetectable downstream**: every
validator we could write passes it, and the substrate dispatches the
wrong capability with a valid-looking request.

That directly violates the fail-closed discipline this repo enforces
everywhere else. `cloister-21e42e` (the empty-value sweep): an empty or
ambiguous value must fail closed, never silently proceed. ADR-0053
rule 5: a misconfigured lease gate fails every request closed rather
than silently serving open. A dispatch layer whose wrong answers are
*indistinguishable from right answers* is the same bug at a higher
layer — and no amount of decoding constraint fixes it, because the
constraint is on the wrong side of the semantics.

## What SOTA says

The dominant neuro-symbolic pattern in the current literature treats
the **LLM strictly as a semantic parser**: natural language in, a
formal-language artifact out (FOL / ASP / Prolog / constraint programs)
— and then delegates *all* multi-step reasoning to a symbolic engine
that emits **explicit proof traces**. Representative sources:

- Zylos, *Neuro-symbolic AI agent reasoning* (2026-03-21) —
  <https://zylos.ai/research/2026-03-21-neuro-symbolic-ai-agent-reasoning/>
- *SymbolicAI* — formalizes LLM-as-semantic-parser with pluggable
  SMT/constraint-solver backends — <https://arxiv.org/pdf/2411.04383>
- *SYNAPSE* (deterministic reliability in a safety-adjacent domain) —
  <https://www.mdpi.com/2075-5309/16/3/534>
- LLM Symbolic Reasoning Survey (AAAI 2026 Bridge) —
  <https://github.com/jindongli-Ai/LLM-Symbolic-Reasoning-Survey>
- Certified/auditable clinical agent behavior via symbolic delegation —
  <https://www.nature.com/articles/s43856-025-01194-x>
- Constrained-decoding background (what grammar masking does and does
  not give you) —
  <https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md>

Directly relevant to cloister: **MCP Solver** already exposes MiniZinc
constraint programming and Z3 SMT solving *over MCP*. Cloister is an
MCP substrate — so if the symbolic side ever needs a real solver, that
solver is just another declared, mediated backend in the manifest, not
new architecture.

The load-bearing principle from this literature, worth quoting because
it is the whole argument:

> the LLM's non-determinism and vulnerability to adversarial input are
> acceptable costs during knowledge-base construction but unacceptable
> during production operation; separating the two phases is the path to
> certified, auditable agent behavior.

## The key insight: cloister is already a neuro-symbolic system, unnamed

Map the concepts from that literature onto what this repo has shipped:

| neuro-symbolic concept | what cloister already has |
|---|---|
| knowledge base | the capnp **manifest** — committed, content-addressed, reviewed |
| symbolic engine | **ADR-0027** capability matchmaker (n-dimensional provides/requires resolution), **ADR-0028** identifier scheme |
| constraint system | lease gate (ADR-0007/0053), `confinement/v1`, vault scopes (ADR-0010/0013) |
| **proof trace** | **receipts** — threat-model §13.4 audit chain, `SkillLoadReceipt` |
| KB-construction vs production phase split | **ADR-0031** (manifest as build artifact) + the standing rule "routes are declarative, never hand-coded in TS" |

The last row is the punchline. The literature says the path to
certified agent behavior is confining non-determinism to the
knowledge-base-construction phase and running production purely
symbolically against the committed KB. **Cloister already enforces
exactly that phase separation**: a human (or an LLM, at authoring time)
writes the manifest; it is reviewed, digest-pinned, and committed;
runtime only ever executes the committed artifact. Non-determinism is
confined to build time by existing policy. What was missing was the
name — and the discipline of keeping the *new* neural component on the
correct side of that line, which the failed first attempt got exactly
backwards.

## Decision

Adopt the parser/adjudicator split as the dispatch architecture:

```
NL intent
   ↓  NEURAL — semantic parse ONLY (small local model, mediated, schema-constrained)
formal capability request      ← malformed/unsatisfiable ⇒ REJECTED here, fail-closed
   ↓  SYMBOLIC — capability matchmaker resolves against committed manifest + policy
dispatch decision + proof trace (receipt)
```

The model **never decides**. It only *proposes a parse* — a formal
capability request in the ADR-0028 vocabulary — and the substrate
adjudicates that request against the committed manifest via the
ADR-0027 matchmaker, under the same lease/scope/confinement constraints
every other dispatch already passes through. The output of adjudication
is a dispatch decision *plus a receipt*: which request was matched,
against which manifest digest, satisfying which constraints — the proof
trace the literature asks for, in the shape (§13.4 receipts) cloister
already emits.

Schema-constrained decoding is retained — but demoted to what it
actually is: an ergonomic guarantee that the parser's output is
*syntactically* a capability request, so the symbolic layer never has
to parse free text. It is no longer asked to carry any semantic
guarantee.

Two consequences worth drawing out explicitly:

1. **The symbolic half runs inside the V8 isolate.** Matching and
   constraint-solving over a committed manifest needs no weights and no
   GPU — it is graph resolution (ADR-0027 Step 1–5) over data already
   in memory. This dissolves the workerd 128 MB memory ceiling that
   killed the in-isolate-inference idea: that ceiling was a physics
   problem for model weights (WASM shares the same 128 MB cap), not a
   policy problem, and the adjudicator simply does not have the
   physics problem. The neural half stays outside the isolate, mediated
   (next section); the decision authority stays inside it.
2. **A mis-parse now fails closed instead of dispatching wrong.** In
   the rejected design, a hallucinated argument dispatched a
   valid-looking request to the wrong place. In this design, the same
   hallucination surfaces as a capability request that is malformed or
   **unsatisfiable against the manifest** — and unsatisfiable requests
   are rejected with a precise error (ADR-0027 already specifies this:
   "a precise error naming the unsatisfied requirement"). The failure
   mode moves from *silent wrong action* to *loud refusal*, which is
   the entire point of the fail-closed discipline.

### Delivery vehicle for the neural half — existing config, not new architecture

The parse-only model does not get a new ingress, a new trust seam, or a
new credential path. `vault-proxy` already has `upstreamBaseUrl` as a
per-service config field (`src/routes/vault-proxy.ts:43`,
`src/manifest/cluster-types.ts:552`). Ollama serves an
Anthropic-compatible `/v1/messages`. So the whole wiring is:

```
Claude Code → cloister vault-proxy (policy · audit · receipts · vault) → local ollama
```

— the same mediation pipeline ADR-0040/0042 shipped, with the upstream
repointed. The sole blocker today is a hardcoded constant at
`scripts/harness-dev.mjs:62` (`const UPSTREAM = "https://api.anthropic.com"`),
while every sibling knob in that file is already env-overridable.
Making `UPSTREAM` overridable is the entire delta. (Independently,
`ollama launch claude --model <m>` demonstrates the same
Anthropic-compatible wiring works end-to-end.)

This placement matters for the trust story: the parser's traffic passes
through the same policy, audit, and receipt surface as every other
model call, so the *proposal* step is observable even though it carries
no authority.

## How this maps onto what cloister already has

- **The formal language exists** — ADR-0028 capability refs
  (`cloister/<name>/v<n>`, reverse-DNS third-party roots) are the
  target vocabulary for the parse. The parser's output schema is "a
  capability request in ADR-0028 terms," not a novel IR.
- **The adjudicator exists (as a spec)** — ADR-0027 Phases 4a–4c are
  the matchmaker. This ADR adds a runtime *query* consumer of the same
  algorithm the build-time wiring uses: instead of "wire this cluster,"
  the question is "does this single request resolve, and to what,
  under current policy."
- **The constraint layer exists** — an adjudicated dispatch still
  passes the lease gate (ADR-0053 `gateAndVerify`), scope match, and
  confinement checks. The matchmaker narrows *what* may be dispatched;
  the lease layer decides *who* may dispatch it. Neither is bypassed
  by the other.
- **The proof trace exists** — §13.4 receipts and `SkillLoadReceipt`
  are the shape; a dispatch receipt records (request, manifest digest,
  binding chosen, constraints satisfied). Nothing about the receipt
  depends on how the request was produced — a human-typed request and
  a model-parsed request adjudicate and attest identically, which is
  the property that makes the neural half swappable.
- **The phase split exists** — ADR-0031 pins the manifest as a build
  artifact. The parser cannot introduce a capability; it can only name
  ones that were committed and reviewed. Authoring the KB remains a
  human/LLM build-time activity exactly as today.

Standing operator rule, restated for the implementation: **no regex**
anywhere in the proposed code. Capability-request validation is
structural (typed parse of a fixed schema), matching is the ADR-0027
graph walk, and path handling follows the repo's `URLPattern`
convention — none of these need or may use regular expressions.

## Consequences

**Positive:**

- Wrong parses fail closed with a nameable reason instead of
  dispatching. The undetectable-wrong-answer class from the first
  attempt is structurally eliminated, not statistically reduced.
- The dispatch decision is explainable and attestable: manifest digest
  + matched binding + satisfied constraints, in an existing receipt
  shape. "Why did this dispatch happen" has a checkable answer.
- The symbolic half is exhaustively testable offline with no model in
  the loop (see What to measure).
- The neural half is a commodity, swappable behind vault-proxy config.
  Model upgrades change parse *yield*, never dispatch *correctness*.
- No new trust seam: the parser rides the shipped ADR-0040/0042
  mediation, and the adjudicator rides the shipped manifest + lease
  machinery.
- Honors the seat-auth constraint: nothing in this design requires
  cloister to hold an API key or invoke a frontier model.

**Negative / costs:**

- Two components to operate instead of one: a local model runtime
  (ollama or similar) plus the matchmaker query path. The model
  runtime is host-side and optional — with no parser, the formal
  request surface still works for programmatic callers.
- The NL affordance is bounded by parse yield. Users will sometimes
  phrase intents the small model cannot map to a well-formed request;
  the system refuses rather than guesses, which is correct but reads
  as less "smart" than a guessing dispatcher.
- ADR-0027 Phases 4a–4c graduate from "planned" to "on the critical
  path" — this ADR is a forcing function on the matchmaker
  implementation arc (`cloister-cf7a3b`).
- The parse schema becomes a compatibility surface: capability
  vocabulary changes (new ADR-0028 refs) need corresponding parser
  prompt/schema updates, or yield silently degrades.

## What to measure

The first attempt measured the wrong thing (does the LLM repeat
itself). Replace it with three metrics that respect the split:

1. **Parse yield** — fraction of NL intents for which the model emits
   a well-formed capability request. This is the neural half's *only*
   metric. It is a liveness/ergonomics number, not a safety number.
2. **Matcher correctness** — the symbolic half is a pure function of
   (request, manifest, policy), so it is **exhaustively verifiable
   offline** against the committed manifest with no model involved:
   enumerate requests, assert resolutions. Provable rather than
   sampled — table-driven tests in the same spirit as ADR-0053's
   six-rule gate test.
3. **Fail-closed rate** — of mis-parses (wrong tool, hallucinated
   argument), the fraction the symbolic layer rejects rather than
   dispatches. **This is the safety number, and the original
   experiment had no way to produce it** — in the constrained-decoding
   design every mis-parse dispatched. Target: 100% of mis-parses that
   are unsatisfiable against the manifest are rejected; residual risk
   is confined to mis-parses that happen to name a *different valid*
   dispatch, which is exactly the set that scopes + lease constraints
   then bound.

Re-run the small-model comparison against metric 1 only, with a real
test set (the 3-case convenience sample above is not one).

## Open questions

- **How small can a parse-only model be?** Parsing NL into a fixed
  formal vocabulary is a strictly weaker requirement than *deciding* a
  dispatch, so the ~4B "competence floor" the table above suggests for
  deciding likely does not apply to parsing. `functiongemma:270m`'s
  failure was a decision/grounding failure, not a syntax failure —
  whether a sub-1B model clears a useful parse yield is an open
  empirical question worth answering, since it changes the host
  footprint materially.
- **Matchmaker vs real solver.** Is the ADR-0027 graph walk sufficient
  adjudication, or do policy interactions (scopes × tenancy ×
  confinement) eventually warrant a real constraint solver? If the
  latter: MCP Solver already exposes Z3 and MiniZinc over MCP, so the
  solver arrives as a declared mediated backend, not an embedded
  dependency. Default answer for now: matchmaker suffices; revisit
  when a policy question the graph walk cannot express actually
  occurs.
- **Tier-2: inference inside the confined microVM.** If the neural
  half later moves from "host process behind vault-proxy" into the
  ADR-0044 compute-isolation substrate (libkrun) with the ADR-0046
  host-mediated policy fs, two things need measuring first:
  mediated-fs throughput for a paged KV cache, and Metal reachability
  inside libkrun on macOS. The existing `tools/libkrun-spike` already
  proves boot + virtio-fs read/write forwarding, so both are
  measurable extensions of a working spike, not greenfield.

## Alternatives considered

- **(a) "Constrained decoding is enough" — the model decides, grammar
  guards the output.** Rejected on the empirical record above:
  byte-identical, 100%-schema-valid runs produced wrong tool choices
  (1/3 for two of four models) and hallucinated arguments, and the
  design gives downstream no way to detect them. Constrained decoding
  guarantees syntax; dispatch is semantics. Retained only as the
  parser's output-shape guarantee, where syntax is all that is asked
  of it.
- **(b) Host an ACP server in workerd (agent-process-v1).** Blocked
  twice over: the operator's Max subscription is seat/session-authed
  (no API-key path for cloister to invoke a model itself), and model
  inference cannot fit the 128 MB isolate/WASM ceiling. The proposal
  stays preserved (`cloister-339a22`); its process/lifecycle
  vocabulary may still be lifted onto the mediated harness later, per
  its own adoption note. This ADR is the in-boundary answer to the
  need that proposal was reaching for.
- **(c) Fully hand-coded dispatch, no neural component.** Rejected:
  it loses the NL affordance that motivated the local agent in the
  first place, and the manifest already exists precisely to be matched
  against — the marginal cost of the parser is one mediated upstream,
  while the adjudicator is required infrastructure (ADR-0027) either
  way. Note the degenerate form survives intact: callers that can emit
  formal capability requests directly simply skip the parser, and
  nothing in the symbolic path knows the difference.
