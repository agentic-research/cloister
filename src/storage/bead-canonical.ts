// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bead canonical-bytes encoder — `bead/v1` digest shape per ADR-0003 +
// ADR-0012's content-addressed handoff requirement.
//
// Two distinct DOs (BeadStore per-repo, TrustStore singleton) need to
// independently compute `content_hash = sha256(canonical(bead))` for a
// given Bead struct so a `peer_attestations` row can reference the same
// digest the BeadStore row holds. The canonicalization MUST be:
//
//   1. **Byte-stable** — same struct → same bytes, on every host, every
//      version. No floating-point drift, no key-ordering ambiguity, no
//      timezone games. Reuses `canonical()` from canonical.ts which sorts
//      object keys + encodes UTF-8 + uses JSON-without-whitespace.
//
//   2. **Versioned** — the `v: 1` preamble pins this shape. Future schema
//      changes (e.g. a new field on Bead) MUST increment the version,
//      because adding a field to v1 silently changes every bead's
//      canonical bytes and would invalidate every prior content_hash.
//
//   3. **Strict** — every field is explicitly listed; we don't `JSON.parse`
//      the Bead and serialize whatever's there. Optional fields
//      (`created_by`, `notes`) normalize `undefined` → `null` so the
//      shape stays uniform across beads with and without the field set.
//
//   4. **Includes `updated_at`** — the digest commits to the bead's STATE
//      at write time, not just its identity. ADR-0012 wants the
//      attestation to bind the witnessed state, so a re-write produces a
//      new digest and a new attestation. (Same bead id, different content,
//      different rows.)
//
// Labels are sorted lexicographically before encoding because they're
// semantically a set — order of insertion shouldn't change the digest.

import type { Bead } from "../types.js";
import { type Digest, asDigest } from "./types.js";
import { canonical, digestBytes } from "./canonical.js";

/** Canonical-bytes encoding tag for the bead/v1 shape. */
export const BEAD_CANONICAL_VERSION = 1;

/**
 * Canonical bytes for a Bead struct. See file header for the invariants
 * this encoding maintains. Throws if any required field is missing or
 * non-canonicalizable (matches `canonical()`'s contract).
 */
export function beadCanonicalBytesV1(bead: Bead): Uint8Array {
  const body = {
    v:           BEAD_CANONICAL_VERSION,
    type:        "bead",
    id:          bead.id,
    title:       bead.title,
    description: bead.description,
    state:       bead.state,
    priority:    bead.priority,
    labels:      [...bead.labels].sort(),
    created_at:  bead.created_at,
    updated_at:  bead.updated_at,
    created_by:  bead.created_by ?? null,
    repo:        bead.repo,
    notes:       bead.notes ?? null,
  };
  return canonical(body);
}

/**
 * Convenience: canonicalize then SHA-256. The output is the digest
 * BeadStore would compute for the same Bead struct, the same digest
 * TrustStore would compute, and the same digest a third-party verifier
 * with just the canonical bytes would compute. ADR-0012's cross-DO
 * consistency rests on this being consistently the case.
 */
export async function beadCanonicalDigestV1(bead: Bead): Promise<Digest> {
  return digestBytes(beadCanonicalBytesV1(bead));
}

void asDigest;  // re-export-only; keeps the import alive for IDEs
