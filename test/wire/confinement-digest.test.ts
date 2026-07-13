// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Conformance: cloister's TS §6 canonicalizer + confinementDigest MUST reproduce
// LLO's pinned digest for the confinement/v1 canonical vector (CONFINEMENT_DIGESTS.blake3
// @ v0.7.3). This is the TS twin of rs/crates/cas/tests/confinement_digest.rs —
// both compute the SAME value via the substrate BLAKE3, so the runtime verify
// (cloister-c80953) agrees with the Rust minter + LLO's blake3 crate.

import { describe, expect, it } from "vitest";
import { canonicalizeConfinement, confinementDigest } from "../../src/wire/confinement-digest.js";

// LLO confinement/v1 @ v0.7.3 CONFINEMENT_DIGESTS.blake3 pin for manifest-canonical.json.
const LLO_PIN = "d9b5b7270bb6e5ec068aec92798dd76b0f71d1fe2640b3a09833b7742d51c617";

// The canonical example manifest (§1-5). Array element order matches the vector
// (§6 does not sort arrays); object key order is irrelevant here — the
// canonicalizer sorts.
const MANIFEST = {
  credentialSource: "keychain://bundle-X-credentials",
  fs: { allow: ["/etc/hosts", { path: "/var/lib/bundle-X/", mode: "rw" }] },
  network: { allowHosts: ["*.telemetry.example.com", "api.example.com"] },
  port: { bind: 8443, address: "127.0.0.1" },
  version: "cloister/confinement/v1",
};

describe("confinement-digest — §6 canonicalizer + BLAKE3 (TS)", () => {
  it("reproduces LLO's v0.7.3 confinementDigest pin", () => {
    expect(confinementDigest(MANIFEST)).toBe(LLO_PIN);
  });

  it("canonicalization is key-order and whitespace invariant (§6)", () => {
    // Same manifest, keys shuffled at every level — must reach the same digest.
    const shuffled = {
      version: "cloister/confinement/v1",
      port: { address: "127.0.0.1", bind: 8443 },
      network: { allowHosts: ["*.telemetry.example.com", "api.example.com"] },
      credentialSource: "keychain://bundle-X-credentials",
      fs: { allow: ["/etc/hosts", { mode: "rw", path: "/var/lib/bundle-X/" }] },
    };
    expect(confinementDigest(shuffled)).toBe(LLO_PIN);
  });

  it("emits §6-canonical bytes (sorted keys, 2-space, no trailing newline)", () => {
    const bytes = canonicalizeConfinement(MANIFEST);
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith('{\n  "credentialSource"')).toBe(true); // sorted: credentialSource first
    expect(text.endsWith("}")).toBe(true); // no trailing newline
    expect(text).not.toContain("\n}\n"); // last byte is `}`
  });
});
