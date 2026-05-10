# Wire: Interlace cert extensions

All three extensions live under the cloister private-enterprise OID arc
`1.3.6.1.4.1.99999.1.*`. They are stored as `Extension` entries inside
the X.509 `tbs_certificate.extensions` SEQUENCE.

## OID arc

| OID                       | Name             | Extension type | extnValue inner DER |
|---|---|---|---|
| `1.3.6.1.4.1.99999.1.4`   | `interlace-epoch` | INTEGER         | `02 <len> [00] <be-bytes>` (DER INTEGER, canonical form; leading `00` only when the high bit of the first content byte would otherwise be set) |
| `1.3.6.1.4.1.99999.1.5`   | `interlace-peer`  | UTF8String      | `0C <len> <utf8 bytes>` |
| `1.3.6.1.4.1.99999.1.6`   | `interlace-scope` | UTF8String      | `0C <len> <utf8 bytes>` |

The `extnValue` field of `Extension` (an OCTET STRING per [RFC 5280
§4.1](https://www.rfc-editor.org/rfc/rfc5280#section-4.1)) wraps the
inner DER above:

```
Extension ::= SEQUENCE {
  extnID    OBJECT IDENTIFIER,    -- e.g. 1.3.6.1.4.1.99999.1.4
  critical  BOOLEAN DEFAULT FALSE, -- always FALSE for these three in cloister
  extnValue OCTET STRING           -- contains DER-encoded inner value
}
```

So a complete `interlace-epoch` extension with epoch=7 looks like:

```
30 11                              -- SEQUENCE Extension { len=17 }
   06 0A 2B 06 01 04 01 86 8D 1F 01 04  -- OID 1.3.6.1.4.1.99999.1.4
   04 03                             -- OCTET STRING { len=3 }
      02 01 07                        -- INTEGER 7
```

## Encoding the epoch INTEGER canonically

Per DER (X.690 §10.3 / RFC 5280), the INTEGER content bytes:

1. Big-endian two's complement.
2. Shortest form: no leading `0x00` octet unless its absence would
   change the high-bit of the first content byte (which would flip the
   sign).
3. For unsigned values like `epoch: u32`:
   - Strip leading zeros from the four-byte big-endian representation.
   - If the resulting first byte has the high bit set (`& 0x80 != 0`),
     prepend a single `0x00` sign byte.

Examples:

| `epoch` (u32) | Content bytes |
|---|---|
| `0`           | `00`           |
| `7`           | `07`           |
| `127`         | `7F`           |
| `128`         | `00 80`        |
| `256`         | `01 00`        |
| `2^31`        | `00 80 00 00 00` |
| `2^32 - 1`    | `00 FF FF FF FF` |

A reference implementation in Rust (from `cert_chain.rs::tests_helpers`):

```rust
fn encode_u32_as_der_int(v: u32) -> Vec<u8> {
    let raw = v.to_be_bytes();
    let mut start = 0;
    while start < 3 && raw[start] == 0 { start += 1; }
    let stripped = &raw[start..];
    let needs_pad = stripped[0] & 0x80 != 0;
    let content_len = stripped.len() + if needs_pad { 1 } else { 0 };
    let mut out = Vec::with_capacity(2 + content_len);
    out.push(0x02);              // INTEGER tag
    out.push(content_len as u8);
    if needs_pad { out.push(0x00); }
    out.extend_from_slice(stripped);
    out
}
```

A verifier reading the extension value should:

1. DER-decode it as an INTEGER.
2. Reject if length > 5 bytes (one optional `0x00` sign byte + four
   value bytes for a `u32`).
3. Reject if length is zero.
4. Strip a leading `0x00` if present and length > 1.
5. Left-pad to 4 bytes and read as big-endian `u32`.

## Encoding peer_fp and scope

Plain DER UTF8String (`0C <len> <utf8 bytes>`). No length prefix
beyond DER. cloister's peer_fp values are of the form
`sha256:<64-hex>` but the wire is opaque UTF-8; any valid UTF-8 is
accepted.

## Critical flag

cloister mints all three with `critical = FALSE` (default). A
conformant verifier MUST accept that AND MUST reject any cert
carrying an unknown OID with `critical = TRUE` (RFC 5280 §4.2).

The known-OID allow-list is exactly the three OIDs above. Standard
X.509 critical extensions (BasicConstraints, KeyUsage, EKU, SAN, etc.)
are NOT in the allow-list because cloister-minted Interlace certs do
not carry them. If a future minter starts emitting them, the
verifier's allow-list must be extended before the critical flag is
flipped.

## Signature algorithm

Both `signatureAlgorithm` (outer) and `tbs_certificate.signature`
(inner; redundant per X.509 but verifiers MUST check it matches)
carry OID `1.3.101.112` (id-Ed25519, RFC 8410). No `parameters` field
(it MUST be absent for Ed25519).

## Subject public key

`SubjectPublicKeyInfo`:

- `algorithm.oid` = `1.3.101.112` (id-Ed25519)
- `algorithm.parameters` = absent
- `subject_public_key` = BIT STRING containing the 32 raw pubkey
  bytes (no unused bits)
