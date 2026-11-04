// SPDX-License-Identifier: AGPL-3.0-or-later
//
// VENDORED — do not edit. A real Signet-profile certificate, minted by notme's
// own `mintBridgeCertPair` (worker/src/cert-authority.ts), signed directly by
// the root with no intermediate tier.
//
// Source: agentic-research/ley-line-open @ v0.21.1 (d11e89a8),
//   rs/ll-open/sign/tests/fixtures/notme-certs/direct-signing.der
//     sha256 7f1222648ea005e7a15d1f0f390e4e0e463e6dcee6c361bcf8188ecab5154222
//   rs/ll-open/sign/tests/fixtures/notme-certs/root.pub
//     sha256 68d4e09f8f6b8175ab8265bf7fc2ba31f608e8dbe702e468ee71e9550d7c7c32
// That directory's PROVENANCE.md records the notme commit and mint command.
// Encoded here as base64url (no padding) of the exact bytes.
//
// Why it is here: it carries `.1.1`, `.1.2`, `.1.3`, `.1.8` (Signet markers)
// AND `.1.5` (authMethod "passkey") and `.1.6` (a 32-byte peer binding) on
// the arc the Interlace profile reads as peer fingerprint and scope. It is the
// certificate the lease gate's Interlace profile binding exists to refuse.

/** Raw 32-byte Ed25519 public key of the minting root. */
export const NOTME_ROOT_PUBKEY_B64 = "61jmh6K7h91Z05IunGAttbeFfd8vvxzlaxpoPBJx3Ps";

/** Root-signed Signet-profile Ed25519 signing certificate (DER). */
export const NOTME_DIRECT_SIGNING_CERT_B64 = "MIICRTCCAfegAwIBAgIQB10ySbH_Zc00Z3iTHP_9GDAFBgMrZXAwKzEZMBcGA1UEAxMQc2lnbmV0LWF1dGhvcml0eTEOMAwGA1UEChMFbm90bWUwHhcNMjYxMDI3MTYwOTMxWhcNMjYxMDI3MTYxNDMxWjAnMRUwEwYDVQQDEwxmaXh0dXJlLXVzZXIxDjAMBgNVBAoTBW5vdG1lMCowBQYDK2VwAyEAhKbnHD689uXpD06YtIW7dVyh-RocjQUOhef14_ZRfUqjggEzMIIBLzAMBgNVHRMBAf8EAjAAMA4GA1UdDwEB_wQEAwIHgDAcBgorBgEEAYaNHwEBBA4MDGZpeHR1cmUtdXNlcjAoBgorBgEEAYaNHwECBBoMGDIwMjYtMTAtMjdUMTY6MDk6MzEuNzE2WjAbBgorBgEEAYaNHwEDBA0wCwwJYmVhZDpyZWFkMBEGCisGAQQBho0fAQQEAwIBAzAXBgorBgEEAYaNHwEFBAkMB3Bhc3NrZXkwLgYKKwYBBAGGjR8BBgQgnZ34FkaB8vkJXwBgvTcHQ7TJvjsUBZ8PNmOyzbGWHHAwFQYKKwYBBAGGjR8BCAQHDAVodW1hbjA3BgNVHREBAf8ELTArhil3aW1zZTovL25vdG1lLnRlc3QvcHJpbmNpcGFsL2ZpeHR1cmUtdXNlcjAFBgMrZXADQQAxEaWnZg-twj1Ba0XSt0HZ6qhzsCdIHTsv797ZYqcvY1Xybjm040wGr--VTyq7Q5kD_D1-F_-zs-iBc48tDioB";
