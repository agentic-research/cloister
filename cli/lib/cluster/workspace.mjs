// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The operator's workspace, as a need a bundle declares once (ADR-0078).
//
// `workspace = "read" | "write"` on a bundle's external facet means the bundle
// is given the operator's workspace at WORKSPACE_PATH, whatever runs it. Every
// placement provides it or refuses by name; nothing starts the bundle without
// it, and nothing drops the declaration:
//
//   - compose bind-mounts ${CLOISTER_WORKSPACE:-.} at WORKSPACE_PATH
//     (composeWorkspaceMount);
//   - a microvm plan carries `workspaceAccess`, and the host runtime refuses it
//     until it can give a guest a workspace (cloister-dc4a53);
//   - every other placement is refused when cluster.toml is parsed
//     (assertWorkspaces).

/** Where every placement presents the workspace: where ley-line-open serves one to a microVM guest. */
export const WORKSPACE_PATH = "/work";

/** What a bundle may declare. Empty means it is given no workspace. */
export const WORKSPACE_ACCESS = Object.freeze(["read", "write"]);

/** The placements that give a bundle its declared workspace (or, for microvm, refuse it by name at launch). */
export const WORKSPACE_PLACEMENTS = Object.freeze(["compose", "microvm"]);

/** The compose variable that chooses the workspace. Unset, it is the compose file's own directory. */
export const WORKSPACE_VARIABLE = "CLOISTER_WORKSPACE";

/** A bundle's declared workspace access: "read", "write", or "" for none. */
export function workspaceAccess(bundle) {
  const access = bundle?.kind?.external?.workspace;
  return typeof access === "string" ? access : "";
}

/**
 * Refuse a workspace declaration no placement of the bundle can honour.
 *
 * @param {Array<object>} bundles validated bundles (the parseTomlToCluster shape)
 */
export function assertWorkspaces(bundles) {
  for (const bundle of bundles) {
    const access = workspaceAccess(bundle);
    if (access === "") continue;
    const name = JSON.stringify(bundle.name);
    if (!WORKSPACE_ACCESS.includes(access)) {
      throw new Error(
        `bundle ${name}: workspace ${JSON.stringify(access)} is not one of ${WORKSPACE_ACCESS.join(", ")} (omit it for none)`,
      );
    }
    // One workspace mounted into every tenant's instance would be shared
    // between tenants, which is the boundary perTenant exists to keep.
    if (bundle.perTenant === true) {
      throw new Error(
        `bundle ${name} is perTenant and declares workspace = "${access}": every tenant's instance ` +
          `would be given the same workspace. A tenant's data does not cross into another tenant's instance`,
      );
    }
    for (const placement of bundle.placements ?? []) {
      if (WORKSPACE_PLACEMENTS.includes(placement.kind)) continue;
      throw new Error(
        `bundle ${name} declares workspace = "${access}", and its "${placement.kind}" placement for env ` +
          `${JSON.stringify(placement.env)} does not give it one: only ${WORKSPACE_PLACEMENTS.map((k) => `"${k}"`).join(" and ")} ` +
          `present the workspace at ${WORKSPACE_PATH} (ADR-0078). Refusing rather than placing the bundle without it`,
      );
    }
  }
}

/**
 * The compose volume entry that gives a service its workspace, as YAML lines
 * under its `volumes:` key. Long syntax, so no reader splits the variable's
 * `:-` default on its colon.
 */
export function composeWorkspaceMount(access) {
  return [
    "      - type: bind",
    `        source: "\${${WORKSPACE_VARIABLE}:-.}"`,
    `        target: ${WORKSPACE_PATH}`,
    ...(access === "read" ? ["        read_only: true"] : []),
  ];
}
