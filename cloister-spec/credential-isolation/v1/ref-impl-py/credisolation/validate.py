"""Structural validators for the credential-isolation/v1 wire shapes.

Used by both the conformance runner (positive: vector outputs round-trip)
and adversarial vectors (negative: malformed inputs MUST be rejected).
"""

from __future__ import annotations

import re

# Per wire/proxy-envelope.md §"Request":
#   Interlace-Nonce: <22-byte-nonce-base64url-no-pad>
#   Interlace-Ts:    <unix-ms-decimal>
#   Interlace-Sig:   <ed25519-sig-base64url-no-pad>
#   Interlace-Cert:  <der-base64url-no-pad>

# 22 base64url chars decode to 16 bytes; spec says "22-byte-nonce" which is
# a 16-byte raw nonce in base64url no-padding (22 b64 chars = 16 bytes).
NONCE_B64URL_RE = re.compile(r"^[A-Za-z0-9_-]{22}$")
TS_MS_RE = re.compile(r"^[1-9][0-9]+$")
# Ed25519 sig is 64 raw bytes → 86 b64url no-pad chars (88 with padding).
SIG_B64URL_RE = re.compile(r"^[A-Za-z0-9_-]{86}$")
# DER cert is variable length; just bound it loosely + check char class.
CERT_B64URL_RE = re.compile(r"^[A-Za-z0-9_-]{16,8192}$")

REQUIRED_REQUEST_HEADERS: tuple[str, ...] = (
    "Interlace-Cert",
    "Interlace-Cert-Chain",
    "Interlace-Sig",
    "Interlace-Nonce",
    "Interlace-Ts",
)


class EnvelopeReject(ValueError):
    """A proxy envelope failed structural validation."""

    def __init__(self, kind: str, detail: str):
        super().__init__(f"{kind}: {detail}")
        self.kind = kind
        self.detail = detail


def validate_request_envelope(headers: dict[str, str]) -> None:
    """Reject malformed proxy-envelope request headers.

    Mirrors what cloister-router does pre-signature: parse the lease
    headers, check each is well-formed, then hand to the Interlace
    verifier. A second implementation MUST raise EnvelopeReject (or
    equivalent) for each of the failure modes below.
    """
    # Normalize to lower-case for lookup (HTTP headers are case-insensitive,
    # but the test vectors pin the canonical Pascal-Case form for readability).
    norm = {k.lower(): v for k, v in headers.items()}

    for required in REQUIRED_REQUEST_HEADERS:
        if required.lower() not in norm:
            raise EnvelopeReject("missing_required_header", required)

    if not NONCE_B64URL_RE.match(norm["interlace-nonce"]):
        raise EnvelopeReject(
            "malformed_nonce",
            f"expected 22 base64url chars, got {norm['interlace-nonce']!r}",
        )
    if not TS_MS_RE.match(norm["interlace-ts"]):
        raise EnvelopeReject(
            "malformed_ts",
            f"expected decimal unix-ms, got {norm['interlace-ts']!r}",
        )
    if not SIG_B64URL_RE.match(norm["interlace-sig"]):
        raise EnvelopeReject(
            "malformed_sig",
            f"expected 86 base64url chars (Ed25519 sig), got {len(norm['interlace-sig'])} chars",
        )
    if not CERT_B64URL_RE.match(norm["interlace-cert"]):
        raise EnvelopeReject("malformed_cert", "cert is not valid base64url")


# ── service / path parsing ──────────────────────────────────────────────

# `<service>` MUST NOT contain a slash, and is lowercase-only — uppercase
# service names would create lookup hazards against manifest entries.
SERVICE_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,62}$")


def parse_vault_proxy_path(path: str) -> tuple[str, str]:
    """Split `/vault/proxy/<service>/<upstream-path>` → (service, upstream-path).

    `upstream-path` includes its leading slash (or empty string for the
    "service root" case `/vault/proxy/<service>`).
    """
    prefix = "/vault/proxy/"
    if not path.startswith(prefix):
        raise EnvelopeReject("malformed_path", f"missing {prefix} prefix")
    rest = path[len(prefix):]
    if "/" not in rest:
        # /vault/proxy/<service> (no trailing slash, no upstream path)
        service, upstream = rest, ""
    else:
        service, upstream = rest.split("/", 1)
        upstream = "/" + upstream
    if not SERVICE_RE.match(service):
        raise EnvelopeReject(
            "malformed_service",
            f"service must match {SERVICE_RE.pattern!r}; got {service!r}",
        )
    return service, upstream


# ── response shape ──────────────────────────────────────────────────────

CONSTANT_TIME_ERROR_STATUSES: frozenset[int] = frozenset({401, 404})
"""401 + 404 are the access-failure status codes in Shape R per
wire/error-responses.md (post-2026-05-18 cycle X-2 unification per
cloister-6eba0a). 403 is INTENTIONALLY ABSENT — historically the
allowedSubs-mismatch path emitted 403, but the route boundary now
collapses that to 404 (cloister-aa9376 + the X-2 wire-shape collapse).
Per the spec a Shape R response on the wire is 401 OR 404; no other
status. The 429 rate-limit path also emits Shape R bodies but with a
distinct status code that legitimately differentiates the operator
signal."""
