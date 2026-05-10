# X.509 cert parse + Interlace claims extraction + Ed25519 verify (§1.4, §2).
#
# We hand-roll a minimal DER parser instead of pulling in pyasn1 / asn1crypto
# / cryptography.x509. Reasons:
#
#   1. The spec is *opinionated* about exactly which extensions matter (the
#      three Interlace OIDs + the critical-flag rejection rule). Walking the
#      DER ourselves makes the rule explicit at every byte.
#   2. cryptography.x509 will happily parse certs that the Interlace verifier
#      MUST reject (e.g. critical unknowns), and its public API for "give me
#      raw tbsCertificate bytes" is awkward. Re-encoding the tbs from a parsed
#      structure is a non-conformance trap (spec §2 step 3 explicitly bans it).
#   3. The DER subset we need is tiny: SEQUENCE, INTEGER, UTF8String, OID,
#      BIT STRING, OCTET STRING, BOOLEAN, NULL, UTCTime, GeneralizedTime.
#
# For Ed25519 verification proper we use `cryptography.hazmat.primitives.asymmetric.ed25519`.

from __future__ import annotations

import datetime as dt
import hashlib
import json
from dataclasses import dataclass, field

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

# ── OID strings ────────────────────────────────────────────────────────

OID_ED25519 = "1.3.101.112"
OID_INTERLACE_EPOCH = "1.3.6.1.4.1.99999.1.4"
OID_INTERLACE_PEER = "1.3.6.1.4.1.99999.1.5"
OID_INTERLACE_SCOPE = "1.3.6.1.4.1.99999.1.6"
INTERLACE_KNOWN_OIDS = frozenset({
    OID_INTERLACE_EPOCH, OID_INTERLACE_PEER, OID_INTERLACE_SCOPE,
})


# ── Verifier result types ──────────────────────────────────────────────

@dataclass(frozen=True)
class CertClaims:
    """Spec §2: claims extracted from a verified cert."""
    ephemeral_pubkey: bytes  # 32 raw bytes
    not_before: int           # unix seconds
    not_after: int            # unix seconds
    epoch: int | None         # required for Phase 1
    peer_fp: str | None       # required for Phase 1
    scope: str | None         # required for Phase 1


class CertReject(Exception):
    """Cert failed verification. `kind` is the stable error code per spec §2."""

    def __init__(self, kind: str, detail: str = ""):
        super().__init__(f"{kind}: {detail}" if detail else kind)
        self.kind = kind
        self.detail = detail


# ── Minimal DER parser ─────────────────────────────────────────────────
#
# Just enough to walk an X.509v3 cert and yank the three Interlace
# extension values. We work with absolute slices into the DER so we can
# extract `tbs_certificate`'s exact bytes without re-encoding.

@dataclass
class _TLV:
    """A parsed Tag-Length-Value record. `value_offset` and `value_end`
    are absolute byte offsets in the original buffer — so callers that
    need byte-exact `tbs_certificate` can slice `[value_offset:value_end]`."""
    tag: int
    value_offset: int
    value_end: int


def _read_len(buf: bytes, off: int) -> tuple[int, int]:
    """Read a DER length starting at offset `off`. Returns (length, new_off)."""
    if off >= len(buf):
        raise CertReject("BadDer", "truncated length")
    first = buf[off]
    off += 1
    if first < 0x80:
        return first, off
    n = first & 0x7F
    if n == 0:
        raise CertReject("BadDer", "indefinite length not allowed in DER")
    if off + n > len(buf):
        raise CertReject("BadDer", "truncated long-form length")
    length = int.from_bytes(buf[off:off + n], "big")
    return length, off + n


def _read_tlv(buf: bytes, off: int) -> _TLV:
    """Read one Tag-Length-Value at `off`."""
    if off >= len(buf):
        raise CertReject("BadDer", "truncated TLV header")
    tag = buf[off]
    length, val_off = _read_len(buf, off + 1)
    end = val_off + length
    if end > len(buf):
        raise CertReject("BadDer", "TLV value extends past buffer")
    return _TLV(tag=tag, value_offset=val_off, value_end=end)


def _tlv_end(tlv: _TLV) -> int:
    return tlv.value_end


def _decode_oid(content: bytes) -> str:
    """Decode a DER OID content (no tag/length) to a dotted string."""
    if not content:
        raise CertReject("BadDer", "empty OID")
    # First byte encodes the first two arc values: arc1*40 + arc2.
    first = content[0]
    arcs = [first // 40, first % 40]
    n = 0
    for b in content[1:]:
        n = (n << 7) | (b & 0x7F)
        if not (b & 0x80):
            arcs.append(n)
            n = 0
    return ".".join(str(a) for a in arcs)


def _decode_integer(content: bytes) -> int:
    """Decode a DER INTEGER content as a signed big-endian integer."""
    if not content:
        raise CertReject("BadDer", "empty INTEGER")
    return int.from_bytes(content, "big", signed=True)


def _decode_unsigned_integer_u32(content: bytes) -> int:
    """Decode a DER INTEGER as an unsigned 32-bit integer.

    Spec wire/cert-extensions.md: epoch is u32 in big-endian. The DER
    INTEGER content may carry a leading 0x00 sign byte (when the high
    bit would otherwise flip negative). Reject if > 5 content bytes or
    zero-length.
    """
    if not content:
        raise CertReject("BadDer", "epoch INTEGER is empty")
    if len(content) > 5:
        raise CertReject("BadDer", f"epoch INTEGER content too long ({len(content)} bytes)")
    if len(content) == 5 and content[0] != 0:
        raise CertReject("BadDer", "epoch INTEGER 5-byte form without sign-byte prefix")
    stripped = content[1:] if (len(content) > 1 and content[0] == 0) else content
    if len(stripped) > 4:
        raise CertReject("BadDer", "epoch INTEGER value exceeds u32 range")
    return int.from_bytes(stripped, "big", signed=False)


def _decode_time(tag: int, content: bytes) -> int:
    """Decode UTCTime (tag 0x17) or GeneralizedTime (tag 0x18) to unix seconds."""
    s = content.decode("ascii")
    if tag == 0x17:
        # UTCTime: YYMMDDhhmmssZ (always Z form per RFC 5280).
        if not s.endswith("Z") or len(s) != 13:
            raise CertReject("BadDer", f"unexpected UTCTime form: {s!r}")
        yy = int(s[0:2])
        # RFC 5280 §4.1.2.5.1: YY < 50 → 20YY, else 19YY.
        year = 2000 + yy if yy < 50 else 1900 + yy
        month = int(s[2:4]); day = int(s[4:6])
        hh = int(s[6:8]); mm = int(s[8:10]); ss = int(s[10:12])
    elif tag == 0x18:
        # GeneralizedTime: YYYYMMDDhhmmssZ (no fractional seconds for RFC 5280 certs).
        if not s.endswith("Z") or len(s) != 15:
            raise CertReject("BadDer", f"unexpected GeneralizedTime form: {s!r}")
        year = int(s[0:4])
        month = int(s[4:6]); day = int(s[6:8])
        hh = int(s[8:10]); mm = int(s[10:12]); ss = int(s[12:14])
    else:
        raise CertReject("BadDer", f"unexpected time tag {tag:#x}")
    return int(dt.datetime(year, month, day, hh, mm, ss, tzinfo=dt.timezone.utc).timestamp())


# ── Cert verify pipeline (§2) ──────────────────────────────────────────

def verify_cert(cert_der: bytes, master_pubkey: bytes) -> CertClaims:
    """Spec §2 cert verification.

    Steps (all conjunctive — any failure raises CertReject):
      1. DER-decode the outer Certificate SEQUENCE.
      2. Identify (tbs_certificate, signatureAlgorithm, signatureValue) children.
      3. Check signatureAlgorithm.oid == id-Ed25519.
      4. Ed25519.verify(master_pubkey, signature, tbs_der).
      5. Extract ephemeral pubkey from SPKI; reject non-Ed25519 / non-32-byte.
      6. Decode validity.not_before / not_after to unix seconds.
      7. Walk extensions: collect known Interlace OIDs, reject critical unknowns.

    Returns CertClaims with optional `epoch`/`peer_fp`/`scope`. Phase 1
    deployments (cloister today) MUST reject if any of those three is
    None — that policy decision is the caller's, not this function's.
    """
    if len(master_pubkey) != 32:
        raise CertReject("BadMasterKey", f"expected 32 bytes, got {len(master_pubkey)}")

    # Outer SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue }
    outer = _read_tlv(cert_der, 0)
    if outer.tag != 0x30:
        raise CertReject("BadDer", f"outer tag {outer.tag:#x} != SEQUENCE")
    if outer.value_end != len(cert_der):
        raise CertReject("BadDer", "extra bytes after outer SEQUENCE")

    p = outer.value_offset
    tbs = _read_tlv(cert_der, p)
    if tbs.tag != 0x30:
        raise CertReject("BadDer", "tbsCertificate is not SEQUENCE")
    # Spec §2 step 3: the signature is over `tbs_certificate` re-encoded
    # to DER. Since the input is already DER, the canonical re-encoding
    # equals the slice — but we explicitly slice including the outer
    # SEQUENCE bytes (tag + length + value), because the signature is
    # over the whole TLV, not just the value.
    tbs_der = cert_der[p:_tlv_end(tbs)]
    p = _tlv_end(tbs)

    sig_algo = _read_tlv(cert_der, p)
    if sig_algo.tag != 0x30:
        raise CertReject("BadDer", "signatureAlgorithm is not SEQUENCE")
    sig_algo_oid_tlv = _read_tlv(cert_der, sig_algo.value_offset)
    if sig_algo_oid_tlv.tag != 0x06:
        raise CertReject("BadDer", "signatureAlgorithm.oid is not OBJECT IDENTIFIER")
    sig_algo_oid = _decode_oid(cert_der[sig_algo_oid_tlv.value_offset:sig_algo_oid_tlv.value_end])
    if sig_algo_oid != OID_ED25519:
        raise CertReject("BadSignature", f"signatureAlgorithm {sig_algo_oid} != id-Ed25519")
    # RFC 8410 says parameters MUST be absent for Ed25519. We don't enforce
    # that hard here — it's a SHOULD-reject the spec leaves to implementations.
    p = _tlv_end(sig_algo)

    sig_value = _read_tlv(cert_der, p)
    if sig_value.tag != 0x03:
        raise CertReject("BadDer", "signatureValue is not BIT STRING")
    sig_content = cert_der[sig_value.value_offset:sig_value.value_end]
    if not sig_content or sig_content[0] != 0:
        raise CertReject("BadDer", "BIT STRING with non-zero unused bits in signatureValue")
    signature = sig_content[1:]
    if len(signature) != 64:
        raise CertReject("BadSignature", f"expected 64-byte Ed25519 sig, got {len(signature)}")
    if _tlv_end(sig_value) != outer.value_end:
        raise CertReject("BadDer", "trailing bytes inside outer SEQUENCE")

    # Step 4: Ed25519 verify.
    try:
        Ed25519PublicKey.from_public_bytes(master_pubkey).verify(signature, tbs_der)
    except InvalidSignature:
        raise CertReject("BadSignature", "Ed25519 verification failed")

    # ── Walk tbs_certificate fields ────────────────────────────────────
    #
    # tbsCertificate ::= SEQUENCE {
    #   version         [0] EXPLICIT Version DEFAULT v1,
    #   serialNumber    CertificateSerialNumber,
    #   signature       AlgorithmIdentifier,        -- redundant copy
    #   issuer          Name,
    #   validity        Validity,
    #   subject         Name,
    #   subjectPublicKeyInfo SubjectPublicKeyInfo,
    #   extensions      [3] EXPLICIT Extensions OPTIONAL
    # }
    q = tbs.value_offset
    first = _read_tlv(cert_der, q)
    # Skip optional [0] version tag.
    if first.tag == 0xA0:
        q = _tlv_end(first)
        first = _read_tlv(cert_der, q)
    serial = first  # INTEGER
    if serial.tag != 0x02:
        raise CertReject("BadDer", "tbs serialNumber is not INTEGER")
    q = _tlv_end(serial)

    inner_sig_algo = _read_tlv(cert_der, q)
    if inner_sig_algo.tag != 0x30:
        raise CertReject("BadDer", "tbs signature is not SEQUENCE")
    inner_sig_algo_oid_tlv = _read_tlv(cert_der, inner_sig_algo.value_offset)
    inner_sig_oid = _decode_oid(cert_der[inner_sig_algo_oid_tlv.value_offset:inner_sig_algo_oid_tlv.value_end])
    if inner_sig_oid != OID_ED25519:
        # Per X.509: outer and inner signature algorithm OIDs MUST match.
        raise CertReject("BadSignature", "tbs signature OID mismatch")
    q = _tlv_end(inner_sig_algo)

    issuer = _read_tlv(cert_der, q)  # Name (SEQUENCE of RDNs)
    if issuer.tag != 0x30:
        raise CertReject("BadDer", "tbs issuer is not SEQUENCE")
    q = _tlv_end(issuer)

    validity = _read_tlv(cert_der, q)
    if validity.tag != 0x30:
        raise CertReject("BadDer", "tbs validity is not SEQUENCE")
    v = validity.value_offset
    nb_tlv = _read_tlv(cert_der, v)
    not_before = _decode_time(nb_tlv.tag, cert_der[nb_tlv.value_offset:nb_tlv.value_end])
    v = _tlv_end(nb_tlv)
    na_tlv = _read_tlv(cert_der, v)
    not_after = _decode_time(na_tlv.tag, cert_der[na_tlv.value_offset:na_tlv.value_end])
    q = _tlv_end(validity)

    subject = _read_tlv(cert_der, q)
    if subject.tag != 0x30:
        raise CertReject("BadDer", "tbs subject is not SEQUENCE")
    q = _tlv_end(subject)

    spki = _read_tlv(cert_der, q)
    if spki.tag != 0x30:
        raise CertReject("BadDer", "SubjectPublicKeyInfo is not SEQUENCE")
    s = spki.value_offset
    spki_algo = _read_tlv(cert_der, s)
    spki_algo_oid_tlv = _read_tlv(cert_der, spki_algo.value_offset)
    spki_algo_oid = _decode_oid(cert_der[spki_algo_oid_tlv.value_offset:spki_algo_oid_tlv.value_end])
    if spki_algo_oid != OID_ED25519:
        raise CertReject("BadDer", f"SPKI algorithm {spki_algo_oid} != id-Ed25519")
    s = _tlv_end(spki_algo)
    spki_key = _read_tlv(cert_der, s)
    if spki_key.tag != 0x03:
        raise CertReject("BadDer", "SPKI subjectPublicKey is not BIT STRING")
    key_bytes = cert_der[spki_key.value_offset:spki_key.value_end]
    if not key_bytes or key_bytes[0] != 0:
        raise CertReject("BadDer", "SPKI BIT STRING has non-zero unused bits")
    ephemeral_pubkey = key_bytes[1:]
    if len(ephemeral_pubkey) != 32:
        raise CertReject("BadDer", f"ephemeral pubkey is {len(ephemeral_pubkey)} bytes, not 32")
    q = _tlv_end(spki)

    # ── Extensions [3] EXPLICIT Extensions OPTIONAL ───────────────────
    epoch: int | None = None
    peer_fp: str | None = None
    scope: str | None = None
    if q < tbs.value_end:
        ext_wrap = _read_tlv(cert_der, q)
        if ext_wrap.tag != 0xA3:
            raise CertReject("BadDer", f"expected extensions [3], got tag {ext_wrap.tag:#x}")
        exts_seq = _read_tlv(cert_der, ext_wrap.value_offset)
        if exts_seq.tag != 0x30:
            raise CertReject("BadDer", "Extensions container is not SEQUENCE")
        e = exts_seq.value_offset
        while e < exts_seq.value_end:
            ext = _read_tlv(cert_der, e)
            if ext.tag != 0x30:
                raise CertReject("BadDer", "Extension is not SEQUENCE")
            e2 = ext.value_offset
            oid_tlv = _read_tlv(cert_der, e2)
            if oid_tlv.tag != 0x06:
                raise CertReject("BadDer", "Extension first child is not OID")
            ext_oid = _decode_oid(cert_der[oid_tlv.value_offset:oid_tlv.value_end])
            e2 = _tlv_end(oid_tlv)
            critical = False
            next_tlv = _read_tlv(cert_der, e2)
            if next_tlv.tag == 0x01:
                # BOOLEAN
                bool_content = cert_der[next_tlv.value_offset:next_tlv.value_end]
                if len(bool_content) != 1:
                    raise CertReject("BadDer", "Extension critical BOOLEAN not 1 byte")
                critical = bool_content[0] != 0
                e2 = _tlv_end(next_tlv)
                next_tlv = _read_tlv(cert_der, e2)
            if next_tlv.tag != 0x04:
                raise CertReject("BadDer", "Extension extnValue is not OCTET STRING")
            ext_value = cert_der[next_tlv.value_offset:next_tlv.value_end]

            if ext_oid in INTERLACE_KNOWN_OIDS:
                # Parse the inner DER per the OID's declared type.
                inner = _read_tlv(ext_value, 0)
                if ext_oid == OID_INTERLACE_EPOCH:
                    if inner.tag != 0x02:
                        raise CertReject("BadDer", "interlace-epoch inner is not INTEGER")
                    epoch = _decode_unsigned_integer_u32(
                        ext_value[inner.value_offset:inner.value_end]
                    )
                elif ext_oid == OID_INTERLACE_PEER:
                    if inner.tag != 0x0C:
                        raise CertReject("BadDer", "interlace-peer inner is not UTF8String")
                    peer_fp = ext_value[inner.value_offset:inner.value_end].decode("utf-8")
                elif ext_oid == OID_INTERLACE_SCOPE:
                    if inner.tag != 0x0C:
                        raise CertReject("BadDer", "interlace-scope inner is not UTF8String")
                    scope = ext_value[inner.value_offset:inner.value_end].decode("utf-8")
            else:
                if critical:
                    raise CertReject("UnknownCriticalExtension", ext_oid)
                # Non-critical unknown → ignore (RFC 5280 §4.2).

            e = _tlv_end(ext)

    return CertClaims(
        ephemeral_pubkey=ephemeral_pubkey,
        not_before=not_before,
        not_after=not_after,
        epoch=epoch,
        peer_fp=peer_fp,
        scope=scope,
    )


# ── Canonical claims JSON (§2.1) ───────────────────────────────────────

def claims_to_canonical_json(claims: CertClaims) -> str:
    """Serialize CertClaims to the canonical interop JSON form.

    Spec §2.1 form:
        {"epk":"<b64url-no-pad>","nb":<int>,"na":<int>[,"ep":<int>][,"pf":"..."][,"sc":"..."]}

    *Note on field order*: the spec README §1 ("canonical JSON: alphabetical
    keys") and §2.1 ("field order is fixed: epk, nb, na, ep, pf, sc") are
    inconsistent on field order, but the cert-vectors `expected_claims_json`
    field is unambiguous: keys appear in declaration order (epk, nb, na, ep,
    pf, sc), NOT in alphabetical order (which would be ep, epk, na, nb, pf,
    sc). The Rust reference impl in `rs/crates/sign/src/cert_chain.rs::claims_to_json`
    confirms declaration order. We follow the test vectors as the ground truth.

    Strings are escaped per RFC 8259 §7 (json.dumps default ensure_ascii=False
    plus separators=(',', ':')). The Rust impl uses a hand-rolled escape that
    matches Python's json.dumps for the test inputs.
    """
    # We build the string manually rather than json.dumps(dict, ...) because
    # we need to (a) preserve insertion order even though Python dict does
    # that since 3.7 — explicit is better — and (b) omit None-valued
    # optional fields rather than emit `null`.
    from .lease import b64url_encode

    parts: list[str] = [
        f'"epk":{json.dumps(b64url_encode(claims.ephemeral_pubkey))}',
        f'"nb":{claims.not_before}',
        f'"na":{claims.not_after}',
    ]
    if claims.epoch is not None:
        parts.append(f'"ep":{claims.epoch}')
    if claims.peer_fp is not None:
        parts.append(f'"pf":{json.dumps(claims.peer_fp, ensure_ascii=False)}')
    if claims.scope is not None:
        parts.append(f'"sc":{json.dumps(claims.scope, ensure_ascii=False)}')
    return "{" + ",".join(parts) + "}"


def cert_fingerprint(cert_der: bytes) -> str:
    """sha256_hex of cert DER. Used as `cert_fp` in §4.1 chain inputs
    and as the seen-nonces ledger key."""
    return hashlib.sha256(cert_der).hexdigest()
