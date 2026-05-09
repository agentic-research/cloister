// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AUTO-GENERATED — do not edit. Regenerate with `task rs:sign:fixtures`.
// Source: rs/crates/sign/examples/gen-fixture.rs
//
// Test fixtures for cloister-bd5241 / cloister-9d49eb cert-chain
// verify wrapper. Generated from a fixed RNG seed so the bytes are
// stable across regenerations.

export const MASTER_PUBKEY_B64 = "ebVWLo_mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ";
export const EPHEMERAL_PUBKEY_B64 = "zRSzf5VulTGU_3-3Oz2B3MVh1hp1OAlLfD4aZD7l86o";
export const NOT_BEFORE = 1700000000;
export const NOT_AFTER  = 1700000300;

/** Cert with all Interlace extensions (epoch + peer_fp + scope). */
export const CERT_FULL_B64 = "MIIBEDCBw6ADAgECAgEBMAUGAytlcDAAMB4XDTIzMTExNDIyMTMyMFoXDTIzMTExNDIyMTgyMFowADAqMAUGAytlcAMhAM0Us3-VbpUxlP9_tzs9gdzFYdYadTgJS3w-GmQ-5fOqo2IwYDARBgorBgEEAYaNHwEEBAMCAQcwIwYKKwYBBAGGjR8BBQQVDBNzaGEyNTY6YWJjMTIzZGVmNDU2MCYGCisGAQQBho0fAQYEGAwWYmVhZF9jcmVhdGU6L3JlcG9zL2ZvbzAFBgMrZXADQQAyrqxZ_WrUBUXaTAYQX0WZx_oGk-0dBaSRAUfOnElu9ZhTxZ-ObN12Bpioydr8HfFJLu4RogmMZ1Luf_SzXOUA";

/** Cert without Interlace extensions (legacy / minimum-viable cert). */
export const CERT_MINIMAL_B64 = "MIGrMF-gAwIBAgIBATAFBgMrZXAwADAeFw0yMzExMTQyMjEzMjBaFw0yMzExMTQyMjE4MjBaMAAwKjAFBgMrZXADIQDNFLN_lW6VMZT_f7c7PYHcxWHWGnU4CUt8PhpkPuXzqjAFBgMrZXADQQCsIdz7NAJyoUvXShDWyJY_KyGFv8dm5DfSW2VeYB2CzF4QEorai0uhWm6rgKeiTNdCwpcqwt6A5SyZgs_F0E8E";

/** Cert minted by a different master — should reject under MASTER_PUBKEY_B64. */
export const CERT_WRONG_MASTER_B64 = "MIIBEDCBw6ADAgECAgEBMAUGAytlcDAAMB4XDTIzMTExNDIyMTMyMFoXDTIzMTExNDIyMTgyMFowADAqMAUGAytlcAMhAM0Us3-VbpUxlP9_tzs9gdzFYdYadTgJS3w-GmQ-5fOqo2IwYDARBgorBgEEAYaNHwEEBAMCAQcwIwYKKwYBBAGGjR8BBQQVDBNzaGEyNTY6YWJjMTIzZGVmNDU2MCYGCisGAQQBho0fAQYEGAwWYmVhZF9jcmVhdGU6L3JlcG9zL2ZvbzAFBgMrZXADQQDHOiQmfgD0F1dh-m7JMuFU-GmDLo46aGb-Eb7AVGAPBcyC3yQYnGg_9Xo4i-GLKLqCbf5J1PjRDQRZDX8UJKsK";

/**
 * Sample signed request for verifyAndUpsertLease integration tests.
 * The signature is over canonicalRequestBytes(method, url, ts, nonce, body)
 * using the ephemeral private key whose public key is embedded in CERT_FULL_B64.
 */
export const SAMPLE_METHOD    = "POST";
export const SAMPLE_URL       = "http://x/mcp";
export const SAMPLE_TS_MS     = 1700000100000;
export const SAMPLE_NONCE_B64 = "oaKjpKWmp6ipqqusra6vsA";
export const SAMPLE_BODY_JSON = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"bead_create\",\"arguments\":{\"repo\":\"/repos/foo\"}}}";
export const SAMPLE_SIG_B64   = "AhN2uSj4KIk2ZGXd06kHthcFw0_Cs6JPGtOedQn1l6TWH1UzIFrZaOHmPqXaFMAhPyRmUNI-QUbObx2vxD4PAA";

/** Master pubkey re-encoded as base64-STANDARD for CA-bundle insertion. */
export const MASTER_PUBKEY_B64_STD = "ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ=";
