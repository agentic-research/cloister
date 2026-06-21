# Capability identifier mapping (ADR-0028 normative crosswalk)

**Status:** Draft (2026-05-18)
**Tracking bead:** `cloister-224917` (paired with [ADR-0028](../docs/adr/0028-capability-scheme.md))
**Audience:** anyone writing a string identifier in any of the three
namespaces (cert payload, schema, manifest); reviewers checking that
new code writes in the right lane.

This is the **normative** companion to ADR-0028. The ADR carries the
*why*; this document carries the *which one do I write today*.

## §1 Three lanes, three concerns

Three identifier schemes coexist across ART. They are **not**
synonyms. Each owns exactly one concern; they may co-occur on the
same boundary but they encode different facts.

| Lane | Owner scheme | Concern | One-line semantics |
|------|--------------|---------|--------------------|
| **1** | **`urn:signet:cap:<action>:<resource>`** (signet URN) | Capability grant on cert | "the issuer authorized the holder to perform action X on resource Y" |
| **2** | **`wimse://<authority>/<context>/<id>`** (WIMSE URI) | Workload identity | "this is the identity I am as a workload" |
| **3** | **`cloister/<name>/v<n>`** (cloister reverse-DNS) | Capability interface contract | "this slot accepts interface Z" |

A real authorization check at a substrate boundary reads **all three**:

- *Who* is asking? — lane 2 (workload identity)
- *What* are they authorized to do? — lane 1 (capability grant)
- *What shape* does this endpoint expect? — lane 3 (capability interface)

## §2 When to use each scheme

```
new cert-carried authorization claim?            →  Lane 1: urn:signet:cap:<action>:<resource>
new workload identity?                           →  Lane 2: wimse://<authority>/<context>/<id>
new interface contract for bundle composition?   →  Lane 3: cloister/<name>/v<n>
```

If you're not sure, ask: *what changes if my code reads or writes
this string?*

- Cert X.509 extensions or JWT-equivalent grant claims? **Lane 1.**
  See `signet/pkg/attest/x509/bridge.go:107` for the encoding.
- Cert subject / `iss` / `sub` claim? **Lane 2.** See
  `notme/schema/identity.capnp:74` for the encoding.
- `[inputs.*].provides`/`requires` in `cluster.toml`? Routes
  declaring a `requiresCapability` field? Files under
  `cloister-spec/<name>/v<n>/`? **Lane 3.** See ADR-0027 for the
  matchmaker that consumes lane-3 identifiers.

## §3 Cross-lane forbidden patterns

These are wrong by construction; lint rules SHOULD catch them
(see §6).

| Pattern | Why wrong | Right answer |
|---------|-----------|--------------|
| `provides = ["urn:signet:cap:sign:artifact"]` in `cluster.toml` | Lane 1 in a lane-3 slot — capability grants are issued to cert holders, not declared by inputs | Use `provides = ["cloister/sign-helper/v1"]` and let the cert verifier translate via §4 |
| `provides = ["wimse://cluster.example/bundles/router"]` | Lane 2 in a lane-3 slot — workload identity is who you are, not what interface you implement | Use `provides = ["cloister/router/v1"]` |
| `urn:signet:cap:wimse://...` | Wrapping a lane-2 URI inside a lane-1 URN | Use the lane that owns the concern; don't nest |
| `cloister/credential-isolation/v1` as a cert extension value | Lane 3 in a lane-1 slot — interface contracts aren't grants | The grant should be `urn:signet:cap:read:credential-isolation` (or similar); the interface contract is named separately |
| WIMSE URI scheme `cloister://...` | Confuses lane 2 (workload) with lane 3 (interface) by sharing a scheme name | Workloads use `wimse://`; interfaces are bare reverse-DNS strings, no scheme |

## §4 Crosswalk table (lane-1 ↔ lane-3)

The substrate boundary that turns a *verified cert* (carrying lane-1
grants) into an *authorized capability call* (against a lane-3
interface) holds this table. It is the **only** place the three lanes
meet programmatically.

| Lane-1 grant (signet URN) | Lane-3 interface (cloister reverse-DNS) | Notes |
|---------------------------|------------------------------------------|-------|
| `urn:signet:cap:read:bead-store` | `cloister/bead-store/v1` | Read-only access (search/list/get/comment-list). |
| `urn:signet:cap:write:bead-store` | `cloister/bead-store/v1` | Read-write access (bead_create/update/close). Implies read. |
| `urn:signet:cap:read:credential-isolation` | `cloister/credential-isolation/v1` | Vault-proxy read on configured `defaultAllowedSubs`. |
| `urn:signet:cap:sign:artifact` | `cloister/sign-helper/v1` | leyline-sign-helper (`POST /sign`) invocation grant. |
| `urn:signet:cap:read:disclosure:<fp>` | `cloister/interlace-discovery/v1` | Per-peer disclosure-endpoint read; `<fp>` is the target peer fingerprint. |
| n/a (substrate-internal) | `cloister/mcp-tool/v1` | `_meta.art.cloister/v1` extension on MCP `server.json`; build-time partitioning hint for the resolver, not a wire surface a cert authorizes. Authorization for invoking the resulting MCP tools belongs to each upstream tool's own capability, not to the partitioning hint itself. |
| n/a (OCI bearer-token) | `cloister/build-cache/v1` | Content-addressed blob transport (BLAKE3-keyed via OCI distribution). v1 spec is explicit (§Non-goals) that authentication beyond OCI's standard bearer-token flow is out of scope; a substrate cert grant is not in the v1 path. A future v2 may add a lane-1 grant if cluster-tier cache scoping becomes load-bearing. |

This table is **non-exhaustive** today. As new capability specs land
under `cloister-spec/<name>/v<n>/`, they MUST add their
URN-to-interface row(s) here in the same PR that adds the spec dir
— otherwise the cert verifier has no way to bridge a grant to the
interface.

**Empty row policy:** If a capability has no lane-1 grant analog
(e.g. a purely-internal substrate capability), the row is still
required, with the lane-1 column reading `n/a (substrate-internal)`.
This forces the spec author to think about whether a grant is
appropriate, rather than silently omitting one.

## §5 Crosswalk table (lane-2 ↔ lane-3)

Workload identity is **not** a grant, but it can be the basis for
implicit grants. The substrate boundary that decides "this workload
is authorized for this interface by virtue of *being* that workload"
holds this table.

| Lane-2 workload (WIMSE URI) | Lane-3 interface implicitly granted | Why |
|-----------------------------|--------------------------------------|-----|
| `wimse://cluster.example/bundles/notme-internal` | `cloister/notme-master-sk-sign/v1` | The notme-internal bundle is the *only* workload allowed to invoke master-sk signing per ADR-0018. |
| `wimse://cluster.example/bundles/cloister-router` | `cloister/credential-isolation/v1` (proxy mode) | The router bundle proxies vault reads on behalf of other bundles; its identity is the authorization. |

This table is intentionally short. **Implicit grants by workload
identity are an anti-pattern** in most cases (they make
audit-by-receipt harder; the receipt records the call but doesn't
show *why* the workload was authorized). The substrate should prefer
explicit lane-1 grants on certs over implicit lane-2 entitlements.
This table captures the genuine exceptions, not the default.

## §6 Lint rule (future)

A future lint rule (`scripts/lint-capability-scheme.mjs`, parented
by `cloister-224917`) MUST fail the build when:

1. Any value in a `cluster.toml` `[inputs.*].provides`/`requires`
   list does NOT match the regex-equivalent shape `cloister/<kebab-case>/v<digit>+`
   (lane 3 only). Substring check, no regex per project convention.
2. Any value in a signed cert extension that lives in the substrate
   payload (e.g. extracted by `lease-middleware.ts`) does NOT match
   the prefix `urn:signet:cap:` (lane 1 only).
3. Any value in a `Bundle.workloadIdentity` field (future schema
   addition) does NOT match the prefix `wimse://` (lane 2 only).

Until the lint lands, code review enforces. ADR-0028 §"Lint rule"
tracks the rule's planned shape.

## §7 Mapping doc maintenance

This document is **load-bearing**. When the crosswalk table here
drifts from the implementation, the substrate boundary can't
translate, and the failure mode is "authorized request gets denied
because the verifier doesn't know URN→interface".

**Update protocol.** Any PR that adds, removes, or renames a row in
§4 MUST also:

1. Add or update the corresponding test vector under
   `cloister-spec/<affected-cap>/<v>/test-vectors/` exercising the
   crosswalk path.
2. Touch the bead it's filed against (or open a new bead under
   `cloister-224917` as a child) so the crosswalk change is
   discoverable.
3. Land in the same PR as the lane-1 grant rollout (if a new
   URN action is added) — never split the URN definition from its
   crosswalk row, or the verifier ships not knowing how to bridge.

**Versioning.** Lane 3 (`cloister/<name>/v<n>`) carries an explicit
version suffix. When `cloister/bead-store/v2` ships, the row stays
in §4 *alongside* the v1 row — old certs with old URN grants must
still bridge to the version of the interface they were issued for.
Deletion of a row is a wire-breaking change and follows the
spec-major-bump rules in `LAYOUT.md` §Versioning.

## §8 Where this doc lives, and where it might move

This file lives at `cloister-spec/_capability-mapping.md` today
(underscore-prefixed to signal *not a capability spec itself* but
spec-tree-shared infrastructure, same convention as
`_traits.capnp` per `cloister-94cf13`).

The cross-repo audit at `docs/cross-repo-audit.md` notes that if a
shared ART substrate repo gets created (per the audit's finding #2
+ #5 recommendation), this doc may move there alongside other
cross-repo concerns. Until then, cloister-spec is the closest thing
to a cross-repo source of truth — and signet + notme already
reference cloister-spec assets, so the location is workable.

**If this doc moves, update:**

- ADR-0028 frontmatter "Pairs with"
- `docs/STATUS.md` ADR-0028 row
- `docs/cross-repo-audit.md` finding #1 reference
- Whatever cert-verifier-layer code reads this table (none today,
  but tracked).

## §9 Open questions

- **Should the crosswalk table be machine-readable?** Today the
  §4 table is markdown — fine for review, but the cert-verifier
  needs to consult it programmatically. A follow-up bead would
  emit a `crosswalk.json` from this markdown (or vice versa) so
  both reviewers and verifiers see the same source of truth.

- **Per-resource vs wildcard URNs.** `urn:signet:cap:read:bead-store`
  is wildcard ("any bead store"); a future `urn:signet:cap:read:bead-store/<repo>`
  scopes by repo. Lane-3 interface names are already wildcard
  ("any cloister/bead-store/v1 implementation"); the scoping happens
  at substrate-call time via the workload identity (lane 2). This
  asymmetry is currently fine but should be documented when the
  per-resource URN shape is introduced.

- **Sigstore receipts (cloister-963a5c).** Sigstore-witnessed
  receipts carry an OIDC-issued identity claim. That claim is
  *closest* to lane 2 (workload identity) — the receipt says "this
  workload (per OIDC) did this thing." The witness verifies the
  workload identity; the call's authorization still comes from
  lane 1 (capability grants on the cert chain). Document this
  triangulation explicitly when the Sigstore workflow lands.
