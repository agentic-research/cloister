// SPDX-License-Identifier: AGPL-3.0-or-later
//
// lint:identity-source — cloister-99a85a, filed from notme after a live instance
// was fixed there (notme-6ad276, notme PR #54).
//
// ── Why the fixtures carry this file's weight ─────────────────────────────
//
// The shipped tree has ZERO instances, by design — this rail is preventive. So
// "it passes on src/" is not evidence; a rail matching nothing passes too. The
// FIXTURES are the evidence: one that must fail, one that must not, and the
// allow-marker path.
//
// The must-NOT-fail direction is the one that earns its keep here. A first cut
// of this rail reported 75 findings against src/ — every one correct code —
// because it matched `peerFp` and type members. A rail that loud gets its
// escape marker pasted everywhere, at which point it detects nothing while
// looking green.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { findAssertedIdentity, ALLOW_MARKER } from "../lint-identity-source.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function fixture(t, files) {
  const dir = mkdtempSync(join(tmpdir(), "identity-src-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

test("FAILS on a handler receiving identity + scopes as inbound parameters", (t) => {
  // The class, exactly as the filing bead describes it: the caller asserts who
  // it is and what it may do, and the handler believes it.
  const dir = fixture(t, {
    "handler.ts": `
export async function handleToolCall(
  toolName: string,
  identity: string,
  scopes: string[],
): Promise<Response> {
  return new Response(toolName + identity + scopes.join(","));
}
`,
  });
  const found = findAssertedIdentity(dir);
  const names = found.map((f) => f.name).sort();
  assert.deepEqual(names, ["identity", "scopes"], `expected both; got ${JSON.stringify(found)}`);
});

test("FAILS on a destructured parameter object too", (t) => {
  const dir = fixture(t, {
    "h.ts": `
export function handle(opts: { identity: string; scopes: readonly string[] }) {
  return opts;
}
`,
  });
  assert.ok(findAssertedIdentity(dir).length > 0, "a destructured assertion is still an assertion");
});

test("PASSES on identity carried as a VERIFIED PROOF", (t) => {
  // The correct shape must not be flagged, or the rail argues against its own
  // remedy.
  const dir = fixture(t, {
    "ok.ts": `
import type { VerifiedLease } from "./lease";
export async function handleToolCall(toolName: string, lease: VerifiedLease) {
  return new Response(toolName + lease.peerFp);
}
`,
  });
  assert.deepEqual(findAssertedIdentity(dir), []);
});

test("PASSES on a type MEMBER — the discriminator that killed 75 false positives", (t) => {
  // `scopes: readonly string[]` inside an interface is a response body saying
  // what a capability requires (src/routes/well-known.ts does exactly this).
  // The same text inside a signature's parens is an authority claim. Parameter
  // position is the whole difference.
  const dir = fixture(t, {
    "doc.ts": `
interface CapabilityDoc {
  readonly name:   string;
  readonly scopes: readonly string[];
}
export type R = { ok: true; identity: string } | { ok: false };
`,
  });
  assert.deepEqual(findAssertedIdentity(dir), [], "type members are not parameters");
});

test("PASSES with an inline allow marker carrying a reason", (t) => {
  const dir = fixture(t, {
    "allowed.ts": `
export function internalOnly(
  // ${ALLOW_MARKER} internal helper, never reachable across a bundle boundary
  identity: string,
) {
  return identity;
}
`,
  });
  assert.deepEqual(findAssertedIdentity(dir), []);
});

test("PASSES on generated code — it cannot be annotated and is not a handler", (t) => {
  const dir = fixture(t, {
    "generated/schema.ts": `export interface X { identity: string; }`,
  });
  assert.deepEqual(findAssertedIdentity(dir), []);
});

test("the SHIPPED tree is clean — and that is a claim, not the evidence", () => {
  // Asserted so a future change that introduces the class is caught. Stated as
  // secondary because a rail matching nothing would also pass this; the
  // fixtures above are what prove it matches the right thing.
  assert.deepEqual(
    findAssertedIdentity(resolve(ROOT, "src")), [],
    "src/ must not receive identity or scopes as boundary parameters",
  );
});
