"""Proxy envelope canonical request bytes.

Per wire/proxy-envelope.md §"Request canonicalization":

    canonical = METHOD + "\n" + URL + "\n" + TS_MS + "\n" + NONCE_B64URL + "\n" + BODY

Identical shape to interlace-spec/0.1.0/ §3.4. This module re-asserts the
shape so credential-isolation conformance can be checked WITHOUT importing
the interlace ref-impl — the duplication is intentional (specs are leaves;
cross-leaf import would create a Python-package dep that masks a wire-spec
dep).

The URL is the FULL cloister-router path observed at the proxy boundary
(`/vault/proxy/<service>/<upstream-path>[?query]`), NOT the upstream URL.
This is the path the caller signed against — URL rewriting to upstream
happens AFTER signature verification.

Stdlib-only on purpose. Anyone auditing a digest can read every byte that
contributes to it.
"""

from __future__ import annotations

import base64
import hashlib


def canonical_request_bytes(
    method: str,
    url: str,
    ts_ms: int,
    nonce_b64url_no_pad: str,
    body: str | bytes,
) -> bytes:
    """Build the bytes that get Ed25519-signed for a proxy request.

    Separator is exactly one LF (0x0A) between the four header fields.
    NO CRLF. NO trailing newline before body. The body MAY contain LF
    since it is the final field.

    `body` accepts bytes (passed through verbatim) or str (UTF-8 encoded).
    GET-style proxy calls pass body="" — the trailing LF before the empty
    body is REQUIRED (the empty string is a field, not a missing field).
    """
    body_bytes = body.encode("utf-8") if isinstance(body, str) else body
    prefix = f"{method}\n{url}\n{ts_ms}\n{nonce_b64url_no_pad}\n".encode("utf-8")
    return prefix + body_bytes


def canonical_request_sha256_hex(
    method: str,
    url: str,
    ts_ms: int,
    nonce_b64url_no_pad: str,
    body: str | bytes,
) -> str:
    """Lowercase hex sha256 of the canonical request bytes."""
    return hashlib.sha256(
        canonical_request_bytes(method, url, ts_ms, nonce_b64url_no_pad, body)
    ).hexdigest()


# ── base64url no-padding (RFC 4648 §5) ──────────────────────────────────


def b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def b64url_decode(s: str) -> bytes:
    pad = (-len(s)) % 4
    return base64.urlsafe_b64decode(s + ("=" * pad))


# ── reserved response headers (wire/proxy-envelope.md §"Response") ──────

RESERVED_RESPONSE_HEADERS: frozenset[str] = frozenset({
    "interlace-receipt",  # set by proxy, never copied from upstream
    "server",             # overwritten to "cloister/credential-isolation/v1"
})
"""Headers the proxy MUST set/overwrite on the response (case-insensitive).
All other upstream response headers MUST pass through unchanged."""
