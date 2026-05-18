"""Receipt commitment canonical input + digest.

Per README.md §"Receipt commitment":

    canonical_receipt_input = UTF-8 concat, separator '\\n', of:
      "cloister/credential-isolation/v1"
      peerFp_hex
      service
      upstream_status_decimal
      upstream_url_path
      request_size_bytes_decimal
      response_size_bytes_decimal
      wall_clock_ms_decimal
      ts_ms_decimal
      nonce_hex

The receipt signature commits to sha256(canonical_receipt_input). The
credential value is NOT part of canonical_receipt_input.

The MUST-NOT-COMMIT list is enforced structurally — `build_receipt_input`
only accepts the named fields; passing a `credential_value` or anything
from the request body / query / allowedSubs is impossible without
modifying this module, which would itself violate the spec.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

CAPABILITY_TAG = "cloister/credential-isolation/v1"
"""Domain-separation tag pinned at the top of every receipt input. Hard-
coding it here means a different capability re-using sha256+LF would
produce different bytes for the same field values — no cross-capability
preimage collisions."""


@dataclass(frozen=True)
class ReceiptFields:
    """The fields a receipt commits to. Structurally enforces the MUST-NOT-
    COMMIT list: there is no field for credential value, allowedSubs,
    query string, request body, or response body. Adding one would be a
    spec change requiring a new vector."""
    peer_fp_hex: str
    service: str
    upstream_status: int
    upstream_url_path: str
    request_size_bytes: int
    response_size_bytes: int
    wall_clock_ms: int
    ts_ms: int
    nonce_hex: str


def build_receipt_input(r: ReceiptFields) -> bytes:
    """Concatenate the receipt fields per spec.

    Format: UTF-8, single LF (0x0A) between fields, no trailing LF.

      cloister/credential-isolation/v1\\n
      <peer_fp_hex>\\n
      <service>\\n
      <upstream_status>\\n
      <upstream_url_path>\\n
      <request_size_bytes>\\n
      <response_size_bytes>\\n
      <wall_clock_ms>\\n
      <ts_ms>\\n
      <nonce_hex>

    Integer fields use decimal with no leading zeros / no scientific
    notation — Python's str(int) is the canonical form. peer_fp_hex and
    nonce_hex are lowercase hex.
    """
    parts = [
        CAPABILITY_TAG,
        r.peer_fp_hex,
        r.service,
        str(r.upstream_status),
        r.upstream_url_path,
        str(r.request_size_bytes),
        str(r.response_size_bytes),
        str(r.wall_clock_ms),
        str(r.ts_ms),
        r.nonce_hex,
    ]
    return "\n".join(parts).encode("utf-8")


def receipt_digest_hex(r: ReceiptFields) -> str:
    """Lowercase hex sha256 of the canonical receipt input."""
    return hashlib.sha256(build_receipt_input(r)).hexdigest()


# ── MUST-NOT-COMMIT enforcement helper ──────────────────────────────────

FORBIDDEN_RECEIPT_FIELDS: frozenset[str] = frozenset({
    "credential",
    "credential_value",
    "credential_hex",
    "credential_b64",
    "credential_partial",
    "credential_length",
    "allowed_subs",
    "allowedSubs",
    "request_body",
    "response_body",
    "query_string",
    "query",
    "kek_url",
    "kek_source",
})
"""Field names that a conformant implementation MUST NOT include in a
receipt payload, in any form (raw, hashed, partial, length, etc.). Per
README §"MUST NOT commit (security-load-bearing)". Used by the validator
to scan candidate receipt-row dictionaries for spec violations."""


def assert_no_forbidden_fields(receipt_row: dict[str, object]) -> None:
    """Raise ValueError if `receipt_row` contains any forbidden field.

    Used by adversarial vectors to validate that a conformant impl
    rejects (or never produces) a receipt row that leaks credential or
    other MUST-NOT-COMMIT material.
    """
    found = sorted(set(receipt_row.keys()) & FORBIDDEN_RECEIPT_FIELDS)
    if found:
        raise ValueError(
            f"receipt-row contains forbidden fields (MUST-NOT-COMMIT): {found}"
        )
