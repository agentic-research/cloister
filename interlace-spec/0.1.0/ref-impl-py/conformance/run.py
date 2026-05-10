#!/usr/bin/env python3
"""Interlace v0.1.0 conformance suite — Python reference.

Loads every test-vector JSON under `interlace-spec/0.1.0/test-vectors/`
and asserts byte-equality of digests / canonical bytes / signatures
between our Python implementation and the pinned expected values.

Exit code is 0 iff every assertion passes. Any divergence is printed
with full context (vector name, expected, actual). A divergence between
this Python impl and cloister-the-TS-impl is a finding worth a bead —
do NOT auto-fix the Python to match cloister; the spec is the contract.
"""

from __future__ import annotations

import base64
import json
import sys
import traceback
from pathlib import Path

# Make `interlace` package importable when run from the package root.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from interlace import bundle as bundle_mod
from interlace import cert as cert_mod
from interlace import chain as chain_mod
from interlace import disclosure as disclosure_mod
from interlace import lease as lease_mod

VECTORS_DIR = Path(__file__).resolve().parent.parent.parent / "test-vectors"


# ── small CLI niceties ───────────────────────────────────────────────────

class Reporter:
    """Tracks per-suite pass/fail counts and prints a tidy summary."""

    def __init__(self) -> None:
        self.suites: list[tuple[str, int, int, list[str]]] = []
        self._current: tuple[str, int, int, list[str]] | None = None

    def start(self, name: str) -> None:
        self._current = (name, 0, 0, [])

    def passed(self, _label: str = "") -> None:
        assert self._current is not None
        n, p, f, errs = self._current
        self._current = (n, p + 1, f, errs)

    def failed(self, label: str, message: str) -> None:
        assert self._current is not None
        n, p, f, errs = self._current
        errs.append(f"{label}: {message}")
        self._current = (n, p, f + 1, errs)

    def finish(self) -> None:
        assert self._current is not None
        self.suites.append(self._current)
        self._current = None

    def summary_and_exit(self) -> None:
        print("\nInterlace v0.1.0 conformance suite — Python reference\n")
        total_pass = 0
        total_fail = 0
        for name, p, f, errs in self.suites:
            mark = "PASS" if f == 0 else "FAIL"
            print(f"[{mark}] {name:<22} ({p} passed, {f} failed)")
            for e in errs:
                print(f"        ! {e}")
            total_pass += p
            total_fail += f
        print()
        if total_fail == 0:
            print(f"All {total_pass} test vector cases passed.")
            sys.exit(0)
        else:
            print(f"{total_fail} of {total_pass + total_fail} cases FAILED.")
            sys.exit(1)


REPORT = Reporter()


def _load(name: str) -> dict:
    return json.loads((VECTORS_DIR / name).read_text())


# ── 1. lease-counter chain ──────────────────────────────────────────────

def run_lease_counter() -> None:
    REPORT.start("lease-counter")
    data = _load("lease-counter.json")
    cert_fp = data["fixed_inputs"]["cert_fp_sha256_hex"]

    # Walk each step independently AND replay end-to-end.
    for v in data["vectors"]:
        label = f"seq={v['seq']} {v['name']}"
        ins = v["inputs"]
        actual = lease_mod.next_chain_hash(
            ins["prev_chain_hash"],
            ins["cert_fp"],
            ins["nonce_b64"],
            ins["ts_ms"],
        )
        if actual != v["expected_last_chain_hash"]:
            REPORT.failed(
                label,
                f"chain-hash mismatch\n            expected {v['expected_last_chain_hash']}\n            actual   {actual}",
            )
            continue
        if ins["cert_fp"] != cert_fp:
            REPORT.failed(label, f"vector cert_fp != fixed_inputs cert_fp")
            continue
        REPORT.passed(label)

    # Sanity: replay the whole chain from genesis and confirm last hash.
    observations = [(v["inputs"]["nonce_b64"], v["inputs"]["ts_ms"]) for v in data["vectors"]]
    steps = lease_mod.replay_chain(cert_fp, observations)
    expected_terminal = data["vectors"][-1]["expected_last_chain_hash"]
    if steps[-1].last_chain_hash == expected_terminal:
        REPORT.passed("replay end-to-end")
    else:
        REPORT.failed(
            "replay end-to-end",
            f"terminal hash mismatch\n            expected {expected_terminal}\n            actual   {steps[-1].last_chain_hash}",
        )

    REPORT.finish()


# ── 2. CA bundle canonical CBOR ─────────────────────────────────────────

def run_ca_bundle() -> None:
    REPORT.start("ca-bundle")
    import hashlib
    data = _load("ca-bundle.json")
    for v in data["vectors"]:
        label = v["name"]
        b = bundle_mod.parse_test_vector_bundle(v["inputs"])
        canonical = bundle_mod.bundle_canonical(b)
        canonical_hex = canonical.hex()
        if canonical_hex != v["expected_cbor_canonical_hex"]:
            REPORT.failed(
                label,
                f"CBOR canonical bytes mismatch\n            expected {v['expected_cbor_canonical_hex']}\n            actual   {canonical_hex}",
            )
            continue
        if len(canonical) != v["expected_cbor_canonical_len"]:
            REPORT.failed(label, f"canonical len {len(canonical)} != {v['expected_cbor_canonical_len']}")
            continue
        sha = hashlib.sha256(canonical).hexdigest()
        if sha != v["expected_cbor_canonical_sha256_hex"]:
            REPORT.failed(
                label,
                f"CBOR sha256 mismatch\n            expected {v['expected_cbor_canonical_sha256_hex']}\n            actual   {sha}",
            )
            continue
        REPORT.passed(label)
    REPORT.finish()


# ── 3. cert vectors ─────────────────────────────────────────────────────

def run_cert_vectors() -> None:
    REPORT.start("cert-vectors")
    data = _load("cert-vectors.json")
    master_b64u = data["fixed_inputs"]["master_pubkey_b64url_no_pad"]
    master_pubkey = lease_mod.b64url_decode(master_b64u)

    # cert_minimal is referenced by name from verify_truncated_cert; build a lookup.
    name_to_cert: dict[str, bytes] = {}
    for v in data["vectors"]:
        if "input_cert_b64url_no_pad" in v:
            name_to_cert[v["name"]] = lease_mod.b64url_decode(v["input_cert_b64url_no_pad"])

    for v in data["vectors"]:
        label = v["name"]

        # Figure out the cert + master inputs for this vector.
        if "input_cert_b64url_no_pad_first_half_of" in v:
            base = name_to_cert[v["input_cert_b64url_no_pad_first_half_of"]]
            cert_der = base[: len(base) // 2]
            this_master = master_pubkey
        elif "input_master_pubkey_byte_length" in v:
            cert_der = b""  # unused — should fail at master-key length check
            this_master = master_pubkey[: int(v["input_master_pubkey_byte_length"])]
        else:
            cert_der = name_to_cert[v["name"]]
            this_master = master_pubkey

        try:
            claims = cert_mod.verify_cert(cert_der, this_master)
        except cert_mod.CertReject as e:
            if v["expected_verify_result"] != "reject":
                REPORT.failed(label, f"unexpected reject: {e}")
                continue
            if v["expected_reject_kind"] != e.kind:
                REPORT.failed(
                    label,
                    f"reject kind mismatch: expected {v['expected_reject_kind']}, got {e.kind} ({e.detail})",
                )
                continue
            REPORT.passed(label)
            continue
        except Exception as e:  # noqa: BLE001
            REPORT.failed(label, f"verify threw non-CertReject: {type(e).__name__}: {e}")
            continue

        if v["expected_verify_result"] != "ok":
            REPORT.failed(label, "verify accepted when it should have rejected")
            continue

        ec = v["expected_claims"]
        ephemeral_b64u = lease_mod.b64url_encode(claims.ephemeral_pubkey)
        if ephemeral_b64u != ec["ephemeral_pubkey_b64url_no_pad"]:
            REPORT.failed(label, f"ephemeral pubkey mismatch: {ephemeral_b64u} != {ec['ephemeral_pubkey_b64url_no_pad']}")
            continue
        if claims.not_before != ec["not_before"]:
            REPORT.failed(label, f"not_before {claims.not_before} != {ec['not_before']}")
            continue
        if claims.not_after != ec["not_after"]:
            REPORT.failed(label, f"not_after {claims.not_after} != {ec['not_after']}")
            continue
        if claims.epoch != ec["epoch"]:
            REPORT.failed(label, f"epoch {claims.epoch} != {ec['epoch']}")
            continue
        if claims.peer_fp != ec["peer_fp"]:
            REPORT.failed(label, f"peer_fp {claims.peer_fp!r} != {ec['peer_fp']!r}")
            continue
        if claims.scope != ec["scope"]:
            REPORT.failed(label, f"scope {claims.scope!r} != {ec['scope']!r}")
            continue

        # Canonical claims JSON, if pinned.
        if "expected_claims_json" in v:
            actual_json = cert_mod.claims_to_canonical_json(claims)
            if actual_json != v["expected_claims_json"]:
                REPORT.failed(
                    label,
                    f"canonical claims JSON mismatch\n            expected {v['expected_claims_json']}\n            actual   {actual_json}",
                )
                continue

        # cert_fp, if pinned.
        if "expected_cert_fp_sha256_hex" in v:
            actual_fp = cert_mod.cert_fingerprint(cert_der)
            if actual_fp != v["expected_cert_fp_sha256_hex"]:
                REPORT.failed(
                    label,
                    f"cert_fp mismatch\n            expected {v['expected_cert_fp_sha256_hex']}\n            actual   {actual_fp}",
                )
                continue

        REPORT.passed(label)
    REPORT.finish()


# ── 4. lease envelope ───────────────────────────────────────────────────

def run_lease_envelope() -> None:
    REPORT.start("lease-envelope")
    import hashlib
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    data = _load("lease-envelope.json")

    seed_b64u = data["shared"]["ephemeral_priv_seed_b64url_no_pad"]
    seed = lease_mod.b64url_decode(seed_b64u)
    priv = Ed25519PrivateKey.from_private_bytes(seed)

    for v in data["vectors"]:
        label = v["name"]
        ins = v["inputs"]
        canonical = lease_mod.canonical_request_bytes(
            ins["method"],
            ins["url"],
            ins["ts_ms"],
            ins["nonce_b64url_no_pad"],
            ins["body"],
        )

        # Pin canonical_bytes_hex + canonical_bytes_sha256_hex when present.
        if "expected_canonical_bytes_hex" in v:
            if canonical.hex() != v["expected_canonical_bytes_hex"]:
                REPORT.failed(
                    label,
                    f"canonical bytes mismatch\n            expected {v['expected_canonical_bytes_hex']}\n            actual   {canonical.hex()}",
                )
                continue
            if len(canonical) != v["expected_canonical_bytes_len"]:
                REPORT.failed(label, f"canonical len {len(canonical)} != {v['expected_canonical_bytes_len']}")
                continue
            sha = hashlib.sha256(canonical).hexdigest()
            if sha != v["expected_canonical_bytes_sha256_hex"]:
                REPORT.failed(
                    label,
                    f"canonical sha256 mismatch\n            expected {v['expected_canonical_bytes_sha256_hex']}\n            actual   {sha}",
                )
                continue

        # Reproduce signature: Ed25519 signing is deterministic (RFC 8032).
        if "expected_signature_b64url_no_pad" in v:
            sig = priv.sign(canonical)
            sig_b64u = lease_mod.b64url_encode(sig)
            if sig_b64u != v["expected_signature_b64url_no_pad"]:
                REPORT.failed(
                    label,
                    f"signature mismatch\n            expected {v['expected_signature_b64url_no_pad']}\n            actual   {sig_b64u}",
                )
                continue

        REPORT.passed(label)
    REPORT.finish()


# ── 5. peer attestation chain ───────────────────────────────────────────

def run_peer_attestation() -> None:
    REPORT.start("peer-attestation")
    data = _load("peer-attestation.json")
    rows = chain_mod.parse_test_vector_chain(data["chain"])
    try:
        chain_mod.validate_chain(rows)
        # Walk each step and report individually.
        for i, r in enumerate(rows):
            label = f"seq={r.seq} {data['chain'][i]['name']}"
            REPORT.passed(label)
    except chain_mod.ChainIntegrityError as e:
        REPORT.failed("chain integrity", str(e))
    REPORT.finish()


# ── 6. disclosure JSONL ─────────────────────────────────────────────────

def run_disclosure() -> None:
    REPORT.start("disclosure")
    data = _load("disclosure.json")
    success = data["success_response"]["body_lines"]
    for i, line in enumerate(success):
        label = f"line[{i}] type={line.get('type')!r}"
        try:
            disclosure_mod.validate_line_shape(line)
            REPORT.passed(label)
        except ValueError as e:
            REPORT.failed(label, str(e))

    # Constant-time error body shape check.
    cte = data["constant_time_error_response"]
    expected_prefix = cte["expected_body_hex_prefix"]
    actual_prefix = disclosure_mod.CONSTANT_TIME_ERROR_BODY[: len(expected_prefix) // 2].hex()
    if actual_prefix != expected_prefix:
        REPORT.failed("constant-time error body", f"prefix mismatch ({actual_prefix} != {expected_prefix})")
    elif len(disclosure_mod.CONSTANT_TIME_ERROR_BODY) != cte["body_length_bytes"]:
        REPORT.failed("constant-time error body", f"length {len(disclosure_mod.CONSTANT_TIME_ERROR_BODY)} != {cte['body_length_bytes']}")
    else:
        REPORT.passed("constant-time error body")

    # Cursor round-trip: encode and verify against a synthetic key.
    payload = disclosure_mod.CursorPayload(
        from_seq=101,
        peer_fp="sha256:abc123def456",
        ts=1700001000000,
    )
    key = b"k" * 32
    token = disclosure_mod.encode_cursor(payload, key)
    try:
        decoded = disclosure_mod.verify_cursor(token, key, expected_peer_fp=payload.peer_fp)
        if decoded == payload:
            REPORT.passed("cursor encode/decode roundtrip")
        else:
            REPORT.failed("cursor encode/decode roundtrip", f"decoded {decoded} != original {payload}")
    except Exception as e:  # noqa: BLE001
        REPORT.failed("cursor encode/decode roundtrip", str(e))

    # Cursor tamper detection.
    tampered = token[:-4] + ("A" if token[-4:-3] != "A" else "B") + token[-3:]
    try:
        disclosure_mod.verify_cursor(tampered, key, expected_peer_fp=payload.peer_fp)
        REPORT.failed("cursor tamper detection", "tampered token verified successfully")
    except ValueError:
        REPORT.passed("cursor tamper detection")

    REPORT.finish()


# ── main ────────────────────────────────────────────────────────────────

def main() -> None:
    try:
        run_lease_counter()
        run_ca_bundle()
        run_cert_vectors()
        run_lease_envelope()
        run_peer_attestation()
        run_disclosure()
    except Exception:  # noqa: BLE001 — top-level safety net
        traceback.print_exc()
        sys.exit(2)
    REPORT.summary_and_exit()


if __name__ == "__main__":
    main()
