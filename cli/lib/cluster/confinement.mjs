// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Which grants a bundle's confinement facet declares (cloister/confinement/v1).
//
// toml-to-cluster normalizes every facet to the deny-all default plus what the
// operator wrote, so "declared" means "differs from that default", one
// dimension at a time. Two readers use this one definition: the round trip
// (cluster-to-toml), which omits a dimension that declares nothing, and the
// check that a bundle placed "microvm" declares no grant the microVM tier
// cannot apply. cli/test/cluster/confinement.test.mjs holds this table to the
// generated schema, so a dimension the schema gains is not silently skipped.

/** Each dimension of the facet, by its key, and whether a normalized facet declares it. */
export const DIMENSIONS = Object.freeze([
  ["fs", (c) => (c.fs?.allow?.length ?? 0) > 0],
  ["network", (c) => (c.network?.allowHosts?.length ?? 0) > 0],
  ["port", (c) => (c.port?.bind ?? 0) !== 0 || (c.port?.address ?? "") !== ""],
  ["credentialSource", (c) => (c.credentialSource ?? "") !== ""],
]);

/** The dimensions `confinement` declares, in schema order. Empty for the deny-all default. */
export function declaredDimensions(confinement) {
  if (!confinement || typeof confinement !== "object") return [];
  return DIMENSIONS.filter(([, declares]) => declares(confinement)).map(([key]) => key);
}

// What a microvm bundle declares instead, per dimension. The microVM tier
// gives a guest no network card and no host path: its only channels are the
// §6 grants `cloister runtime plan` derives from [[bundles.ports]] and
// [[connections]], and the host runtime refuses a plan carrying anything else
// (Confinement::check_microvm_grants, rs/crates/host-runtime/src/lib.rs).
const MICROVM_REMEDY = Object.freeze({
  fs:
    "the microVM tier serves a workspace only through LLO's execution daemon, and " +
    "cloister's host runtime does not serve one yet; run the bundle as \"process\" and " +
    "say so in executionModeRationale (ADR-0062)",
  network:
    "a guest's outbound reach is its declared connections, which LLO's broker " +
    "(ley-line-open-e2c5ce) will carry; it has no other egress",
  port: "declare the listener as a [[bundles.ports]] entry; it is presented on the guest's loopback at its port",
  credentialSource: "give the bundle its credential through a vault slice",
});

/**
 * Refuse a bundle placed "microvm" in any environment whose confinement
 * declares a grant the microVM tier cannot apply. Before this, such a grant
 * passed every gate, reached the launch plan, and was refused by the host
 * runtime at launch, so the bundle counted as isolated and could not run.
 *
 * @param {Array<object>} bundles validated bundles (the parseTomlToCluster shape)
 */
export function assertMicrovmConfinement(bundles) {
  for (const bundle of bundles) {
    const placements = bundle.placements ?? [];
    const implicit = placements.length === 0 && bundle.kind?.external?.executionMode === "microvm";
    const envs = placements.filter((p) => p.kind === "microvm").map((p) => p.env);
    if (!implicit && envs.length === 0) continue;
    const declared = declaredDimensions(bundle.confinement);
    if (declared.length === 0) continue;
    const where = implicit
      ? 'executionMode = "microvm" with no placement rows, so in every env'
      : `${envs.length === 1 ? "env" : "envs"} ${envs.map((e) => JSON.stringify(e)).join(", ")}`;
    const named = declared.map((d) => `confinement.${d}`);
    throw new Error(
      `bundle ${JSON.stringify(bundle.name)} is placed "microvm" (${where}) and declares ` +
        `${named.join(" and ")}. A microVM guest has no network card and no host path: its only ` +
        `channels are the confinement/v1 §6 grants \`cloister runtime plan\` derives from ` +
        `[[bundles.ports]] and [[connections]], and the host runtime refuses a plan carrying any ` +
        `other grant. ` +
        declared.map((d) => `confinement.${d}: ${MICROVM_REMEDY[d] ?? "the microVM tier has no mapping for it"}.`).join(" "),
    );
  }
}
