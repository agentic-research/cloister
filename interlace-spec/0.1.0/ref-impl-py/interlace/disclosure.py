# Disclosure JSONL (§5) — line shape validation + cursor format.
#
# This module handles the *shape* of the disclosure JSONL records and the
# *encoding* of the pagination cursor. It does NOT implement the actor
# side (HTTP serving, page-size cutoff, constant-time 404). Those are
# implementation policy; the spec only pins what goes on the wire.

from __future__ import annotations

import hashlib
import hmac
import json
from dataclasses import dataclass

from .lease import b64url_decode, b64url_encode


CONSTANT_TIME_ERROR_BODY_LEN = 256
CONSTANT_TIME_ERROR_BODY = b"0" * CONSTANT_TIME_ERROR_BODY_LEN


# ── Line shapes (§5.1) ─────────────────────────────────────────────────

REQUIRED_HEADER_FIELDS = {"type", "version", "peer_fingerprint", "master_public_key"}
REQUIRED_ATTESTATION_FIELDS = {
    "type", "seq", "prev_self_ref", "prev_peer_ref", "content_hash",
    "content_type", "scope", "cert_b64", "sig_b64", "created_at",
}
REQUIRED_PENDING_FIELDS = {
    "type", "content_hash", "scope", "attempts", "next_retry_at",
    "exhausted", "created_at", "last_attempt_at",
}


def validate_line_shape(line: dict) -> str:
    """Validate one JSONL line against its expected record shape.

    Returns the record `type` on success. Raises ValueError if the line
    is missing required fields, has the wrong type for a known field, or
    violates a record-specific invariant (e.g. genesis attestation's
    prev_self_ref is null).

    Unknown `type` values are accepted (spec §7: "consumers MUST ignore
    unknown type values"). Header version != "v1" is rejected.
    """
    rec_type = line.get("type")
    if not isinstance(rec_type, str):
        raise ValueError(f"missing or non-string 'type': {line!r}")

    if rec_type == "header":
        missing = REQUIRED_HEADER_FIELDS - line.keys()
        if missing:
            raise ValueError(f"header missing fields: {sorted(missing)}")
        if line["version"] != "v1":
            raise ValueError(f"header version != 'v1': {line['version']!r}")
        if not isinstance(line["peer_fingerprint"], str):
            raise ValueError("header.peer_fingerprint must be string")
        if not isinstance(line["master_public_key"], str):
            raise ValueError("header.master_public_key must be string")
        # next_cursor is optional; if present, must be a string.
        if "next_cursor" in line and not isinstance(line["next_cursor"], str):
            raise ValueError("header.next_cursor must be string when present")

    elif rec_type == "attestation":
        missing = REQUIRED_ATTESTATION_FIELDS - line.keys()
        if missing:
            raise ValueError(f"attestation missing fields: {sorted(missing)}")
        if not isinstance(line["seq"], int) or line["seq"] < 1:
            raise ValueError(f"attestation.seq must be int>=1, got {line['seq']!r}")
        if line["prev_self_ref"] is not None and not isinstance(line["prev_self_ref"], str):
            raise ValueError("attestation.prev_self_ref must be string|null")
        if line["prev_peer_ref"] is not None and not isinstance(line["prev_peer_ref"], str):
            raise ValueError("attestation.prev_peer_ref must be string|null")
        for f in ("content_hash", "content_type", "scope", "cert_b64", "sig_b64"):
            if not isinstance(line[f], str):
                raise ValueError(f"attestation.{f} must be string")
        if not isinstance(line["created_at"], int):
            raise ValueError("attestation.created_at must be int (unix-ms)")
        if line["seq"] == 1 and line["prev_self_ref"] is not None:
            raise ValueError("genesis attestation (seq=1) must have prev_self_ref=null")

    elif rec_type == "pending":
        missing = REQUIRED_PENDING_FIELDS - line.keys()
        if missing:
            raise ValueError(f"pending missing fields: {sorted(missing)}")
        if not isinstance(line["attempts"], int) or line["attempts"] < 1:
            raise ValueError(f"pending.attempts must be int>=1, got {line['attempts']!r}")
        if not isinstance(line["exhausted"], bool):
            raise ValueError("pending.exhausted must be bool")
        if line["last_attempt_at"] is not None and not isinstance(line["last_attempt_at"], int):
            raise ValueError("pending.last_attempt_at must be int|null")

    return rec_type


# ── Cursor format (§5.2) ───────────────────────────────────────────────

@dataclass(frozen=True)
class CursorPayload:
    """Decoded cursor payload. Field names match the spec exactly."""
    from_seq: int
    peer_fp: str
    ts: int


def _payload_canonical_json(p: CursorPayload) -> str:
    """Canonical JSON: keys sorted ASCII ascending, no whitespace.

    Spec §5.2: keys are 'fromSeq', 'peerFp', 'ts' (camelCase per the
    cloister implementation, not snake_case as the dataclass field names).
    Sorted ASCII gives: fromSeq < peerFp < ts.
    """
    obj = {"fromSeq": p.from_seq, "peerFp": p.peer_fp, "ts": p.ts}
    # sort_keys=True + separators=(',',':') = canonical (no whitespace,
    # alphabetical keys). ensure_ascii=False to match RFC 8259 §7 raw UTF-8.
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def encode_cursor(payload: CursorPayload, hmac_key: bytes) -> str:
    """Build a `v1.<payload_b64u>.<hmac_b64u>` cursor token.

    Spec §5.2: HMAC-SHA256 is computed over UTF8("v1." || payload_b64u),
    NOT over the full token (which would be a chicken-and-egg).
    """
    payload_b64 = b64url_encode(_payload_canonical_json(payload).encode("utf-8"))
    signing_input = f"v1.{payload_b64}".encode("utf-8")
    mac = hmac.new(hmac_key, signing_input, hashlib.sha256).digest()
    mac_b64 = b64url_encode(mac)
    return f"v1.{payload_b64}.{mac_b64}"


def verify_cursor(token: str, hmac_key: bytes, expected_peer_fp: str) -> CursorPayload:
    """Verify and decode a cursor token.

    Returns CursorPayload on success. Raises ValueError on any failure
    (callers should collapse to the constant-time 404; we don't enrich
    the error class here because the caller's policy is "all failures
    look the same to the network").
    """
    parts = token.split(".")
    if len(parts) != 3:
        raise ValueError("cursor: wrong segment count")
    version, payload_b64, mac_b64 = parts
    if version != "v1":
        raise ValueError("cursor: wrong version")

    signing_input = f"v1.{payload_b64}".encode("utf-8")
    expected_mac = hmac.new(hmac_key, signing_input, hashlib.sha256).digest()
    try:
        actual_mac = b64url_decode(mac_b64)
    except Exception as e:  # noqa: BLE001 — base64 raises a variety of errors
        raise ValueError(f"cursor: malformed MAC: {e}") from None
    # Constant-time compare: spec §5.2 explicitly requires it.
    if not hmac.compare_digest(expected_mac, actual_mac):
        raise ValueError("cursor: HMAC mismatch")

    try:
        payload_json = b64url_decode(payload_b64).decode("utf-8")
        payload = json.loads(payload_json)
    except Exception as e:  # noqa: BLE001
        raise ValueError(f"cursor: malformed payload: {e}") from None
    if not (isinstance(payload, dict)
            and isinstance(payload.get("fromSeq"), int)
            and isinstance(payload.get("peerFp"), str)
            and isinstance(payload.get("ts"), int)):
        raise ValueError("cursor: payload type mismatch")
    if payload["peerFp"] != expected_peer_fp:
        raise ValueError("cursor: peerFp mismatch")

    return CursorPayload(
        from_seq=payload["fromSeq"],
        peer_fp=payload["peerFp"],
        ts=payload["ts"],
    )
