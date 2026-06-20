# ADR-0024 — `cloister/credential-isolation/v1` capability

- **Status:** Draft (2026-05-17)
- **Tracking bead:** `cloister-8f57f0`
- **Framing:** First concrete capability under `cloister-1b59a2`
  (substrate-as-kernel — every concrete cloister subsystem becomes a
  v1 reference impl of a named Capability Interface).
- **Pairs with:** ADR-0007 (Interlace identity), ADR-0013 (slice-grant
  enforcement), ADR-0014 (pluggable KEK source). Builds directly on
  the existing vault DO (`src/vault-store.ts`); does NOT replace it.

## Context

Cloister has a credential vault today (`src/vault-store.ts`,
ADR-0013/0014). It's used by cloister-internal bundles. External AI
assistants — OpenClaw, Claude Code, Codex, Cursor, anything that
runs skills/tools needing API keys — currently hold credentials in
plaintext config (e.g. OpenClaw's `~/.openclaw/openclaw.json` `env`
blocks, Claude Code's `mcpServers` config, etc.).

This means: every skill in those ecosystems has full plaintext access
to every API key the user has configured. A compromised skill can
exfiltrate the whole set. Filesystem-level encryption-at-rest (macOS
FileVault, etc.) protects against *theft of the disk* but not against
*one skill reading another skill's secrets in-process*.

The user wants cloister's vault to be the substrate AI assistants
*delegate credential storage to*. Skills never hold credentials.
Cloister's vault holds them, enforces per-skill `allowedSubs` glob
matching at the V8-isolate boundary (ADR-0013), and exposes upstream
API endpoints as proxies that inject the credential server-side.

The substrate-as-kernel framing (`cloister-1b59a2`) says this capability
should be named, spec-defined, and pluggable: any operator should be
able to swap the cloister vault DO for a different
`cloister/credential-isolation/v1` implementation (e.g. backed by
Vault.io, AWS Secrets Manager, a self-hosted YubiHSM, etc.) without
touching the consumer side.

## Decision

Define `cloister/credential-isolation/v1` as the first concrete
capability under the substrate-as-kernel framing.

The capability publishes:

1. **A wire protocol** for credential-proxied API calls. Skill →
   cloister-vault-proxy → upstream. Credential never crosses the
   response boundary; injection happens vault-side.
2. **An identity model.** Skills authenticate via Interlace lease
   (ADR-0007). The verified `peerFp` is the subject for `allowedSubs`
   matching.
3. **A capability registry entry** at
   `/.well-known/cloister-capabilities/v1/` listing this capability
   and its current implementation.
4. **A test-vector conformance suite** at
   `cloister-spec/credential-isolation/v1/` mirroring the
   `interlace-spec/0.1.0/` pattern — anyone building a second
   implementation passes the same vectors and is conformant.

### Wire protocol

```
POST /vault/proxy/<service>/<upstream-path>
Authorization: <Interlace-lease-headers>            # per interlace-spec/0.1.0
Content-Type: application/json                       # or whatever the upstream takes
<request body>                                        # skill's request, sans credential

→ verify Interlace lease (existing lease-middleware)
→ resolve credential by (verifiedLease.peerFp, service)
→ check stored credential's allowedSubs glob against peerFp
→ resolve injection strategy from the per-service manifest entry
→ forward to <upstream-base-url>/<upstream-path> with credential injected
→ stream response back to skill verbatim
→ emit Interlace receipt committing to (peerFp, service, upstream_status, path) — NOT the credential value
```

### Injection strategies (discriminated union)

The manifest declares per-service how the credential is injected into
the upstream request. The union is intentionally narrow — only shapes
that appear in widely-deployed APIs:

| Strategy | Wire shape | Example services |
|---|---|---|
| `authorizationBearer` | `Authorization: Bearer <secret>` header added | OpenAI, Anthropic, GitHub, Stripe |
| `authorizationBasic` | `Authorization: Basic <base64(user:secret)>` | older OAuth1-ish services |
| `headerNamed { name: Text }` | `<name>: <secret>` header added | Anthropic's `x-api-key`, GitHub's `X-GitHub-Token` |
| `queryParam { name: Text }` | `?<name>=<secret>` appended | older Google APIs, some legacy services |
| `bodyField { path: Text }` | JSON body field added/replaced at JSONPath | OAuth2 client_credentials grant bodies |

Adding a new strategy requires a schema extension (ADR-0004
append-only) + a new conformance vector. **No "raw shell out" strategy
ever** — the union is closed-by-design.

### Audit invariants

Every proxy call emits an Interlace receipt (`peer_receipts` table in
TrustStore) with the following commitments:

- `peerFp` — the verified skill identity.
- `service` — which logical service the credential belongs to.
- `upstream_status` — HTTP status code returned by upstream.
- `upstream_url_path` — the path component (sans query string).
- `request_size_bytes` — request body size.
- `response_size_bytes` — response body size.
- `wall_clock_ms` — how long the upstream call took.

**The credential value itself is never committed to.** A receipt
cannot be used to reconstruct or verify the credential. This is the
"silence is evidence" property from ADR-0007 §13.2 applied to the
credential-proxy seam.

### Manifest extensions

Per ADR-0004 (append-only), add a new `vaultProxyService` backend
kind plus per-service injection-strategy declaration:

```capnp
struct VaultProxyService {
  name @0 :Text;                       # logical service name, e.g. "openai"
  upstreamBaseUrl @1 :Text;            # https://api.openai.com
  injection :union {
    authorizationBearer @2 :Void;
    authorizationBasic @3 :Void;
    headerNamed @4 :Text;              # header name
    queryParam @5 :Text;               # param name
    bodyField @6 :Text;                # JSON path
  }
  defaultAllowedSubs @7 :List(Text);   # glob list applied when credential is added without explicit allowedSubs
  rateLimitPerMinute @8 :UInt32;       # per-(peerFp, service) bucket
}
```

The existing `Backend.kind` union grows a `vaultProxy` variant
pointing at a `List(VaultProxyService)`. Per ADR-0004, no field
renumbering; new variant gets the next free ordinal.

## Identity model

The skill authenticates via Interlace lease, same as every other
cloister-router route today. No new auth path. No bearer tokens for
this capability — that's the **wrong** path
(per `cloister-1b59a2` discussion).

**Bootstrap question:** how does a skill get an Interlace lease?

Three answers depending on deployment shape:

1. **Skill runs as a cloister bundle** (e.g. OpenClaw co-located inside
   cloister-router per ADR-0018 / cloister-db99cd). It inherits the
   bundle's identity automatically; cloister mints leases for it via
   notme.
2. **Skill runs externally + cloister-router exposes a lease-minting
   sub-route** for it (e.g. a privileged "skill registration" endpoint
   that the gateway operator uses to register a long-lived skill cert).
   The skill then mints short-lived leases against that cert.
3. **Skill speaks to notme directly** over UDS (only possible in
   co-located deployments where notme is reachable from the skill
   process). Same flow as cloister-internal bundles.

This ADR commits to (1) + (2) as the supported v1 paths. (3) is
deployment-dependent and not specified here.

## Spec composition + circular-dep avoidance

This capability is one node in a substrate-wide spec graph. The graph
must be acyclic. Rail for keeping it that way:

### Specs this one CONSUMES (one-way fan-in)

- **`interlace-spec/0.1.0/`** — the identity wire shape (lease envelope,
  cert chain). credential-isolation/v1 uses Interlace as the auth
  primitive; this ADR does not re-specify it. interlace-spec is
  vendor-neutral by design (Python ref-impl proves cross-implementation
  byte-equality).
- **`@notme/contract`** (notme repo, `packages/contract/`) — TS
  constants pinned across the notme ecosystem: `SCOPES`,
  `OIDC_ALLOWED_ALGS`, `ERROR_STATUS`, `CONTRACT_VERSION`. cloister
  consumes this for any token that flows through a notme-minted
  identity surface (scope names in particular).

### Specs this one DOES NOT consume

- **`notme-router`** or any other implementation. Specs are leaves;
  they don't depend on impls. The runtime cloister-router → notme call
  is a *runtime* dep (one-way over a service binding), not a *spec*
  dep — different graphs.

### Specs this one DEFINES (new content)

- The `/vault/proxy/<service>/<path>` wire shape (request / response
  envelope, error codes specific to credential-proxy operations).
- The five injection strategies (`authorizationBearer`,
  `authorizationBasic`, `headerNamed`, `queryParam`, `bodyField`) and
  their per-strategy wire semantics.
- The receipt commitment shape for proxy calls (what fields the
  receipt commits to, what fields it MUST NOT commit to).
- The manifest schema extensions for `vaultProxyService` (per
  ADR-0004 append-only).

### Why the graph is acyclic

Two distinct graphs:

| Layer | Direction | This node consumes | This node is consumed by |
|---|---|---|---|
| **Spec graph** | fan-in, leaves | `interlace-spec/0.1.0/`, `@notme/contract` | Future capability ADRs may reference us; we don't reference them back |
| **Runtime graph** | one-way | At runtime, cloister-router calls notme for lease minting | notme never calls back into cloister-router |

Cycle would require either (a) a spec depending on an impl, OR (b) a
runtime call bouncing both ways. Both are forbidden by design.

### Where the specs physically live (short-term reality)

- `interlace-spec/0.1.0/` lives in this repo (`cloister/interlace-spec/`).
  notme mirrors it byte-identically (the user has flagged this is the
  pattern @notme/contract → notme.bot already uses). A future ADR
  should lift specs into their own repo to make the vendor-neutrality
  visible at the directory level, but the spec dependency is
  conceptually clean today regardless of physical location.
- `cloister-spec/credential-isolation/v1/` lives in this repo
  (`cloister/cloister-spec/`) for the same reason: it's where the
  schema-bridge codegen ecosystem already reads from. Same future-
  lift question applies.
- `@notme/contract` lives in the notme repo. cloister consumes it via
  the byte-identical-mirror pattern (CI byte-diff against the source)
  until it's published as `@notme/contract` on npm. Same shape as
  notme.bot → notme/packages/contract today.

### Scope tokens this capability adds to `@notme/contract`

Per the `@notme/contract` rules ("never mutate an existing constant
value in place; add new, deprecate old, drop after consumer migrates"),
credential-isolation/v1 proposes adding the following to `SCOPES`:

```ts
export const SCOPES = {
  // … existing scopes …
  CRED_READ: "cred:read",       // read a stored credential by service name
  CRED_WRITE: "cred:write",     // store / rotate a credential
  CRED_PROXY: "cred:proxy",     // call upstream via the vault proxy
  CRED_LIST: "cred:list",       // list services the caller is allowed to proxy
} as const;
```

These are proposed; landing them is a notme-repo PR, not a
cloister-repo PR. The cloister-side impl waits until the contract
bump lands.

## Conformance

`cloister-spec/credential-isolation/v1/` contains:

- `README.md` — wire protocol spec (this ADR's `Wire protocol` section
  is the seed; the spec is what conformance is measured against).
- `vectors/` — canonical request/response pairs per injection strategy.
  Each vector includes: the Interlace lease bytes, the manifest entry,
  the skill request, the expected upstream request, the expected
  receipt commitment.
- `ref-impl-py/` — Python reference implementation. If your bytes match
  these, you're conformant.
- `conformance/` — test runner that any implementation can drive
  against any vault deployment to validate compliance.

This is the same pattern as `interlace-spec/0.1.0/`. The Python
ref-impl exists *because* cross-implementation byte-equality is what
makes the capability falsifiable instead of a unilateral cloister
claim.

## What this doesn't do

- **Doesn't replace the existing CredentialVault DO.** The DO is the
  default v1 implementation of this capability. Existing cloister-
  internal usage keeps working unchanged.
- **Doesn't ship multiple implementations.** Like k8s ships with no
  CNI bundled, cloister ships with the CredentialVault DO as the only
  v1 impl at first. The contribution is the *vocabulary*; alternatives
  accrete with users.
- **Doesn't pre-empt the network-identity ADR.** The identity model
  here uses Interlace (ADR-0007) as-is. When the network-identity ADR
  formalizes any cross-substrate identity-flow extensions, this ADR
  inherits them by re-pointing at the new spec.
- **Doesn't define skill registration.** The bootstrap-question
  enumeration above is intentionally not normative. v1's identity
  story is "the skill presents an Interlace lease and the gateway
  verifies it." How the lease was minted is out of scope.

## Consequences

- Cloister becomes a credible credential-isolation substrate for
  external AI assistants. OpenClaw, Claude Code, Codex, etc. each get
  a recipe showing how to wire their config to cloister's vault proxy.
- The "substrate-as-kernel" framing (`cloister-1b59a2`) gets its first
  concrete instance. Future capability ADRs follow the same template
  (`cloister/bead-storage/v1`, `cloister/audit/v1`, etc.).
- The conformance pattern is repeatable. Each future capability ships
  its own spec dir + vectors + ref-impl-py + conformance runner.
- New audit row class (`vault_proxy_receipts`) on TrustStore.
  Append-only per ADR-0003 content-addressed handoff semantics.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Bearer-token auth instead of Interlace lease | The "cheap path" from session 2026-05-17. Works but creates a parallel auth surface; once the lease pipeline is the source of truth for identity (ADR-0007), introducing a sibling shape is the wrong precedent. |
| Per-skill long-lived API tokens (no minting) | Same problem as bearer-token but worse — operator manages a sprawling token set. Doesn't compose with the rest of cloister's identity flow. |
| Expose plaintext credentials over a "vault read" endpoint with TLS | Defeats the entire ADR-0013 invariant. Plaintext crosses the response boundary; one compromised skill leaks the whole vault. |
| Skip the spec dir + vectors; just ship the route | Loses the multi-implementation property. Anyone wanting to back cloister-credential-isolation with their own implementation has nothing to validate against. |
| Embed the credential injection logic in each skill (lib distributed by cloister) | Defeats the boundary entirely. The whole point is that the skill doesn't touch credentials. |

## Implementation

Phased per `docs/plans/credential-isolation-capability.md`. Each phase
closes when its test tranche turns green. TDD-shape: tests are written
first (failing); impl turns them green.

Summary of phases:

1. **Phase 0 (this ADR + scaffold)**: this doc + the spec scaffold +
   the failing test file + the stub module.
2. **Phase 1 (identity)**: `/vault/proxy/<service>` route exists,
   verifies Interlace lease, returns 401/403/404 correctly. No
   injection yet.
3. **Phase 2 (injection: header strategies)**: `authorizationBearer`,
   `authorizationBasic`, `headerNamed`. Upstream call succeeds with
   credential injected.
4. **Phase 3 (injection: body + query)**: `queryParam`, `bodyField`.
5. **Phase 4 (streaming)**: chunked + SSE response bodies stream
   without buffering. Client disconnect aborts upstream.
6. **Phase 5 (audit)**: receipt emitted on every call. Receipt commits
   to the right fields; does NOT commit to the credential.
7. **Phase 6 (rate limit)**: per-(peerFp, service) token bucket.
8. **Phase 7 (no-plaintext invariants)**: error responses don't leak;
   tracing logs don't leak; metrics don't leak.
9. **Phase 8 (capability registry)** — *deferred 2026-06-20 per cred-iso
   audit R-5 (`cloister-12bf80`)*. Original spec: `/.well-known/cloister-
   capabilities/v1/` lists this capability. Disposition: held pending
   ADR-0027 matchmaker. The matchmaker surfaces capability discovery via
   the input-resolution path (`[inputs.*]` in `cluster.toml`), which
   makes a separate `/.well-known/` lookup likely redundant. Revisit
   when the matchmaker lands or when a concrete consumer needs a stable
   well-known surface independent of input resolution.
10. **Phase 9 (conformance vectors)**: `cloister-spec/credential-
    isolation/v1/vectors/` populated; Python ref-impl driving them
    against the running cloister.
11. **Phase 10 (consumer recipes)**: `recipes/credential-isolation/
    {openclaw,claude-code,codex}/` each with a working operator
    runbook.

## Tracking

- Bead: `cloister-8f57f0` (this ADR + impl).
- Framing: `cloister-1b59a2` (substrate-as-kernel).
- Depends on: nothing currently blocked — the existing vault DO is
  the v1 reference impl, ADR-0007 lease pipeline is the v1 identity
  flow.
- Informs: future capability ADRs follow this template.
