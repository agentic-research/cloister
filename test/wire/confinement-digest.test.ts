// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Conformance: cloister's §7 canonical JSON for confinement/v1, hashed by the
// substrate BLAKE3, MUST reach LLO's pinned confinementDigest for the canonical
// vector (CONFINEMENT_DIGESTS.blake3 @ v0.7.3).
//
// The canonical JSON is the CLI's `canonicalJson`
// (cli/lib/harness/confinement-lattice.mjs), the one copy cloister keeps. The
// confinement lattice compares manifests by it, so this pins that two manifests
// the lattice calls equal are two a certificate's digest calls equal. The
// BLAKE3 is LLO's own, through the wasm bridge (src/wire/cas-hash.ts).
//
// The digest a run is held to is computed and checked in Rust:
// rs/crates/cas/tests/confinement_digest.rs pins the same value, and the
// harness runner (tools/harness-sandbox) verifies it against the identity
// certificate before Sandbox::apply (cloister-c80953).

import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../cli/lib/harness/confinement-lattice.mjs";
import { blake3Hex } from "../../src/wire/cas-hash.js";

// LLO confinement/v1 @ v0.7.3 CONFINEMENT_DIGESTS.blake3 pin for manifest-canonical.json.
const LLO_PIN = "d9b5b7270bb6e5ec068aec92798dd76b0f71d1fe2640b3a09833b7742d51c617";

// The canonical example manifest (§1-5). Array element order matches the vector
// (§7 does not sort arrays); object key order is irrelevant here, since the
// canonical form sorts it.
const MANIFEST = {
  credentialSource: "keychain://bundle-X-credentials",
  fs: { allow: ["/etc/hosts", { path: "/var/lib/bundle-X/", mode: "rw" }] },
  network: { allowHosts: ["*.telemetry.example.com", "api.example.com"] },
  port: { bind: 8443, address: "127.0.0.1" },
  version: "cloister/confinement/v1",
};

const digest = (manifest: unknown): string => blake3Hex(new TextEncoder().encode(canonicalJson(manifest)));

describe("confinement/v1 §7 canonical JSON, hashed by the substrate BLAKE3", () => {
  it("reproduces LLO's v0.7.3 confinementDigest pin", () => {
    expect(digest(MANIFEST)).toBe(LLO_PIN);
  });

  it("is key-order invariant at every level", () => {
    const shuffled = {
      version: "cloister/confinement/v1",
      port: { address: "127.0.0.1", bind: 8443 },
      network: { allowHosts: ["*.telemetry.example.com", "api.example.com"] },
      credentialSource: "keychain://bundle-X-credentials",
      fs: { allow: ["/etc/hosts", { mode: "rw", path: "/var/lib/bundle-X/" }] },
    };
    expect(digest(shuffled)).toBe(LLO_PIN);
  });

  it("omits null and undefined fields, as §7 says", () => {
    expect(digest({ ...MANIFEST, workspace: null, scratch: undefined })).toBe(LLO_PIN);
  });

  it("emits sorted keys, a two-space indent, and no trailing newline", () => {
    const text = canonicalJson(MANIFEST);
    expect(text.startsWith('{\n  "credentialSource"')).toBe(true);
    expect(text.endsWith("}")).toBe(true);
  });
});
