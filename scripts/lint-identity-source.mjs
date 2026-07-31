#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// lint:identity-source — identity and scopes crossing a bundle boundary must be
// DERIVED FROM A VERIFIED PROOF, never received as parameters.
//
// Filed from notme (cloister-99a85a) after a live instance was fixed there
// (notme-6ad276, notme PR #54). There is NO cloister instance today — this is a
// preventive rail in the `lint:lease-gate-source` / `lint:trust-env-locality`
// family, filed because the class is cheap to reintroduce and expensive to spot
// in review.
//
// ── The class ──────────────────────────────────────────────────────────────
//
// A handler reachable across a bundle boundary accepts `identity` or `scopes`
// as an inbound parameter:
//
//     async function handleThing({ identity, scopes, payload }) { … }
//
// This reads as plumbing. It is a trust inversion: the CALLER now asserts who it
// is and what it may do, and the handler believes it. Every check downstream is
// then evaluating the attacker's claim rather than a fact.
//
// The correct shape is that identity comes from verifying something the caller
// cannot forge — in cloister, `verifyAndUpsertLease` returns a `VerifiedLease`
// carrying peerFp + scope + cert DER, and THAT is what threads inward
// (cloister-492c08).
//
// ── Why a textual rail and not a type ──────────────────────────────────────
//
// A type would be better and is the right long-term answer: make `identity:
// string` unrepresentable at a boundary by having only `VerifiedLease` carry it.
// That is a refactor across the route surface. This rail costs one file and
// catches the reintroduction TODAY, which is the trade every other rail in this
// family made. When the type lands, delete this.
//
// ── Non-vacuity ────────────────────────────────────────────────────────────
//
// A rail that passes because it matches nothing is a comment. The shipped tree
// currently has zero instances — by design, this is preventive — so passing here
// proves nothing on its own. The companion test drives a FIXTURE that must fail,
// and asserts the allow-marker path works. That is where this rail's evidence
// lives; see scripts/test/lint-identity-source.test.mjs.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

/** Inline escape hatch, mirroring `lint-allow-silent` / `lint-allow-rawparse`. */
export const ALLOW_MARKER = "lint-allow-asserted-identity:";

/** Lines above a hit that may carry its marker + reason. */
export const ALLOW_LOOKBACK = 5;

/**
 * Parameter names that assert identity or authority.
 *
 * Deliberately NOT a substring match on "identity": `identityService`,
 * `identityUrl` and `notmeIdentity` are configuration, not assertions, and
 * flagging them would train people to add the marker reflexively — which is how
 * an escape hatch stops meaning anything.
 */
export const ASSERTED_NAMES = Object.freeze([
  "identity", "scopes", "callerIdentity", "callerScopes",
]);

// NOT included, and the omission is the point: `peerFp` and `subjectFp` are what
// verification PRODUCES — `VerifiedLease.peerFp`, `BundleAuthResult.subjectFp` —
// and they legitimately thread inward from there. Flagging them produced 75
// findings against a tree the filing bead says has ZERO instances, every one of
// them correct code. A rail that loud gets its marker pasted everywhere, which
// is how an escape hatch stops meaning anything.

/**
 * A parameter is only interesting when it is DECLARED INBOUND with a plain type.
 *
 * `identity: VerifiedLease` is the correct shape and must not be flagged —
 * the whole point is that identity arrives as a verified proof. So the pattern
 * matches primitive/collection annotations only.
 */
const ASSERTED_TYPES = "string|string\\[\\]|readonly string\\[\\]|number|unknown|any";

const PATTERNS = ASSERTED_NAMES.map((name) => ({
  name,
  re: new RegExp(`\\b${name}\\s*(\\?)?\\s*:\\s*(${ASSERTED_TYPES})\\b`),
}));

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|mts|mjs)$/.test(entry) && !/\.test\.[a-z]+$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Scan a tree for asserted-identity parameters.
 *
 * Exported so the companion test can drive a fixture directory rather than
 * asserting against src/ — which currently has no instances, and would make the
 * test pass for the wrong reason.
 *
 * @param {string} root
 * @returns {{file: string, line: number, name: string, text: string}[]}
 */
export function findAssertedIdentity(root) {
  const findings = [];
  for (const file of walk(root)) {
    // Generated code is not a hand-written handler; its shapes come from the
    // schema, and flagging them asks someone to annotate a file they must not
    // edit.
    if (relative(REPO_ROOT, file).includes("/generated/")) continue;

    const lines = readFileSync(file, "utf8").split("\n");
    // PARAMETER POSITION is the whole discriminator. `scopes: readonly string[]`
    // inside an interface is a response body describing what a capability
    // requires; the same text inside a signature's parens is a caller asserting
    // its own authority. Tracking paren depth separates them, and without it
    // this rail reported 75 findings on a tree with no instances.
    let depth = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const code = line.replace(/\/\/.*$/, "");
      // Depth AT THE MATCH, not for the line. A single-line signature has
      // balanced parens, so a line-level check skips `fn(identity: string)`
      // entirely — which is how the first version of this passed a fixture it
      // was written to fail.
      const depthAt = [];
      let d = depth;
      for (const ch of code) {
        depthAt.push(d);
        if (ch === "(") d++;
        else if (ch === ")") d = Math.max(0, d - 1);
      }
      const lineStartDepth = depth;
      depth = d;

      // Comments describing the rule are not violations of it.
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      for (const { name, re } of PATTERNS) {
        const m = re.exec(code);
        if (!m) continue;
        // Inside a parameter list at the point the name appears, or continuing
        // one opened on an earlier line.
        const atIdx = m.index < depthAt.length ? depthAt[m.index] : lineStartDepth;
        if (atIdx === 0) continue;
        const window = lines.slice(Math.max(0, i - ALLOW_LOOKBACK), i).join("\n");
        if (window.includes(ALLOW_MARKER)) continue;
        findings.push({
          file: relative(REPO_ROOT, file),
          line: i + 1,
          name,
          text: line.trim(),
        });
        break;
      }
    }
  }
  return findings;
}

function main() {
  const root = process.argv[2] ? resolve(process.argv[2]) : resolve(REPO_ROOT, "src");
  const findings = findAssertedIdentity(root);
  if (findings.length === 0) {
    process.stdout.write("lint-identity-source: clean ✓\n");
    process.stdout.write("  no boundary handler receives identity or scopes as a parameter\n");
    return;
  }
  process.stderr.write(
    `lint-identity-source: ${findings.length} asserted-identity parameter(s)\n\n`,
  );
  for (const f of findings) {
    process.stderr.write(`  ${f.file}:${f.line}\n    ${f.text}\n`);
  }
  process.stderr.write(
    "\n  Identity and scopes crossing a bundle boundary must be DERIVED FROM A\n" +
    "  VERIFIED PROOF, not received. A caller that supplies its own identity is\n" +
    "  asserting it, and every check downstream then evaluates the caller's claim\n" +
    "  rather than a fact.\n\n" +
    "  In cloister that proof is `VerifiedLease` from verifyAndUpsertLease\n" +
    "  (cloister-492c08) — thread THAT inward.\n\n" +
    `  If a parameter genuinely is not an authority claim, add\n` +
    `  "${ALLOW_MARKER} <reason>" within ${ALLOW_LOOKBACK} lines above it.\n`,
  );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
