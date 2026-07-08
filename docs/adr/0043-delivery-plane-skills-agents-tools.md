# ADR-0043 — cloister as the isolated delivery plane for skills, agents, and tools (with load-event receipts)

- **Status:** Proposed (2026-07-08)
- **Tracking bead:** `cloister-2853a7` (skill/agent delivery plane)
- **Pairs with:**
  - ADR-0040 / ADR-0042 (credential isolation + the runnable harness — this extends the *same move* from the LLM key to skills/agents/tools)
  - ADR-0026 (tool composition — content-addressed, signed `[inputs.*]`; the model this generalizes)
  - ADR-0016 (cloister as private MCP registry) / ADR-0038 / ADR-0041 (the OCI registry + image-publish contract; the artifact substrate)
  - ADR-0009 (compute substrate sandboxing — the *isolation* half; deferred)
  - ADR-0037 (secure MCP ingress transports, `cloister-22a5ca`) + `cloister-31a988` (secure ART tool constellation) — this ADR is the delivery-side of the same "cloister as isolated plane" frame

## Context

Credential isolation shipped: a harness (Claude Code / Codex) gets its **LLM key**
(vaulted) and its **tools** (`/mcp`) through cloister, lease-gated and receipted
(ADR-0040/0042). But **skills and agent definitions still load from the local
filesystem** (`~/.claude/skills`, plugins, `~/github/jamestexas/agents` markdown).
That is the hole: *reading skills = reading the disk = reaching `~/.ssh`,
`~/.aws`, credentials.* "Give the harness its skills" currently means "give the
harness the whole disk."

Skills and agents are **probabilistic config**: like MCP servers, they load into
the harness and *shape* the model's behavior — but they don't determine it. The
model's *decision* to invoke a skill is internal and unobservable from outside
the harness.

The goal: cloister becomes the **delivery plane** for skills + agents + tools, so
the harness's entire reach is cloister (skills, tools, LLM key, identity,
receipts) and everything else — including `~/.ssh` — is out of scope. And every
*load* is on the record.

## Decision

Cloister delivers skills/agents/tools as **content-addressed, signed artifacts
over its existing lease-gated channel**, and **receipts every load event**. Two
layers, both required for the full guarantee:

### Layer 1 — Delivery (flip where skills come from)

Skills/agents are served as **OCI artifacts on the `/v2` registry** (GH-backed;
OCI holds arbitrary artifacts, not just container images), cosign/Interlace-
signed, pulled **by digest**. `~/github/jamestexas/agents` (markdown) is the
concrete source, packaged into signed artifacts. Delivery reuses the ADR-0026
content-addressed input model (a skill/agent input KIND) rather than a bespoke
protocol.

The harness obtains skills *from cloister* — either a **sync step** (extends the
harness-shim: pull signed artifacts by digest → materialize into the harness's
skill dir) or **skills-as-MCP-resources** over `/mcp`. Either way the harness
needs **zero broad filesystem access to get skills** — which removes the reason
for the broad mount.

### Layer 2 — Isolation (deny everything else)

Delivery alone does **not** stop a host process from reading `~/.ssh` — a process
with disk access always can. The hard guarantee needs the harness **sandboxed**
(container / microVM per ADR-0009, deferred) with a *narrow* mount (a workdir; no
`~/.ssh`, no `~/.aws`) and cloister as the only outbound. Because Layer 1
delivers skills+tools+key via cloister, the mount collapses toward "a workdir + a
socket to cloister." Delivery is **necessary but not sufficient** for the
`~/.ssh` guarantee; the sandbox completes it.

### Load-event receipts — what we can and cannot audit

This is the honest boundary of auditing probabilistic config:

- **We CANNOT log decision points.** Why or when the model chose to apply a
  loaded skill is internal to the harness/model; cloister never sees it and this
  ADR does not pretend to.
- **We CAN log the observable events**, and they are enough for provenance +
  non-repudiation:
  1. **Load events** — "skill/agent `X` (digest `D`) loaded into session `S` for
     peer `P` at `T`." A load is a cloister-mediated pull, so it is deterministic
     and signed. Emit a **`SkillLoadReceipt`** onto the same receipt chain as
     LLM-call receipts (ADR-0040 §13.4 lineage).
  2. **Turns** — one `user ↔ model (+ any tool calls)` exchange. cloister already
     receipts the model call at the `/vault/proxy` boundary; the turn receipt is
     linked to the set of loaded-skill digests active for that session.

The provenance you get: *"these signed skills/agents (by digest) were loaded for
this session, and here is every turn that ran under them"* — offline-verifiable
and non-repudiable. You cannot prove **why** the model acted; you can prove
**what config it was running** and **every turn it took**. That is the maximum
auditable surface for probabilistic config, and it is stated as such.

## Consequences

- The harness's reach **collapses to cloister**: skills, agents, tools, LLM key,
  identity, receipts — one lease-gated, audited channel; the sandbox denies the
  rest. This is the endgame credential isolation was step 1 of.
- **Skill/agent provenance** becomes a first-class artifact: signed, digest-
  pinned, load-receipted. A compromised or swapped skill is detectable (digest)
  and its load is on the record.
- New trust seams (skill artifact signing; the delivery/sync step; the
  `SkillLoadReceipt`) — the threat model gains a section before code lands
  (house rule).
- The `~/.ssh` guarantee is **not** delivered by this ADR alone — it requires the
  ADR-0009 sandbox. This ADR makes the sandbox's mount trivially narrow; it does
  not replace it.
- Turn-level (not decision-level) auditing is the accepted ceiling and is
  documented as honest scope, mirroring ADR-0040's custody-vs-audit precision.

## Alternatives considered

- **Filesystem skills (status quo).** The problem this ADR exists to fix: skill
  access = disk access = `~/.ssh` reach.
- **Skills injected only into the prompt.** No provenance, no digest, no load
  receipt; a swapped skill is invisible. Rejected.
- **A bespoke skill-delivery protocol.** Rejected — reuse the OCI registry (/v2)
  + the ADR-0026 content-addressed input model + `/mcp` resources; a new protocol
  is surface we don't need.
- **Log decision points.** Impossible from outside the harness (probabilistic,
  internal). Load-events + turns are what's observable; claiming more would be
  dishonest.
