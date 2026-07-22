# math-friend review log — agent-process/v1 proposal

**Reviewed:** 2026-05-17
**Reviewer:** math-friend (theoretical-foundations-analyst)
**Source-of-truth:** [`agent-process-v1.md`](agent-process-v1.md) — revised in place

## Summary

The core argument holds: model LLM invocations as processes, host the ACP server side in workerd, lean on V8 isolates for sandboxing and Interlace leases for identity. ACP is exactly the spawn/await/stream/cancel surface the proposal needed, and the cloister-substrate guarantees (V8 isolate, lease identity, receipts) are non-trivial additions ACP-as-protocol does not speak to. The biggest correction was the **ExitEnvelope `status` union**: the original draft conflated ACP `StopReason` values with Anthropic Messages API `stop_reason` values (it listed `stop_sequence` and `tool_use`, which are provider-side, not ACP). A second load-bearing correction was the **hibernation expectations**: the Cloudflare hibernation API does not survive an in-flight outgoing `fetch()`, so a DO actively talking to Anthropic cannot hibernate during generation — the proposal had implied otherwise. Beyond those, the revisions are cite-and-tighten work: ACP repo URL and provenance, current crate vs. wire version, rosary's actual source structure (`AgentSession` polymorphism, not a `DispatchHandle` enum), the full OpenAI Runs lifecycle (`requires_action`, `cancelling`, `incomplete` were missing), and the Anthropic-streaming-cancel reality (no provider-native cancel verb; TCP close is the mechanism; billing-after-disconnect is ambiguous).

## Changes made (each with rationale + citation)

### Change 1: ACP repo URL, maintainership, and SDK ecosystem

- **Section:** TL;DR + Critical prior art: ACP
- **Before:** "ACP (Agent Client Protocol) is an in-flight standardization effort... Rust crate: `agent_client_protocol`."
- **After:** Identifies the canonical repo as `github.com/zed-industries/agent-client-protocol`, maintained by Zed Industries; notes TypeScript, Python, Kotlin, Java SDKs; clarifies "open spec with multi-org adoption" rather than "in-flight standardization" (not ratified by IETF/similar, but well past the "in-flight" framing).
- **Why:** "In-flight" understates ACP's maturity (3.1k stars, 44 releases, an extension registry, multiple language SDKs, multiple agent implementations including the official Codex bridge). The org name is `zed-industries`, not `agentclientprotocol`. The crate identifier on crates.io is `agent-client-protocol` (hyphenated), not `agent_client_protocol` (which is its Rust ident form).
- **Citation:** [github.com/zed-industries/agent-client-protocol](https://github.com/zed-industries/agent-client-protocol); [agentclientprotocol.com](https://agentclientprotocol.com/); [zed.dev/blog/acp-registry](https://zed.dev/blog/acp-registry).

### Change 2: ACP wire shape — protocol version, capability surface, exact methods

- **Section:** Critical prior art: ACP (wire-shape block)
- **Before:** Loose textual sketch claiming `permission/request` and `session/cancel()` (parenthesized as if a request/response method).
- **After:** Explicit method shapes with parameters (`initialize(protocolVersion, clientCapabilities, clientInfo?)`, `session/new(cwd, mcpServers)`, `session/prompt(sessionId, prompt: ContentBlock[])`), notes `session/cancel` is a notification (one-way), names the actual permission method `session/request_permission`, mentions `session/update` for streaming notifications, and adds optional `fs/read_text_file` / `fs/write_text_file` capabilities. Also notes the wire `protocolVersion` is currently `1` (a `uint16`), separate from crate version.
- **Why:** Methods and request/notification distinction matter — `session/cancel` being a notification is load-bearing for cancellation semantics (the agent's response to the *in-flight `session/prompt`* is what carries `StopReason::Cancelled`).
- **Citation:** [Canonical schema.json on `main`](https://github.com/zed-industries/agent-client-protocol/blob/main/schema/schema.json), specifically the `CancelNotification` and `ProtocolVersion` definitions.

### Change 3: ExitEnvelope `status` union — remove Anthropic-side stop reasons

- **Section:** ExitEnvelope (the contract)
- **Before:** `"end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | "refusal" | "cancelled" | "timeout" | "cap_exceeded" | "error"` — described as "ACP StopReason union, extended."
- **After:** `"end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled" | "timeout" | "cap_exceeded" | "error"`. Added a paragraph explicitly distinguishing **Anthropic Messages API `stop_reason`** (`end_turn` | `max_tokens` | `stop_sequence` | `tool_use` | `pause_turn` | `refusal`) from **ACP `StopReason`** (`end_turn` | `max_tokens` | `max_turn_requests` | `refusal` | `cancelled`) and specifying the translation rules.
- **Why:** This was the load-bearing factual error. `stop_sequence` and `tool_use` are Anthropic-only — they describe one provider turn's exit, not the ACP `session/prompt` turn's exit. `tool_use` in particular CANNOT be a final ExitEnvelope status, because it's the signal to *continue* (execute the tool, feed results back). `max_turn_requests` was missing from the union (it's an ACP variant the substrate would emit when it caps tool→model round-trips).
- **Citation:** ACP schema `StopReason` enum: kebab-case `const` values `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled` (verified from [raw schema.json](https://raw.githubusercontent.com/zed-industries/agent-client-protocol/main/schema/schema.json) on 2026-05-17). Anthropic stop_reason values per [Messages API docs](https://docs.claude.com/en/api/messages) and the streaming events example in [Streaming docs](https://docs.claude.com/en/docs/build-with-claude/streaming).

### Change 4: ACP cancel response shape

- **Section:** ExitEnvelope (after the union)
- **Before:** No explicit cite of what `cancelled` means.
- **After:** Quoted directly from the ACP `CancelNotification` schema description ("Upon receiving this notification, the Agent SHOULD: Stop all language model requests... Respond to the original `session/prompt` request with `StopReason::Cancelled`").
- **Why:** This is the contract the substrate must honor — the agent loop in the DO has to translate substrate cancel into provider-stream close, finish in-flight tool calls, then return to the awaiting `session/prompt` with `Cancelled`.
- **Citation:** ACP `schema/schema.json` `CancelNotification` description.

### Change 5: Hibernation caveat (load-bearing)

- **Section:** Shape (new DO namespace bullet) — added a substantial new paragraph
- **Before:** "Hibernation-safe WebSocket attachments for progress streams" — implied hibernation works generally.
- **After:** Cites `ctx.acceptWebSocket(ws)` + `ws.serializeAttachment(state)` correctly (with the 2048-byte attachment limit), and adds a "Hibernation caveat" paragraph noting hibernation is blocked by in-flight `fetch()`, active alarms, and `setTimeout`/`setInterval`. Therefore the DO is **NOT** hibernatable during active provider generation; hibernation pays off in between-turn idle gaps. References [workerd#4864](https://github.com/cloudflare/workerd/issues/4864) for the open work on outgoing-WebSocket hibernation.
- **Why:** Operator expectations matter. The original framing implied "we get hibernation savings on long-running sessions" which is the wrong promise — long-running ones spend most of their wall-clock in a `fetch` to Anthropic, which prevents hibernation. The promise is "hibernation across `session/prompt` boundaries and during tool-call wait periods."
- **Citation:** [Cloudflare Durable Objects WebSockets best practices](https://developers.cloudflare.com/durable-objects/best-practices/websockets/); [Hibernation example](https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/); [workerd#4864](https://github.com/cloudflare/workerd/issues/4864).

### Change 6: Rosary file structure + ACP integration phase status

- **Section:** Rosary relationship (load-bearing seam)
- **Before:** "three modules: providers.rs, session.rs, sweep.rs"; "Rosary migrates its `DispatchHandle::Acp` variant"; "ADR-0002 lists 4 implementation phases."
- **After:** "five files: `mod.rs`, `prompt.rs`, `providers.rs`, `session.rs`, `sweep.rs`" with each file's contents named; correction that ADR-0002 §4 proposed a `DispatchHandle::Cli | DispatchHandle::Acp` enum but the implementation landed as `Box<dyn AgentSession>` behind a single `AgentHandle` struct — so the migration path is "swap `AcpNativeProvider`'s transport from local subprocess to cloister-hosted ACP server"; ADR-0002 has six phases (not four); explicit per-phase landed/partial/not-yet status verified against `rosary/src/` HEAD.
- **Why:** The original draft's claim of `DispatchHandle::Acp` would have misled readers into thinking the rosary-side migration touches an enum variant; the actual seam is the `AgentSession` trait + the provider's transport choice. The phase-count mismatch is a smaller error but still wrong.
- **Citation:** `~/remotes/art/rosary/src/dispatch/mod.rs` (defines `AgentHandle` struct); `~/remotes/art/rosary/src/dispatch/providers.rs` (defines `AcpNativeProvider` and the trait); `~/remotes/art/rosary/src/acp.rs` (the `AcpSession` !Send-boundary thread); `~/remotes/art/rosary/Cargo.toml` (`agent-client-protocol = "0.10.2"`); `~/remotes/art/rosary/docs/adr/0002-acp-integration.md` (six-phase list).

### Change 7: Seam-map row corrections + cancellation row honesty

- **Section:** Seam map table
- **Before:** "Session state: ... survives workerd restart via alarm-resumable hibernation"; "Cancellation: ACP session/cancel + SIGTERM to subprocess | ACP session/cancel → DO marks aborted → outgoing provider stream disconnected"
- **After:** Session-state row now says "survives workerd restart via hibernation when there is no in-flight outbound fetch (see Hibernation section below)." Cancellation rosary-side row now says "AcpSession::kill() sends SIGTERM, waits 5s, escalates SIGKILL; ACP session/cancel notification flows via the protocol" (matching what the actual code does in `acp.rs`); cloister-side row says "outgoing provider stream closed (TCP disconnect — no provider-native cancel endpoint; see Provider Matrix section)."
- **Why:** Both row-versions needed to align with documented reality — workerd hibernation has fetch-blocking constraints, and Anthropic's Messages API has no cancel endpoint (you close the SSE socket and hope generation halts).
- **Citation:** rosary `src/acp.rs:90-124` (the SIGTERM-then-SIGKILL escalation logic); Anthropic [streaming docs](https://docs.claude.com/en/docs/build-with-claude/streaming) (no cancel verb documented).

### Change 8: Kubelet analogy — kept, with caveat

- **Section:** Rosary relationship — new "Kubelet analogy" subsection
- **Before:** One-liner: "rosary → k8s; cloister → kubelet."
- **After:** A 6-row mapping table (API server ↔ bead store, scheduler ↔ reconciler, kubelet ↔ DO host, pod ↔ session/isolate, CRI ↔ ACP wire, status update ↔ session/update + ExitEnvelope), followed by a caveat that kubelet is a per-node daemon while cloister IS the substrate (no host/daemon split). Analogy is apt for the LB/scheduling factoring; should not be read as architectural identity.
- **Why:** The original analogy was correct but unmarked — math-friend was asked to neither sand nor blindly defend it. The mapping holds tightly enough to be useful; the single significant disanalogy (host/daemon vs substrate-is-host) is worth calling out so future readers don't over-extend.
- **Citation:** [kubernetes.io/docs/concepts/architecture/](https://kubernetes.io/docs/concepts/architecture/), [Container Runtime Interface](https://kubernetes.io/docs/concepts/architecture/cri/).

### Change 9: Sandboxing model — exact §s and quoted invariants

- **Section:** Sandboxing model table
- **Before:** Citations like "ADR-0013 §slice-grant" — section names that don't exist in the ADR.
- **After:** Each row now has an explicit anchor link into the actual ADR (`#decision`, `#wire-protocol`) with a brief inline quote of the relevant invariant. Rephrased the `globalOutbound` row to say "omitted in workerd config" rather than "controlled by manifest" — ADR-0013 explicitly clarifies that vault wiring is at the workerd config layer, NOT the cloister.capnp manifest layer.
- **Why:** Citation hygiene; also ADR-0013's central correction was that the manifest doesn't need a `vaultSlice` field (ADR-0010's original sketch) — capability enforcement is at the workerd config layer. The original draft's "manifest controlled `globalOutbound`" rephrasing inverted that.
- **Citation:** [ADR-0013](../adr/0013-slice-grant-enforcement.md) Decision table; [ADR-0007](../adr/0007-interlace-substrate.md) Decision §State layer; [ADR-0024](../adr/0024-credential-isolation-capability.md) Wire protocol §.

### Change 10: Provider matrix — Anthropic cancellation reality + billing

- **Section:** Provider matrix
- **Before:** Anthropic row had no notes about cancellation; the math-friend citation stub asked the question.
- **After:** Anthropic row says "no provider-native cancel endpoint... cancellation is TCP-disconnect of the SSE stream. The Message Batches API has explicit cancel, but the streaming Messages API does not." Added a follow-up paragraph "Billing implication of provider-side cancellation gap" explaining that ExitEnvelope `tokens_out` on a `cancelled` / `cap_exceeded` ExitEnvelope must be treated as a *lower bound* on what Anthropic ultimately bills, because there's no documented guarantee that token generation halts the instant the TCP socket closes. The streaming-refusals doc's billing language is quoted directly.
- **Why:** This is operational reality that the substrate cannot hide. Receipts that commit to `tokens_out` as if it were ground-truth billing would be misleading. The substrate should commit to what it *observed* — that's an honest receipt.
- **Citation:** [Streaming docs](https://docs.claude.com/en/docs/build-with-claude/streaming); [Streaming refusals](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/handle-streaming-refusals) ("you will be billed for output tokens up until the refusal"); [Cancel Message Batches](https://docs.anthropic.com/en/api/canceling-message-batches).

### Change 11: OpenAI Assistants Runs lifecycle — full state list + Responses API deprecation

- **Section:** Provider matrix + Prior art table
- **Before:** "queued → in_progress → completed/failed/cancelled/expired" (5 states)
- **After:** Full nine-state list (`queued`, `in_progress`, `requires_action`, `cancelling`, `cancelled`, `failed`, `completed`, `incomplete`, `expired`) with mapping to ExitEnvelope status. Added the deprecation note that Assistants API is being replaced by the Responses API.
- **Why:** `requires_action` and `incomplete` are particularly important for the substrate — `requires_action` is the tool-call-waiting state (analogous to a tool boundary in ACP), and `incomplete` is OpenAI's specific exit for `max_*_tokens` overrun (which the substrate maps to `max_tokens` ACP equivalent or substrate `cap_exceeded`).
- **Citation:** [OpenAI Runs object API reference](https://platform.openai.com/docs/api-reference/runs/object); deprecation discussion at [openai migration blog/community thread](https://community.openai.com/) (also referenced in search results).

### Change 12: Temporal row — Activity-vs-Workflow framing

- **Section:** Prior art table
- **Before:** "Not LLM-shaped — that's `cloister/workflow/v1` (separate)" — true but unilluminating.
- **After:** "An agent-process is an **Activity** from Temporal's POV (single non-deterministic I/O unit), not a Workflow. `cloister/workflow/v1` (future) is the Workflow layer that composes agent-process Activities." Citation to the Temporal workflows doc on the deterministic-replay model.
- **Why:** The Activity/Workflow distinction is the conceptual hinge. Temporal Workflows must be deterministic, so the LLM-call-with-I/O *must* be an Activity. The proposal's future `workflow/v1` layer is the Workflow shell that calls agent-process as an Activity. Naming this explicitly clarifies why `agent-process/v1` is the right *leaf*.
- **Citation:** [Temporal Workflows](https://docs.temporal.io/workflows); [Workflow Execution overview](https://docs.temporal.io/workflow-execution).

### Change 13: Open questions — added 2 new questions, expanded 4 existing

- **Section:** Open design questions
- **Before:** 8 questions, mostly correctly framed but lacking specifics.
- **After:** 10 questions. Added Q9 (hibernation expectations — explicit budget framing given the fetch-blocking caveat) and Q10 (billing-after-cancel granularity — what should the substrate commit to in receipts when generation was interrupted mid-stream). Expanded Q1 (named the specific ACP optional capabilities to consider — `fs/read_text_file`, `fs/write_text_file`, `terminal/*`), Q3 (named the credential-injection strategies from ADR-0024 that fit Anthropic), Q5 (explicit hard-kill route + analog to rosary's SIGKILL escalation), and Q8 (tied receipt chaining to ADR-0007's per-peer chain invariant).
- **Why:** Open questions are where this proposal hands off to humans. Each needed enough specificity that the operator can answer with one read of the cited references, not "go research it."
- **Citation:** Inline in each question.

### Change 14: Citations section — replaced stub list with real index

- **Section:** Final section
- **Before:** Numbered list of nine "stubs the math-friend review must source."
- **After:** Ten-entry "Citations index" with retrieval date (2026-05-17) and real URLs for ACP, StopReason wire format, cancel semantics, Anthropic streaming + billing, workerd hibernation, OpenAI Runs lifecycle, Temporal, kubelet/CRI, rosary source confirmations, and cloister ADR cross-refs.
- **Why:** Convert the unresolved-questions section into the actual evidence trail.
- **Citation:** (the index *is* the citation, each entry is its own primary source.)

## Open issues for the author (cloister team) to address

1. **Q9 / Q10 are operator policy calls, not technical questions.** The substrate cannot decide whether `tokens_out` on a cancelled ExitEnvelope should be treated as authoritative-billing or observed-lower-bound; only the operator's downstream billing reconciliation can. Need an explicit decision.
2. **ADR-0002's phase 5 (ACP becomes default in rosary)** is the prerequisite for the rosary-side migration this proposal depends on. The rosary repo currently has `claude` as the default provider in `provider_by_name("claude")`. Either rosary needs its own bead to flip the default to `acp`, or this proposal needs to ship without rosary's default flipping (the migration becomes opt-in per bead).
3. **Capability-isolation/v1 (ADR-0024) dependency**: Open Q3 asks whether agent-runtime holds Anthropic keys directly or routes through credential-isolation/v1 from day 1. ADR-0024 is Draft status (2026-05-17, same day as this proposal). The cleanest story is "credential-isolation/v1 ships first; agent-runtime is one of its first consumers" but that may slip v1. Need an explicit go/no-go on the ordering.
4. **The crate version mismatch (`0.10.2` pinned in rosary vs. `0.12.1` published)** is fine — the wire protocol version is `1` in both — but if cloister implements the ACP server side, it should target the wire `protocolVersion: 1` against the **latest** schema/JSON, not specifically against 0.10.2 Rust struct shapes. Mention in the cloister-side impl bead.
5. **ADR-0008 (rosary three-tier hierarchy)** is still Proposed. The seam map row "Agent hierarchy / permissions: three-tier model" assumes ADR-0008 lands; if it doesn't, cloister's enforcement story stays per-bead-PermissionProfile-shaped rather than tier-shaped. Not blocking, but worth confirming the hierarchy decision lands before this proposal's enforcement-section claims solidify.
6. **The "Capability registry endpoint advertises `cloister/agent-process/v1`" item in Done-when** is the seam to the `cloister-1b59a2` substrate-as-kernel framing. Worth checking that the registry path (`/.well-known/cloister-capabilities/v1/`) is the agreed path — ADR-0024 also references it but no ADR ratifies it yet.

## Citation index

Retrieval date for all entries: 2026-05-17.

1. [Agent Client Protocol — project site](https://agentclientprotocol.com/) — protocol overview, lifecycle methods, transport options.
2. [github.com/zed-industries/agent-client-protocol](https://github.com/zed-industries/agent-client-protocol) — canonical repo (Zed Industries, 3.1k stars, 44 releases).
3. [ACP schema.json on `main`](https://github.com/zed-industries/agent-client-protocol/blob/main/schema/schema.json) — `StopReason` wire format (`end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`), `CancelNotification` agent obligations, `ProtocolVersion` as `uint16`.
4. [docs.rs `agent-client-protocol` 0.10.2](https://docs.rs/agent-client-protocol/0.10.2/agent_client_protocol/) — `StopReason` is `#[non_exhaustive]` with the five canonical variants.
5. [Zed blog: The ACP Registry is Live](https://zed.dev/blog/acp-registry) — multi-agent extension marketplace, evidence of ecosystem maturity.
6. [zed-industries/codex-acp](https://github.com/zed-industries/codex-acp) — Codex CLI bridged to ACP.
7. [Anthropic Streaming Messages docs](https://docs.claude.com/en/docs/build-with-claude/streaming) — SSE event model; no documented cancel verb for the Messages API.
8. [Anthropic streaming refusals + billing](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/handle-streaming-refusals) — "you will be billed for output tokens up until the refusal."
9. [Anthropic Cancel Message Batches](https://docs.anthropic.com/en/api/canceling-message-batches) — explicit cancel verb (Batches only, not Messages).
10. [Cloudflare Durable Objects — Use WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) — `ctx.acceptWebSocket(ws)`, `serializeAttachment` (2048 byte limit), hibernation behavior.
11. [Cloudflare Durable Objects — WebSocket hibernation example](https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/) — handler shape (`webSocketMessage`, `webSocketClose`, `webSocketError`), constructor-replay model.
12. [Cloudflare Durable Objects — Lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/) — eviction + recreation model.
13. [workerd#4864](https://github.com/cloudflare/workerd/issues/4864) — open feature request for outgoing-WebSocket hibernation.
14. [OpenAI Assistants Run object API reference](https://platform.openai.com/docs/api-reference/runs/object) — full nine-state lifecycle.
15. [OpenAI Assistants deep dive](https://developers.openai.com/api/docs/assistants/deep-dive) — state transitions + `requires_action` semantics.
16. [Temporal Workflows](https://docs.temporal.io/workflows) — Event-History replay, determinism requirements, Activity boundary for I/O.
17. [Temporal Workflow Execution overview](https://docs.temporal.io/workflow-execution) — execution lifecycle.
18. [Kubernetes Architecture](https://kubernetes.io/docs/concepts/architecture/) — control-plane / data-plane split, kubelet's role.
19. [Kubernetes Container Runtime Interface](https://kubernetes.io/docs/concepts/architecture/cri/) — CRI as kubelet ↔ runtime interface (the analog of ACP for cloister).
20. **Rosary source files** (local):
    - `/Users/jamesgardner/remotes/art/rosary/src/dispatch/mod.rs`
    - `/Users/jamesgardner/remotes/art/rosary/src/dispatch/providers.rs`
    - `/Users/jamesgardner/remotes/art/rosary/src/dispatch/session.rs`
    - `/Users/jamesgardner/remotes/art/rosary/src/acp.rs`
    - `/Users/jamesgardner/remotes/art/rosary/Cargo.toml`
    - `/Users/jamesgardner/remotes/art/rosary/docs/adr/0002-acp-integration.md`
    - `/Users/jamesgardner/remotes/art/rosary/docs/adr/0008-agent-hierarchy-dispatch-model.md`
21. **Cloister ADR cross-refs** (local):
    - `/Users/jamesgardner/remotes/art/cloister/docs/adr/0007-interlace-substrate.md`
    - `/Users/jamesgardner/remotes/art/cloister/docs/adr/0013-slice-grant-enforcement.md`
    - `/Users/jamesgardner/remotes/art/cloister/docs/adr/0024-credential-isolation-capability.md`
