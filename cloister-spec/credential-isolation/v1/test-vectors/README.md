# `credential-isolation/v1` test vectors

Canonical inputs + expected digests. A second implementation
(TypeScript, Rust, Go, ...) is byte-compatible iff it reproduces every
`expected_*` value from the `inputs` in this directory.

This corpus is the operational form of ADR-0024's `## Conformance`
section. The spec text is the contract; the vectors are the spec text
made falsifiable.

## File map

| File | Covers | Cases |
|---|---|---|
| [`injection-fixtures.json`](injection-fixtures.json) | All 5 injection strategies (`authorizationBearer`, `authorizationBasic`, `headerNamed`, `queryParam`, `bodyField`). Each case fixes (skill request, credential, upstream base, strategy params) and pins the byte-exact upstream request the proxy MUST produce. | 5 |
| [`injection-collision.json`](injection-collision.json) | Skill-supplied field collides with vault injection. Header/body strategies OVERWRITE; query-param APPENDS. Behavior is intentional and pinned. | 3 |
| [`proxy-envelope-canonical.json`](proxy-envelope-canonical.json) | The canonical request bytes that go into `Interlace-Sig` (per `wire/proxy-envelope.md` §"Request canonicalization"). URL is the cloister-router path, NOT the upstream URL. | 3 |
| [`receipt-commitment.json`](receipt-commitment.json) | The canonical bytes that get hashed into a receipt commitment + the sha256 digest. The capability tag `cloister/credential-isolation/v1` is the first field — domain-separation guarantee. | 3 |
| [`path-parsing.json`](path-parsing.json) | `/vault/proxy/<service>/<path>` parse — accept good shapes, reject bad ones. The 404-vs-400 boundary lives here. | 4 |
| [`error-responses.json`](error-responses.json) | Constant-time-shape 401 / 403 / 404 body bytes. Per spec, 401 and 404 are byte-equal; 403 has its own (distinct) body. | 3 |
| [`reserved-response-headers.json`](reserved-response-headers.json) | Two headers the proxy MUST set/overwrite on its OWN response (`Interlace-Receipt`, `Server`); all other upstream headers pass through unchanged. | 2 |
| [`adversarial-malformed-envelope.json`](adversarial-malformed-envelope.json) | Reject malformed lease envelopes — missing required header, malformed nonce / timestamp / signature. Tests the spec's pre-signature parse path. | 4 |
| [`adversarial-credential-leak.json`](adversarial-credential-leak.json) | Reject receipt rows that commit to forbidden fields per README §"MUST NOT commit (security-load-bearing)" — credential value, `allowedSubs`, request/response body, query, KEK source. | 5 |
| [`adversarial-tamper-canonical.json`](adversarial-tamper-canonical.json) | Tampered canonical bytes / tampered receipt fields produce a different digest than the attacker claims — the spec's "byte-equality is the defense" property. | 2 |

**Total:** 10 JSON vector files. 34 distinct cases.

## Adversarial coverage (3 of 10 files; 11 of 34 cases)

- `adversarial-malformed-envelope.json` — pre-signature parse rejections
- `adversarial-credential-leak.json` — MUST-NOT-COMMIT field enforcement
- `adversarial-tamper-canonical.json` — byte-equality defense (claimed
  digest must equal actual digest; tampering trips the check)

## Vector-file conventions

- Top-level keys: `$comment` (string, human-only), `version` (must match
  spec version), `vectors` (list of cases).
- Each case has: `name`, `description`, `inputs`, and one or more
  `expected_*` fields.
- Adversarial cases additionally have an `expected_reject_kind` plus
  enough detail to make the rejection check unambiguous.
- Bytes are pinned as lowercase hex. JSON-serialized payloads pin both
  the hex AND the human-readable form when both are useful.

## Cryptography references

- SHA-256: [FIPS 180-4](https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.180-4.pdf).
- HMAC-SHA256: [RFC 2104](https://www.rfc-editor.org/rfc/rfc2104).
- base64url: [RFC 4648 §5](https://www.rfc-editor.org/rfc/rfc4648#section-5).
- base64 (standard): [RFC 4648 §4](https://www.rfc-editor.org/rfc/rfc4648#section-4).
- Basic auth: [RFC 7617](https://www.rfc-editor.org/rfc/rfc7617).
- application/x-www-form-urlencoded: [WHATWG URL](https://url.spec.whatwg.org/#urlencoded-serializing).
- Ed25519: [RFC 8032](https://www.rfc-editor.org/rfc/rfc8032) — inherited
  from `interlace-spec/0.1.0/`.

## Fake-credential pinning

Every credential value in these vectors is `FAKE` / `FAKEDEMO` /
`s3cr3t-pass-FAKE` shaped. None match the pattern of any real key.
Pre-commit secret scanners that flag this corpus are over-fitting —
file a bead, don't hand-replace with longer fake strings.
