// SPDX-License-Identifier: AGPL-3.0-or-later
//
// importFacts: a rendered infrastructure document in, resource facts out
// (ADR-0073). Read-only. It runs no tool and writes nothing. A resource type is
// looked up across every provider mapping (Cloudflare, Google) by own property.

import { entryFor, importResource } from "./cloudflare.mjs";
import { readShowJson } from "./terraform.mjs";


/**
 * @param {object} document parsed `terraform show -json` / `tofu show -json` output
 * @returns {{kind: string, formatVersion: string, facts: object[], skipped: Record<string, number>}}
 *   `skipped` counts managed resources by type that no mapping reads (for an
 *   object a resource holds whole, by the type of its kind), so the report can
 *   say what it did not look at instead of implying it saw everything.
 */
export function importFacts(document) {
  const { kind, formatVersion, resources, references, expressions } = readShowJson(document);
  const facts = [];
  const skipped = new Map(); // a Map, so a type named `toString` counts like any other
  for (const found of resources) {
    // A resource that holds an object whole is read as that object, by the
    // entry for its kind; one no entry reads is counted under the name of
    // what was not read (see entryFor).
    const { entry, resource, skipped: unread } = entryFor(found);
    if (!entry) {
      skipped.set(unread, (skipped.get(unread) ?? 0) + 1);
      continue;
    }
    // Configuration references describe a PLAN: in a state document they are not read.
    const plan = kind === "plan";
    facts.push(importResource(resource, entry, plan ? references.get(resource.address) : undefined, plan ? expressions.get(resource.address) : undefined));
  }
  return { kind, formatVersion, facts, skipped: Object.fromEntries(skipped) };
}
