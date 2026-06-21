# Conformance runner

Drives the Python reference implementation against the pinned vectors in
`../../test-vectors/`. A second implementation (TypeScript, Rust, Go,
...) is byte-conformant iff it produces every `expected_*` value in
those vectors from the same `inputs`.

## Run

```sh
cd cloister-spec/credential-isolation/v1/ref-impl-py
python3 conformance/run.py
```

(Stdlib-only — no `uv sync` / dependency install required. See
`../pyproject.toml` for why.)

## CI integration

Wired into `task verify` as `verify:cred-iso-conformance` per
`cloister-138082` (cred-iso audit R-3). Runs in the `verify` GitHub
Actions job alongside the Rust audit, capnp-roundtrip harness, and
cluster.toml drift gate. **No CI workflow change was needed:**

- `ubuntu-latest` (Ubuntu 24.04) ships `python3 ≥ 3.12` preinstalled,
  satisfying this package's `requires-python = ">=3.11"` declared in
  `../pyproject.toml`.
- Zero pip / uv installs — `dependencies = []` is load-bearing (see
  `../pyproject.toml` comment block); no dep cache to maintain.

A vector divergence in CI fails the verify job deterministically:
`run.py` exits 0 iff every assertion passes, and any divergence prints
the suite, label, expected vs actual bytes with full context.

## What's covered

| Suite | Vector file | Cases |
|---|---|---|
| injection-fixtures | `injection-fixtures.json` | All 5 strategies × happy-path |
| injection-collision | `injection-collision.json` | Skill-supplied field collides with vault injection — overwrite / append behavior pinned |
| proxy-envelope-canonical | `proxy-envelope-canonical.json` | Canonical request bytes + sha256 for 3 method+URL+body shapes |
| receipt-commitment | `receipt-commitment.json` | Canonical receipt input + sha256 digest |
| path-parsing | `path-parsing.json` | `/vault/proxy/<service>/<path>` split, accept + reject |
| error-responses | `error-responses.json` | Constant-time Shape R body bytes for 401 / 404 (allowedSubs-mismatch 403 collapsed to 404 per X-2 cycle, cloister-6eba0a) |
| reserved-response-headers | `reserved-response-headers.json` | Headers proxy MUST set/overwrite vs pass through |
| adversarial-malformed-envelope | `adversarial-malformed-envelope.json` | Reject malformed nonce / ts / sig / missing |
| adversarial-credential-leak | `adversarial-credential-leak.json` | Reject receipt rows that commit to credential / allowedSubs / body |
| adversarial-tamper-canonical | `adversarial-tamper-canonical.json` | Tampered canonical bytes / receipt fields → digest mismatch |

## What's NOT covered here

- **Ed25519 signature verification** — inherited from
  `interlace-spec/0.1.0/ref-impl-py/` byte-for-byte. credential-isolation
  /v1 does NOT re-specify the lease envelope; it only specifies what URL
  goes into the canonical bytes and what receipt fields commit. Sig-bytes
  vectors live in interlace-spec.
- **DER cert chain verification** — same reason. Use interlace-spec's
  `cert-vectors.json` for chain conformance.
- **Live cloister round-trip** — out of scope for the spec's ref-impl.
  See `recipes/credential-isolation/` (cloister-repo) for end-to-end
  operator runbooks against a running cluster.

## What a divergence means

If the Python impl passes and your impl fails: your impl is non-conformant.
Pull the failing vector's `inputs` block, reproduce locally, fix.

If the Python impl fails and your impl passes: file a bead. The Python
impl is the spec made operational; if it disagrees with the spec text,
one of the two is wrong, and the test corpus is what disambiguates.
**Do NOT auto-fix the Python to match a different impl** — the spec is
the contract.
