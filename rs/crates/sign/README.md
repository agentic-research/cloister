# leyline-sign

CMS signing primitives + gpgsm-compatible binary for jj commit signing.

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
