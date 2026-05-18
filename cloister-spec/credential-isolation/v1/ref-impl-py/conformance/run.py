#!/usr/bin/env python3
"""cloister/credential-isolation/v1 conformance suite — Python reference.

Loads every test-vector JSON under `cloister-spec/credential-isolation/v1/
test-vectors/` and asserts byte-equality of expected outputs between the
Python reference implementation and the pinned expected values.

Exit code is 0 iff every assertion passes. Any divergence is printed
with full context. A divergence between this Python impl and any other
implementation (TypeScript, Rust, Go, ...) is a finding worth a bead —
do NOT auto-fix the Python to match; the spec is the contract.
"""

from __future__ import annotations

import json
import sys
import traceback
from pathlib import Path

# Make `credisolation` package importable when run from package root.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from credisolation import envelope, injection, receipt, validate

VECTORS_DIR = Path(__file__).resolve().parent.parent.parent / "test-vectors"


# ── reporter ────────────────────────────────────────────────────────────


class Reporter:
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
        print("\ncloister/credential-isolation/v1 conformance suite — Python reference\n")
        total_pass = 0
        total_fail = 0
        for name, p, f, errs in self.suites:
            mark = "PASS" if f == 0 else "FAIL"
            print(f"[{mark}] {name:<36} ({p} passed, {f} failed)")
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


# ── 1. injection strategies (happy + collision) ─────────────────────────


def _run_injection_file(filename: str, suite_name: str) -> None:
    REPORT.start(suite_name)
    data = _load(filename)
    for v in data["vectors"]:
        label = f"{v['strategy']}: {v['name']}"
        ins = v["inputs"]
        req = injection.SkillRequest(
            method=ins["skill_request"]["method"],
            upstream_path=ins["skill_request"]["upstream_path"],
            query=ins["skill_request"].get("query", ""),
            headers=dict(ins["skill_request"]["headers"]),
            body=ins["skill_request"].get("body", ""),
        )
        fn = injection.STRATEGY_DISPATCH[v["strategy"]]
        kwargs = dict(ins.get("strategy_params", {}))
        try:
            out = fn(req, ins["credential"], ins["upstream_base"], **kwargs)
        except Exception as e:  # noqa: BLE001
            REPORT.failed(label, f"injection raised: {type(e).__name__}: {e}")
            continue
        exp = v["expected_upstream_request"]
        if out.method != exp["method"]:
            REPORT.failed(label, f"method {out.method!r} != {exp['method']!r}")
            continue
        if out.url != exp["url"]:
            REPORT.failed(
                label,
                f"url mismatch\n            expected {exp['url']}\n            actual   {out.url}",
            )
            continue
        if out.headers != exp["headers"]:
            REPORT.failed(
                label,
                f"headers mismatch\n            expected {exp['headers']}\n            actual   {out.headers}",
            )
            continue
        if out.body != exp["body"]:
            REPORT.failed(
                label,
                f"body mismatch\n            expected {exp['body']!r}\n            actual   {out.body!r}",
            )
            continue
        REPORT.passed(label)
    REPORT.finish()


def run_injection_fixtures() -> None:
    _run_injection_file("injection-fixtures.json", "injection-fixtures")


def run_injection_collision() -> None:
    _run_injection_file("injection-collision.json", "injection-collision")


# ── 2. proxy envelope canonical bytes ───────────────────────────────────


def run_proxy_envelope_canonical() -> None:
    REPORT.start("proxy-envelope-canonical")
    data = _load("proxy-envelope-canonical.json")
    for v in data["vectors"]:
        label = v["name"]
        ins = v["inputs"]
        canonical = envelope.canonical_request_bytes(
            ins["method"],
            ins["url"],
            ins["ts_ms"],
            ins["nonce_b64url_no_pad"],
            ins["body"],
        )
        if canonical.hex() != v["expected_canonical_bytes_hex"]:
            REPORT.failed(
                label,
                f"canonical hex mismatch\n            expected {v['expected_canonical_bytes_hex']}\n            actual   {canonical.hex()}",
            )
            continue
        if len(canonical) != v["expected_canonical_bytes_len"]:
            REPORT.failed(
                label,
                f"canonical len {len(canonical)} != {v['expected_canonical_bytes_len']}",
            )
            continue
        sha = envelope.canonical_request_sha256_hex(
            ins["method"], ins["url"], ins["ts_ms"], ins["nonce_b64url_no_pad"], ins["body"],
        )
        if sha != v["expected_canonical_bytes_sha256_hex"]:
            REPORT.failed(
                label,
                f"sha256 mismatch\n            expected {v['expected_canonical_bytes_sha256_hex']}\n            actual   {sha}",
            )
            continue
        REPORT.passed(label)
    REPORT.finish()


# ── 3. receipt commitment ───────────────────────────────────────────────


def run_receipt_commitment() -> None:
    REPORT.start("receipt-commitment")
    data = _load("receipt-commitment.json")
    for v in data["vectors"]:
        label = v["name"]
        r = receipt.ReceiptFields(**v["inputs"])
        ci = receipt.build_receipt_input(r)
        if ci.hex() != v["expected_canonical_input_hex"]:
            REPORT.failed(
                label,
                f"canonical input hex mismatch\n            expected {v['expected_canonical_input_hex']}\n            actual   {ci.hex()}",
            )
            continue
        if len(ci) != v["expected_canonical_input_len"]:
            REPORT.failed(label, f"canonical len {len(ci)} != {v['expected_canonical_input_len']}")
            continue
        d = receipt.receipt_digest_hex(r)
        if d != v["expected_digest_sha256_hex"]:
            REPORT.failed(
                label,
                f"digest mismatch\n            expected {v['expected_digest_sha256_hex']}\n            actual   {d}",
            )
            continue
        REPORT.passed(label)
    REPORT.finish()


# ── 4. adversarial: malformed envelope ──────────────────────────────────


def run_adversarial_malformed_envelope() -> None:
    REPORT.start("adversarial-malformed-envelope")
    data = _load("adversarial-malformed-envelope.json")
    for v in data["vectors"]:
        label = v["name"]
        try:
            validate.validate_request_envelope(v["inputs"]["headers"])
        except validate.EnvelopeReject as e:
            if v["expected_reject_kind"] != e.kind:
                REPORT.failed(
                    label,
                    f"reject kind mismatch: expected {v['expected_reject_kind']!r}, got {e.kind!r} ({e.detail})",
                )
                continue
            REPORT.passed(label)
            continue
        # Validation accepted — that's a fail for adversarial vectors.
        REPORT.failed(label, "envelope was accepted but should have been rejected")
    REPORT.finish()


# ── 5. adversarial: credential leak in receipt ──────────────────────────


def run_adversarial_credential_leak() -> None:
    REPORT.start("adversarial-credential-leak")
    data = _load("adversarial-credential-leak.json")
    for v in data["vectors"]:
        label = v["name"]
        try:
            receipt.assert_no_forbidden_fields(v["inputs"]["receipt_row"])
        except ValueError as e:
            if v["expected_reject_kind"] != "forbidden_field":
                REPORT.failed(label, f"unexpected reject: {e}")
                continue
            if v["expected_forbidden_field"] not in str(e):
                REPORT.failed(
                    label,
                    f"forbidden field {v['expected_forbidden_field']!r} not in message: {e}",
                )
                continue
            REPORT.passed(label)
            continue
        REPORT.failed(label, "receipt row accepted but should have been rejected")
    REPORT.finish()


# ── 6. adversarial: tampered canonical input ────────────────────────────


def run_adversarial_tamper_canonical() -> None:
    REPORT.start("adversarial-tamper-canonical")
    data = _load("adversarial-tamper-canonical.json")
    for v in data["vectors"]:
        label = v["name"]
        ins = v["inputs"]
        if v["kind"] == "envelope":
            actual = envelope.canonical_request_sha256_hex(
                ins["method"], ins["url"], ins["ts_ms"],
                ins["nonce_b64url_no_pad"], ins["body"],
            )
        elif v["kind"] == "receipt":
            actual = receipt.receipt_digest_hex(receipt.ReceiptFields(**ins["receipt_fields"]))
        else:
            REPORT.failed(label, f"unknown adversarial kind {v['kind']!r}")
            continue
        # Adversarial: claimed_digest is the WRONG digest someone might
        # post. Conformance is "actual != claimed".
        if actual == v["claimed_digest_sha256_hex"]:
            REPORT.failed(
                label,
                f"digest collision with tampered claim: {actual} == {v['claimed_digest_sha256_hex']}",
            )
            continue
        if actual != v["expected_correct_digest_sha256_hex"]:
            REPORT.failed(
                label,
                f"correct digest mismatch\n            expected {v['expected_correct_digest_sha256_hex']}\n            actual   {actual}",
            )
            continue
        REPORT.passed(label)
    REPORT.finish()


# ── 7. path parsing (positive + reject) ─────────────────────────────────


def run_path_parsing() -> None:
    REPORT.start("path-parsing")
    data = _load("path-parsing.json")
    for v in data["vectors"]:
        label = v["name"]
        ins = v["inputs"]
        try:
            service, upstream = validate.parse_vault_proxy_path(ins["path"])
        except validate.EnvelopeReject as e:
            if v["expected_result"] != "reject":
                REPORT.failed(label, f"unexpected reject: {e}")
                continue
            if v["expected_reject_kind"] != e.kind:
                REPORT.failed(label, f"kind mismatch: expected {v['expected_reject_kind']}, got {e.kind}")
                continue
            REPORT.passed(label)
            continue
        if v["expected_result"] != "ok":
            REPORT.failed(label, "path accepted but should have been rejected")
            continue
        if service != v["expected_service"] or upstream != v["expected_upstream_path"]:
            REPORT.failed(
                label,
                f"parse mismatch: ({service!r},{upstream!r}) != ({v['expected_service']!r},{v['expected_upstream_path']!r})",
            )
            continue
        REPORT.passed(label)
    REPORT.finish()


# ── 8. error responses (byte-equal body shape) ──────────────────────────


def run_error_responses() -> None:
    import hashlib
    REPORT.start("error-responses")
    data = _load("error-responses.json")
    for v in data["vectors"]:
        label = v["name"]
        body = v["expected_body"]
        sha = hashlib.sha256(body.encode("utf-8")).hexdigest()
        if sha != v["expected_body_sha256_hex"]:
            REPORT.failed(
                label,
                f"body sha mismatch\n            expected {v['expected_body_sha256_hex']}\n            actual   {sha}",
            )
            continue
        REPORT.passed(label)
    REPORT.finish()


# ── 9. reserved response headers (static consistency) ───────────────────


def run_reserved_response_headers() -> None:
    REPORT.start("reserved-response-headers")
    data = _load("reserved-response-headers.json")
    for v in data["vectors"]:
        label = v["name"]
        if v["name"] == "reserved_set_canonical":
            expected_set = set(v["expected_reserved_response_headers_lowercase"])
            actual_set = set(envelope.RESERVED_RESPONSE_HEADERS)
            if expected_set != actual_set:
                REPORT.failed(
                    label,
                    f"reserved-set mismatch: expected {sorted(expected_set)}, got {sorted(actual_set)}",
                )
                continue
            if v["expected_server_header_value"] != receipt.CAPABILITY_TAG:
                REPORT.failed(
                    label,
                    f"Server header value mismatch: expected {v['expected_server_header_value']!r}, "
                    f"got {receipt.CAPABILITY_TAG!r}",
                )
                continue
            REPORT.passed(label)
        elif v["name"] == "pass_through_other_headers":
            # Structural: the expected output should contain every upstream
            # header verbatim EXCEPT for those in RESERVED_RESPONSE_HEADERS,
            # which get overwritten / set by the proxy.
            upstream = v["inputs"]["upstream_response_headers"]
            expected = v["expected_proxy_response_headers"]
            ok = True
            for k, val in upstream.items():
                if k.lower() in envelope.RESERVED_RESPONSE_HEADERS:
                    # Reserved: expected proxy value differs
                    if expected.get(k) == val:
                        REPORT.failed(
                            label,
                            f"reserved header {k} passed through unchanged: {val!r}",
                        )
                        ok = False
                        break
                else:
                    # Non-reserved: must pass through verbatim
                    if expected.get(k) != val:
                        REPORT.failed(
                            label,
                            f"header {k} mutated: expected pass-through {val!r}, got {expected.get(k)!r}",
                        )
                        ok = False
                        break
            if ok:
                REPORT.passed(label)
        else:
            REPORT.failed(label, "unknown vector name in reserved-response-headers.json")
    REPORT.finish()


# ── main ────────────────────────────────────────────────────────────────


def main() -> None:
    try:
        run_injection_fixtures()
        run_injection_collision()
        run_proxy_envelope_canonical()
        run_receipt_commitment()
        run_path_parsing()
        run_error_responses()
        run_reserved_response_headers()
        run_adversarial_malformed_envelope()
        run_adversarial_credential_leak()
        run_adversarial_tamper_canonical()
    except Exception:  # noqa: BLE001 — top-level safety net
        traceback.print_exc()
        sys.exit(2)
    REPORT.summary_and_exit()


if __name__ == "__main__":
    main()
