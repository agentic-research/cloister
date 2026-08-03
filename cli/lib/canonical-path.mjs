// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Confinement paths are policy, not convenience input. Reject ambiguous dot
// segments rather than normalizing them into a different authorization scope.

export function isCanonicalAbsolutePath(value) {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    !value.split("/").some((segment) => segment === "." || segment === "..")
  );
}
