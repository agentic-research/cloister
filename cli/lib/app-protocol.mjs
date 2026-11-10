// SPDX-License-Identifier: AGPL-3.0-or-later
//
// cli/lib/app-protocol.mjs — the ONE `appProtocol` label validator
// (ADR-0030 §A4, cloister-0fa3d7).
//
// Lives under cli/lib so the build path (toml-to-cluster's port/connection
// checks, cloister-991e65) and the lint (scripts/lint-app-protocol.mjs, which
// re-exports it) share one implementation. Do not write a second one.
//
// Per project convention (cloister-6f06cc resolution): NO REGEX. All
// shape checks use substring + character-range probes.

// ── Substrate-blessed labels (ADR-0030 §A4) ──────────────────────────────
//
// Closed set. Adding a label requires a PR + ADR amendment. The
// substrate guarantees canonical handling for these.

export const BLESSED_LABELS = Object.freeze([
  "art.mcp-jsonrpc",
  "art.interlace-capnp",
  "art.capnp-uds",
  "art.http",
  "art.http2",
  "art.grpc",
  "art.tcp",
  "art.tls",
  // ADR-0069 §2 / §3 amendment (cloister-991e65): the MySQL wire, spoken by
  // MySQL, Cloud SQL for MySQL, MariaDB, Vitess and Dolt's sql-server.
  "art.mysql",
]);

const BLESSED_SET = new Set(BLESSED_LABELS);

const VENDOR_PREFIX = "x-";

// ── Validator ────────────────────────────────────────────────────────────

/**
 * Returns null when `value` is a well-formed app_protocol label,
 * otherwise a short reason string. Substring + char-range probes only;
 * no regex.
 *
 *   - `art.<name>`     — accepted iff `<name>` is in BLESSED_LABELS
 *                        (the full string is, that is)
 *   - `x-<vendor>-...` — accepted iff `<vendor>` is non-empty
 *                        kebab-case + at least one segment follows
 *   - anything else    — rejected with the namespace-rules message
 */
export function validateAppProtocol(value) {
  if (typeof value !== "string") return "not a string";
  if (value.length === 0) return "empty string";

  // Substrate-blessed path: exact match against the closed set.
  if (value.startsWith("art.")) {
    if (BLESSED_SET.has(value)) return null;
    return (
      `"${value}" is not a substrate-blessed label — the \`art.*\` ` +
      "namespace is a closed set; add via PR + ADR amendment. " +
      "Current blessed set: " + BLESSED_LABELS.join(", ")
    );
  }

  // Vendor-extensible path: `x-<vendor>-<protocol>` shape.
  if (value.startsWith(VENDOR_PREFIX)) {
    const afterPrefix = value.slice(VENDOR_PREFIX.length);
    if (afterPrefix.length === 0) {
      return `"${value}": empty vendor segment after "x-"`;
    }
    // Split on first hyphen → <vendor> + <rest>
    const firstHyphenIdx = afterPrefix.indexOf("-");
    if (firstHyphenIdx === -1) {
      return (
        `"${value}": x- namespace requires the shape ` +
        `\`x-<vendor>-<protocol>\` (e.g. "x-myorg-redis")`
      );
    }
    const vendor = afterPrefix.slice(0, firstHyphenIdx);
    const rest = afterPrefix.slice(firstHyphenIdx + 1);
    if (vendor.length === 0) return `"${value}": empty vendor segment`;
    const vendorProblem = checkKebabSegment(vendor);
    if (vendorProblem) return `"${value}": vendor segment "${vendor}": ${vendorProblem}`;
    if (rest.length === 0) {
      return (
        `"${value}": missing protocol segment after vendor — ` +
        `expected \`x-${vendor}-<protocol>\``
      );
    }
    const restProblem = checkKebabPath(rest);
    if (restProblem) return `"${value}": protocol segment "${rest}": ${restProblem}`;
    return null;
  }

  // Neither namespace.
  return (
    `"${value}" does not match the substrate-blessed \`art.*\` set ` +
    'nor the operator-extensible `x-<vendor>-<protocol>` shape. ' +
    "Per ADR-0030 §A4, app_protocol labels must use one of those two " +
    "namespaces. Use `x-<vendor>-...` for experimental protocols; " +
    "promote to `art.*` via PR + ADR amendment when load-bearing."
  );
}

/**
 * Returns null if `s` is one kebab segment (lowercase ASCII + digits +
 * NO hyphen). Used for the vendor portion which is a single token.
 */
function checkKebabSegment(s) {
  for (const ch of s) {
    const isLower = ch >= "a" && ch <= "z";
    const isDigit = ch >= "0" && ch <= "9";
    if (!(isLower || isDigit)) {
      return `non-kebab character "${ch}" (allowed: a-z, 0-9)`;
    }
  }
  return null;
}

/**
 * Returns null if `s` is a kebab-shaped path (lowercase + digits +
 * hyphens; no leading/trailing/doubled hyphens). Used for the rest of
 * an `x-<vendor>-<rest>` label.
 */
function checkKebabPath(s) {
  for (const ch of s) {
    const isLower = ch >= "a" && ch <= "z";
    const isDigit = ch >= "0" && ch <= "9";
    const isHyphen = ch === "-";
    if (!(isLower || isDigit || isHyphen)) {
      return `non-kebab character "${ch}" (allowed: a-z, 0-9, hyphen)`;
    }
  }
  if (s.startsWith("-")) return "leading hyphen";
  if (s.endsWith("-")) return "trailing hyphen";
  if (s.includes("--")) return "doubled hyphen";
  return null;
}
