# leyline-sign

CMS signing primitives + gpgsm-compatible binary for jj commit signing.

The cloister-side bin target of this crate is **`leyline-sign-helper`** —
the loopback-UDS host signing daemon specified by
[ADR-0019](../../../docs/adr/0019-sign-only-helper-protocol.md). The
supervisor units that own its process lifecycle live in
[`supervisor/`](supervisor/README.md).

## What's here

- **Certificate** — Ed25519 self-signed X.509 certificate generation.
- **Signature** — CMS (RFC 5652) `SignedData` creation and verification.
- **`leyline-sign` binary** — drop-in replacement for gpgsm. Accepts `--sign`/`--verify` on stdin/stdout, compatible with jj's signing interface.

## Usage with jj

```bash
jj config set --user signing.backend "gpg"
jj config set --user signing.backends.gpg.program "leyline-sign"
jj config set --user signing.sign-all true
```

## Related projects

The names `leyline-sign`, `leyline-sign-helper`, `signet-sign`, and
`"leyline"` (no suffix) get used in close proximity in the cloister
constellation and are easy to conflate. They are not the same thing.
See [`docs/glossary.md`](../../../docs/glossary.md) for the canonical
disambiguation; the short version:

- **`signet-sign`** — sibling Rust crate that lives in the
  [`signet`](https://github.com/agentic-research/signet) repo at
  `signet/rs/crates/sign/`. Pure-library Ed25519 CMS/PKCS#7
  signing + verification (RFC 5652 / RFC 8419), `cdylib + staticlib + rlib`,
  wasm32-compatible. **No daemon, no UDS, no OS-keystore client.** The
  cloister-side crate in *this* directory is a different crate (also
  named the dir `rs/crates/sign/`, which is the source of the confusion);
  the two crates solve adjacent problems and are intentionally separate
  pending a deeper convergence call.
- **`leyline`** (no `-sign`, no `-net`) — the *protocol* name, not a
  crate. Defined by [ADR-0005](../../../docs/adr/0005-internal-wire-leyline-net.md):
  the signed-capnp wire that cloister speaks at the companion ↔ backend
  seam. Implemented in the `ley-line` repo's
  `ley-line/rs/crates/net/` ("leyline-net"); cloister consumes that
  crate, it does not vendor it here.
- **`leyline-sign-helper`** — the bin target compiled out of this crate
  (under the `host` feature). The ADR-0019 sign-only daemon: loopback
  UDS, OS-keystore-backed master key, phantom-token contract.
