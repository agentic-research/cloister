// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Which bundles the compose file runs (ADR-0070 §2 amendment 2026-11-19).
//
// `compose` is a placement kind. `emit-compose` writes a service for each
// external bundle placed `compose` in the compose env, and for no other. A
// bundle that says it is a microVM is no longer run as a plain container
// because compose happened to be the thing started.
//
// One compatibility rule, stated and not inferred per bundle: a cluster in
// which NO bundle declares a placement row was written before this existed,
// and compose ran every external bundle in it. It still does, and the file
// says so. The first placement row anywhere ends that: from then on the rows
// are what is run.
//
// `emit-compose` and `graph.mjs` both read this, so the graph cannot describe
// a service the file does not contain.

import { COMPOSE_ENV, checkableBundle, placementFor } from "./connections.mjs";

const isExternal = (bundle) => Boolean(bundle?.kind && typeof bundle.kind === "object" && "external" in bundle.kind);

/**
 * @param {object} cluster a parsed cluster
 * @param {string} [env] the env compose is emitted for
 * @returns {{
 *   env: string,
 *   legacy: boolean,
 *   cluster: object,
 *   skipped: Array<{name: string, reason: string}>,
 * }}
 *   `cluster` is the input with the external bundles compose does not run
 *   removed (bundles that run inside the gateway stay: they have no service
 *   either way). `skipped` names each removed bundle and why. `legacy` is
 *   true when no bundle declares a placement row.
 */
export function composeView(cluster, env = COMPOSE_ENV) {
  const bundles = cluster.bundles ?? [];
  const legacy = !bundles.some((b) => (b.placements ?? []).length > 0);
  const skipped = [];
  const kept = bundles.filter((b) => {
    if (!isExternal(b) || legacy) return true;
    const kind = placementFor(checkableBundle(b), env);
    if (kind === "compose") return true;
    skipped.push({
      name: b.name,
      reason: kind === null
        ? `it has placements, and none is for env "${env}"`
        : `it is placed "${kind}" for env "${env}"${(b.placements ?? []).length === 0 ? " (implicitly, from its executionMode)" : ""}`,
    });
    return false;
  });
  return { env, legacy, cluster: { ...cluster, bundles: kept }, skipped };
}

/**
 * Refuse a wire that has an end compose does not run: the address it would
 * hand its source names a service that is not in the file.
 */
export function assertWiresRun(view) {
  for (const w of view.cluster.wires ?? []) {
    for (const end of [w.from, w.to]) {
      const gone = view.skipped.find((s) => s.name === end);
      if (!gone) continue;
      throw new Error(
        `emit-compose: wire "${w.binding}" (${w.from} → ${w.to}) has an end compose does not run: "${end}" is not a service here because ${gone.reason}. ` +
          `Add \`[[bundles.placements]] env = "${view.env}", kind = "compose"\` to "${end}", or remove the wire`,
      );
    }
  }
}
