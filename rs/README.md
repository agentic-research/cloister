# `rs/` — Rust workspace

Cargo workspace hosting cloister's Rust crates. Today there's one
member: [`crates/sign`](crates/sign/) — the `leyline-sign` CMS/PKCS#7
+ Ed25519 verifier, compiled to wasm32 and consumed by cloister's
lease middleware via [`src/wire/signet-verify.ts`](../src/wire/signet-verify.ts).

Lifted from
[ley-line](https://github.com/agentic-research/ley-line) on
**2026-05-09** under the original Apache-2.0 license, then re-licensed
AGPL-3.0-or-later to match cloister. The upstream copy remains
Apache-2.0 and is unaffected. See
[`crates/sign/NOTICE`](crates/sign/NOTICE) for the attribution required
by Apache 2.0 §4(c).

## Layout

| Path | Notes |
|------|-------|
| `Cargo.toml` | Workspace root. `resolver = "2"`. Single member today; future Rust additions (cloister-companion when it ships) land here. |
| `Cargo.lock` | Pinned. Checked in so the wasm32 build is reproducible. |
| `crates/sign/` | The leyline-sign crate — see [`crates/sign/README.md`](crates/sign/README.md). Builds a wasm32 module + a `gpgsm`-compatible native binary. |
| `target/` | Cargo build output. Gitignored. |

## Build output cloister depends on

```
rs/target/wasm32-unknown-unknown/release/leyline_sign.wasm
```

That file is what cloister's wasm import (declared in
[`config.capnp`](../config.capnp) + the wrangler bundle rule) resolves
to at workerd boot. Building cloister therefore requires a working
Rust toolchain with the `wasm32-unknown-unknown` target installed; the
melange/apko OCI image build pipeline pulls in the toolchain via
[`melange.yaml`](../melange.yaml).

To build the wasm artifact manually:

```sh
cd rs && cargo build --release --target wasm32-unknown-unknown -p leyline-sign
```

## Decisions

- **Why a workspace for one crate** — leaves room for cloister-companion
  + other Rust crates to land as additional members without churning
  the top-level layout. Per
  [ADR-0009](../docs/adr/0009-compute-substrate-portability.md) the
  companion sidecar is part of the planned substrate.
- **Why wasm32 + workerd, not a native binary** — workerd is a
  sandboxed V8 isolate with no `child_process` and no native shared
  libraries. The verifier has to run inside the isolate to be on the
  lease-middleware hot path, which means wasm32. See
  [ADR-0013](../docs/adr/0013-slice-grant-enforcement.md) for the
  isolate boundary as a security claim.
- **Why a Rust verifier at all** — the CMS / PKCS#7 / X.509 wire shapes
  are not in the Web Crypto surface; rolling them in JS would mean
  re-implementing X.509 in a non-audited substrate. Reusing ley-line's
  battle-tested crate keeps cloister and signet on byte-equal cert
  handling. Per
  [ADR-0007](../docs/adr/0007-interlace-substrate.md).
