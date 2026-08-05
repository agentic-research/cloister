// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Companion test for lint:sibling-bead-refs.
//
// The rail exists because a sibling repo's ADR named an OPEN cloister bead and
// nothing surfaced it (cloister-043eb8 / ley-line-open ADR-0035 §4). So the
// property that matters is not "the rail runs" — it is "the rail FAILS on the
// exact state that existed the day the mistake was made." That state is
// reconstructed below against the real sibling checkout, with only the bead
// STATUS injected, so the test proves the scanner really finds the reference in
// the tree rather than in a fixture.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import {
  adrDirs,
  beadStatus,
  collectRefs,
  lloRoot,
  main,
  acknowledges,
} from "../lint-sibling-bead-refs.mjs";

const ROOT = lloRoot();
const HAVE_SIBLING = existsSync(ROOT) && adrDirs(ROOT).length > 0;
const skip = HAVE_SIBLING ? false : "no ley-line-open checkout";

function capture() {
  const out = [];
  return { out, log: (...a) => out.push(a.join(" ")), err: (...a) => out.push(a.join(" ")) };
}

test("the sibling checkout really does reference cloister beads by id", { skip }, () => {
  // Guards the whole suite against passing vacuously: if the scan found nothing,
  // every assertion below would be trivially satisfied.
  const refs = collectRefs(adrDirs(ROOT));
  assert.ok(
    refs.size > 0,
    "expected at least one cloister-<hex> reference in ley-line-open's ADRs; " +
      "if this fails the scanner is broken, not the sibling repo",
  );
  for (const id of refs.keys()) assert.match(id, /^cloister-[0-9a-f]{6}$/);
});

test("an OPEN bead named by a sibling ADR fails the rail", { skip }, () => {
  // The 2026-08-03 state, reconstructed: every referenced bead reported open.
  const { out, log, err } = capture();
  const code = main({ log, err, run: (id) => `BEAD ${id} P1 design open` });

  assert.equal(code, 1, "a sibling ADR naming an open bead must fail the gate");
  const text = out.join("\n");
  assert.match(text, /decides work we hold OPEN/);
  // The message must carry the incident, not just the rule — a bare "FAIL" here
  // tells the next person nothing about why looking is cheaper than designing.
  assert.match(text, /ley-line-open ADR-0035/);
});

test("closed beads are silent — the normal end state does not nag", { skip }, () => {
  const { out, log, err } = capture();
  const code = main({ log, err, run: (id) => `BEAD ${id} P1 design closed` });

  assert.equal(code, 0);
  const text = out.join("\n");
  assert.match(text, /clean/);
  assert.doesNotMatch(text, /FAIL/);
});

test("a bead the store never had is reported but does NOT fail our gate", { skip }, () => {
  // Dangling cross-repo references are the sibling's rot. Failing cloister's
  // gate on an id that never existed here trains people to bypass the gate.
  const { out, log, err } = capture();
  const code = main({
    log,
    err,
    run: () => { throw new Error("bead not found in repo cloister"); },
  });

  assert.equal(code, 0, "a dangling sibling reference must not fail our build");
  assert.match(out.join("\n"), /does not\s+exist in this store/);
});

test("beadStatus reads the real store and survives ANSI colouring", { skip }, () => {
  // rsry colours its output; a naive /open/ match against the raw bytes would
  // still work, so assert against a line that is coloured the way rsry does it.
  const coloured = "  \x1b[2mcloister-043eb8\x1b[0m \x1b[33mP1\x1b[39m design \x1b[2mclosed\x1b[0m";
  assert.equal(beadStatus("cloister-043eb8", () => coloured), "closed");
  assert.equal(
    beadStatus("cloister-043eb8", () => coloured.replace("closed", "open")),
    "open",
  );
  assert.equal(
    beadStatus("cloister-043eb8", () => { throw new Error("not found"); }),
    "missing",
  );
});

test("the shipped tree satisfies the rail", { skip }, () => {
  // The rail must be true of cloister as it stands, not only of fixtures —
  // otherwise it could ship broken and nobody would know until it first fired.
  const { log, err } = capture();
  assert.equal(main({ log, err }), 0);
});

test("a missing sibling checkout skips cleanly instead of failing CI", () => {
  const { out, log, err } = capture();
  const code = main({ env: { CLOISTER_LLO_ROOT: "/nonexistent/ley-line-open" }, log, err });

  assert.equal(code, 0);
  assert.match(out.join("\n"), /SKIPPED/);
});

// ── the acknowledgement path (found while clearing LLO ADR-0037) ──────────
//
// The rail's own error message offered two clearances — close it, or comment
// saying why it does not resolve the question — and implemented only the first.
// So the only way to green was to CLOSE a bead that was not done, which is the
// record-destroying move the rail exists to prevent. These pin both directions.

test("a comment NAMING the sibling ADR clears an open bead", () => {
  const files = new Set(["0037-naming-the-proxy-channel.md"]);
  assert.equal(
    acknowledges("cloister-x", files, () => "read ADR-0037; it cites us but does not decide this"),
    true,
  );
  // …and the filename stem works as well as the ADR-NNNN form.
  assert.equal(
    acknowledges("cloister-x", files, () => "see 0037-naming-the-proxy-channel for context"),
    true,
  );
});

test("a comment that does NOT name the ADR is not an acknowledgement", () => {
  // Otherwise any comment at all would clear the rail, and "somebody read the
  // sibling's decision" — the whole property — would go unchecked.
  const files = new Set(["0037-naming-the-proxy-channel.md"]);
  assert.equal(acknowledges("cloister-x", files, () => "still working on this"), false);
  assert.equal(acknowledges("cloister-x", files, () => "acknowledged"), false);
});

test("EVERY citing ADR must be named, not just one", () => {
  // A bead cited by two sibling ADRs is two unread decisions. Naming one and
  // staying silent on the other would clear the rail while half the point of
  // it went unmet.
  const files = new Set(["0037-naming-the-proxy-channel.md", "0035-confinement.md"]);
  assert.equal(acknowledges("cloister-x", files, () => "read ADR-0037"), false);
  assert.equal(acknowledges("cloister-x", files, () => "read ADR-0037 and ADR-0035"), true);
});

test("an unreadable comment store is NOT an acknowledgement", () => {
  // Fail closed: if we cannot show somebody read it, we have not shown it.
  assert.equal(
    acknowledges("cloister-x", new Set(["0037-x.md"]), () => { throw new Error("no store"); }),
    false,
  );
});
