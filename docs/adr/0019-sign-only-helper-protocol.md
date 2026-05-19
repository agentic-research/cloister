---
title: "ADR-0019: Sign-only trust-anchor-helper protocol"
status: Accepted (2026-05-12) — math-friend dual review synthesized (cloister-98b693)
date: 2026-05-12
tags: [security, helper, sign-only, keystore, trust-root, ed25519]
threat_model: docs/security/threat-model.md
relates_to:
  - 0007-interlace-substrate.md
  - 0011-hypervisor-bundle-boundary.md
  - 0013-slice-grant-enforcement.md
  - 0014-pluggable-kek-source.md
  - 0018-notme-co-location.md
supersedes_framing: []
---

## Context

ADR-0014 v2 established the URL-spec resolver for the vault KEK
(`VAULT_KEK_SOURCE`). The helper sidecar (`scripts/kek-helper.mjs`)
mediates access to OS-keystore-backed values by accepting URL specs
(`keychain://`, `secret-tool://`, `http://`, `file://`) and returning
the resolved bytes via `GET /resolve?url=<spec>`.

The math-friend dual review of ADR-0018 (notme co-location) — both
reviewers independently — flagged that **this byte-return semantic
defeats the "key bytes never enter V8 heap" property the substrate
wants to claim**. Concrete:

- `kek-helper.mjs` shells to `security find-generic-password -w`
- Returns the 32-byte secret over HTTP
- workerd's vault DO reads the response, derives the AES-GCM KEK
  via HKDF, imports as a `CryptoKey` with `extractable: false`
- Between the keystore call and the `CryptoKey` import, **the secret
  bytes ARE in workerd's V8 heap**

For the vault KEK (a per-cluster wrapping key) this is tolerable —
the KEK is itself an intermediate; per-credential DEKs are what
actually wrap secrets. But for the master signing key (`master_sk`,
ADR-0018), the byte-return semantic breaks the architectural argument:

- ADR-0018 wants `master_sk` operations co-located with cloister's
  workerd process via the `notme-identity` bundle
- The argument is "V8 isolate + bundle-isolation lint contains
  master_sk operations to the notme-identity bundle"
- BUT if the helper returns `master_sk` bytes to workerd, master_sk
  is in V8 heap for the same window the vault KEK is
- Any V8 0-day in any bundle in the same process reaches `master_sk`
  bytes during that window

The fix is structural: **the helper must perform signing host-side
and return only signatures.** The key bytes never traverse the wire.

This isn't ADR-0018-specific. The same property is needed for ADR-0014
v2b (env://-as-encrypted-carrier — the recipient key bytes must not
re-enter workerd to perform age decryption) and any future signing
operation cloister wants to defer to the host.

## Decision

Define a new protocol on the trust-anchor-helper: **`POST /sign`** —
the helper signs the provided payload using the URL-spec-resolved key
and returns only the signature + pubkey. **`GET /resolve` remains as
a separate operation** for backward compatibility with vault KEK use
cases that aren't signing-shaped, but is documented as the strictly
weaker semantic.

### Wire protocol

All binary fields use **base64url** (RFC 4648 §5) no-padding for
consistency with [`interlace-spec/0.2.0-draft/RECEIPTS.md`](../../interlace-spec/0.2.0-draft/RECEIPTS.md)
and disclosure cursors. The `+/` alphabet is rejected.

The `url` field is parsed strictly: URLs containing `?` or `#` are
rejected at parse time with HTTP 400 `bad_request`. Cloister's
signing-scheme grammar is fixed at the cloister boundary; nono's
`?decode=*` family reaches into nono's trust module (which links
sigstore-verify), and the `kid` determinism invariant (req 7) is
cleaner without query-string aliasing. (URI-grammar invariant —
added by the 2026-05-13 cycle, threat-model §17.5.)

```
POST /sign HTTP/1.1
Host: 127.0.0.1:8786
Content-Type: application/json
Content-Length: <n>

{
  "url":           "keychain://com.cloister/master-sk",
  "alg":           "ed25519",
  "payload_b64":   "<base64url bytes to sign>",
  "return_pubkey": false
}
```

Response on success:

```
HTTP/1.1 200 OK
Content-Type: application/json

{
  "signature_b64": "<base64url 64-byte Ed25519 signature>",
  "kid":           "<base64url first 8 bytes of SHA-256(pubkey)>"
}
```

If `return_pubkey: true` was requested AND the operation succeeded:

```
{
  "signature_b64": "...",
  "kid":           "...",
  "pubkey_b64":    "<base64url 32-byte Ed25519 public key>"
}
```

Response on failure (constant-time per §"Constant-time error shape"):

```
HTTP/1.1 4xx | 5xx
Content-Type: application/json

{
  "error":  "<error code: bad_request | not_found | keystore_locked | unsupported_alg | payload_too_large | internal | timeout>",
  "reason": "<human-readable detail; never includes secret material>"
}
```

### Health probe

```
GET /healthz HTTP/1.1

→ 200 OK
{
  "ok":                true,
  "platform":          "darwin" | "linux" | "windows",
  "supported_schemes": ["keychain://", "file://", "secret-tool://", ...],
  "supported_algs":    ["ed25519"],
  "uptime_s":          12345,
  "build_sha":         "<git ref of leyline-sign-helper>"
}
```

`GET /healthz` MUST NOT expose per-entry presence (oracle), request
counters, or last-error detail.

### Normative requirements

1. **Helper MUST NOT return key bytes for signing operations.** The
   only data leaving the helper for a `POST /sign` call is the
   signature + `kid` + optionally the public key.

2. **Helper MUST bind to loopback only** at fixed `127.0.0.1:8786`.
   On EADDRINUSE the helper MUST log structured error + exit
   non-zero. MUST NOT fall back to a different port (workerd binding
   wouldn't find it).

3. **Helper MUST reject `POST /sign` bodies > 64 KiB** with HTTP 413
   `payload_too_large`, checked against `Content-Length` **before**
   parsing the body. (Was SHOULD in draft; promoted to MUST per
   both reviewers — DoS defense.)

4. **Helper MUST timeout `POST /sign` operations at 5 seconds** with
   HTTP 504 `timeout`. Ed25519 signing itself is microseconds; only
   the OS-keystore-unlock prompt is slow.

5. **Helper MUST support `alg = "ed25519"`.** Future expansion to
   `ml-dsa-44` or other PQ algorithms is allowed but not required.

6. **Helper MUST validate keystore byte length against declared `alg`
   BEFORE signing.** Ed25519 requires exactly 32 bytes of seed; any
   other length returns `unsupported_alg` with no signature performed.
   The `alg` field is caller-asserted — without this gate, a caller
   could request `ed25519` against an ml-dsa-44 seed and get a "valid"
   signature under an attacker-irrelevant pubkey. (Math-friend #1's
   largest gap.)

7. **Helper MUST be deterministic in `pubkey_b64` (when returned) and
   `kid` for a given `url`.** Same OS-keystore entry → same keypair →
   byte-identical responses.

8. **Helper SHOULD return `pubkey_b64` only when `return_pubkey: true`
   is in the request.** Default `false`. Steady-state callers cache
   the pubkey from a one-time bootstrap. This converts the per-call
   `(url → pubkey)` oracle into a one-call bootstrap. (Math-friend #1.)

9. **Helper MUST emit `kid` on every successful response.** Format:
   `base64url(first 8 bytes of SHA-256(pubkey))`. Callers detect
   keystore-entry rotation by `kid` divergence across calls. No
   SIGHUP/operator-action required for rotation.

10. **Helper MUST default-rate-limit `POST /sign` at 1000 sigs/sec
    per source UID.** Configurable via `--rate-limit`. Excess returns
    HTTP 429 `rate_limited`. Defends against in-process DoS from a
    compromised cluster-tier bundle that somehow obtained `KEK_HELPER`.

11. **Helper MUST log only operation type + URL scheme + outcome**,
    never URL paths, payload bytes, signature bytes, or pubkey bytes.
    Example log: `keychain:// sign ok 64B-payload`, not
    `keychain://com.cloister/master-sk signed [0x12 0x34 ...]`.

12. **Helper MUST expose `GET /healthz`** with the contract above.
    MUST NOT expose per-entry presence in any endpoint.

13. **`GET /resolve` semantics are unchanged** but are documented as
    strictly weaker. The vault KEK continues to use `GET /resolve`
    under ADR-0014 v2a. **Signing-key consumers** (notme `master_sk`,
    receipts, anything in cloister-127a3c's scope) **MUST use
    `POST /sign`**.

14. **Helper MUST refuse `POST /sign` for URLs not on a per-caller
    allow-list when `--require-sign-allow` is set.**

    Grammar:
    ```text
    LEYLINE_SIGN_SIGN_ALLOW := CALLER_ENTRY (";" CALLER_ENTRY)*
    CALLER_ENTRY            := CALLER_NAME "=" PREFIX_LIST
    PREFIX_LIST             := PREFIX ("," PREFIX)*
    ```

    **`;` separates callers; `,` chains prefixes within one caller. They
    are NOT interchangeable** — a common operator error is `router=A,router=B`
    (which parses as caller=`router`, prefixes=[`A`, `router=B`] — the
    second `router=` becomes part of a prefix string).

    Worked examples:

    | Env value | Behavior |
    |---|---|
    | `router=keychain://com.cloister/master-sk` | `router` may sign over the master-sk URL (or any extension of it); other callers refused. |
    | `router=keychain://a,keychain://b` | `router` may sign over either prefix. |
    | `router=keychain://master-sk;notme=keyring://com.cloister/notme/cloister` | Two callers, each pinned to their own URL. |
    | `*=file:///tmp/dev-seed` | Wildcard — any authenticated caller may sign over this prefix. Use sparingly. |

    Empty allow-list with `--require-sign-allow` set is fail-stop at
    startup. Added by the 2026-05-13 adversarial cycle (threat-model
    §17.2). Closes the gap where a bearer-token holder could otherwise
    direct the helper to sign with an attacker-supplied URL (e.g.,
    `op://attacker-vault/their-key/field`).

15. **Helper MUST collapse all keystore-side failures to the
    constant-time 404 wire shape.** `SecretNotFound`, `KeystoreAccess`
    (e.g., "keychain locked", "op not signed in"), and `ConfigParse`
    (malformed URI) MUST all return the byte-identical 404 body. The
    distinct outcome labels (`not_found`, `keystore_locked`, `bad_uri`)
    survive in tracing for operators, not on the wire. Closes
    2026-05-13 cycle threat-model §17.10 (oracle-friend F1+F2).

(Three other invariants added by the 2026-05-13 cycle are not
normative on the wire and live elsewhere in this ADR — `cloister-d816a0`
consolidation: the `/sign` URL grammar reject is the URI-shape clause
in §"Wire protocol"; the blocking-thread-pool dispatch invariant is
in §"Implementation pins" → "Concurrency invariants"; the `nono::*`
tracing clamp is in §"Implementation pins" → "Logging hygiene".)

### Constant-time error shape

Per the §9.4 constant-time-404 pattern from ADR-0007 / `disclosure.ts`:

- HTTP 404 (`not_found`) and HTTP 500 (`internal`) MUST return
  byte-identical body length and content-type. The caller cannot
  distinguish "URL spec resolves to a missing keystore entry" from
  "internal helper error" via response shape or timing.
- Caller errors that are NOT entry-existence-conditional (HTTP 400
  `bad_request` for malformed JSON, HTTP 413 `payload_too_large`,
  HTTP 415 `unsupported_alg`, HTTP 429 `rate_limited`) MAY differ —
  these reveal caller-side mistakes, not keystore state.
- HTTP 503 `keystore_locked` is a transient OS-state error; distinct
  from 404 because operator-actionable ("unlock your keychain") vs
  "the entry never existed."

### Keystore-byte caching policy (resolves math-friend conflict)

Math-friend #1 (crypto) recommended caching the loaded `SigningKey`
across calls to eliminate per-call keystore-call cost + side-channel
discipline.

Math-friend #2 (ops) required re-reading keystore on every call to
preserve "OS keystore IS the source of truth" semantics.

**Synthesis adopted here:**

- Helper MAY cache the parsed `SigningKey` object in memory, indexed
  by `byte_hash = SHA-256(keystore_bytes)`.
- Helper MUST re-read the raw bytes from the OS keystore on every
  `POST /sign` call **for cheap-read schemes** (`keychain://`,
  `secret-tool://`, `keyring://`, `file://`) — no byte-level caching;
  rotation latency is zero.
- If `SHA-256(re-read bytes) == cached_byte_hash`, reuse the parsed
  `SigningKey` from cache (saves Ed25519-key parsing, which IS the
  cache-timing hot path; raw bytes are already in memory either way).
- If hashes differ (operator rotated the keystore entry), drop the
  cache entry and re-parse. The first call after rotation sees a
  new `kid` value; caller-side rotation detection works automatically.

Result: per-call keystore boundary check (ops invariant satisfied) +
cached parsing (crypto invariant satisfied) + zero-operator-action
rotation (both invariants satisfied).

### Subprocess-scheme TTL cache amendment (2026-05-13, cloister-2a0faa)

The "re-read every call" invariant above predates the `op://` (1Password
CLI) and `apple-password://` (macOS `security` CLI) schemes. Both spawn
a subprocess per read; both can trigger interactive auth (op signin,
FaceID prompt). Re-reading EVERY call would mean every `/sign`
re-prompts the user — a non-starter for production deploys (the
2026-05-13 adversarial cycle's dos-friend F2 + threat-model §17.7).

**Amendment for subprocess-shelling schemes:**

- Helper MAY cache the read-result (bytes OR error) for these schemes
  for up to `LEYLINE_SIGN_RESOLVE_TTL_MS` milliseconds (default
  **60_000ms = 60s**, configurable via env var).
- During the TTL window, subsequent callers receive the cached value
  without spawning a fresh subprocess. Successful AND failed reads are
  both cached (so a transient `op` outage doesn't cause partial-cache
  inconsistency among concurrent callers).
- Per-spec singleflight ensures only ONE in-flight read regardless of
  how many concurrent callers arrive while a read is pending.
- After TTL elapses, the next caller's read evicts the cached entry
  and starts fresh.

**Trade-off acknowledged:**

- Rotation latency for `op://` / `apple-password://` is bounded by TTL.
  Default 60s = operator who rotates a 1Password secret sees the new
  bytes within 60s.
- Operators requiring tighter rotation can set
  `LEYLINE_SIGN_RESOLVE_TTL_MS=0`, which makes ALL schemes follow the
  "re-read every call" invariant (matching pre-2026-05-13 behavior).
  This trades latency for prompt cost.
- The env var applies to all schemes uniformly; per-scheme tuning
  requires a code change. One knob is easier to audit than five.

This amendment IS NOT a deviation from the math-friend #2 ops
invariant for cheap-read schemes — those still re-read on every call.
It's a new policy for the new schemes, designed so the rotation
latency is bounded + operator-tunable.

### Implementation pins

- **Crate:** `ed25519-dalek = "2.1"` (already in `rs/crates/sign/Cargo.toml`).
  Same crate for the wasm verifier and the host signer — avoids
  cross-implementation divergence.
- **Algorithm form:** RFC 8032 §5.1 **pure Ed25519**. NOT Ed25519ph.
  NOT custom hash-then-sign.
- **Signature normalization:** canonical RFC 8032 — `R` is compressed
  Edwards point in canonical form; `s` ∈ [0, ℓ−1]. `ed25519-dalek`
  2.x emits this by construction.
- **HTTP server crate:** TBD between `tiny_http` (small, low-churn)
  and `axum`/`hyper` (large, well-audited). Pinned during
  cloister-99165e implementation review.
- **Keystore federation:** split across two Cargo features per the
  2026-05-13 adversarial cycle (threat-model §17.1):
  - **`host` (default):** direct `keyring = "3"` dep. Platform features
    pinned: `apple-native` on macOS, `sync-secret-service` on Linux.
    Supports `keychain://` (macOS Keychain), `secret-tool://` (Linux
    libsecret), `keyring://<svc>/<acct>` (explicit form), `file://`.
    **No `nono` in the dep graph.** Default deploys avoid the
    sigstore-verify / aws-lc-rs / landlock closure.
  - **`host-extras` (additive opt-in):** adds `nono = "0.54"` as an
    optional dep + enables the `op://` (1Password CLI) and
    `apple-password://` (macOS Passwords CLI) schemes. nono provides
    `validate_op_uri` + `validate_apple_password_uri` for URI shape
    validation. The actual subprocess dispatch stays cloister-side
    (in `host::keystore::run_subprocess_with_trim`) so the PATH-pin +
    env_clear hardening (trust-root-friend F3, threat-model §17.3)
    applies even with nono present.
  - **`file://` scheme** stays in cloister's own reader (binary-safe
    bytes + `/\r?\n+$/` multi-CRLF trim) regardless of feature flags.

  **History (2026-05-13):** the initial `cloister-2a0faa` commit routed
  all of these schemes through `nono = "0.54"` (with `system-keyring`).
  The cycle's trust-root-friend F1 flagged the supply-chain closure
  (sigstore-verify, sigstore-trust-root, aws-lc-rs (+ aws-lc-sys),
  landlock, x509-cert, ~80 other crates). The follow-up commit
  feature-gated nono behind `host-extras` so default deploys avoid
  the heavy closure. Cloister's keyring backend path was rewritten to
  use `keyring::Entry` directly (no nono mediation).

- **Headless platform disposition:** Linux libsecret is supported as a
  first-class scheme under default `host`. Windows Credential Manager
  via the same `keyring` 3.x backend is untested in cloister CI today
  (see the "follow-up" note below).
- **Toolchain pin:** `rust-toolchain.toml` at `rs/` pins channel
  `1.95.0` (originally introduced for nono 0.54's MSRV; retained for
  reproducibility). `task rs:audit` (folded into `task verify`) asserts
  the channel pin matches the documented value and runs
  `cargo audit --deny warnings` + `cargo deny check` over the
  supply-chain closure.

- **Supply-chain trust base.**
  - Default `host`: `keyring = "3"` + `axum = "0.7"` + `tokio = "1"` +
    `tower` + `tower-http` + `serde` + `serde_json` + `base64ct` +
    `clap` + `tracing` + `tracing-subscriber` + `zeroize`.
    `cargo tree --features leyline-sign/host` ≈ 245 lines.
  - `host,host-extras`: above + `nono = "0.54"` + sigstore-* +
    aws-lc-rs + landlock + ~80 other transitive crates.
    `cargo tree --features "leyline-sign/host leyline-sign/host-extras"` ≈ 559 lines.
  - `cargo tree --edges normal` (no host feature, wasm verifier only):
    ≈ 58 lines.

  Long-tail attestation tracked under `cloister-8df072` (cargo-vet
  trust set + quarterly attestation report).

- **Subprocess hardening for `op://` + `apple-password://`** (host-extras
  only). The two CLI-shell schemes do NOT route through nono's
  `Command::new("op")` bare-name lookup; they go through cloister's
  local subprocess shim in `host::keystore::run_subprocess_with_trim`.
  That shim requires `LEYLINE_SIGN_OP_BIN` / `LEYLINE_SIGN_SECURITY_BIN`
  to point to an absolute path of an extant file; runs
  `Command::env_clear()` + explicit allow-list (HOME,
  OP_SERVICE_ACCOUNT_TOKEN, OP_SESSION_*, OP_ACCOUNT, OP_DEVICE for
  `op`; HOME only for `security`); caps wall-clock at
  `SUBPROCESS_TIMEOUT = 4500ms` (under the 5s `SIGN_TIMEOUT`) and kills
  the child on timeout. Closes 2026-05-13 cycle trust-root-friend F3
  (PATH-hijack) + isolation-friend F-iso-3 (env wholesale inheritance).

#### Concurrency invariants

- **Keystore I/O MUST run on a blocking-thread pool**, not the
  request runtime's worker threads. The synchronous nono dispatch
  (`keyring` crate IPC; `op` / `security` subprocess polling) goes
  through `tokio::task::spawn_blocking` so a slow keystore call does
  not pin a worker. Subprocess wall-clock is capped at 4500ms (under
  the 5s `SIGN_TIMEOUT` of req 4) and the child is killed on
  timeout. (Implementation invariant; not protocol-visible. Closes
  2026-05-13 cycle threat-model §17.6.)

#### Logging hygiene

- **`nono::*` tracing targets MUST be clamped to INFO max.** Nono's
  own debug lines emit redacted-but-correlatable URIs (service /
  vault / item names) that req 11 wants out of logs. Operators
  running `RUST_LOG=debug` for unrelated debugging would otherwise
  inherit nono's leakage. Implemented via an EnvFilter directive in
  the helper's `init_tracing`. (Deployment-side log-pipeline
  invariant; not protocol-visible. Closes 2026-05-13 cycle §17.10,
  oracle-friend F4.)

### Implementation language and location

Per `cloister-99165e`: extend `cloister/rs/crates/sign/` (leyline-sign)
with a `[[bin]]` entry for the helper daemon, gated behind a `host`
feature. Conditional compilation:

- `#[cfg(target_arch = "wasm32")]` — existing wasm-verifier path
- `#[cfg(not(target_arch = "wasm32"))]` — host-side helper code
  (`keyring` crate + cloister-side URI validators + subprocess shims +
  `axum`/`hyper` + ed25519 sign; nono only under `host-extras`).
  `cloister-2a0faa` verified the wasm artifact stays byte-identical
  (`sha256 = 653eae67e682cb…`) across every iteration of the cycle:
  original keyring dep, nono swap, feature-gate. All host-feature deps
  are strictly gated behind `feature = "host"` (or `host-extras`) and
  never reachable from the wasm build path.

The wasm-side verifier code is unchanged. The new binary is a native
target of the same crate. This keeps cloister at TS + Rust (no third
language) and reuses existing leyline-sign types between the wasm
verifier and the host signer.

## Rationale

### Two independent shifts in this ADR (per math-friend #2)

The ADR proposes two changes. Be honest about each:

1. **Protocol: byte-return → sign-only.** This is the **load-bearing
   change**. It is what ADR-0018 actually needs. Strict trust-property
   improvement — key bytes never enter V8 heap during the sign window.
   No "shape-different" qualifier; this is unambiguously better for
   the heap-isolation property.

2. **Implementation language: JavaScript → Rust.** This is **orthogonal**
   to (1) and is justified by:
   - **Distribution** — single static binary, brew/cargo install, no
     Node-on-host requirement for non-developer self-hosters
   - **Constant-time crypto primitives by default** in `ed25519-dalek`
     (curve25519-dalek constant-time field arithmetic) or `ring`
   - **Type-safe wire validation** via Rust's type system

   NOT justified by "smaller trust base." Honest trust-base comparison:
   - JS sidecar: ~150 effective LOC, **zero NPM dependencies**, Node
     runtime (huge but mature CVE pipeline)
   - Rust binary: ~600-1000 LOC realistic, `keyring` + HTTP server
     crate + `ed25519-dalek` + supervisor glue — multiple maintained
     crates, larger graph, smaller runtime

   These are different trust-base **shapes**, not strictly better or
   worse on absolute size. The Rust shape is adopted for packaging
   and constant-time-by-default reasons, NOT trust-base reduction.

### Why a new protocol rather than amending /resolve

The byte-return semantic of `GET /resolve` is by design — vault KEK
operations consume the resolved bytes (HKDF) and `Cred.value` reads
similarly. Removing `/resolve` would break those callers. Adding a
sibling `POST /sign` operation:

- Preserves backward compat for vault KEK (ADR-0014 v2a unchanged)
- Provides the stronger semantic for callers that need it
- Lets consumers opt in by URL-scheme convention (signing-key URLs
  use `POST /sign`; non-signing-key URLs continue to use
  `GET /resolve`)

### Why Ed25519-first

Cloister's signing operations are all Ed25519 today (interlace lease
certs, receipts, attestation chains). PQ migration (ml-dsa-44) is a
separate discussion. The protocol is algorithm-agnostic in shape
(`alg` field), so adding `ml-dsa-44` later is a non-breaking extension —
the wire format accommodates ml-dsa-44's 2420-byte signature + 1312-byte
pubkey via base64url-encoded JSON strings.

### Why HTTP and not Unix-socket / stdio

The existing helper uses HTTP-on-loopback because workerd's service
binding system speaks HTTP natively (no UDS support). Cloister's
existing `KEK_HELPER` Service binding pattern is reusable as-is for
the new `/sign` endpoint. Forward-compatible with `tpm://` and
`pkcs11://` URL schemes — those map cleanly onto the TBS-in /
signature-out shape.

### Why "helper MUST NOT log payload bytes"

The payload for receipts is the canonical-CBOR commitment — itself
not secret (it commits to a request hash, body hash, headers hash,
timestamp). But future signing operations may sign sensitive payloads
(audit logs, DSSE attestations of build artifacts containing
proprietary content). The discipline of "log scheme + outcome, never
payload" prevents accidental information disclosure via logs.

## Threats and mitigations

Synthesized from math-friend dual review (cloister-98b693).

### Cryptographic boundary

Key bytes never traverse the wire and never enter V8's heap. They
exist in the helper process's memory for the lifetime of the cached
`SigningKey` object (see §"Keystore-byte caching policy"). The
protocol moves the in-RAM blast radius from {workerd's multi-isolate
V8 process} to {a single-purpose helper daemon}. For hardware-backed
schemes (`tpm://`, `pkcs11://`, future), the bytes never enter
user-space at all.

**Attack-surface delta vs `GET /resolve` (byte-return path):**

| Attack class | `GET /resolve` (today) | `POST /sign` (this ADR) | Delta |
|---|---|---|---|
| V8 0-day reads master_sk from heap | YES (HKDF/CryptoKey-import window) | NO | **Reduced** |
| Workerd process dump captures master_sk | YES | NO | **Reduced** |
| Helper process dump captures master_sk | YES | YES (smaller, single-purpose TCB) | Same blast, smaller TCB |
| Cross-isolate cache-timing on key bytes | YES (bytes flow through workerd CPU pages) | REDUCED (only helper CPU pages) | **Reduced** |
| Algorithm substitution at keystore entry | N/A | **NEW** — mitigated by byte-length validation (normative req. 6) | New, addressed |
| URL-spec enumeration via pubkey return | minimal (200 vs 404) | **NEW per-call oracle** — mitigated by opt-in pubkey (normative req. 8) | New, addressed |
| Payload-size DoS | YES | Mitigated by 64 KiB MUST + Content-Length check (req. 3) | Addressed |
| Rate-limit DoS | YES (no limit) | Mitigated by 1000 sigs/sec default (req. 10) | Addressed |
| Constant-time error oracle for missing entries | Partial | Mitigated by 404/500 byte-identical responses | Improved |

### Implementation correctness

Per §"Implementation pins": `ed25519-dalek = "2.1"`. Curve25519-dalek
backend has constant-time field arithmetic. Sign is constant-time over
the secret key. `SHA-512(prefix || M)` is not constant-time over
`len(M)`, but `M` is public payload — acceptable.

Cache the parsed `SigningKey` (load-once parsing) but re-read raw
bytes from keystore on every call (the trust boundary). This
eliminates per-call Ed25519-key parsing (which IS the cache-timing
hot path) without amortizing the keystore boundary check.

The `alg`-substitution defense (normative req. 6) is the largest
gap closed: caller-asserted `alg` is verified against keystore byte
length BEFORE any signing operation. A 32-byte Ed25519 seed cannot
be signed under `ml-dsa-44` and vice versa.

### Operational

Per math-friend #2's normative requirements:

1. **Helper supervision.** The helper MUST run under a user-scoped
   supervisor (launchd plist on macOS, systemd user unit on Linux,
   Task Scheduler on Windows). The supervisor MUST restart on crash
   with bounded backoff (`Restart=on-failure RestartSec=1
   StartLimitBurst=5 StartLimitIntervalSec=10`). The repo ships
   templated units alongside the binary at `rs/crates/sign/dist/`.

2. **Lifecycle signals.** SIGTERM → stop accepting new requests,
   drain in-flight up to 5s, exit cleanly. SIGINT identical. **NO
   SIGHUP handler** — rotation propagates automatically via the
   byte-hash cache-invalidation pattern in §"Keystore-byte caching
   policy" (no explicit reload signal needed).

3. **Bind policy.** Helper MUST bind to fixed `127.0.0.1:8786`. On
   EADDRINUSE the helper MUST log a structured error and exit
   non-zero. MUST NOT fall back to a different port — workerd binding
   wouldn't find it.

4. **Crash-restart contract.** When the helper is down,
   `KEK_HELPER.fetch()` returns 503 to the workerd-side caller;
   vault DO + receipt emitter + co-located notme-identity bundle
   throw with distinct error code `trust_anchor_unreachable`. The
   `task dev` startup probes `/healthz` and refuses to proceed if
   the helper is unreachable — avoids "helper is down, every
   request 503s for 10 minutes before operator notices."

5. **Headless platform disposition.** macOS Keychain on headless
   servers requires `security set-generic-password-partition-list
   -S apple-tool:,apple: -k <password> <keychain>` to permit
   non-interactive access; without it, first access blocks on a
   TOFU dialog. Linux libsecret on headless requires an unlocked
   D-Bus session keyring, which typically does not exist by default
   — **headless Linux self-host SHOULD default to `file://` with a
   `chmod 600` operator-managed file**, not `secret-tool://`.
   Windows headless is deferred to a future ADR ("best-effort,
   interactive sessions only").

6. **Concurrent self-host instances.** Two `task dev` processes on
   the same UID both try to bind 8786; second fails. **Pattern:**
   one helper per UID, no per-cluster isolation. Multi-cluster
   self-host shares the trust anchor (one operator = one trust
   anchor). Document this explicitly.

7. **Operational failure-mode catalog** (operator playbook):

   | Scenario | Behavior | Recovery |
   |---|---|---|
   | Keystore entry missing | HTTP 404 `not_found` | Provision via `security add-generic-password` (macOS) / `secret-tool store` (Linux) / operator-managed file |
   | macOS Keychain locked | HTTP 503 `keystore_locked` | `security unlock-keychain ~/Library/Keychains/login.keychain-db` or OS prompt |
   | `alg` mismatch with stored key | HTTP 415 `unsupported_alg` | Re-provision keystore with correct key type; or use correct `alg` in request |
   | Payload > 64 KiB | HTTP 413 `payload_too_large` | Caller side: chunk or reject |
   | Helper crashes mid-signing | Supervisor restarts with backoff; caller sees 503 | Automated via supervisor; operator alerted if `StartLimitBurst` exceeded |
   | Port 8786 occupied | Helper exits with structured error | `lsof -iTCP:8786` to identify; resolve and restart |
   | Daemon hangs | HTTP 504 `timeout` after 5s | Supervisor restart on next request failure |
   | Operator rotates keystore entry | Automatic — next call re-reads bytes; SHA-256 mismatch invalidates parsed `SigningKey` cache; new `kid` in response | No operator action required |

### Trust-base shift (JS sidecar → Rust binary)

Honest characterization (per math-friend #2): different trust-base
**shapes**, not strictly smaller.

- **JS sidecar:** ~150 effective LOC of glue, zero NPM dependencies,
  Node-runtime trust base (huge surface but mature CVE pipeline +
  LTS), `node:child_process` spawnSync to `/usr/bin/security` (process
  boundary between helper logic and keystore client)
- **Rust binary:** ~600-1000 LOC realistic, `keyring` crate (active
  but smaller maintainer pool; pulls in `security-framework` on
  macOS, `zbus` + `secret-service-rs` on Linux), HTTP server crate
  (TBD), `ed25519-dalek` 2.x, supervisor glue, Rust toolchain
  (smaller stdlib but less-mature security-coordination)

The Rust shape is adopted for **distribution** (single binary, no
Node-on-host for non-developer self-hosters) and **constant-time
crypto primitives by default**, NOT for trust-base reduction.

**Threat model §2 (trust roots table)** grows a new row: "the
leyline-sign-helper binary." Mitigation: loopback-only bind;
sign-only protocol; in-memory `SigningKey` cache invalidated by
byte-hash mismatch; `--rate-limit`; supervisor-managed lifecycle;
`/healthz` with no per-entry oracle.

### Migration risk (cloister-993bef)

The single largest footgun: **response-shape drift on `/resolve`**.
The current JS helper trims trailing newlines from the keystore
output before returning. If the Rust binary doesn't reproduce this
trim **exactly**, the byte sequence fed into HKDF differs → derived
KEK differs → all previously-wrapped DEKs become unrecoverable.

**Mandatory mitigation:** golden-vector parity tests in cloister-993bef
Phase B. Without byte-exact `/resolve` equivalence between the old
and new helpers, the migration is unsafe.

Phased rollout sequence enforced by cloister-993bef:
- **Phase A** — binary build, no wiring (shipped via cloister-99165e / PR #1)
- **Phase B** — contract parity tests (golden vectors; LOAD-BEARING GATE) (shipped 2026-05-13)
- **Phase C** — opt-in shadow (`--use-rs-helper` flag; both shapes coexist) (shipped 2026-05-13)
- **Phase D** — default switch (`task dev:bootstrap` uses Rust binary) (shipped 2026-05-13)
- **Phase E** — deprecation warning on JS helper invocation (skipped — Phase D moved everyone)
- **Phase F** — delete `scripts/kek-helper.mjs` (shipped 2026-05-18 via cloister-993bef close)

**ADR-0018 dependency:** notme co-location is unblocked at **Phase C**
(sign-only available as opt-in), NOT Phase F. Make this explicit in
the ADR-0018 prerequisite gate.

### Audit logging follow-up

Today's helper logs only at `--verbose`. Signing operations on
`master_sk` are the trust-root signing path; operators will want an
audit log of `{ ts, url-scheme, alg, payload_sha256, pubkey_fp, outcome }`.
**Out of scope for this ADR** — filed as a follow-up bead for the
helper implementation phase.

## Alternatives considered

1. **Keep byte-return semantic; accept the V8 heap window as residual
   risk.** The current state. Pro: simpler; existing code works. Con:
   defeats the architectural argument for ADR-0018 + ADR-0014 v2b.

2. **Move signing into a TPM / HSM.** Strongest possible boundary.
   Pro: hardware-enforced key isolation. Con: significant operational
   overhead for self-hosters; not all platforms have TPMs; HSMs are
   $$. This ADR doesn't preclude TPM/HSM later; the URL-spec resolver
   already supports `tpm://` as a future scheme. Sign-only protocol
   is the software equivalent that works everywhere.

3. **Run signing in a separate process via fork/exec per signature.**
   Pro: process boundary between V8 and signing. Con: fork/exec
   overhead per signature is unacceptable for receipts emission
   (target: sub-ms). The daemon model gives the boundary without
   per-call cost.

4. **This ADR (the daemon serves /sign).** Pro: software boundary;
   no per-call overhead; reuses existing helper infrastructure;
   leyline-sign crate already exists and compiles to native; protocol
   is forward-compatible with TPM/HSM via URL-spec scheme growth.

## Consequences

- **`scripts/kek-helper.mjs` is deprecated.** Migrates to a native
  binary built from `cloister/rs/crates/sign/` per cloister-99165e.
  The migration bead (cloister-993bef) re-wires `KEK_HELPER` Service
  bindings to the new binary.
- **Threat model §2 (trust roots table) grows a row** for the helper
  binary. Its trust boundary: anyone with UID:port access on the host
  machine. Mitigation: loopback-only bind; expected to run alongside
  cloister-router as a sibling daemon on the same host.
- **Receipts impl (cloister-ae713f, shipped)** continues to use
  Web Crypto Ed25519 in V8 for now. The follow-up bead
  (cloister-9a1b72, port receipts to Rust-wasm) is the natural
  alignment point — that bead can switch receipts signing to use
  `POST /sign` against the new helper.
- **ADR-0018 prerequisite gate updates.** "Implementation does NOT
  proceed until cloister-127a3c + cloister-12b062 land" becomes:
  "Implementation does NOT proceed until ADR-0019 is Accepted AND
  cloister-99165e (helper binary) is shipped AND signing-key
  consumers use `POST /sign`, not `GET /resolve`."

## Coordinated with

- **cloister-99165e** (leyline-sign host-binary target) — implementation
- **cloister-993bef** (kek-helper.mjs migration) — call-site migration
- **cloister-988589** (lint gaps fix) — adjacent prerequisite for ADR-0018
- **cloister-127a3c** / **signet-20a875** — signet's own master_sk URL-spec
  adoption may or may not use this protocol; signet decides
- **cloister-db99cd** (ADR-0018) — primary consumer; gated on this ADR

## Status

**Accepted** (2026-05-12) — math-friend dual review (cloister-98b693)
synthesized into "Threats and mitigations" above.

Reviewer #1 verdict: Cryptographically sound with caveats — all
caveats incorporated as normative requirements (alg-substitution
defense, opt-in pubkey, base64url, 64 KiB MUST, rate limit,
ed25519-dalek pin, constant-time error shape).

Reviewer #2 verdict: Operationally requires revision — incorporated:
two-shifts framing in §Rationale; failure-mode catalog; supervisor
contracts; headless platform disposition; migration phasing for
cloister-993bef.

Full review logs preserved at:
- `_agent_log/theoretical-foundations-analyst_2026-05-12_adr0019_crypto_review.md`
- `_agent_log/theoretical-foundations-analyst_2026-05-12_reviewer-operational_agent_log.md`

**Implementation gate (cloister-99165e):** does NOT proceed until
this ADR is Accepted (now) AND the HTTP server crate choice is
pinned during implementation review.

**ADR-0018 prerequisite gate update:** db99cd is unblocked at
**cloister-993bef Phase C** (sign-only available as opt-in), not
Phase F. Update db99cd's Status section accordingly.
