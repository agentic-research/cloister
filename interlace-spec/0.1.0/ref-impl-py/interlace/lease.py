# Lease envelope (§3) + lease-counter chain (§4.1).
#
# These two surfaces are the load-bearing pieces of the §13.2 "silence is
# evidence" property: the chain hash is what a peer reconstructs and
# compares against what disclosure returns, and the envelope is what the
# actor signs to prove the request was admitted.
#
# Both surfaces are UTF-8 byte concatenations with no separators (chain)
# or with single-LF separators (envelope). Threat-model §7.7.a explicitly
# warns: if you accidentally insert separators in the chain input, your
# digest looks indistinguishable from cluster-side §13.2 misbehavior.

from __future__ import annotations

import base64
import hashlib
from dataclasses import dataclass

ZERO_HASH = "0" * 64
"""Genesis prev-chain hash: 64 ASCII zeros."""


# ── §4.1 lease-counter chain ────────────────────────────────────────────

def next_chain_hash(
    prev_chain_hash: str,
    cert_fp: str,
    nonce_b64: str,
    ts_ms: int,
) -> str:
    """Fold one observation into the per-peer chain hash.

    Spec §4.1:
        next_chain_hash = sha256_hex(UTF8(prev || cert_fp || nonce_b64 || ts_str))

    With ABSOLUTELY NO SEPARATORS between fields. Insertion of any
    delimiter (newline, comma, colon, space) breaks cross-implementation
    byte-equality and silently violates §13.2 (threat-model §7.7.a).

    All four inputs are ASCII-safe:
      - prev_chain_hash: 64 lowercase hex chars (or ZERO_HASH at genesis)
      - cert_fp:         64 lowercase hex chars (sha256_hex of cert DER)
      - nonce_b64:       base64url no-padding of the raw nonce bytes
      - ts_ms:           decimal Unix-milliseconds (no leading zeros, no
                         scientific notation — Python's str(int) is fine)

    Returns 64 lowercase hex chars.
    """
    payload = f"{prev_chain_hash}{cert_fp}{nonce_b64}{ts_ms}".encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


# ── §3.2 lease envelope canonical bytes ─────────────────────────────────

def canonical_request_bytes(
    method: str,
    url: str,
    ts_ms: int,
    nonce_b64: str,
    body: str | bytes,
) -> bytes:
    """Build the bytes that get Ed25519-signed for a lease envelope.

    Spec §3.2:
        <method>\n<url>\n<ts>\n<nonce_b64url_no_pad>\n<body>

    Separator is exactly one LF (0x0A) between fields. NO CRLF. NO
    trailing newline. The body MAY contain LF since it's the final
    field; the parser reads the first four LF-separated fields and
    treats everything after the fourth LF as the body.

    `body` accepts bytes (passed through verbatim) or str (UTF-8 encoded).
    GET requests pass body="" — the trailing LF before the empty body is
    REQUIRED (the empty string is a field, not a missing field).
    """
    if isinstance(body, str):
        body_bytes = body.encode("utf-8")
    else:
        body_bytes = body
    prefix = f"{method}\n{url}\n{ts_ms}\n{nonce_b64}\n".encode("utf-8")
    return prefix + body_bytes


# ── §3 scope grammar (helpers for §3.3 scope-match) ─────────────────────

def scope_grants(cert_scope: str, requested_scope: str) -> bool:
    """Does a cert with scope `cert_scope` permit `requested_scope`?

    Spec §3.3:
      - cert_scope == "*"                       → admin (any)
      - cert_scope == requested_scope           → exact
      - cert_scope ends in ":*" AND requested
        starts with that prefix (sans the "*")  → wildcard

    No multi-component wildcards. No glob. No regex.
    """
    if cert_scope == "*":
        return True
    if cert_scope == requested_scope:
        return True
    if cert_scope.endswith(":*"):
        prefix = cert_scope[:-1]  # keep the trailing colon
        return requested_scope.startswith(prefix)
    return False


# ── Convenience wrapper: full chain replay ──────────────────────────────

@dataclass(frozen=True)
class ChainStep:
    """One row of a lease-counter chain. Mirrors spec §4.1 schema."""
    seq: int
    prev_chain_hash: str
    last_chain_hash: str
    cert_fp: str
    nonce_b64: str
    ts_ms: int


def replay_chain(
    cert_fp: str,
    observations: list[tuple[str, int]],
    initial_prev_hash: str = ZERO_HASH,
    initial_seq: int = 0,
) -> list[ChainStep]:
    """Replay a list of (nonce_b64, ts_ms) observations against a starting
    state, returning one ChainStep per observation.

    Pure function: takes a deterministic starting point + an ordered
    sequence of observations, returns the resulting chain. The conformance
    suite uses this to walk the test-vector observations end-to-end.

    Genesis is implicit: pass the default `initial_prev_hash = ZERO_HASH`
    and `initial_seq = 0` and the first returned step has seq=1.
    """
    out: list[ChainStep] = []
    prev_hash = initial_prev_hash
    prev_seq = initial_seq
    for nonce_b64, ts_ms in observations:
        new_hash = next_chain_hash(prev_hash, cert_fp, nonce_b64, ts_ms)
        new_seq = prev_seq + 1
        out.append(ChainStep(
            seq=new_seq,
            prev_chain_hash=prev_hash,
            last_chain_hash=new_hash,
            cert_fp=cert_fp,
            nonce_b64=nonce_b64,
            ts_ms=ts_ms,
        ))
        prev_hash = new_hash
        prev_seq = new_seq
    return out


# ── base64url no-padding utilities ──────────────────────────────────────
#
# RFC 4648 §5. Kept here so callers don't have to remember that
# base64.urlsafe_b64encode emits padding by default.

def b64url_encode(raw: bytes) -> str:
    """Encode raw bytes as base64url (RFC 4648 §5) without padding."""
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def b64url_decode(s: str) -> bytes:
    """Decode base64url string (any padding state) to raw bytes."""
    pad = (-len(s)) % 4
    return base64.urlsafe_b64decode(s + ("=" * pad))
