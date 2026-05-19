# Cross-repo overlap audit — cloister / signet / notme / ley-line

**Filed:** 2026-05-18  ·  **Bead:** [cloister-182ba2](../README.md#beads)
·  **Status:** Findings + recommended actions; no work has been
done against any of the items here yet.

This document enumerates surfaces that overlap between cloister and
its sibling repos in the ART workspace (`~/remotes/art/`). The intent
is to be the source-of-truth for "what needs cross-repo coordination"
so future evolve cycles can reference this instead of re-discovering
the same overlaps each time a fresh session opens.

The five findings below are ordered by **coordination cost** — items
near the top need an architectural decision before any single repo
can move forward, items near the bottom are mechanical cleanup that
just hasn't been scheduled yet.

| # | Surface | Repos touched | Recommended action | Tracking |
|---|---------|---------------|---------------------|----------|
| 1 | Capability identifier scheme | cloister + signet + notme | **ADR-0028** in cloister; reconcile to a single scheme | cloister-2f021f, blocks cloister-963a5c |
| 2 | `rs/crates/sign/` trust-root crate | cloister + signet + ley-line + ley-line-open | Promote one crate, mark the others as either thin wrappers or DELETE-ON-MERGE | cloister-12b062 |
| 3 | `vault/` substrate duplication | cloister + notme | notme/vault/ is legacy — delete on schedule | notme-9af5dd |
| 4 | `interlace-spec/0.1.0/` consumer fanout | cloister (owner) + notme + signet | Version-pin consumers; declare the spec ABI-stable | (no bead yet — file one) |
| 5 | Schema-bridge tool | cloister (owner) + notme (lifted copy) | Either extract to ART-shared crate, OR notme consumes via git submodule / git subtree | (no bead yet — file one) |

Sections below give the evidence + the recommendation for each.

---

## 1. Capability identifier scheme drift — needs ADR-0028

Three independent schemes for "name a capability" coexist today:

| Repo | Format | Example | Reference |
|------|--------|---------|-----------|
| **signet** | `urn:signet:cap:<action>:<resource>` (URN) | `urn:signet:cap:sign:artifact`, `urn:signet:cap:mcp:rosary.bot/<email>` | `pkg/attest/x509/bridge.go:107`, `pkg/oidc/cloudflare.go:43` |
| **notme** | `wimse://<authority>/<context>/<id>` (WIMSE identity URI) | `wimse://notme.bot/{context}/{id}` | `schema/identity.capnp:74,204,211`, `docs/design/008-bridge-cert-csr-wimse.md` |
| **cloister** | `cloister/<name>/v<n>` (reverse-DNS-ish path) | `cloister/credential-isolation/v1`, `cloister/interlace-discovery/v1` | ADR-0024, ADR-0027 |

These are not equivalent: signet's URNs encode an action+resource
binary (`sign:artifact`), notme's WIMSE URIs encode a workload
identity (`wimse://notme.bot/context/id`), and cloister's reverse-DNS
paths name a capability *interface* (provides/requires sides per
ADR-0027). All three have legitimate use cases, but no document says
*which scheme owns which concept*.

This breaks at the seams: when an Interlace cert from signet carries
`urn:signet:cap:sign:artifact` and arrives at a cloister bundle that
declares `provides = ["cloister/sign-helper/v1"]`, neither side has
a documented protocol for matching them up.

**Recommended action.** Draft **ADR-0028** in cloister that
reconciles the three. Three plausible outcomes:

- **(a)** **All three scopes are distinct types.** Signet URNs name
  *capability grants on certs*; notme WIMSE URIs name *workload
  identities*; cloister paths name *capability interface contracts*.
  The matchmaker (ADR-0027) operates on cloister paths; the cert
  carries the URN; the workload presents the WIMSE URI. Three
  schemes, three concerns, one mapping document.

- **(b)** **WIMSE wins.** Standardize on `wimse://` for everything;
  signet rewrites URN-emitting code; cloister adopts the WIMSE
  shape. Larger blast radius (cert payload change) but a single
  vocabulary.

- **(c)** **Reverse-DNS wins.** Standardize on `cloister/<name>/v<n>`
  shape; signet emits this in cert extensions; notme schemas adopt
  it. Aligns with the kernel-of-capabilities framing but means
  abandoning WIMSE (which has external consumers — Cloudflare Access
  integration).

Author's read: **(a) is the right answer.** Three concepts, three
names is honest. The ADR should publish the mapping table so any
future implementer can translate. Blocker for `cloister-2f021f`
(WIMSE vs SPIFFE) and `cloister-963a5c` (Sigstore workflow).

## 2. `rs/crates/sign/` trust-root crate — duplicated four ways

The crate that does Ed25519 CMS/PKCS#7 signing + cert verification
exists in **four repositories**, with three different identities:

| Repo | Crate name | License | Files |
|------|------------|---------|-------|
| **cloister** | `leyline-sign` | AGPL-3.0-or-later | `lib.rs`, `cert.rs`, `cert_chain.rs`, `cms.rs`, `error.rs`, `ffi.rs`, `oid.rs`, **`bin/helper.rs`**, **`host/`** module |
| **signet** | `signet-sign` | Apache-2.0 OR MIT | `lib.rs`, `cert.rs`, `cms.rs`, `error.rs`, `ffi.rs`, `oid.rs` (no host, no helper) |
| **ley-line** | `leyline-sign` | AGPL-3.0-or-later | `lib.rs`, `cert.rs`, `cms.rs`, `error.rs`, `ffi.rs`, `oid.rs` (no host, no helper) |
| **ley-line-open** | (separate path: `rs/ll-open/sign/`) | — | parallel copy |

cloister's version is the most complete — it carries the
`leyline-sign-helper` binary + `host` feature gate per ADR-0019, in
addition to the wasm-buildable verifier core that all four share.

**Risk:** The cert/CMS/oid code drifts. A CVE in one repo's `cert.rs`
doesn't auto-propagate; a fix in `signet-sign` doesn't reach
`leyline-sign`. The repos differ in license posture too (AGPL vs
Apache+MIT), which complicates an obvious "just make signet depend on
leyline-sign" answer.

**Recommended action.** Three plausible outcomes:

- **(a)** **Promote `leyline-sign` to its own ART repo** (e.g.
  `~/remotes/art/leyline-sign/`); all four current sites depend on
  it. License has to be the more permissive choice (Apache-2.0 OR
  MIT) for signet to consume; that means relicensing cloister's host
  helper. **Highest one-time cost, lowest steady-state.**

- **(b)** **`leyline-sign` stays in cloister, signet vendors from it.**
  Signet drops `signet-sign` + git-subtree-pulls `cloister/rs/crates/sign/`.
  License has to reconcile (one side gives ground); cloister becomes
  the upstream of record. **Medium cost.**

- **(c)** **Accept the duplication.** Document the four copies in this
  table, set up a CI lint that fails if `cert.rs`/`cms.rs`/`oid.rs`
  byte-diverge across the repos, and treat them as "auto-pinned
  copies." **Lowest one-time cost, highest steady-state friction.**

Author's read: **(b) is the next concrete step** — cloister already
hosts the helper binary, which is the value-add. Tracked by
`cloister-12b062` (P1, OPEN). Decision needs license reconciliation
first.

## 3. `vault/` substrate duplication

Two `vault/` directories exist:

- `cloister/vault/` — the canonical implementation, ADR-0010 +
  ADR-0013 + ADR-0021 substrate slice, per-bundle DOs, KEK source
  per ADR-0014.

- `notme/vault/` — legacy. notme's vault is a smaller surface that
  predates the ADR-0021 per-bundle work; the README explicitly says
  this is removed when `notme-9af5dd` closes.

**Recommended action.** Close `notme-9af5dd`. No coordination needed
between sessions — it's a notme-side delete + reference rewrite. The
finding here is just "this is still on the books," not "this needs
new design."

## 4. `interlace-spec/0.1.0/` consumer fanout

`interlace-spec/` is canonical inside cloister at the repo root.
Cross-repo consumers include:

- `notme/schema/identity.capnp` (cross-references the spec for
  WIMSE binding semantics — file:line `74` and elsewhere)
- `signet/pkg/` (no direct grep hit today, but the bridge cert
  format alignment work in `signet-882eca` references the spec)
- `ley-line/` (sigstore integration depends on the receipt-chain
  shape from `interlace-spec/0.1.0/RECEIPTS.md`)

No version pin or `go.mod`/`Cargo.toml` dependency links these — the
consumers either re-implement the schema (notme) or eyeball the spec
markdown (signet, ley-line). Last week's well-known epoch-index work
(`cloister-c13fa5`) bumped the discovery doc to **0.2.0** while
RECEIPTS.md is still at 0.1.0; there's no mechanism preventing the
consumers from drifting.

**Recommended action.** Two-step:

1. **Declare a versioned ABI.** `interlace-spec/0.2.0/` (or
   `0.1.1/`) becomes a frozen tag. The README at
   `interlace-spec/README.md` should call out the versioning
   contract: minor versions are additive-only; major versions
   require consumer migration.

2. **Add a consumer registry.** A file like
   `interlace-spec/CONSUMERS.md` enumerating who consumes what
   version + where in their tree. Today the cross-repo grep is the
   only way to find this; that's load-bearing tribal knowledge.

No bead exists for either step yet. File when scheduling.

## 5. Schema-bridge tool — already lifted into notme

`notme/packages/schema-bridge/NOTICE` line 3:

```
Lifted from cloister/tools/schema-bridge/ (AGPL-3.0) on 2026-05-18
```

That happened **today**. The pattern of "I need the schema-bridge
output in repo X, so I copy the source" is already going to bite
when the AGPL-3.0 source picks up a security fix or a Phase 2
feature (capability ref shape per ADR-0027).

**Recommended action.** Three plausible outcomes:

- **(a)** **Promote `tools/schema-bridge/` to its own ART repo**
  (e.g. `~/remotes/art/schema-bridge/`); cloister + notme + future
  consumers depend on it as a published artifact. Mirrors the
  recommendation for `leyline-sign` in finding #2.

- **(b)** **Use git subtree** so notme's `packages/schema-bridge/`
  is auto-syncable from cloister's `tools/schema-bridge/`. Lower
  ceremony than promoting; loses the "single upstream" benefit.

- **(c)** **Accept the lift.** Add a CI lint in notme that fails the
  build if the `NOTICE` SHA doesn't match a recent cloister commit;
  forces a re-lift on every cloister change. Lowest cost, highest
  friction.

Author's read: **(a) is consistent with #2.** If we promote
`leyline-sign` we should promote `schema-bridge` at the same time —
they're both "ART-shared infrastructure that several repos want."

No bead exists yet. File one alongside the `leyline-sign` decision
so the answer is consistent.

---

## What this audit is NOT

- **Not** a migration plan. The "Recommended action" cells say
  "do this," but each one needs its own ADR + bead before
  implementation starts.
- **Not** a vote of confidence in any of the three capability
  schemes from #1. ADR-0028 picks; this audit just maps the surface.
- **Not** comprehensive. It covers the five overlaps surfaced by a
  half-hour `~/remotes/art/` walk + the cloister bead backlog. A
  second pass focused on (e.g.) the `Taskfile.yml`s, the
  `wrangler.toml`s, the cargo workspace shapes would surface more.

## Update protocol

When a finding here is closed (or escalates to its own ADR), strike
the row and add the resolution citation:

```
| 1 | ~~Capability identifier scheme~~ | — | **Resolved** by [ADR-0028](adr/0028-…) | — |
```

This document is the live ledger. If you find a sixth overlap,
append it as `## 6.` with the same shape.
