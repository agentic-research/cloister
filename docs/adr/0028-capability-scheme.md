# ADR-0028 — Capability identifier scheme: three concerns, three names

- **Status:** Proposed (2026-05-18)
- **Tracking bead:** `cloister-224917` (WIMSE vs SPIFFE), blocks `cloister-963a5c` (Sigstore workflow)
- **Pairs with:**
  - ADR-0007 (Interlace substrate — signed certs that carry capability grants)
  - ADR-0024 (cloister/credential-isolation/v1 — first cloister capability spec)
  - ADR-0027 (substrate-as-kernel matchmaker — consumes capability interface names)
  - `docs/cross-repo-audit.md` finding #1 (the surface that surfaced this question)

## Context

Three independent identifier schemes for "name a capability" coexist
across the ART workspace today:

| Repo | Format | Example | Reference |
|------|--------|---------|-----------|
| **signet** | `urn:signet:cap:<action>:<resource>` (URN) | `urn:signet:cap:sign:artifact`, `urn:signet:cap:mcp:rosary.bot/<email>` | `signet/pkg/attest/x509/bridge.go:107`, `signet/pkg/oidc/cloudflare.go:43` |
| **notme** | `wimse://<authority>/<context>/<id>` (WIMSE workload identity URI) | `wimse://notme.bot/{context}/{id}` | `notme/schema/identity.capnp:74,204,211`; `notme/docs/design/008-bridge-cert-csr-wimse.md` |
| **cloister** | `cloister/<name>/v<n>` (reverse-DNS-ish capability interface name) | `cloister/credential-isolation/v1`, `cloister/interlace-discovery/v1` | ADR-0024, ADR-0027 |

The cross-repo audit at `docs/cross-repo-audit.md` (finding #1)
catalogues the drift. The three formats are **not** synonyms with
different paint — they each encode something different:

- **Signet URNs** name a **capability grant on a cert.** A bridge
  cert ships `Capability` X.509 extensions; the URNs INSIDE the
  extension say what the cert HOLDER is allowed to do (sign this,
  attest that, talk to that MCP server). They live in the cert
  payload; their semantics are "the issuer authorized the holder
  to perform action X on resource Y."

- **WIMSE URIs** name a **workload identity.** A notme worker
  proves it is `wimse://notme.bot/sessions/abc123`. They live in
  the subject of a bridge cert / in JWT-equivalent claims; their
  semantics are "this is the identity I am as a workload." They
  are draft IETF WG (Workload Identity in Multi-Service
  Environments), with a real consumer ecosystem (Cloudflare
  Access, SPIFFE-style platforms).

- **Cloister reverse-DNS names** name a **capability interface
  contract.** `cloister/credential-isolation/v1` is the NAME OF A
  SHAPE that bundles can provide or require. They live in
  `cluster.toml` `[inputs.*]` `provides`/`requires` blocks and in
  `cloister-spec/<name>/v<n>/`; their semantics are "this is the
  interface contract the matchmaker (ADR-0027) walks."

Treating them as interchangeable causes:

1. **Cross-seam confusion.** When a signet-minted cert arrives at a
   cloister bundle that declares `provides = ["cloister/sign-helper/v1"]`,
   neither side has a documented protocol for matching the cert's
   URN-shaped capability claim against the bundle's reverse-DNS
   interface declaration.

2. **Scope creep.** WIMSE URIs leak into capability-grant slots
   ("identity == permission") which conflates workload presence
   with action authorization.

3. **Spec drift.** Each repo's contributors pick a scheme based on
   the seam they're working on; nothing documents the global rule,
   so the three vocabularies grow in parallel.

## Decision

**Adopt all three schemes; assign each a single owning concern;
publish the mapping between them.**

Three concepts, three names is honest. Forcing a single
vocabulary onto all three concerns either (a) loses information
(WIMSE has no place for action+resource pairs) or (b) over-loads
one scheme (capability interface names shouldn't double as
workload identities — different lifecycle, different audience,
different SUBSTRATE).

### The three-lane mapping

| Concern | Owner scheme | Format | Lives in |
|---------|--------------|--------|----------|
| **Capability grant** (cert holder's authorization, "I am allowed to do X") | signet URN | `urn:signet:cap:<action>:<resource>` | Bridge cert X.509 `Capability` extension (signet/pkg/attest/x509/bridge.go); JWT-equivalent grant claims |
| **Workload identity** (cert subject's identity, "I am workload Y") | WIMSE URI | `wimse://<authority>/<context>/<id>` | Bridge cert subject (notme/schema/identity.capnp); SPIFFE-style identity claims |
| **Capability interface** (the SHAPE bundles compose against, "this slot accepts interface Z") | cloister reverse-DNS | `cloister/<name>/v<n>` (interchangeably `cloister/<name>/v<n>@<digest>` for content-pinned refs per ADR-0027) | `cluster.toml` `[inputs.*]` `provides`/`requires`; `cloister-spec/<name>/v<n>/` |

The three lanes are orthogonal. A real authorization check at a
substrate boundary reads ALL THREE:

- The presenting **workload identity** is `wimse://notme.bot/sessions/abc`.
  (Who is asking?)
- The presented **capability grants** include `urn:signet:cap:sign:artifact`.
  (What are they authorized to do?)
- The endpoint's **capability interface** is `cloister/sign-helper/v1`.
  (What shape does this slot expect?)

The matchmaker (ADR-0027) only ever sees lane 3. The Interlace
cert verifier (ADR-0007) only ever sees lanes 1 + 2. The seam where
they meet is the route-attaching code that turns a verified cert
into a bundle-authoring claim — that's the ONE place that needs the
mapping document.

### Mapping document

A new file `cloister-spec/_capability-mapping.md` (parallel to the
proposed `_traits.capnp` per cloister-94cf13) declares the rules:

```
# Capability identifier mapping (ADR-0028)

## When to use each scheme

| Use case | Scheme | Example |
|----------|--------|---------|
| New cert-carried authorization claim | signet URN | urn:signet:cap:read:bead-store |
| New workload identity | WIMSE URI | wimse://cluster.example/bundles/router |
| New interface contract for bundle composition | cloister reverse-DNS | cloister/bead-store/v1 |

## Crosswalk

When a substrate boundary needs to translate (e.g. "this cert grants
urn:signet:cap:read:bead-store; does that satisfy a bundle that
requires cloister/bead-store/v1?"), the boundary code holds the
table:

  urn:signet:cap:read:bead-store    →  cloister/bead-store/v1 (read-only access)
  urn:signet:cap:write:bead-store   →  cloister/bead-store/v1 (read-write access)
  urn:signet:cap:sign:artifact      →  cloister/sign-helper/v1
  ...

The crosswalk is the substrate's job; capability spec authors
write only in their owning lane.
```

## Alternatives considered

### Alternative (b) — WIMSE wins

Standardize on `wimse://` for everything. Signet rewrites
URN-emitting code; cloister adopts the WIMSE shape for interface
contracts.

**Rejected because:**

- WIMSE has no place for action+resource pairs. Forcing
  `wimse://signet/cap/sign/artifact` is syntactic accommodation, not
  a model fit.
- WIMSE has external consumers (Cloudflare Access, SPIFFE-shaped
  platforms) that constrain the URI shape — those consumers don't
  expect URI-as-capability-grant.
- Bridge cert format change would break signet's existing OIDC
  exchange flow + ADR-0007 cert chain verifier.

### Alternative (c) — Reverse-DNS wins

Standardize on `cloister/<name>/v<n>` shape; signet emits this in
cert extensions; notme schemas adopt it.

**Rejected because:**

- Loses the workload-identity concept entirely; can't distinguish
  "this workload is workload X" from "this workload holds capability
  X."
- WIMSE has existing external consumers; breaking them costs more
  than the consistency buys.
- Confuses cert payload (lane 1) with composition substrate (lane 3),
  which are genuinely different concerns with different lifecycles.

### Alternative (d) — Defer

Leave all three schemes co-existing with no mapping document.

**Rejected because:**

- Already the status quo; the cross-repo audit shows it's costing
  coordination ad-hoc as each session re-discovers the question.
- Blocks `cloister-963a5c` (Sigstore workflow) which can't ship
  without a clear "which scheme do Sigstore-witnessed receipts
  carry?" answer.

## Consequences

### Positive

- **Each repo keeps its scheme.** No cross-repo migration; signet
  URNs, notme WIMSE URIs, cloister reverse-DNS names all stay as
  they are today.
- **The mapping document is authoritative.** Future contributors
  read it once, know which lane to write in.
- **ADR-0027 matchmaker is unblocked.** It operates entirely in
  lane 3 (cloister reverse-DNS); the crosswalk is the cert-verifier
  layer's problem.
- **Sigstore workflow (cloister-963a5c) is unblocked.** Receipts
  carry the URN grants (lane 1); the witness verifies against the
  workload's WIMSE identity (lane 2); the workflow declares its
  composition needs in reverse-DNS (lane 3).

### Negative

- **The crosswalk table has to exist somewhere.** A new file
  (`cloister-spec/_capability-mapping.md`) has to be maintained;
  drift between the crosswalk and the underlying schemes is a new
  failure mode.
- **The lane discipline is implicit in code review.** No
  schema-level gate stops someone writing `urn:signet:cap:...` in a
  `provides = [...]` block. Lint rule should catch this (TODO).
- **Three-vocabulary documentation cost.** Newcomers have to learn
  the distinction before reading any seam that touches identity OR
  capability.

### Neutral

- WIMSE remains a draft IETF spec; if it doesn't reach RFC, notme
  may need to migrate. That migration is bounded to notme + the
  crosswalk row, not to cloister or signet.
- Adding a fourth lane (e.g. an OCI-image capability identifier for
  ADR-0026 inputs) is a strict extension — declare it, add the
  crosswalk row, leave the other three alone.

## Implementation arc

1. **Land this ADR as Proposed** so the framing is citable.
2. **Write `cloister-spec/_capability-mapping.md`** — the
   normative crosswalk document. Lives in cloister-spec so all three
   repos can reference it.
3. **Update notme/schema/identity.capnp + signet/pkg/attest/x509/bridge.go
   doc comments** to point at the mapping doc. (Cross-repo PRs,
   small, coordination-light.)
4. **Add lint** (`scripts/lint-capability-scheme.mjs` or extend
   existing `lint-bundle-isolation.mjs`) that fails when a
   `provides`/`requires` value doesn't match the `cloister/...`
   shape — catches accidental WIMSE/URN leakage into lane 3.
5. **Promote to Accepted** after the lint lands + one cross-repo
   consumer adopts the mapping doc.

## Open questions

- **Should the crosswalk live in `cloister-spec/` or in its own
  ART-shared repo?** The cross-repo audit finding #2 + #5 both
  point at a "shared ART substrate" repo as the right home for
  cross-repo concerns. If that repo gets created, the crosswalk
  moves there. Until then, cloister-spec is the closest thing.

- **Does ADR-0028 need a Cap'n Proto schema for the crosswalk?**
  The mapping is operator-readable today; if substrates start
  parsing it programmatically (e.g. cert-verifier looks up the
  URN→cloister-DNS row), it needs a typed shape. Defer to a
  follow-up bead.
