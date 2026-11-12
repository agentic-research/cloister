// SPDX-License-Identifier: AGPL-3.0-or-later
//
// importFacts: a rendered infrastructure document in, resource facts out
// (ADR-0073). Read-only. It runs no tool and writes nothing.

import { CLOUDFLARE_TYPES, importResource } from "./cloudflare.mjs";
import { readShowJson } from "./terraform.mjs";

/** Provider mappings, keyed by resource type. One spread per provider. */
const TYPES = Object.freeze({ ...CLOUDFLARE_TYPES });

/**
 * @param {object} document parsed `terraform show -json` / `tofu show -json` output
 * @returns {{kind: string, formatVersion: string, facts: object[], skipped: Record<string, number>}}
 *   `skipped` counts managed resources by type that no mapping reads, so the
 *   report can say what it did not look at instead of implying it saw everything.
 */
export function importFacts(document) {
  const { kind, formatVersion, resources } = readShowJson(document);
  const facts = [];
  const skipped = {};
  for (const resource of resources) {
    const entry = TYPES[resource.type];
    if (!entry) {
      skipped[resource.type] = (skipped[resource.type] ?? 0) + 1;
      continue;
    }
    facts.push(importResource(resource, entry));
  }
  return { kind, formatVersion, facts, skipped };
}
