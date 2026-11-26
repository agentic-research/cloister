// SPDX-License-Identifier: AGPL-3.0-or-later
//
// importFacts: a rendered infrastructure document in, resource facts out
// (ADR-0073). Read-only. It runs no tool and writes nothing. A resource type is
// looked up across every provider mapping by own property: cloister's own, or
// those with a checkout's entries added (checkout.mjs).

import { SHIPPED, importResource } from "./cloudflare.mjs";
import { readShowJson } from "./terraform.mjs";


/**
 * @param {object} document parsed `terraform show -json` / `tofu show -json` output
 * @param {object} [registry] the mappings to read with (cloudflare.mjs makeRegistry)
 * @returns {{kind: string, formatVersion: string, facts: object[], skipped: Record<string, number>, registry: object}}
 *   `skipped` counts managed resources by type that no mapping reads (for an
 *   object a resource holds whole, by the type of its kind), so the report can
 *   say what it did not look at instead of implying it saw everything.
 *   `registry` is what read them, for the report to read the same way.
 */
export function importFacts(document, registry = SHIPPED) {
  const { kind, formatVersion, resources, references, expressions } = readShowJson(document);
  const facts = [];
  const skipped = new Map(); // a Map, so a type named `toString` counts like any other
  for (const found of resources) {
    // A resource that holds an object whole is read as that object, by the
    // entry for its kind; one no entry reads is counted under the name of
    // what was not read (see entryFor).
    const { entry, resource, skipped: unread } = registry.entryFor(found);
    if (!entry) {
      skipped.set(unread, (skipped.get(unread) ?? 0) + 1);
      continue;
    }
    // Configuration references describe a PLAN: in a state document they are not read.
    const plan = kind === "plan";
    facts.push(importResource(resource, entry, plan ? references.get(resource.address) : undefined, plan ? expressions.get(resource.address) : undefined));
  }
  return { kind, formatVersion, facts, skipped: Object.fromEntries(skipped), registry };
}
