# Confinement model — how cloister isolates what it runs

This is the operator-facing companion to
[`tenancy-model.md`](tenancy-model.md). Tenancy answers *"which tenant is
which, and who may reach it."* Confinement answers *"when cloister runs a
thing — a harness, a tool, a pod — what can that thing actually touch?"*

The one principle underneath everything here: **one declared, default-deny,
fail-closed policy drives two enforcement planes at once.**

- **The cloister plane** — the V8-isolate boundary, per-bundle vault slices,
  service-binding-as-syscall (ADR-0013), and the lease gate. This is what a
  *bundle* declares in the manifest, and what `lint:bundle-isolation` enforces
  (the invariants in [CLAUDE.md](../../CLAUDE.md)).
- **The kernel plane** — an OS sandbox (Seatbelt on macOS, Landlock on Linux)
  applied to a *host process* so its filesystem and network reach are cut to an
  allow-list. This is what `cloister-harness` applies today, and what the
  libkrun compute-substrate (ADR-0044) will strengthen.

The two are not stacked layers glued together — they derive from the same
declaration, so a confined thing's reach is the *same* whether you read it as
"what the bundle declares" or "what the kernel enforces."

---

## Default-deny is the contract, and it is not free

Everything cloister confines is **allow-list, deny-by-default**: a path or a
network egress that is not explicitly granted is denied. That is the whole
security value — "give the harness its tools" must never mean "give the harness
the disk."

**But default-deny is not automatic on every axis.** The kernel sandbox's
filesystem is allow-list by construction (no grant → no access), but its
*network* default is *allow-all*. So confinement is enforced **fail-closed**:
cloister refuses to run a confined thing unless its policy *explicitly* declares
a deny-by-default network mode (`blocked` or `proxy`). A missing or loose
network stanza is a hard error, not a silent wide-open sandbox.

If you take one thing from this doc: **a confinement policy that doesn't say
`network.mode = blocked` will be rejected, on purpose.**

---

## Confining a harness (shipped)

A *harness* is an agent runtime — Claude Code, Codex — that you point at cloister
instead of at the model provider directly. Confining it means: it reaches the
model **only** through cloister's vault proxy, and it cannot read your secrets or
the wider disk while doing so.

### Run it

```sh
SANDBOX=nono task harness:dev
```

This mints a dev identity, starts cloister + the lease shim, then launches your
harness **kernel-confined** via the `cloister-harness` binary
(`tools/harness-sandbox/`). Without `SANDBOX=nono`, the same command prints an
`export ANTHROPIC_BASE_URL=…` line and you launch the harness yourself,
unconfined — useful for debugging, but not the isolated path.

### What it confines to

`harness-dev.mjs` emits a declared policy (`.harness-policy.json`, a nono
`CapabilityManifest`) and `cloister-harness` applies it. The harness gets:

| Grant | Why |
|---|---|
| **rw** the workdir | the code it's working on |
| **rw** `~/.claude` (harness state) | sessions, config |
| **ro** the harness binary + system dirs | so it can actually start (dylibs, `~/.local/bin`) |
| **network: blocked**, except **localhost `:8799`** | the vault-proxy seam — its *only* egress |

Everything else is denied: `~/.ssh`, `~/.aws`, `~/.config/gcloud` (named in an
explicit deny for good measure), and every outbound host but the proxy. The
model credential never enters the harness's environment — cloister injects it at
the proxy and **receipts every call** (`cloister/credential-isolation/v1`).

### What is proven today

A confined harness has been verified end-to-end against the live stack: the real
harness executes confined, reaches the vault proxy (a receipt fires), and is
denied `~/.ssh` (EPERM) and all direct external network. See
[`tools/harness-sandbox/README.md`](../../tools/harness-sandbox/README.md) for the
invariant tests.

### A note on credentials and the Keychain

The nono base profile denies the macOS Keychain Mach services (`securityd`,
`keychaind`) by default — so a confined harness *cannot* read an OAuth token that
lives in your login Keychain. This is correct, not a bug: cloister resolves the
credential **before** the sandbox seals (via `nono::keystore`) and hands it to
the vault, so the confined process is credential-less.

---

## Confining services / tools / pods (partly shipped)

A *service* (a `tenants/` backend — an MCP server, a Durable Object, a proxied
tool) is confined along the **cloister plane** today, and will gain a **kernel
plane** as the compute-substrate lands.

### What's enforced now

- **Tier boundary** (ADR-0011) — every bundle is `hypervisor` or `cluster` tier;
  a hypervisor-layer bundle must carry a non-empty rationale. `lint` Inv 3.
- **Slice-grant** (ADR-0013) — a bundle reaches a credential or a peer bundle
  *only* through a declared service binding; cluster-tier bundles can't hold vault
  bindings they didn't declare. `lint` Inv 1, 2, 4, 5.
- **Multi-tenant chain** (ADR-0034) — `tenantDispatch row.binding → wire → bundle
  ← input.workerdId` for per-tenant deployments. `lint` Inv 6–9.
- **Process/container separation** — `deployment/cluster-in-a-pod.md` runs each
  service as its own container with its own bindings; peers reach each other only
  over declared wires.

These are **declarative and CI-gated**: the isolation is what the manifest says,
and `task lint` fails the build if a bundle's declared reach violates an
invariant. See [`tenancy-model.md`](tenancy-model.md) and
[`backend-kinds.md`](backend-kinds.md).

### What's forthcoming

Per-service **kernel** confinement — running each backend the way `cloister-harness`
runs the harness, and ultimately inside a libkrun microVM whose *only* filesystem
is host-mediated — is the compute-substrate work (ADR-0044) + mediated-fs delivery
(ADR-0043). Until then, service isolation is the V8-isolate boundary + the
declarative slice-grants above + container separation, **not** a per-service OS
sandbox. This doc will grow a "confine a pod" runbook when that ships.

---

## The per-tool checklist

For any tool you mount in the cluster, the operator questions are the same three,
and each has a home:

1. **Use it** — its tools, scopes, and endpoint: its page under
   [`tenants/`](../tenants/) + [`integration/mcp-client.md`](../integration/mcp-client.md).
2. **Configure it** — its backend kind + bindings:
   [`backend-kinds.md`](backend-kinds.md), [`bundle-topology.md`](bundle-topology.md),
   and [`authoring-server-json.md`](../integration/authoring-server-json.md).
3. **Confine it** — its tier, slice-grants, and (forthcoming) kernel policy: this
   doc + [`tenancy-model.md`](tenancy-model.md).

The `tenants/` pages own #1 and #2 per tool today; #3 (the confining dimension per
tool) is the model above, and becomes per-tool as the compute-substrate lands.
