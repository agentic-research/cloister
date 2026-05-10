# Peer attestation chain (§4.2).
#
# One row per state-boundary write, per (actor, peer) pair. The chain
# link is `prev_self_ref = previous_row.content_hash` (per-peer; NOT a
# global hash across all peers — see ADR-0007 audit finding 3 / spec
# §4.2). The genesis row has `prev_self_ref = None` and seq=1.
#
# `content_hash` is sha256_hex of the underlying state-write's canonical
# bytes (in cloister: `bead-canonical.ts`). The attestation row records
# the hash; it does NOT recompute the canonical bytes itself. Different
# implementations choose their own state-boundary canonical encoding.

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class AttestationRow:
    """One row of the per-peer attestation chain. Mirrors spec §4.2 schema."""
    peer_fingerprint: str
    seq: int
    prev_self_ref: str | None
    prev_peer_ref: str | None
    content_hash: str
    content_type: str
    scope: str
    cert_b64: str
    sig_b64: str
    created_at: int  # unix-ms


class ChainIntegrityError(Exception):
    """Mismatch between claimed `prev_self_ref` and observed chain head.

    Cloister surfaces this as `{ok: false, error: 'prev_self_ref_mismatch'}`
    at write time; conformant implementations MUST refuse the row, NOT
    silently rewrite the chain head."""


def validate_chain(rows: list[AttestationRow]) -> None:
    """Walk an attestation chain and assert per-peer link integrity.

    Rules (spec §4.2):
      - rows[0].prev_self_ref MUST be None (genesis).
      - rows[0].seq == 1.
      - rows[i].prev_self_ref == rows[i-1].content_hash for i >= 1.
      - rows[i].seq == rows[i-1].seq + 1.
      - All rows share the same peer_fingerprint.

    Raises ChainIntegrityError on first violation. Reads only; pure
    function over the rows list.
    """
    if not rows:
        return  # empty chain is trivially valid

    if rows[0].prev_self_ref is not None:
        raise ChainIntegrityError(
            f"genesis row has non-null prev_self_ref={rows[0].prev_self_ref!r}"
        )
    if rows[0].seq != 1:
        raise ChainIntegrityError(f"genesis row seq={rows[0].seq}, expected 1")

    peer_fp = rows[0].peer_fingerprint
    for i in range(1, len(rows)):
        prev = rows[i - 1]
        curr = rows[i]
        if curr.peer_fingerprint != peer_fp:
            raise ChainIntegrityError(
                f"row {i} peer_fingerprint mismatch: {curr.peer_fingerprint!r} != {peer_fp!r}"
            )
        if curr.prev_self_ref != prev.content_hash:
            raise ChainIntegrityError(
                f"row {i} prev_self_ref={curr.prev_self_ref!r} != prev.content_hash={prev.content_hash!r}"
            )
        if curr.seq != prev.seq + 1:
            raise ChainIntegrityError(
                f"row {i} seq={curr.seq} != prev.seq+1 ({prev.seq + 1})"
            )


def parse_test_vector_chain(chain_vectors: list[dict]) -> list[AttestationRow]:
    """Build AttestationRow list from the test-vector JSON shape.

    The peer-attestation.json vectors elide `cert`/`sig` (since byte-exact
    sig values would require an Ed25519 signing oracle); we keep the
    placeholder strings as-is so layout validation works without crypto.
    """
    rows: list[AttestationRow] = []
    for entry in chain_vectors:
        r = entry["row"]
        rows.append(AttestationRow(
            peer_fingerprint=r["peer_fingerprint"],
            seq=int(r["seq"]),
            prev_self_ref=r["prev_self_ref"],
            prev_peer_ref=r["prev_peer_ref"],
            content_hash=r["content_hash"],
            content_type=r["content_type"],
            scope=r["scope"],
            cert_b64=r["cert_b64"],
            sig_b64=r["sig_b64"],
            created_at=int(r["created_at"]),
        ))
    return rows
