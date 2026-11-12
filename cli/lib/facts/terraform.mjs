// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Reader for the documented `terraform show -json` / `tofu show -json`
// document (state or plan). Cloister runs neither tool: the operator renders
// the document and hands over the file (ADR-0070 §2, rendered output only).
//
// The raw `.tfstate` file is a different, undocumented format and is refused.

/** The only document major version this reader understands. */
export const SUPPORTED_FORMAT_MAJOR = 1;

/**
 * Validate the document and return its managed resources, flattened across
 * modules, each as `{address, type, name, provider, values, sensitive}`.
 *
 * A plan document is read from `planned_values`; a state document from
 * `values`. Data sources are skipped: they describe lookups, not resources
 * this configuration owns.
 */
export function readShowJson(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("the Terraform document is not a JSON object");
  }
  if (typeof document.format_version !== "string") {
    if ("lineage" in document || "serial" in document) {
      throw new Error(
        "this looks like a raw .tfstate file, which is not a documented format. " +
          "Render it first: `terraform show -json > state.json` (or `tofu show -json`)",
      );
    }
    throw new Error("the Terraform document has no format_version; expected `terraform show -json` output");
  }
  const major = Number.parseInt(document.format_version.split(".")[0], 10);
  if (major !== SUPPORTED_FORMAT_MAJOR) {
    throw new Error(
      `Terraform document format_version ${JSON.stringify(document.format_version)} is not supported ` +
        `(this reader understands major version ${SUPPORTED_FORMAT_MAJOR})`,
    );
  }
  const root = document.planned_values?.root_module ?? document.values?.root_module;
  const kind = document.planned_values ? "plan" : "state";
  const resources = [];
  if (root) collect(root, resources);
  return { kind, formatVersion: document.format_version, resources };
}

function collect(module, out) {
  for (const resource of module.resources ?? []) {
    if (resource?.mode !== "managed") continue;
    if (typeof resource.type !== "string" || typeof resource.address !== "string") continue;
    out.push({
      address: resource.address,
      type: resource.type,
      name: typeof resource.name === "string" ? resource.name : "",
      provider: typeof resource.provider_name === "string" ? resource.provider_name : "",
      values: resource.values && typeof resource.values === "object" ? resource.values : {},
      sensitive:
        resource.sensitive_values && typeof resource.sensitive_values === "object"
          ? resource.sensitive_values
          : {},
    });
  }
  for (const child of module.child_modules ?? []) collect(child, out);
}
