# CA bundle canonical signing input (§1.3).
#
# Wire transport for the bundle is JSON, but the *signed* canonical bytes
# are RFC 8949 deterministic CBOR. The signature is computed over the
# canonical CBOR encoding of the bundle's six fields packed as an
# integer-keyed map (1..6).
#
# The CBOR encoding has subtle rules:
#   - integers use shortest form (major type 0/1)
#   - bytes use major type 2 (NOT the typed-array tag RFC 8746)
#   - inner string-keyed maps sort keys by RFC 8949 §4.2 bytewise
#     lexicographic order (shorter first; equal-length compared byte-wise)
#
# cbor2.dumps(..., canonical=True) handles all three when the input is a
# plain dict; we just need to make sure the values are the right Python
# types (bytes for byte values, str for text, int for integers).

from __future__ import annotations

from dataclasses import dataclass

import cbor2


@dataclass(frozen=True)
class CABundle:
    """Cluster CA bundle, parsed from the JSON wire form.

    `keys` is a dict mapping `kid` (e.g. "master-k1") to the raw 32-byte
    Ed25519 pubkey. Callers receiving JSON typically need to
    base64-standard-decode the wire values into bytes; that's outside
    this module's scope.

    `prev_key_id` is "" (empty string) when there's no rotation window —
    this matches the Go-side encoding (signet/pkg/revocation/checker.go).
    A JSON wire form that omits the field entirely MUST be normalized to
    "" before canonical encoding so the signature input is deterministic.
    """
    epoch: int
    seqno: int
    keys: dict[str, bytes]
    key_id: str
    prev_key_id: str
    issued_at: int


def bundle_canonical(bundle: CABundle) -> bytes:
    """Produce the RFC 8949 canonical CBOR bytes for a bundle's signing
    input. Must match `src/storage/bundle-canonical.ts::bundleCanonical`
    byte-for-byte.

    The map shape is:
        {1: epoch, 2: seqno, 3: keys, 4: keyId, 5: prevKeyId, 6: issuedAt}

    Integer keys 1..6 are already in canonical (numeric) order; cbor2's
    `canonical=True` will sort the inner `keys` map's text keys by
    RFC 8949 §4.2 (shorter first; equal-length bytewise lex). For the
    test vector with two equal-length keys ("master-k0" vs "master-k1"),
    bytewise lex gives k0 < k1, matching the expected hex.
    """
    message = {
        1: bundle.epoch,
        2: bundle.seqno,
        3: bundle.keys,
        4: bundle.key_id,
        5: bundle.prev_key_id,
        6: bundle.issued_at,
    }
    # canonical=True implements RFC 8949 §4.2 Core Deterministic Encoding:
    # shortest-form ints, bytewise-sorted map keys, definite-length items.
    return cbor2.dumps(message, canonical=True)


def parse_test_vector_bundle(
    inputs: dict,
) -> CABundle:
    """Reconstruct a CABundle from the test-vector JSON shape.

    The vectors store the bundle's `keys` as `{<kid>_b64_std: <b64-std>}`
    — i.e. with the `_b64_std` suffix encoding the wire transport.
    Strip the suffix, base64-standard-decode the value, and produce a
    CABundle whose `keys` is `{<kid>: <raw bytes>}`.

    `prevKeyId` may be absent in the JSON; canonicalize to "" so the CBOR
    encoding always carries the empty-string placeholder at key 5 (the
    spec mandates this for the steady-state single-key bundle).
    """
    import base64

    keys_raw = inputs["keys"]
    keys: dict[str, bytes] = {}
    for tagged_kid, b64 in keys_raw.items():
        if not tagged_kid.endswith("_b64_std"):
            raise ValueError(
                f"unexpected key-suffix in test-vector keys: {tagged_kid!r}"
            )
        kid = tagged_kid[: -len("_b64_std")]
        keys[kid] = base64.b64decode(b64)

    return CABundle(
        epoch=int(inputs["epoch"]),
        seqno=int(inputs["seqno"]),
        keys=keys,
        key_id=str(inputs["keyId"]),
        prev_key_id=str(inputs.get("prevKeyId", "")),
        issued_at=int(inputs["issuedAt_unix_sec"]),
    )
