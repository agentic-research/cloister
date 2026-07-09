# Glossary

Canonical definitions for terms that get used in close proximity in
cloister docs and conversations and are easy to conflate. Add entries
here when a name has shown up in more than one place with a different
meaning, or when a future reader is likely to mistake it for a sibling.

Entries are alphabetical. Each entry names what the thing *is* (crate,
binary, protocol, concept), where it lives, and which sibling terms it
is **not**.

## leyline

**A protocol name. Not a crate.**

The signed-capnp wire that cloister speaks at the companion ↔ backend
seam (the "internal wire"). Defined by
[ADR-0005: Internal wire = leyline-net (signed capnp); MCP/JSON-RPC only
at the public face](adr/0005-internal-wire-leyline-net.md).

Concretely:

- The wire format is `sequence | publicKey | signature | contentHash`
  capnp framing, Ed25519-signed, AEAD-wrapped at the companion ↔ backend
  hop.
- The reference implementation lives **outside cloister**, in the
  `ley-line` repo at `ley-line/rs/crates/net/` ("leyline-net"). Cloister
  consumes that crate; it does not vendor or fork it.
- ADR-0005 amendment: cloister ↔ companion is **plain capnp IPC** (no
  AEAD) inside the trust boundary. Only the outer companion ↔ backend
  hop is full leyline-net.

The word "leyline" *on its own*, without a `-sign` or `-net` suffix,
always refers to this protocol — never to a binary or library.

**Not to be confused with:** `leyline-sign`, `leyline-sign-helper`,
`signet-sign` (see below).

## leyline-sign

**A Rust crate upstream in LLO** (`agentic-research/ley-line-open`).
Path: `rs/ll-open/sign/` (Cargo manifest: `rs/ll-open/sign/Cargo.toml`).
Cloister pulls the crate via a git dep pinned by SHA in
[`rs/crates/cas/Cargo.toml`](../rs/crates/cas/Cargo.toml) (bead
`cloister-8f4d3f`; before 2026-07-09 the crate lived at cloister's
`rs/crates/sign/`, deleted with the LLO consolidation).

Two-faced crate:

1. **Library** — `cdylib + staticlib + rlib` Ed25519 CMS primitives
   (certificate generation, `SignedData` create/verify). Builds for
   wasm32 with the default feature set; the wasm artifact is byte-
   identical regardless of the `host` feature flag (verified by
   `task rs:sign:wasm`).
2. **Binary** — `leyline-sign` is also the name of a gpgsm-compatible
   commit-signing CLI (drop-in for `jj`'s signing backend).

The same crate *also* ships the `leyline-sign-helper` bin target
under the `host` feature — see the next entry. The crate name + the
helper binary name are siblings inside one Cargo package; they
deliberately share the `leyline-sign` prefix.

**Not to be confused with:** `signet-sign` (different crate, different
repo, lib-only) — see below.

## leyline-sign-helper

**A binary, not a crate.** The `host`-feature `[[bin]]` target of the
`leyline-sign` crate (upstream in LLO). Source: LLO's
`rs/ll-open/sign/src/bin/helper.rs`.

The cloister-side host signing daemon specified by
[ADR-0019: Sign-only trust-anchor-helper protocol](adr/0019-sign-only-helper-protocol.md).
Properties:

- Listens on `127.0.0.1:8786` (loopback HTTP, no TLS — supervisor-
  scoped, never exposed off-host).
- Owns the master signing key via OS keystore (`keychain://` on macOS,
  `secret-tool://` / `keyring://` on Linux, `file://` for headless).
  Optional `op://` and `apple-password://` schemes gated behind the
  `host-extras` feature.
- Speaks the ADR-0019 phantom-token contract: caller hands the helper
  a key reference + payload; helper returns a signature without ever
  exposing the master secret to the caller's address space.
- Lifecycle managed by supervisor units in LLO's
  `rs/ll-open/sign/supervisor/` (launchd on macOS, systemd-user on
  Linux).

**Not to be confused with:** `signet-sign` (sibling Rust library
crate, different repo, no daemon, no UDS) — see below.

## signet-sign

**A Rust crate in a different repo.** Lives in the
[`signet`](https://github.com/agentic-research/signet) repo at
`signet/rs/crates/sign/`. Pure library:
`cdylib + staticlib + rlib`, Ed25519 CMS/PKCS#7 signing and
verification (RFC 5652 + RFC 8419), wasm32-compatible. No daemon,
no UDS, no OS-keystore client, no supervisor.

Adjacent concern to cloister's `leyline-sign` crate — both implement
Ed25519 CMS — but they are intentionally separate pending a deeper
convergence call (out of scope for this glossary; tracked elsewhere).
Conflation is easy because:

- Both crates historically lived at `rs/crates/sign/` inside their own
  repo. As of 2026-07-09 the LLO copy lives at `rs/ll-open/sign/`.
- Both produce `cdylib + staticlib + rlib`.
- Both do Ed25519 + CMS.

Disambiguators when you see the name in context:

- Path begins with `signet/` → `signet-sign`.
- Path begins with `ley-line-open/rs/ll-open/sign/` (or historically
  `cloister/rs/crates/sign/`) → `leyline-sign`.
- Cargo package `name = "signet-sign"` → signet repo.
- Cargo package `name = "leyline-sign"` → LLO repo.

**Not to be confused with:** `leyline-sign`, `leyline-sign-helper`,
`leyline` (see above).
