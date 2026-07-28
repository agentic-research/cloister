# Plan — `cloister/credential-isolation/v1` (TDD-shape)

- **Bead:** `cloister-8f57f0`
- **ADR:** `docs/adr/0024-credential-isolation-capability.md`
- **Spec:** `leyline-schema-spec/credential-isolation/v1/`
- **Framing:** First concrete capability under `cloister-1b59a2`
  (substrate-as-kernel).

## How to read this plan

Each phase has a tranche of failing tests that close it. **Implementation
work = make the tests turn green.** No phase ships without its tests
passing. New behavior added later = a new test added first, watched
red, then made green.

The failing baseline lives at `test/routes/vault-proxy.test.ts`. The
stub at `src/routes/vault-proxy.ts` exists so imports link and tests
fail with `not-implemented` rather than module-not-found. Stub deletes
itself piece-by-piece as phases close.

## Dependency rail (recap from ADR-0024)

- Spec graph: leaves only. leyline-schema-spec/credential-isolation/v1
  CONSUMES interlace-spec/0.1.0 + @notme/contract. Specs don't consume
  impls. Future capability ADRs follow the same rule.
- Runtime graph: cloister-router → notme (one-way over service binding).
  notme never calls back. Service-binding is the runtime seam.
- Cross-repo TS constants: cloister mirrors `@notme/contract` via the
  byte-identical-mirror + CI byte-diff pattern (same shape as
  notme.bot → notme/packages/contract). Replace with `npm install
  @notme/contract` once published.

**Pre-Phase prerequisite (notme-repo PR, not this plan):** add
`CRED_READ`, `CRED_WRITE`, `CRED_PROXY`, `CRED_LIST` to
`@notme/contract`'s `SCOPES` per its append-only rules. cloister-side
work waits for this to land + the mirror to byte-diff clean.

## Phases

### Phase 0 — Scaffolding (this commit)

**What lands:** ADR-0024, spec scaffold (`leyline-schema-spec/credential-isolation/v1/README.md` + `wire/proxy-envelope.md`), plan doc (this file), stub module (`src/routes/vault-proxy.ts`), failing test file (`test/routes/vault-proxy.test.ts`), task list scaffolding.

**Test state:** all tests fail. `task lint` flags the failure
(intentional — the baseline is the executable plan).

**Closes when:** the diff lands on a branch + the failing-test count
is what's expected (15 failing tests, no errors).

### Phase 1 — Identity gates

**Tests this phase closes:**
- `returns 401 when no Interlace headers present`
- `returns 401 when lease signature fails verification`
- `returns 401 when lease nonce is replayed`
- `returns 401 when lease ts is outside clock-skew bound`
- `accepts valid lease + returns 404 when service not declared`
- `returns 403 when valid lease + service declared + peerFp not in allowedSubs`
- `returns same constant-time body shape for 401/403/404` (enumeration-oracle invariant)

**Impl:** mount `/vault/proxy/<service>/<path>` route. Wire to
existing `src/routes/lease-middleware.ts` for the lease verification
pipeline. Look up service from manifest (`VaultProxyService` entries).
Return constant-time 401/403/404 bodies. No credential lookup yet, no
upstream call yet.

**Spec dep:** interlace-spec/0.1.0 — fully consumed. No new wire
shape on the response side; just status codes + bodies.

**Closes when:** the 7 identity tests above pass. Existing
cluster:zod, lint, test all stay green.

### Phase 2 — Header injection strategies

**Tests this phase closes:**
- `authorizationBearer: upstream receives Authorization: Bearer <stored>`
- `authorizationBasic: upstream receives Authorization: Basic <b64(user:stored)>`
- `headerNamed { name: "x-api-key" }: upstream receives x-api-key: <stored>`
- `client never observes the stored credential in success response body`
- `client never observes the stored credential in success response headers`

**Impl:** the actual upstream call. Resolve credential by
`(verifiedLease.peerFp, service)` from the existing CredentialVault
DO (no schema change to the DO; consume its current surface). Apply
injection per the manifest's per-service strategy. Make the upstream
call via `fetch()`. Return the upstream response verbatim, sans
credential.

**Spec dep:** `wire/injection-strategies.md` (write this file in this
phase — it documents the three header strategies + their conformance
vectors).

**Closes when:** the 5 tests above pass + the 7 from Phase 1 still
pass.

### Phase 3 — Query + body injection strategies

**Tests this phase closes:**
- `queryParam { name: "api_key" }: upstream URL has ?api_key=<stored>`
- `bodyField { path: "client_secret" }: upstream JSON body merges in stored cred`
- `bodyField on top-level path works`
- `bodyField on nested path (e.g. "auth.client_secret") works`
- `queryParam URL-encodes the credential value correctly`

**Impl:** the two non-header strategies. JSON body merging via
JSONPath (cheap subset: dot-separated paths, no array indices for
v1). Query string injection with URL encoding.

**Spec dep:** `wire/injection-strategies.md` extended with the two
strategies + their vectors.

**Closes when:** the 5 tests above pass + Phases 1-2 still pass.

### Phase 4 — Streaming + chunked + SSE

**Tests this phase closes:**
- `upstream chunked transfer-encoding streams to client without buffering`
- `upstream SSE event stream forwards token-by-token`
- `client disconnect aborts upstream request mid-flight`
- `wall_clock_ms on the receipt reflects time-to-last-byte, not time-to-first-byte`

**Impl:** swap the upstream `fetch()` for a streaming response. Use
the `ReadableStream` from `Response.body` and pipe it to the
worker's response. Hook `request.signal` so caller disconnect cancels
the upstream.

**Spec dep:** `wire/proxy-envelope.md` §Response — the streaming
guarantee is implicit there. Make it explicit in this phase if
discrepancies appear.

**Closes when:** the 4 tests above pass + Phases 1-3 still pass.

### Phase 5 — Audit receipts

**Tests this phase closes:**
- `receipt emitted on every proxy call (success path)`
- `receipt emitted on every proxy call (error path)`
- `receipt commits to (peerFp, service, upstream_status, upstream_url_path, request_size, response_size, wall_clock_ms)`
- `receipt MUST NOT commit to credential value`
- `receipt MUST NOT commit to upstream request body`
- `receipt MUST NOT commit to upstream response body`
- `receipt MUST NOT commit to query string`
- `receipt MUST NOT commit to allowedSubs list`

**Impl:** wire to existing Interlace receipt emitter (TrustStore's
`peer_receipts` table). Define a new receipt type
`credential-isolation/v1/proxy-call` so future consumers can
filter. Commit hash = `sha256(canonical_receipt_input)` per the spec.

**Spec dep:** write `wire/receipt-commitment.md` in this phase.
Includes the canonical-bytes definition + the explicit MUST-NOT list.

**Closes when:** the 8 tests above pass + Phases 1-4 still pass.

### Phase 6 — Rate limit

**Tests this phase closes:**
- `per-(peerFp, service) token bucket enforced`
- `rate limit returns 429 with @notme/contract ERROR_STATUS mapping`
- `rate limit does NOT leak across (peerFp, service) tuples`

**Impl:** in-DO rate limiter. Bucket per `(peerFp, service)`,
refilled at `rateLimitPerMinute` (manifest field). Use the same
shape as existing `LEYLINE_SIGN_CALLER_TOKENS` rate limit on the
helper (consistency across substrate-side rate limits).

**Closes when:** the 3 tests above pass + Phases 1-5 still pass.

### Phase 7 — No-plaintext-leak invariants (security-audit pass)

**Tests this phase closes:**
- `error response (401/403/404/429/500) MUST NOT include credential`
- `error response MUST NOT include upstream-side error details that may include credential`
- `tracing log MUST NOT include credential at any log level`
- `metric label MUST NOT include credential or any prefix of it`
- `upstream-response header (Set-Cookie, etc.) is forwarded but credential is NEVER in any header cloister sets`

**Impl:** audit pass. Likely requires: a wrapper around all
log/metric emission paths in `src/routes/vault-proxy.ts` that
sanity-checks no field name implies "credential" or "secret"; a
fallthrough error handler that catches upstream errors and returns
the constant-time 502 body without forwarding upstream-internal
error messages (which sometimes echo headers).

**Closes when:** the 5 tests above pass + Phases 1-6 still pass + a
manual audit walks every code path looking for leak vectors and
reports findings.

### Phase 8 — Capability registry endpoint

**Tests this phase closes:**
- `GET /.well-known/cloister-capabilities/v1/ lists cloister/credential-isolation/v1 with impl metadata`
- `entry includes spec_url, impl_version, allowed_strategies`
- `entry conforms to the well-known schema (whatever we land for capability discovery)`

**Impl:** new route. Reads from the manifest at startup to populate
the capability list. v1 lists only this capability + the
substrate-internal vault DO as the v1 impl.

**Spec dep:** this is the first instance of the capability-discovery
shape that `cloister-1b59a2` charted. Land a tiny spec for the
registry-endpoint format itself — out of scope for this bead, file as
follow-up.
<!-- lint-allow-unresolved: DEFERRED BY DECISION, not missing. ADR-0024 Phase 8 held the capability registry on 2026-06-20 (cred-iso audit R-5, cloister-12bf80): the ADR-0027 matchmaker surfaces discovery through input resolution, making a separate /.well-known/ lookup likely redundant. Adjacent pieces exist and are NOT this: signet owns grant representation (docs/design/010, urn:signet:cap:), LLO owns identifier lanes (schema-spec/_capability-mapping.md, ADR-0028). Neither specifies a discovery response shape. Revisit per ADR-0024's own condition — see cloister-9c196b. -->
(`leyline-schema-spec/capability-discovery/v1/`)

**Closes when:** the 3 tests above pass + Phases 1-7 still pass.

### Phase 9 — Conformance vectors

**Tests this phase closes:** none in cloister's vitest suite; this
is the spec-side conformance suite.

**Spec dep:** populate `leyline-schema-spec/credential-isolation/v1/
vectors/` with JSON-as-carrier vectors for each strategy + each
identity gate + each error class. Implement
`leyline-schema-spec/credential-isolation/v1/ref-impl-py/` (Python ref
impl). Implement `conformance/run.py` that drives a running cloister
through the vectors and validates byte-equality.

**Closes when:** the Python ref-impl + the cloister TS impl both
pass the conformance suite against the same vectors. CI gate added
(`task cred-iso:conformance` invokes the runner).

### Phase 10 — Consumer recipes

**What lands:**
- `recipes/credential-isolation/openclaw/` — operator runbook showing
  how to wire OpenClaw's `~/.openclaw/openclaw.json` to route its
  upstream API calls through cloister's vault proxy. Identity story
  options documented (skill-as-cloister-bundle vs operator-registered
  long-lived skill cert).
- `recipes/credential-isolation/claude-code/` — same for Claude Code's
  MCP server config. Skills' Streamable HTTP backends point at
  cloister.
- `recipes/credential-isolation/codex/` — same for Codex.

**Closes when:** each recipe has a working end-to-end example tested
against a local cloister + that consumer running side-by-side.

### Phase 11 — Manifest schema additions (lands LAST, gated on the ADR)

**Why last:** the manifest extension is a substrate-decision touch
that requires ADR-0024 to be Accepted AND the user's incoming
network-identity ADR to inform any cross-cutting schema fields. Until
then, this capability runs off existing manifest fields + a
side-channel TOML config file in `leyline-schema-spec/credential-isolation/
v1/example-services.toml` for declaring services.

Once the manifest extension lands:
- `Backend.kind` grows a `vaultProxy: List(VaultProxyService)` variant.
- The new `VaultProxyService` struct (per ADR-0024) carries per-service
  config.
- schema-bridge picks up the new fields automatically (zod codegen).
- The bidi TOML pipeline (when it lands) makes operator-side
  configuration ergonomic.

**Closes when:** manifest extension lands + the side-channel
`example-services.toml` mode is removed + all tests still pass.

## Out of scope for this plan

- Credential rotation policy (when, who triggers, how propagated).
  Filed for a future bead.
- Multi-region / replicated vault. Existing CredentialVault DO is
  singleton-per-cluster; replication is ADR-0010 territory.
- BYO-key delegation (where the credential lives in the operator's
  HSM and the proxy holds only a reference). Future capability,
  possibly v2 of this one.
- Webhook-style notification ("credential rotated, here's the new
  receipt sequence"). Future.

## Status tracking

This plan is the bead's living document. Each phase update lives in
the bead's comment thread. The plan turns green phase-by-phase; once
Phase 11 closes the bead does too.
