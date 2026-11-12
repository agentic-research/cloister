// SPDX-License-Identifier: AGPL-3.0-or-later
//
// importFacts: a rendered infrastructure document in, resource facts out
// (ADR-0073). Read-only. It runs no tool and writes nothing.

import { importResource, mappedType } from "./cloudflare.mjs";
import { readShowJson } from "./terraform.mjs";


/**
 * @param {object} document parsed `terraform show -json` / `tofu show -json` output
 * @returns {{kind: string, formatVersion: string, facts: object[], skipped: Record<string, number>}}
 *   `skipped` counts managed resources by type that no mapping reads, so the
 *   report can say what it did not look at instead of implying it saw everything.
 */
export function importFacts(document) {
  const { kind, formatVersion, resources } = readShowJson(document);
  const facts = [];
  const skipped = new Map(); // a Map, so a type named `toString` counts like any other
  for (const resource of resources) {
    const entry = mappedType(resource.type);
    if (!entry) {
      skipped.set(resource.type, (skipped.get(resource.type) ?? 0) + 1);
      continue;
    }
    facts.push(importResource(resource, entry));
  }
  return { kind, formatVersion, facts, skipped: Object.fromEntries(skipped) };
}
