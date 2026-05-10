# Interlace v0.1.0 — Python conformance suite

This directory runs every fixed test vector under
`interlace-spec/0.1.0/test-vectors/` through the sibling `interlace/`
Python package and asserts byte-equality against the pinned expected
values. A green run means the Python implementation reproduces the
same canonical bytes, digests, and signatures as cloister (the
TypeScript reference) at every signed surface.

## Running

```sh
cd interlace-spec/0.1.0/ref-impl-py
python3 -m venv .venv
source .venv/bin/activate
pip install -e .                  # installs cryptography + cbor2
python conformance/run.py
```

Python 3.11 or newer is required.

## Expected output

```
Interlace v0.1.0 conformance suite — Python reference

[PASS] lease-counter          (4 passed, 0 failed)
[PASS] ca-bundle              (2 passed, 0 failed)
[PASS] cert-vectors           (7 passed, 0 failed)
[PASS] lease-envelope         (4 passed, 0 failed)
[PASS] peer-attestation       (3 passed, 0 failed)
[PASS] disclosure             (7 passed, 0 failed)

All 27 test vector cases passed.
```

Exit code: 0 on full pass, 1 on any divergence, 2 on harness exception.

## What each suite asserts

### lease-counter (4 cases)
Spec §4.1. For each of three steps (genesis + two follow-ons) the
runner recomputes `sha256_hex(UTF8(prev || cert_fp || nonce || ts))`
with NO separators and asserts the digest matches the vector's
`expected_last_chain_hash`. A fourth "replay" case walks all three
steps end-to-end from `ZERO_HASH` and confirms the terminal hash.

The "no separators" rule is load-bearing (threat-model §7.7.a):
inserting a delimiter looks indistinguishable from cluster-side §13.2
misbehavior. The conformance check is what makes this falsifiable
across implementations.

### ca-bundle (2 cases)
Spec §1.3. The bundle's canonical signing input is RFC 8949
deterministic CBOR. The runner re-encodes a two-key (rotation window)
bundle and a single-key (steady state) bundle through `cbor2.dumps(...,
canonical=True)` and asserts both the canonical byte hex and the
sha256 of those bytes match.

### cert-vectors (7 cases)
Spec §2 + `wire/cert-extensions.md`. Mix of accept/reject cases:

| Case | Outcome |
|---|---|
| `cert_full` | accept; pin claims + canonical claims JSON + cert_fp |
| `cert_minimal` | accept; no extensions, claims have None for ep/pf/sc |
| `cert_wrong_master` | reject as `BadSignature` |
| `cert_critical_unknown_ext` | reject as `UnknownCriticalExtension` (RFC 5280 §4.2) |
| `cert_noncritical_unknown_ext` | accept; non-critical unknown is ignored |
| `verify_truncated_cert` | reject as `BadDer` |
| `verify_wrong_master_key_length` | reject as `BadMasterKey` |

The cert verifier is hand-rolled DER (`interlace/cert.py`) rather than
`cryptography.x509`, so the critical-flag rejection rule is explicit at
every byte (and `tbs_certificate` slicing is byte-exact, per spec §2
step 3's ban on re-encoding from a parsed structure).

### lease-envelope (4 cases)
Spec §3.2. For three POST cases and one GET-with-empty-body case the
runner builds the canonical bytes `<method>\n<url>\n<ts>\n<nonce>\n<body>`
and (a) asserts the bytes match the pinned hex + length + sha256 (POST
cases) and (b) signs them with the fixture's ephemeral private seed and
asserts the resulting Ed25519 signature matches the pinned
`expected_signature_b64url_no_pad`. Ed25519 is deterministic per RFC
8032, so byte-equal canonical input + byte-equal key → byte-equal sig.

### peer-attestation (3 cases)
Spec §4.2. The runner walks the three-row test chain and asserts
per-peer link integrity: genesis has `prev_self_ref = null`, follow-on
rows have `prev_self_ref == previous_row.content_hash`, all rows share
one `peer_fingerprint`, `seq` is monotonic. Byte-exact `sig` validation
needs an Ed25519 signing oracle which the vectors elide; the
conformance suite asserts chain *layout* not signature bytes.

### disclosure (7 cases)
Spec §5. The runner:
- validates the shape of one header, two attestation, and one pending
  record from `disclosure.json::success_response`,
- asserts the constant-time 404 error body is exactly 256 ASCII `'0'`
  bytes,
- round-trips a cursor through `encode_cursor` → `verify_cursor` with a
  fresh HMAC key,
- confirms tamper-detection rejects a single-character bit-flip in the
  HMAC segment.

## What divergence looks like

If a test fails the runner prints both `expected` and `actual` values
inline. Sample divergence (synthetic):

```
[FAIL] lease-counter          (3 passed, 1 failed)
        ! seq=1 genesis: chain-hash mismatch
            expected 549167a8c86aa0ea24bb14a968784a5b15bdb7d9f63dca16a55746fee205df64
            actual   ba4ec0aa1d3afe5b2d99027d44823f5e6113dee5c8a7b3a1f25f5f9d4cd92c1e
```

A divergence between cloister and this Python implementation is a
*finding*, not a bug to silently paper over. Treatment:

1. Pin the suspect inputs in a fresh bead.
2. Check the spec wording — is the rule unambiguous?
3. Check both implementations' code against the spec.
4. The implementation that diverges from the spec is wrong; if BOTH
   implementations match each other but disagree with the spec, the
   spec is wrong (file a v0.1.x errata).

Do NOT adjust the Python implementation to "match" cloister by edit;
the whole point of having a second implementation is that they cross-
falsify the spec. If you change the Python so it agrees with cloister
without understanding why, you've thrown away the falsifiability.

## Dependencies

- Python 3.11+ (uses PEP 604 `X | Y` type syntax inline).
- `cryptography>=42` for Ed25519 sign/verify and SHA-256/HMAC. The
  stdlib `hashlib` covers SHA-256/HMAC directly; we use it where
  possible.
- `cbor2>=5.4` for RFC 8949 deterministic CBOR encoding. The stdlib
  has no CBOR module, hence this dependency.

No other runtime deps. The conformance runner has no test framework —
it's a single Python script with hand-rolled pass/fail tracking, so the
output is deterministic and easy to diff in CI.
