# `rs/` — Rust workspace

Cargo workspace hosting cloister's remaining Rust surface. The signing
substrate (`leyline-sign` — CMS/PKCS#7 + Ed25519 verifier + ADR-0019
`leyline-sign-helper` binary) now lives upstream in LLO
(`agentic-research/ley-line-open`, `rs/ll-open/sign/`) as of
**2026-07-09** (bead `ley-line-open-7226e3` / LLO PR #160). Cloister
consumes it via a git dep pinned by SHA in
[`crates/cas/Cargo.toml`](crates/cas/Cargo.toml), so:

- `cargo build --target wasm32-unknown-unknown -p leyline-sign` still
  emits `leyline_sign.wasm` at the same target path — cloister's
  [`src/wire/signet-verify.ts`](../src/wire/signet-verify.ts) imports
  it byte-identically to before.
- `cargo build --features host --bin leyline-sign-helper -p
  leyline-sign` still emits the ADR-0019 native helper.

The remaining local member — [`crates/cas`](crates/cas/) — is a
wasm-bridge crate that pulls LLO's `leyline-cas-ffi` (BLAKE3
substrate) and doubles as the workspace anchor for `leyline-sign`.

## Layout

| Path | Notes |
|------|-------|
| `Cargo.toml` | Workspace root. `resolver = "2"`. Single member. |
| `Cargo.lock` | Pinned. Checked in so the wasm32 build is reproducible. |
| `crates/cas/` | Wasm-bridge for LLO's `leyline-cas-ffi` (BLAKE3 CAS hash for the bundle pipeline, bead cloister-713b4e). Also the workspace anchor for `leyline-sign` — its Cargo.toml is where the two LLO git deps + SHA pins live. |
| `target/` | Cargo build output. Gitignored. |

## Build outputs cloister depends on

```
rs/target/wasm32-unknown-unknown/release/leyline_sign.wasm   # from LLO
rs/target/wasm32-unknown-unknown/release/cloister_cas.wasm   # from crates/cas
```

Those files are what cloister's wasm imports (declared in
[`config.capnp`](../config.capnp) + the wrangler bundle rule) resolve
to at workerd boot. Building cloister therefore requires a working
Rust toolchain with the `wasm32-unknown-unknown` target installed; the
melange/apko OCI image build pipeline pulls in the toolchain via
[`melange.yaml`](../melange.yaml).

To build both artifacts manually:

```sh
cd rs && cargo build --release --target wasm32-unknown-unknown -p leyline-sign
cd rs && cargo build --release --target wasm32-unknown-unknown -p cloister-cas
```

## Decisions

- **Why bridge-only, not fork** — LLO owns the canonical `leyline-*`
  crates per [ADR-0035](../docs/adr/0035-cloister-llo-boundary.md).
  Cloister's remaining Rust is either bridge crates (LLO-adjacent
  wasm-glue) or none (the ADR-0045 amendment sets the north star:
  cloister consumes LLO-published wasm artifacts once the LLO
  wasm-publish work — bead `ley-line-open-a2099a` — lands, at which
  point `crates/cas` also retires).
- **Why wasm32 + workerd, not a native binary** — workerd is a
  sandboxed V8 isolate with no `child_process` and no native shared
  libraries. The verifier has to run inside the isolate to be on the
  lease-middleware hot path, which means wasm32. See
  [ADR-0013](../docs/adr/0013-slice-grant-enforcement.md) for the
  isolate boundary as a security claim.
- **Why a Rust verifier at all** — the CMS / PKCS#7 / X.509 wire shapes
  are not in the Web Crypto surface; rolling them in JS would mean
  re-implementing X.509 in a non-audited substrate. Reusing LLO's
  battle-tested crate keeps cloister and every other constellation
  consumer on byte-equal cert handling. Per
  [ADR-0007](../docs/adr/0007-interlace-substrate.md).
