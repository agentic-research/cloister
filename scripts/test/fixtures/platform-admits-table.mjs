// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A test double for the host runtime's `platform-admits` verb that answers from
// an explicit table. Tests state the answers they need; none of them restates
// LLO's admission rule (cloister-b94b14).
//
//   tableAdmits({ "linux/arm64": { admitted: ["linux/arm64", "linux/arm64/v8"],
//                                  overlapping: ["linux/arm64", "linux/arm64/v8"] } })
//
// The lists are filtered to the candidates actually passed, as the real verb
// answers. A platform missing from the table throws, so a test cannot pass by
// asking something it never declared.

export function tableAdmits(table) {
  return (platform, candidates) => {
    const entry = table[platform];
    if (!entry) {
      throw new Error(`tableAdmits: no answer declared for platform ${JSON.stringify(platform)}`);
    }
    return {
      admitted: candidates.filter((c) => (entry.admitted ?? []).includes(c)),
      overlapping: candidates.filter((c) => (entry.overlapping ?? entry.admitted ?? []).includes(c)),
    };
  };
}
