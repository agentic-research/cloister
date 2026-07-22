# cloister/agent-process/v1 — design proposal

**Bead:** `cloister-339a22`
**Status:** Draft (2026-05-17), math-friend-reviewed 2026-05-17. **Not scheduled** — preserved for reference; see the blocking constraint below.
**Companion docs:** [`agent-process-v1.review-changes.md`](agent-process-v1.review-changes.md) — math-friend revision log + citations

> **⚠️ Adoption constraint (noted 2026-07-22, operator).** This proposal has cloister host the ACP **server** side — i.e. cloister *is* the agent, invoking a model from inside workerd. That requires **programmatic (API-key) model access**. A **Claude Code Max subscription is seat/session-authed, not API-key-authed**, so the operator's own account cannot back this shape; it would need separate API billing. That is a real gating constraint on the whole proposal, not a detail.
>
> Note this is the **inverse** of the direction cloister actually shipped: [ADR-0040](../adr/0040-harness-in-cloister.md) / [ADR-0042](../adr/0042-turnkey-harness-dev-run.md) have cloister **mediate** a harness (Claude Code) running on the *host* — vaulting the credential and proxying the call — which works with a subscription-authed harness precisely because cloister never invokes the model itself. Before reviving this proposal, reconcile it against that shipped mediation model: the useful part may be the **process/lifecycle vocabulary** (spawn / await / signal / exit-code, addressable handles) applied to the mediated harness, rather than hosting an ACP server in workerd.

## TL;DR

LLM invocations today are modeled as one-shot API calls. We need them modeled as **processes** — with explicit termination, separate progress/exit channels, real cancellation, and addressable handles. The protocol exists already: **[ACP (Agent Client Protocol)](https://agentclientprotocol.com/)** — an open standard maintained by Zed Industries with TypeScript, Python, Rust, Kotlin, and Java SDKs ([github.com/zed-industries/agent-client-protocol](https://github.com/zed-industries/agent-client-protocol)). Rosary already consumes it as a client (pinned at `agent-client-protocol = "0.10.2"` in `rosary/Cargo.toml`). The substrate gap is the **server side**: a workerd-hosted, V8-isolate-sandboxed, Interlace-lease-identified ACP server. That's `cloister/agent-process/v1`.

## Problem

Today's LLM-call shape:

- **Lifetime mismatch**: providers expose req → response (with optional streaming deltas). Real agent work is multi-step, multi-tool, multi-spawn — minutes to hours. Caller has no clean way to spawn-and-await.
- **Termination conflation**: the model's "last token" IS its exit. There's no separate channel for the exit contract vs in-flight progress. A caller wanting "did this actually complete or did it bail on a budget" must parse the token stream.
- **Cancellation gap**: no clean way to abort a streaming generation mid-flight; in practice, callers disconnect and the provider may still bill for the full continuation.
- **Sub-spawn ad-hoc**: the Anthropic Claude Code Task tool and OpenAI Assistants Runs each invent their own "I spawned a child" semantics; not provider-portable.
- **No address handle**: spawned work doesn't get a substrate-level address you can `@` for status, signal, or cancel.

These are the same gaps unix processes solved decades ago. The shape we want — and don't have yet at substrate level — is the process-lifecycle primitives (fork / spawn / wait / signal / exit-code), mapped to LLM invocations.

## Recursive-descent frame (where this sits)

From the design conversation (2026-05-17):

| Layer | Concern | Today | This proposal |
|---|---|---|---|
| L0 | The thing (an LLM invocation) | Provider HTTP call | Process with lifecycle |
| L1 | How you address it | URL/header opaque | `@agent-process:<id>` (uniform-address shape) |
| L2 | Schema for L1 | OpenAPI / SDK | ACP — `agent_client_protocol` Rust crate |
| L3 | Generator of L2 | Hand-written SDKs per provider | ACP standard |
| L4 | WHY L3 looks the way it does | Consumer was human dev | (the inefficiency the substrate-as-kernel framing exists to fix) |
| L5 | What's true if consumer is fluid | Self-describing, composable, discoverable, symmetric, capability-shaped | The `cloister-1b59a2` framing |

This proposal lives at L0–L2. L5 lifts (full agent-native substrate) ride the same rail once shipped.

## Critical prior art: ACP

**ACP (Agent Client Protocol)** is an open protocol for spawning AI agents as subprocesses (today, JSON-RPC over stdio; HTTP/WebSocket transports are documented as work-in-progress on the project site). It is **not** a ratified standard from a body like IETF, but it is a maintained open spec with multi-org adoption: the canonical schema, Rust reference implementation, TypeScript SDK (`@agentclientprotocol/sdk`), Python SDK, plus Kotlin/Java SDKs all live under [github.com/zed-industries/agent-client-protocol](https://github.com/zed-industries/agent-client-protocol) (maintained by Zed Industries; 3.1k stars, 44 releases as of 2026-05). The protocol wire version is a 16-bit integer, currently `1`, separate from crate version numbers. The ACP Registry — an extension marketplace for agents — was announced 2026 ([zed.dev/blog/acp-registry](https://zed.dev/blog/acp-registry)). Rosary's ADR-0002 (`docs/adr/0002-acp-integration.md` in the rosary repo) accepted ACP as the dispatch substrate.

ACP's wire shape (verified against the canonical JSON schema at [`schema/schema.json`](https://github.com/zed-industries/agent-client-protocol/blob/main/schema/schema.json) on the project repo, and against rosary's live use in `src/acp.rs`):

```
initialize(protocolVersion, clientCapabilities, clientInfo?)
                              → handshake; agent declares its capabilities
session/new(cwd, mcpServers)  → opens a session bound to a working
                                 dir + MCP server set; returns sessionId
session/prompt(sessionId, prompt: ContentBlock[])
                              → sends a prompt; agent streams back
                                 session/update notifications;
                                 final response carries a StopReason
session/cancel(sessionId)     → notification (one-way, no response).
                                 Agent SHOULD stop LLM requests, abort
                                 tool calls, send pending updates, then
                                 respond to the in-flight session/prompt
                                 with StopReason::Cancelled
                                 (per CancelNotification schema docs)
session/update                → notification from agent → client carrying
                                 incremental updates (text, tool calls,
                                 plan, available commands, etc.)
session/request_permission    → agent asks the client to authorize a
                                 tool call; client answers per policy
fs/read_text_file, fs/write_text_file
                              → optional capabilities (client-side
                                 filesystem mediation)
```

This is **already** the spawn/await/stream/cancel surface I was about to invent. Cloister should not reinvent — cloister should **host the ACP server side** in workerd, providing the substrate-level guarantees ACP-as-protocol doesn't speak to (sandboxing, identity, audit).

## Rosary relationship (load-bearing seam)

Rosary today is the **ACP client** + work orchestrator. Verified against `rosary/src/` as of 2026-05-17:

- `rsry/src/dispatch/` — five files: `mod.rs` (`AgentHandle`, `PermissionProfile`, `spawn()`, `spawn_detached()` for Unix `setsid` MCP-path detach), `prompt.rs` (prompt assembly), `providers.rs` (`AgentProvider` trait + `ClaudeProvider`, `GeminiProvider`, `AcpCliProvider` [legacy stub], `AcpNativeProvider` [live]), `session.rs` (`AgentSession` trait + `CliSession`, `ComputeSession`, `StdCliSession` impls), `sweep.rs` (reconciler integration).
- `rsry/src/acp.rs` — `AcpSession` wraps the `!Send` ACP `ClientSideConnection` in a dedicated `std::thread` running a single-threaded tokio runtime + `LocalSet`. The `finished: Arc<AtomicBool>` + `join_handle` shape lets the reconciler poll/wait/kill from any thread. `RosaryClient` implements the ACP `Client` trait with `request_permission` auto-approval via `should_approve(tool_name, permissions)`.
- `rsry/Cargo.toml` pins `agent-client-protocol = "0.10.2"`. Current published version is 0.12.1.
- `rsry/docs/adr/0002-acp-integration.md` — decisions: rosary is ACP **client only, not server**; permissions handled protocol-native via `RosaryClient::request_permission()`; MCP servers configured in `NewSessionRequest`; per-bead JSONL log streams. ADR lists six implementation phases (not four): (1) Session Bridge, (2) Agent Handle, (3) Reconciler Integration, (4) Notification Streaming, (5) Provider Unification (ACP becomes default), (6) Review Agent Migration. As of 2026-05-17 source: phases 1-2 shipped (`acp.rs`, `AcpNativeProvider`); phase 3-4 partial (`AcpSession` integrates with the reconciler's polling loop via `try_wait`/`wait`/`take_tools_used`, and notifications stream to `.rsry-stream.jsonl` via `RosaryClient::session_notification`, but a dedicated `rsry logs --bead` is not yet on main); phase 5-6 not yet (ACP is one provider among `claude`/`gemini`/`acp`, selectable via `provider_by_name`, not default).
- `rsry/docs/adr/0008-agent-hierarchy-dispatch-model.md` (Proposed) — three-tier hierarchy (orchestrator/feature/dev) with per-tier permissions.

**Seam map:**

| Capability | Rosary owns | Cloister owns (this proposal) |
|---|---|---|
| Work intake | Beads via Dolt/MCP/Linear/GitHub | n/a |
| Reconciler / scheduling | Picks beads → picks agents → dispatches | n/a |
| Agent hierarchy / permissions | Three-tier model; `PermissionProfile` per bead | Enforces permission grants at V8 isolate boundary |
| Spawn primitive | Calls ACP `initialize` + `session/new` + `session/prompt` (currently against a local subprocess via `AcpNativeProvider`) | **Hosts ACP server side** — receives `session/new`, instantiates DO, runs agent loop |
| Provider adapter | Selects which agent binary to invoke (`claude-agent-acp`, etc.) | Receives ACP messages → translates to provider API call (Anthropic Messages, OpenAI, etc.) |
| Session state | Tracks active sessions in-process; per-bead `.rsry-stream.jsonl` | Persists session in DO SQLite; survives workerd restart via hibernation when there is no in-flight outbound fetch (see Hibernation section below) |
| Sandboxing | OS-level subprocess + `setsid` detach (`spawn_detached`) | V8 isolate per session (cloister-hosted) |
| Identity | Per-bead `PermissionProfile` | Interlace lease scoped to parent identity; tools' grants bounded by lease scope (ADR-0007) |
| Audit | JSONL log per bead + `tool_log` (`Arc<Mutex<Vec<ToolCallRecord>>>`) | Interlace receipts (progress-tagged + exit-tagged separately); ADR-0007 receipt chain rooted at session-start |
| Cancellation | `AcpSession::kill()` sends SIGTERM, waits 5s, escalates SIGKILL; ACP `session/cancel` notification flows via the protocol | ACP `session/cancel` notification → DO marks aborted → outgoing provider stream closed (TCP disconnect — no provider-native cancel endpoint; see Provider Matrix section) |

**The pivot**: rosary continues to be the orchestrator. Cloister becomes the substrate that **hosts ACP agents server-side** with substrate-grade guarantees (V8 sandbox, lease-identity, receipts). The migration moves `AcpNativeProvider` from "spawn local subprocess, talk JSON-RPC over stdio" to "open a cloister session over HTTP, talk ACP over that transport" — the `AgentSession`-trait polymorphism in `dispatch/session.rs` absorbs the swap. (ADR-0002 §4 originally proposed a `DispatchHandle::Cli | DispatchHandle::Acp` enum; the implementation instead landed as `Box<dyn AgentSession>` behind a single `AgentHandle` struct, which is the seam this proposal actually edits.)

### Kubelet analogy — apt with one caveat

Rosary → k8s control plane (API server + scheduler + controllers); cloister → kubelet (substrate-hosts-the-unit). The mapping is structurally tight on three axes:

| k8s | rosary + cloister |
|---|---|
| API server | rosary's bead store + MCP work intake |
| Scheduler | rosary reconciler picks the bead → agent → repo |
| Kubelet | cloister DO hosts the ACP session, enforces sandbox, mediates outbound, reports status |
| Pod | One ACP session (one V8 isolate) |
| CRI | ACP wire (`session/new`, `session/prompt`, `session/update`) |
| Kubelet → API server status updates | DO `session/update` notifications + final ExitEnvelope |

The caveat: kubelet runs as a per-node OS daemon; cloister is itself the substrate (workerd serving the Worker bundles, plus DO storage as state). "Cloister IS a kubelet for one agent session" — the host/daemon dichotomy collapses because the substrate is the host. Documented in the kubelet docs at [kubernetes.io/docs/concepts/architecture/](https://kubernetes.io/docs/concepts/architecture/) and the [Container Runtime Interface](https://kubernetes.io/docs/concepts/architecture/cri/). The analogy is apt for the LB/scheduling factoring; it should not be read as a literal architectural match.

## cloister/agent-process/v1 proposal

### What ships in v1

A new workerd bundle `agent-runtime` (NOT a separate workerd process — that's a scale-out optimization for v2). Implements the ACP server side. Per ADR-0013, the V8 isolate boundary is the sandbox; per ADR-0007, every session emits Interlace receipts.

### Shape

- **New bundle** in `cluster.toml`:
  ```toml
  [[bundles]]
  name                = "agent-runtime"
  description         = "cloister/agent-process/v1 — ACP server hosted in workerd"
  tier                = "cluster"
  workerdServiceName  = "agent-runtime"
  holdsCredential     = []   # provider keys mediated via credential-isolation/v1 (cloister-8f57f0)
  hypervisorRationale = ""
  kind                = "workerd"

    [bundles.workerd]
    entryPoint = "src/bundles/agent-runtime/index.ts"

  [[wires]]
  from    = "cloister-router"
  to      = "agent-runtime"
  binding = "AGENT_RUNTIME"
  transport = "uds"
  ```

- **New DO namespace**: `AgentProcess` — one instance per session. Holds:
  - ACP session state (initialize handshake result, MCP server set, current prompt context)
  - Provider call state (in-flight HTTP, accumulated tokens, tool-call count)
  - Caps (wall_s, tokens, tool_calls, sub_spawns)
  - Receipt chain (progress + exit tags)
  - Alarm for wall-clock cap enforcement
  - Hibernation-safe WebSocket attachments for progress streams (via `ctx.acceptWebSocket(ws)` + `ws.serializeAttachment(state)`; per [Cloudflare DO WebSockets docs](https://developers.cloudflare.com/durable-objects/best-practices/websockets/), the connection stays open on CF's network while the DO is evicted from memory, and `ctx.getWebSockets()` + `ws.deserializeAttachment()` restore per-socket state on wake. Serialized attachment max 2048 bytes.)

> **Hibernation caveat (load-bearing):** Per the same Cloudflare docs, hibernation is blocked while a Durable Object has an in-flight outgoing `fetch()`, an active alarm callback, or scheduled `setTimeout`/`setInterval`. The agent-process DO will have an in-flight provider stream (Anthropic `POST /v1/messages?stream=true`) for the duration of the model's generation — typically seconds to minutes. **The DO is therefore NOT hibernatable during active generation.** Hibernation pays off in the *between-turns* gaps (waiting on tool-call results from MCP servers, between user prompts in a multi-turn session). Cap-enforcement alarms also block hibernation while pending. v1 should not promise hibernation savings during generation; v2 can revisit when [workerd#4864 (hibernation for outgoing WebSockets)](https://github.com/cloudflare/workerd/issues/4864) and related fetch-hibernation work lands.

- **Routes on cloister-router** (proxied via service binding to `agent-runtime`):
  - `POST /agent/v1/sessions` — ACP `initialize` + `session/new`; returns `{ session_id, handle: "@agent-process:<id>" }`
  - `POST /agent/v1/sessions/<id>/prompt` — ACP `session/prompt`; non-blocking, returns 202
  - `GET  /agent/v1/sessions/<id>/exit` — long-poll up to 30s for ExitEnvelope; returns 202 if still running
  - `GET  /agent/v1/sessions/<id>/stream` — SSE of `SessionNotification` events
  - `POST /agent/v1/sessions/<id>/cancel` — ACP `session/cancel`
  - `GET  /agent/v1/sessions/<id>` — current status + provenance snapshot

- **ACP server impl**: a TS module that speaks the ACP protocol JSON-RPC envelope inside the DO. NOT a subprocess — the agent loop runs IN the DO, calling provider APIs via `env.fetch`. (Rosary's existing ACP integration spawns subprocesses; cloister's hosts the loop in-isolate.)

- **Provider adapter (v1)**: Anthropic Messages API only. Translates ACP messages to/from provider format. The provider's stream → ACP `SessionNotification` events.

### ExitEnvelope (the contract)

When the session terminates, the DO commits an ExitEnvelope; the long-poll returns it; the receipt chain is sealed.

```typescript
interface ExitEnvelope {
  // ACP StopReason union (kebab/snake-case wire format from the canonical
  // schema at github.com/zed-industries/agent-client-protocol/blob/main/
  // schema/schema.json), extended with substrate-specific terminal states.
  // ACP StopReason values: end_turn | max_tokens | max_turn_requests
  //                        | refusal | cancelled
  // Substrate extensions: timeout | cap_exceeded | error
  status:              "end_turn" | "max_tokens" | "max_turn_requests"
                       | "refusal" | "cancelled"
                       | "timeout" | "cap_exceeded" | "error";

  payload:             unknown;        // typed if spawn declared exit_schema; raw final message otherwise
  provenance: {
    provider:          string;         // "anthropic", "openai", ...
    model:             string;         // "claude-opus-4-7" / "gpt-4-turbo" / ...
    session_id:        string;         // ACP session id
    started_at_ms:     number;
    ended_at_ms:       number;
    wall_ms:           number;
    tokens_in:         number;
    tokens_out:        number;
    tool_calls:        number;
    sub_spawns:        number;
    hit_cap:           null | "wall_s" | "tokens" | "tool_calls" | "sub_spawns";
  };
  tree?: {
    handle:    string;
    children:  ExitEnvelope["tree"][];
  };
  error?: { code: string; message: string };
  receipt_chain_root:  string;          // sha256 of the Interlace receipt chain
}
```

**Provider stop-reason translation.** Anthropic Messages API's `stop_reason` field (`end_turn` | `max_tokens` | `stop_sequence` | `tool_use` | `pause_turn` | `refusal`) is the provider's terminal signal for one assistant turn — it is **not** the ACP `StopReason`. The agent-runtime translates: `tool_use` continues the turn (executes the tool, feeds results back into a follow-up `POST /v1/messages`); `stop_sequence` and `end_turn` collapse to ACP `end_turn`; Anthropic `max_tokens` → ACP `max_tokens`; Anthropic `refusal` → ACP `refusal`. The `max_turn_requests` ACP value is substrate-enforced (caps the number of tool→model round-trips per `session/prompt`). Substrate-only values (`timeout`, `cap_exceeded`, `error`) layer on top and never originate from the provider.

The `cancelled` value matches ACP's prescribed agent behavior on receipt of `session/cancel`: per the ACP CancelNotification schema documentation, "Upon receiving this notification, the Agent SHOULD: Stop all language model requests as soon as possible; Abort all tool call invocations in progress; Send any pending session/update notifications; Respond to the original session/prompt request with StopReason::Cancelled."

### Cloister-native additions (what ACP doesn't speak to)

ACP is wire protocol; the substrate adds:

1. **V8 isolate per session** (ADR-0013) — the DO instance runs the agent loop in workerd; isolate boundary prevents slice-escape. ACP-server-as-DO is the cleanest mapping: each DO instance == one ACP session == one V8 isolate.

2. **Interlace lease as session identity** (ADR-0007) — `session/new` requires a verified lease; substrate derives child lease for the session; tool calls inside the session bounded by lease scope.

3. **Receipt tag separation** (this proposal extends ADR-0007 §13.x):
   - **Progress-tagged receipt**: emitted on every `SessionNotification`. Informational. Multiple per session.
   - **Exit-tagged receipt**: emitted exactly once. Terminal. Contains ExitEnvelope. Substrate refuses to mark session "done" until exit-receipt is committed; refuses to accept progress-receipts after.
   - Tag enum: `{ progress, exit }`. A V can replay the chain and prove "everything before the exit-receipt is progress; the exit-receipt is the contract."

4. **Mailbox-addressable handle** (depends on `mailbox/v1`): `@agent-process:<id>` is `uniform-address/v1`-shaped; addressable for `cancel`, `status`, future `signal`.

5. **Workflow-hostable**: `cloister/workflow/v1` (future) wraps an agent-process as a leaf — durable across multi-spawn flows. The agent-process itself stays leaf-shaped; workflows compose them.

### Sandboxing model

| Concern | Mechanism | Citation |
|---|---|---|
| Agent code can't reach unscoped tools | V8 isolate + service binding allow-list | [ADR-0013 Decision table](../adr/0013-slice-grant-enforcement.md#decision) ("Service binding as syscall... the *only* outbound channel is a service binding to vault or another gated worker. All exits are mediated.") |
| Agent code can't reach unbound network | `globalOutbound` omitted in workerd config | [ADR-0013 Decision table](../adr/0013-slice-grant-enforcement.md#decision) ("`globalOutbound` not set: `fetch()` is `undefined` in the tool-bundle isolate. No network exit.") |
| Agent can't forge identity | Interlace lease verified on every authenticated request; child lease derived from parent | [ADR-0007 §lease-layer + Amendment 2026-05-08 finding 2](../adr/0007-interlace-substrate.md#decision) (lease pipeline + `peer_lease_counters` table for §13.2 mutual-assured-accountability over read-heavy traffic) |
| Provider call uses scoped credential | Vault proxy injects credential server-side; bytes never enter agent isolate | [ADR-0024 §Wire protocol](../adr/0024-credential-isolation-capability.md#wire-protocol) (credential never crosses the response boundary; injection happens vault-side; no `bodyField`-style "raw shell out" strategy) |
| Audit trail is unforgeable | Interlace receipt chain rooted at session-start; Ed25519-signed via `leyline-sign` WASM | [ADR-0007 Decision §State layer + §Single shared crypto artifact](../adr/0007-interlace-substrate.md#decision) (`peer_attestations` table; signed via the same `leyline-sign` WASM consumed by cloister, notme, `ll sign` CLI, and third-party auditors) |

Important: cloister-hosted sessions have **stronger** sandboxing than rosary's current subprocess-based ACP — subprocess can see the host filesystem; the V8 isolate has no `disk` / `durableObjectStorage` bindings in this configuration and `fetch()` is `undefined` (per ADR-0013).

### Exit mechanism

Hybrid (recommended v1):

1. **Provider-native exit (primary)**: ACP `StopReason` is the model's exit signal. `end_turn` = success; `refusal` = failure; `max_tokens` = cap_exceeded; etc.
2. **Caps (predicate fallback)**: substrate-enforced wall_s, tokens, tool_calls, sub_spawns. When a cap fires, substrate emits `cap_exceeded` exit and cancels the provider stream.
3. **Explicit exit tool (optional)**: callers wanting a structured payload can grant the agent an `exit(status, payload)` tool. Calling it commits an ExitEnvelope with the structured payload. Substrate gates on this when granted.

### Provider matrix (v1 → v2)

| Provider | v1 | v2 | Notes |
|---|---|---|---|
| Anthropic Messages API | ✓ | | Streaming + tool use + cache control. **No provider-native cancel endpoint**: cancellation is TCP-disconnect of the SSE stream (per [streaming docs](https://docs.claude.com/en/docs/build-with-claude/streaming) — no documented cancel verb; SDK cancellation uses `AbortController`). The Message **Batches** API has explicit cancel, but the streaming Messages API does not. |
| OpenAI Assistants Runs API | | ✓ | Lifecycle states: `queued`, `in_progress`, `requires_action`, `cancelling`, `cancelled`, `failed`, `completed`, `incomplete`, `expired` (per [API reference](https://platform.openai.com/docs/api-reference/runs/object)). Maps to ExitEnvelope as: `completed` → `end_turn`; `cancelled`/`cancelling` → `cancelled`; `failed` → `error`; `incomplete` → `max_tokens` (when caused by max_*_tokens) or `cap_exceeded`; `expired` → `timeout`. **The Assistants API is being deprecated in favor of the Responses API** — by the time v2 ships, the integration target may shift. |
| Local Claude Code (subagent via Task tool) | | ✓ | Bridge — call ACP from within a CC subagent |
| Local Codex | | ✓ | Codex CLI integration via ACP. The [`zed-industries/codex-acp`](https://github.com/zed-industries/codex-acp) bridge exists today. |
| Local-Llama / OSS models | | future | Via litellm or vllm-OpenAI-compat |

**Billing implication of provider-side cancellation gap.** When the substrate enforces a cap or receives `session/cancel` during active Anthropic generation, the only way to stop the model is to close the underlying SSE connection. Per the documented streaming guidance ("you will be billed for output tokens up until the refusal" in the streaming-refusals doc, and the general principle that `usage` is reported in `message_delta`), there is no public guarantee that token generation halts at the same instant as the TCP close. The substrate's ExitEnvelope `tokens_out` is therefore a *lower bound* on what may be billed when status is `cancelled` / `cap_exceeded` — the receipt should commit to this bound, not assert it as exact. This is a known operational reality, not a substrate defect.

## Open design questions

1. **ACP capability set**: which ACP optional capabilities does cloister implement in v1? In particular, the spec's `fs/read_text_file`, `fs/write_text_file`, `terminal/*` client-side filesystem mediation capabilities — does cloister announce them, or refuse them in `initialize` (forcing the agent to use server-side state)? Cloister-hosted sessions have no host filesystem to read from, so probably refuse, but `session/request_permission` mediation needs explicit policy. Needs spec read of the [protocol reference](https://agentclientprotocol.com/protocol).
2. **Long-poll vs SSE for await**: lean long-poll-30s for `GET /exit` (simple, web-native, survives proxies) + SSE for `GET /stream` (separate concerns: exit is a fact; stream is informational).
3. **Capability mediation under credential-isolation/v1**: does the agent-runtime bundle hold provider API keys directly, or does credential-isolation/v1 ([ADR-0024](../adr/0024-credential-isolation-capability.md)) mediate from day 1? Latter is more correct (matches the "no plaintext crosses the response boundary" invariant); former lets us ship without 8f57f0 blocking. The credential-isolation/v1 wire shape can wrap Anthropic's `POST /v1/messages` cleanly via `authorizationBearer` or `headerNamed("x-api-key")` injection — no shape mismatch.
4. **Process-tree introspection**: opt-in (`spawn({ tree: true })`) or always-on? Cost is per-spawn metadata maintenance + a recursive ExitEnvelope walk; benefit is the `tree` field's existence for callers that want it.
5. **Cancellation semantics**: hard kill (immediate provider-stream disconnect) vs graceful (signal agent, allow N seconds for cleanup, then kill)? ACP `session/cancel` is the graceful path and the spec prescribes the agent's response shape (return `StopReason::Cancelled` after stopping LLM requests and aborting in-flight tool calls). Substrate may add a hard variant `POST /agent/v1/sessions/<id>/kill` that bypasses ACP and immediately TCP-closes the provider stream + commits a `cancelled` ExitEnvelope, for the misbehaving-agent case. (Rosary's `AcpSession::kill()` already implements a 5s-graceful-then-SIGKILL escalation — cloister's hard-kill variant is the analog of SIGKILL.)
6. **Mailbox dependency**: does v1 ship without `mailbox/v1` (no `@agent-process:<id>` routing), or block on mailbox? Probably ship without — addressability is additive; the session ID is a usable handle through the v1 HTTP routes.
7. **Single-host or cross-host in v1**: v1 keeps sessions co-located with the caller; cross-host comes via leyline-net (ADR-0005) in v2.
8. **Receipt chaining across sub-spawns**: child receipt chain is rooted at parent's session — does each child get a fresh chain linked back, or extends the parent's? Probably fresh chain with a parent-pointer (matches process tree shape and ADR-0007's per-peer chain invariant — a child session is a new peer relationship, not a continuation of the parent's `peer_attestations` rows).
9. **Hibernation expectations**: per the Hibernation caveat above, v1 should explicitly **not** promise hibernation savings during active generation, and the operator-facing budget should price wall-clock-during-generation accordingly. Hibernation pays off during between-turn idle gaps and across `session/prompt` boundaries when the caller hasn't sent a new prompt.
10. **Anthropic billing-after-cancel granularity**: as documented in the Provider Matrix, the substrate cannot guarantee that `ExitEnvelope.tokens_out` equals what Anthropic ultimately bills when cancellation interrupts a stream. Operator-facing surface should treat `tokens_out` on a cancelled ExitEnvelope as `tokens_observed_before_disconnect`. Is that disclosure framing acceptable, or do we need to reconcile via the provider's billing API afterwards?

## Prior art

| System | What it has | Gap vs this proposal |
|---|---|---|
| **ACP** ([`agent-client-protocol`](https://github.com/zed-industries/agent-client-protocol)) | Wire protocol for spawn/prompt/stream/cancel; JSON-RPC over stdio (today), HTTP/WebSocket WIP; Rust/TS/Python/Kotlin/Java SDKs; protocol version 1 | No substrate guarantees (sandbox, identity, audit) — that's what we add |
| **Rosary** | ACP client via `AcpNativeProvider`; reconciler; bead-driven dispatch; three-tier hierarchy (ADR-0008, Proposed) | Subprocess-based today; cloister upgrades to workerd-hosted |
| **Anthropic Claude Code Task tool** | Spawn subagent, get result | Provider-locked; exit = "model stopped"; no isolate sandbox |
| **OpenAI Assistants Runs API** | Explicit lifecycle: `queued` → `in_progress` → `requires_action` (loop) → `cancelling` → terminal `{completed, failed, cancelled, incomplete, expired}`. [API reference](https://platform.openai.com/docs/api-reference/runs/object) | OpenAI-only; no progress/exit channel separation; deprecated in favor of Responses API |
| **LangGraph** | Durable agent state machines | Library; no substrate isolation |
| **Microsoft Autogen** | Multi-agent message passing | Library; no substrate guarantees |
| **Temporal workflows** | Durable Event-History replay + Activities + Signals. Workflows must be deterministic; non-deterministic I/O goes in Activities, which run once and have their result recorded ([docs](https://docs.temporal.io/workflows)). | An agent-process is an **Activity** from Temporal's POV (single non-deterministic I/O unit), not a Workflow. `cloister/workflow/v1` (future) is the Workflow layer that composes agent-process Activities — separate primitive. |

The combo (ACP wire + cloister substrate + rosary orchestrator) is novel-by-composition, not novel-by-component.

## Done when

- This proposal stabilized + math-friend reviewed
- ADR-0026 drafted + accepted
- Open questions §1–§8 resolved
- TDD failing-test baseline filed (separate bead)
- Impl PRs land (one or more)
- Rosary's `DispatchHandle::Acp` migrated to use cloister-hosted sessions (separate rosary bead)
- Capability registry endpoint (`/.well-known/cloister-capabilities/v1/`) advertises `cloister/agent-process/v1` as implemented by `agent-runtime` bundle

## Out of scope (v2+)

- Separate workerd process for `agent-runtime` (scale-out)
- OpenAI / Codex / Llama provider adapters
- Cross-host sessions (leyline-net)
- wasm-compiled third-party agent loops (operator drops a `.wasm` agent; runtime hosts)
- Custom operator-supplied tools sandboxed beyond V8 isolate (per-tool wasm capability)
- Mailbox-mediated inter-session communication (depends on `mailbox/v1`)
- Workflow-runtime composition (depends on `cloister/workflow/v1`)

## Dependencies

- `cloister-1b59a2` — substrate-as-kernel framing; informs capability-shape, doesn't block
- `cloister-8f57f0` — credential-isolation/v1; informs Q3; not strict blocker (can ship with `holdsCredential` direct + migrate)
- `cloister-ae4ed2` — Layer 2 manifest schema additions; not blocker for v1 (this proposal works with the existing schema)
- Rosary ADR-0002 implementation phase status — needed for the migration plan

## Citations index

Sourced by math-friend (2026-05-17). Retrieval date for all: 2026-05-17 unless otherwise noted.

1. **ACP project + standardization framing** — [agentclientprotocol.com](https://agentclientprotocol.com/) (project site); [github.com/zed-industries/agent-client-protocol](https://github.com/zed-industries/agent-client-protocol) (canonical repo, 3.1k stars, 44 releases, maintained by Zed Industries). Multiple language SDKs: Rust, TypeScript (`@agentclientprotocol/sdk`), Python, Kotlin, Java.
2. **ACP StopReason wire format** — [schema/schema.json on main](https://github.com/zed-industries/agent-client-protocol/blob/main/schema/schema.json) (`oneOf` of `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled` as string `const` values); [Rust docs.rs for 0.10.2](https://docs.rs/agent-client-protocol/0.10.2/agent_client_protocol/) (the version rosary pins). `#[non_exhaustive]` per docs.rs.
3. **ACP cancel semantics** — `CancelNotification` description in `schema/schema.json`: "Stop all language model requests as soon as possible; Abort all tool call invocations in progress; Send any pending session/update notifications; Respond to the original session/prompt request with `StopReason::Cancelled`." Linked from [agentclientprotocol.com/protocol/prompt-turn#cancellation](https://agentclientprotocol.com/protocol/prompt-turn#cancellation).
4. **Anthropic Messages streaming + cancellation** — [Streaming Messages docs](https://docs.claude.com/en/docs/build-with-claude/streaming) (defines SSE event sequence + `message_delta.usage`; no documented cancel verb). [Streaming refusals docs](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/handle-streaming-refusals) on billing for partial generations ("you will be billed for output tokens up until the refusal"). [Message Batches Cancel](https://docs.anthropic.com/en/api/canceling-message-batches) (explicit cancel — only on Batches API, not Messages).
5. **workerd DO hibernation + WebSocket lifecycle** — [Use WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) (`ctx.acceptWebSocket(ws)` vs `ws.accept()`; in-memory state reset on hibernation; `serializeAttachment`/`deserializeAttachment` for per-socket state; handlers `webSocketMessage`/`webSocketClose`/`webSocketError`). [Hibernation example](https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/). [workerd#4864](https://github.com/cloudflare/workerd/issues/4864) (open: outgoing-WebSocket hibernation). 2048-byte attachment limit per the API docs.
6. **OpenAI Assistants Runs lifecycle** — [Run object API reference](https://platform.openai.com/docs/api-reference/runs/object) confirms statuses `queued`, `in_progress`, `requires_action`, `cancelling`, `cancelled`, `failed`, `completed`, `incomplete`, `expired`. Assistants API deprecation note: [OpenAI dev community migration thread](https://community.openai.com/t/assistants-api-deprecation).
7. **Temporal determinism + Activities** — [Workflows](https://docs.temporal.io/workflows) ("Event History... a complete, ordered log of everything that has already happened"; "Workflow code must be deterministic to support replay"; Activities are the boundary for non-deterministic I/O). [Workflow Execution overview](https://docs.temporal.io/workflow-execution).
8. **Kubelet / CRI** — [Kubernetes architecture](https://kubernetes.io/docs/concepts/architecture/) and [Container Runtime Interface](https://kubernetes.io/docs/concepts/architecture/cri/) for the analogy claim. Kubelet docs at [kubernetes.io/docs/reference/command-line-tools-reference/kubelet/](https://kubernetes.io/docs/reference/command-line-tools-reference/kubelet/).
9. **Rosary source confirmations** — `~/remotes/art/rosary/src/dispatch/{mod,prompt,providers,session,sweep}.rs`, `~/remotes/art/rosary/src/acp.rs`, `~/remotes/art/rosary/Cargo.toml`, `~/remotes/art/rosary/docs/adr/0002-acp-integration.md`, `~/remotes/art/rosary/docs/adr/0008-agent-hierarchy-dispatch-model.md`.
10. **Cloister ADR cross-refs** — [ADR-0007 Interlace substrate](../adr/0007-interlace-substrate.md), [ADR-0013 slice-grant enforcement](../adr/0013-slice-grant-enforcement.md), [ADR-0024 credential-isolation/v1](../adr/0024-credential-isolation-capability.md).

---

**End of draft + math-friend revision. Rationale + per-change citations in `agent-process-v1.review-changes.md`.**
