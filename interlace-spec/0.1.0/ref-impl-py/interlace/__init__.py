# Interlace v0.1.0 — Python reference implementation.
#
# This package is the second implementation of the Interlace wire-format
# spec (cloister-the-TypeScript-impl is the first). Its purpose is to be
# byte-compatible at every signed surface, so the test vectors in
# `interlace-spec/0.1.0/test-vectors/` are *cross-implementation
# falsifiable* — if cloister and this Python both pass them, the spec is
# the contract; if one diverges from the other, exactly one of (spec,
# cloister, python) has a bug.
#
# Surfaces, by module:
#
#   cert.py      — §1.4 + §2: X.509 DER parse + Ed25519 cert verify,
#                  Interlace extension OIDs, canonical claims JSON.
#   bundle.py    — §1.3:      CA bundle canonical CBOR for signing.
#   lease.py     — §3 + §4.1: lease envelope canonical bytes,
#                  lease-counter chain step.
#   chain.py     — §4.2:      peer attestation chain (prev_self_ref).
#   disclosure.py — §5:       JSONL line shapes + cursor format.
#
# Code clarity is the optimization target. Production-grade hardening
# (constant-time MAC comparison, key rotation, error-class collapse,
# bundle-staleness clock) is the *implementing* side's job, not the
# reference's.

from . import bundle, cert, chain, disclosure, lease

__all__ = ["bundle", "cert", "chain", "disclosure", "lease"]
