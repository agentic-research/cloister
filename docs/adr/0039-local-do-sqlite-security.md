# ADR-0039 — Securing local Durable Object SQLite at rest

- **Status:** Proposed (2026-07-05)
- **Tracking bead:** `cloister-ffd17b` (research + this ADR)
- **Pairs with:**
  - ADR-0014 (Pluggable KEK source — the OS-keystore key custody this reuses)
  - ADR-0019 (sign-only trust-anchor-helper — the custody channel for the KEK)
  - ADR-0023 (`CLOISTER_DO_PATH` — the storage-path indirection Phase 1 mounts onto)
  - ADR-0024 (`credential-isolation/v1` — names the same-UID "one skill reads another's secrets" adversary)
  - ADR-0021 / §18 (vault at-rest envelope — the AES-256-GCM pattern Phase 3 generalizes)
  - Threat model §13.9 (the seam this ADR defends; extended first per the house rule)

## Context

Cloudflare secures Durable Objects and their SQLite backing in
production: encrypted at rest, process-isolated, reachable only through
the DO runtime. **Locally — `workerd serve` / miniflare — none of that
holds.** The DO SQLite files sit plaintext on disk, mode `0644`, and
hold the load-bearing state: bead content (BeadStore), the entire trust
substrate (TrustStore `peer_lease_counters`, `seen_nonces`,
`peer_attestations` — the §13.2 audit chain), BlobStore CAS, and the
vault DO.

Verified against the live tree (`cloister-ffd17b`): four persistence
paths — `.wrangler/state/v3/do/` (`task dev`),
`~/.local/share/cloister/do/` (`task serve:local`), `/data/do` (OCI
volume), `~/.cache/cloister-dev/do/` — all plaintext. Live
`peer_lease_counters` + `seen_nonces` rows were read directly with
`sqlite3`. The WAL/`-shm` sidecars carry plaintext recent writes too.

**Why now.** §13.7.2 + §13.7.4 already treat "operator-tier disk
tamper" as an explicit out-of-scope boundary. That is fine for a
*server* the operator owns. It is **too cheap on a local machine that
runs AI agents all day**: any same-UID process — a malicious skill, a
compromised `npm postinstall`, a rogue tool — is de-facto
"operator-tier" and can open the DO files out of band from the runtime.
That is precisely the adversary ADR-0024 already names ("one skill
reading another skill's secrets in-process"), applied to storage.

**The hard constraint.** workerd's `durableObjectStorage` union is
`none | inMemory | localDisk` only (verified in the vendored
`workerd.capnp`) — there is **no encryption hook, no keying option**.
The DO runtime cannot seal its own SQLite. So any solution is either
*around* the file (encrypt the volume / the bytes before write) or
*alongside* it (tamper-evidence), not *inside* workerd.

**One thing is already right:** the vault seals credential *values*
(`credentials.sealed_headers`, AES-256-GCM, `vault/src/crypto.ts`, §18).
The gap is everything else — vault *metadata* and the other three DOs.

## Decision

Secure local DO SQLite with a **layered, Mac-first** design built
almost entirely from primitives cloister already has. Three composable
layers (none substitutes for another):

1. **At-rest encryption (confidentiality)** — key custody via the OS
   keystore, which the vault KEK schemes already provide end-to-end
   (`apple-password://` / `keychain://` on Mac; `secret-tool://` /
   `keyring://` on Linux; `op://`), routed through the sign-helper
   (ADR-0019). The consumer is new; the custody is not.
2. **BLAKE3 integrity manifest (tamper-evidence)** — a root hash over
   each DO's canonical row-set, anchored *outside* the filesystem the
   attacker can rewrite, verified at DO-constructor time. Converts
   silent tamper into detected-at-boot (§13.2 "silence is evidence",
   one layer down).
3. **Cert-gated access (attributability)** — the existing lease
   middleware gates the *sanctioned* path, so any out-of-band file
   access is, by definition, anomalous. Orthogonal to 1–2.

### Precedence & non-goals

- We do **not** fork workerd or ship SQLCipher (ruled out: no keyed-VFS
  surface in workerd; miniflare's SQLite is likewise not SQLCipher).
- We do **not** raise the boundary to root/supervisor (§13.7.4
  unchanged). The target adversary is **same-UID** (T2/T3) and
  **offline disk/backup** (T1).
- FileVault/LUKS are complementary (they cover stolen-disk) but do
  **not** cover the same-UID-live or backup-copy cases, so they are a
  baseline, not the answer.

## Phased plan (Mac-first, shortest secure path)

- **Phase 0 — placement + permissions (zero code, today).** `umask
  077` / `chmod 700` the DO dir + `0600` files; keep `CLOISTER_DO_PATH`
  out of iCloud-synced dirs; document `tmutil addexclusion` for the DO
  + `.wrangler` paths. Real wins against T1-lite, no code.
- **Phase 1 — encrypted volume (confidentiality, layer 1).** `task
  dev:securevol`: create/mount an encrypted APFS sparse bundle at
  `CLOISTER_DO_PATH` (ADR-0023 indirection — no config forks),
  passphrase generated once and stored via the same Keychain discipline
  `scripts/dev-bootstrap.mjs` already uses for the vault KEK. `task
  serve:local` gains a preflight asserting the mount. Linux twin:
  `fscrypt` / LUKS + `secret-tool://`. Covers the whole file incl
  WAL/`-shm`; kills T1. **Also fixes the wiring gap** (§13.9.3): add the
  `KEK_HELPER` binding to `config.capnp` (today only in `wrangler.toml`
  comments) so keystore KEK schemes work on the serve path.
- **Phase 2 — integrity manifest (tamper-evidence, layer 2).** BLAKE3
  root per DO over canonical rows (reuse `*-canonical.ts`; **not** raw
  file bytes — WAL makes those unstable), anchor written to the OS
  keystore / sign-helper (outside the rewritten FS), verified in the DO
  constructor (same slot the vault runs `#assertKekSourceSpecPinned()`).
  Needs a dirty-shutdown ⇒ warn-not-fail state machine to avoid
  crash-time false positives.
- **Phase 3 — selective column sealing (defense in depth).** Generalize
  the §18 vault envelope (HKDF → KEK, per-write DEK, AES-256-GCM) to
  secret-valued columns that don't need SQL queryability — bead
  free-text bodies, vault metadata. Keyed with a second HKDF info-string
  off the same root (`vault/src/kek-scope.ts` already sub-derives).
  Explicitly **defer** TrustStore hot-path columns (counters/nonces are
  `WHERE`-queried; sealing them breaks the query).

## Rationale

- **Reuse over invent.** The expensive half of at-rest encryption is key
  custody, and cloister already has it hardened (ADR-0014/0019 KEK
  schemes + helper bearer-token auth + absolute-path binary pinning,
  §15/§17). Phase 1 is "point the existing key at the existing storage
  path," not new crypto.
- **Encrypt the volume, not (mostly) the columns.** Column sealing
  (Phase 3) is precise but loses SQL queryability — unacceptable for
  TrustStore's hot path. A volume/APFS-image mount covers everything
  including WAL with zero cloister/workerd code, so it leads.
- **Detect, then prevent.** Confidentiality (layer 1) and integrity
  (layer 2) are different properties needing different primitives —
  encryption doesn't stop a same-UID *rewrite*; the BLAKE3 anchor does
  (by detection). This mirrors §13.2 exactly, one layer down.
- **Mac-first is a real constraint, not a preference.** The `keychain://`
  / `apple-password://` schemes + APFS encrypted images are a complete
  Mac story today; Linux (`secret-tool://` + fscrypt/LUKS) is the twin,
  shipped in the same phases.

## Alternatives considered

- **SQLCipher / keyed workerd VFS.** Rejected — no surface in workerd,
  would mean forking it; miniflare doesn't help either.
- **FileVault/LUKS only.** Rejected as *the* answer — covers stolen-disk
  but not same-UID-live or backup-copy; kept as baseline.
- **`inMemory` DO storage for dev.** A zero-persistence option workerd
  supports; viable for throwaway sessions but trades away bead
  continuity — offered as a mode, not the default.
- **Do nothing (keep the §13.7.4 boundary).** Rejected for local: the
  boundary is too cheap when same-UID = operator-tier.

## Consequences

- A local cloister gets a real at-rest story matching (in spirit) what
  CF provides in prod, built from existing primitives — Phase 0/1 are
  small and high-value.
- **Two concrete gaps close along the way:** (a) `config.capnp` gains
  the missing `KEK_HELPER` binding; (b) encrypting the vault DO's own
  SQLite closes the plaintext-`vault_state`-KEK-pin re-pin loop
  (`cloister-fbc6eb`).
- **Open / to verify:** SQLCipher-under-workerd (assume no); APFS-sparse
  + WAL under hard power-loss (smoke-test before defaulting); miniflare
  `--persist-to` onto the mount (unverified which `task dev` supports);
  integrity-manifest write-ordering state machine. Each is flagged in
  §13.9 residuals.

## Status

Proposed (2026-07-05). Phase 0 is doable immediately (zero code). Phases
1–3 are impl beads to file against this ADR; Phase 2 extends the threat
model further (already seeded at §13.9.2) before code.
