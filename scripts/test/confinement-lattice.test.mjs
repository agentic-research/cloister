// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The confinement lattice, asserted as ALGEBRA rather than as examples.
//
// ADR-0068 claims that cloister does not need to implement a Trust Ratchet,
// because confinement/v1 is already a meet-semilattice and the ratchet is its
// meet. That claim is only worth anything if the laws actually hold — a `meet`
// that is not associative gives enforcement points that disagree depending on
// the order events reached them, which is precisely the bug the algebra is
// supposed to make impossible.
//
// So these are universally quantified over a corpus rather than checked at
// three hand-picked values (ADR-0067's quantifier point), and the corpus
// includes the REAL emitted documents, not only fixtures.
//
// The load-bearing one is `closure`: a meet of two valid confinement/v1
// documents must itself be a valid confinement/v1 document. Nothing else here
// would catch a meet that produced, say, `{"mode":"ro"}` — a spelling §2
// rejects — and that would be a ratchet whose narrowed state no runner accepts.
//
// ## What the quantified properties CANNOT tell you
//
// `leq` is defined as `a ∧ b = a`, so it is computed with the same `meet` it is
// checking. A `meet` that is wrong CONSISTENTLY — one that unions rights
// instead of intersecting them, say — still satisfies every law here, because
// both sides of each comparison are wrong in the same direction. Mutation
// testing confirmed exactly that: inverting the fs-path and rights meets left
// all the algebra green.
//
// So the two kinds of test here are not redundant and neither subsumes the
// other. The quantified properties check that the algebra is CONSISTENT — that
// enforcement points which saw the same events converge. The named tests below
// them check that it is CORRECT — that narrowing means what a reader thinks it
// means. Semantics come from the named ones; delete those and this file proves
// only that the implementation agrees with itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  meet, ratchet, leq, normalize, bottom, canonicalJson, CONFINEMENT_VERSION,
} from "../../cli/lib/harness/confinement-lattice.mjs";
import { confinementManifest } from "../../cli/lib/harness/launch.mjs";
import { validate } from "../lib/json-schema-subset.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCHEMA = JSON.parse(
  readFileSync(resolve(ROOT, "test/fixtures/llo-confinement-v1/confinement.schema.json"), "utf8"),
);

const V = CONFINEMENT_VERSION;

// The corpus. Two entries are the documents cloister actually emits; the rest
// exercise each dimension's interesting cases — nested prefixes, incomparable
// siblings, wildcard vs apex, the §6 rights lattice where `connect` and `bind`
// are incomparable atoms rather than a chain.
const CORPUS = [
  bottom(),
  confinementManifest(1),
  confinementManifest(3),
  { version: V, fs: { allow: ["/run/cloister/"] } },
  { version: V, fs: { allow: [{ path: "/run/cloister/", mode: "rw" }] } },
  { version: V, fs: { allow: ["/run/cloister/workspace/", "/etc/ssl/"] } },
  // Deliberately the SAME two subtrees in the opposite order, and likewise for
  // hosts below. Without a pair like this the corpus cannot distinguish an
  // order-sensitive meet from an order-independent one: every multi-grant meet
  // would inherit its ordering from one operand and agree with itself. Dropping
  // the sort inside `meetGrants` passed all seventeen properties until these
  // existed, which is the difference between a property and a property that can
  // fail.
  { version: V, fs: { allow: ["/etc/ssl/", "/run/cloister/"] } },
  { version: V, fs: { allow: [{ path: "/run/cloister/workspace/deep/", mode: "rw" }] } },
  { version: V, fs: { allow: ["/var/"] } },
  // Sibling paths that share a STRING prefix but not a SEGMENT prefix, and with
  // no trailing slash to make the distinction for us. Every other path in this
  // corpus ends in `/`, which silently hid the difference between a segment
  // test and `String.startsWith` — the mutation that degrades `covers` to a raw
  // prefix check passed everything until these two lines existed.
  { version: V, fs: { allow: ["/opt/tool"] } },
  { version: V, fs: { allow: ["/opt/toolkit/data"] } },
  // NESTED grants inside a single allow-list, plus a literal duplicate. Every
  // other document here lists siblings only, so `dropSubsumed` was never
  // reached and deleting it changed nothing. Redundant entries do not widen the
  // reach-set — but they do change the §7 bytes, which is enough to break
  // idempotence, and a canonical form that is not canonical is not one.
  { version: V, fs: { allow: ["/run/cloister/", "/run/cloister/workspace/"] } },
  { version: V, fs: { allow: [{ path: "/run/cloister/", mode: "rw" }, "/run/cloister/workspace/"] } },
  { version: V, fs: { allow: ["/var/", "/var/"] } },
  { version: V, network: { allowHosts: ["*.example.com", "api.example.com"] } },
  { version: V, network: { allowHosts: ["127.0.0.1"] } },
  { version: V, network: { allowHosts: ["*.example.com"] } },
  { version: V, network: { allowHosts: ["api.example.com", "example.com"] } },
  { version: V, network: { allowHosts: ["example.com", "127.0.0.1"] } },
  { version: V, network: { allowHosts: ["127.0.0.1", "*.example.com"] } },
  { version: V, network: { allowHosts: ["*.sub.example.com"] } },
  { version: V, port: { bind: 8443 } },
  { version: V, port: { bind: 8443, address: "0.0.0.0" } },
  { version: V, port: { bind: 8443, address: "10.0.0.5" } },
  { version: V, port: { bind: 9000, address: "10.0.0.5" } },
  { version: V, unixSocket: { allow: ["/run/cloister/shim.sock"] } },
  // A DIRECTORY in socket position. §2 documents its paths as prefixes; §6 says
  // only "Socket paths", and a socket is an endpoint rather than a subtree. With
  // one socket path in the corpus, exact-match and prefix-match agreed and the
  // difference was invisible.
  { version: V, unixSocket: { allow: ["/run/cloister/"] } },
  { version: V, unixSocket: { allow: [{ path: "/run/cloister/shim.sock", mode: "bind" }] } },
  { version: V, unixSocket: { allow: [{ path: "/run/cloister/shim.sock", mode: "connect-bind" }] } },
  { version: V, credentialSource: "keychain://cloister" },
  { version: V, credentialSource: "file:///etc/cloister/creds" },
  {
    version: V,
    fs: { allow: [{ path: "/run/cloister/workspace/", mode: "rw" }, "/etc/ssl/"] },
    network: { allowHosts: ["*.example.com", "127.0.0.1"] },
    port: { bind: 8443 },
    unixSocket: { allow: [{ path: "/run/cloister/shim.sock", mode: "connect-bind" }] },
    credentialSource: "keychain://cloister",
  },
];

const eq = (a, b) => canonicalJson(a) === canonicalJson(b);
const pairs = CORPUS.flatMap((a) => CORPUS.map((b) => [a, b]));

test("the corpus is not empty and includes the documents cloister really emits", () => {
  // Vacuity guard: every property below quantifies over CORPUS.
  assert.ok(CORPUS.length > 10, "corpus too small to quantify over");
  assert.ok(CORPUS.some((d) => eq(d, confinementManifest(1))), "1-root document missing");
  assert.ok(CORPUS.some((d) => eq(d, confinementManifest(3))), "3-root document missing");
});

test("closure — a meet of two valid documents is itself a valid document", () => {
  // The one that keeps the ratchet usable. A narrowed state a runner refuses is
  // worse than no narrowing: it fails at exec time, far from the event that
  // caused it.
  for (const [a, b] of pairs) {
    const errors = validate(meet(a, b), SCHEMA);
    assert.deepEqual(errors, [],
      `meet is not closed over confinement/v1:\n${canonicalJson(a)}\n∧\n${canonicalJson(b)}\n=\n${canonicalJson(meet(a, b))}\n${errors.join("\n")}`);
  }
});

test("idempotent — normalize(normalize(d)) == normalize(d)", () => {
  for (const d of CORPUS) {
    assert.ok(eq(normalize(normalize(d)), normalize(d)), `not idempotent: ${canonicalJson(d)}`);
  }
});

test("commutative — a ∧ b == b ∧ a", () => {
  for (const [a, b] of pairs) {
    assert.ok(eq(meet(a, b), meet(b, a)),
      `not commutative:\n${canonicalJson(meet(a, b))}\nvs\n${canonicalJson(meet(b, a))}`);
  }
});

test("associative — (a ∧ b) ∧ c == a ∧ (b ∧ c)", () => {
  // The property that lets enforcement points agree on an event SET rather than
  // an event ORDER, which is what removes AAM's synchronized-acknowledgment
  // requirement. If this fails, the ratchet needs consensus after all.
  for (const a of CORPUS) {
    for (const b of CORPUS) {
      for (const c of CORPUS) {
        assert.ok(eq(meet(meet(a, b), c), meet(a, meet(b, c))),
          `not associative on\n${canonicalJson(a)}\n${canonicalJson(b)}\n${canonicalJson(c)}`);
      }
    }
  }
});

test("decreasing — a ∧ b is at most as permissive as each side", () => {
  // "Can only narrow", as a theorem rather than a rule someone has to enforce.
  for (const [a, b] of pairs) {
    assert.ok(leq(meet(a, b), a), `meet not ≤ left:\n${canonicalJson(a)}`);
    assert.ok(leq(meet(a, b), b), `meet not ≤ right:\n${canonicalJson(b)}`);
  }
});

test("greatest lower bound — anything below both is below the meet", () => {
  // Distinguishes a real meet from merely "some smaller thing". Without it,
  // `meet` could return ⊥ always and every other property here would pass.
  for (const c of CORPUS) {
    for (const [a, b] of pairs) {
      if (leq(c, a) && leq(c, b)) {
        assert.ok(leq(c, meet(a, b)),
          `not a greatest lower bound:\n${canonicalJson(c)}\n≤ both, but not ≤\n${canonicalJson(meet(a, b))}`);
      }
    }
  }
});

test("bottom absorbs — a ∧ ⊥ == ⊥, and ⊥ is a valid document", () => {
  // Fail-closed without an error state: a conflict or a timeout resolves to a
  // document that denies everything and that a runner still accepts.
  assert.deepEqual(validate(bottom(), SCHEMA), []);
  for (const d of CORPUS) {
    assert.ok(eq(meet(d, bottom()), bottom()), `⊥ not absorbing for ${canonicalJson(d)}`);
  }
});

test("the order is reflexive and transitive", () => {
  for (const d of CORPUS) assert.ok(leq(d, d), `not reflexive: ${canonicalJson(d)}`);
  for (const a of CORPUS) {
    for (const b of CORPUS) {
      for (const c of CORPUS) {
        if (leq(a, b) && leq(b, c)) assert.ok(leq(a, c), "not transitive");
      }
    }
  }
});

test("the ratchet is order-independent and duplicate-insensitive", () => {
  // Same event set, three deliveries: in order, reversed, and with every event
  // delivered twice. All three must land on the same state, or two enforcement
  // points that saw the same events differently would enforce differently.
  const initial = CORPUS.at(-1);
  const events = [
    { version: V, network: { allowHosts: ["127.0.0.1"] } },
    { version: V, fs: { allow: ["/run/cloister/workspace/"] } },
    { version: V, port: { bind: 8443 } },
  ];
  const forward = ratchet(initial, events);
  assert.ok(eq(forward, ratchet(initial, [...events].reverse())), "ratchet is order-dependent");
  assert.ok(eq(forward, ratchet(initial, [...events, ...events])), "ratchet is not duplicate-safe");
  assert.deepEqual(validate(forward, SCHEMA), [], "ratcheted state is not a valid document");
});

test("every reachable ratchet state is below the INITIAL document", () => {
  // The commitment argument in ADR-0068. Because narrowing is monotone, the
  // reachable set is contained in the down-set of the initial document — so a
  // cert committing to the initial confinement already bounds every state the
  // run can reach, and the runner needs to check refinement rather than track
  // which events fired.
  const initial = CORPUS.at(-1);
  for (const a of CORPUS) {
    for (const b of CORPUS) {
      assert.ok(leq(ratchet(initial, [a, b]), initial),
        `ratcheted state escaped the initial commitment:\n${canonicalJson(ratchet(initial, [a, b]))}`);
    }
  }
});

test("widening is not expressible", () => {
  // The security claim, stated as the absence of a counterexample: no pair in
  // the corpus meets to something strictly more permissive than a side.
  for (const [a, b] of pairs) {
    const m = meet(a, b);
    assert.ok(!(leq(a, m) && !leq(m, a) && !eq(a, m) && !leq(a, b)),
      `meet widened past its left operand:\n${canonicalJson(a)}\n→\n${canonicalJson(m)}`);
  }
});

test("a read-write grant meets a read-only one down to read-only", () => {
  // The narrowing that matters most in practice, pinned by name rather than
  // left to the quantified properties: after a protected read, the workspace
  // should still be reachable and no longer writable.
  const rw = { version: V, fs: { allow: [{ path: "/run/cloister/workspace/", mode: "rw" }] } };
  const ro = { version: V, fs: { allow: ["/run/cloister/"] } };
  assert.deepEqual(meet(rw, ro), {
    version: V,
    fs: { allow: ["/run/cloister/workspace/"] },
  });
});

test("meeting two different bind ports removes the listener entirely", () => {
  // §4 spells "no listener" as an OMITTED block. `{bind: 0}` is not the
  // spelling for absence — that one shipped once already.
  const m = meet({ version: V, port: { bind: 8443 } }, { version: V, port: { bind: 9000 } });
  assert.equal(m.port, undefined, "expected the port block to be omitted, not zeroed");
  assert.deepEqual(validate(m, SCHEMA), []);
});

test("the canonical form carries no entry another entry already implies", () => {
  // Minimality. A grant covered by a broader one with at least its rights adds
  // nothing to the reach-set and only bytes to the digest.
  const nested = { version: V, fs: { allow: ["/run/cloister/", "/run/cloister/workspace/"] } };
  assert.deepEqual(normalize(nested), { version: V, fs: { allow: ["/run/cloister/"] } });
  // …but a NARROWER path with MORE rights is not implied and must survive.
  const escalating = { version: V, fs: { allow: ["/run/cloister/", { path: "/run/cloister/workspace/", mode: "rw" }] } };
  assert.deepEqual(normalize(escalating), {
    version: V,
    fs: { allow: ["/run/cloister/", { path: "/run/cloister/workspace/", mode: "rw" }] },
  });
  assert.deepEqual(normalize({ version: V, fs: { allow: ["/var/", "/var/"] } }),
    { version: V, fs: { allow: ["/var/"] } }, "a literal duplicate must collapse to one");
  // Hosts have the same obligation and a separate implementation, so they need
  // their own assertion — a wildcard already admits every name beneath it. This
  // one is not reachable from the algebra: dropping the host minimality filter
  // leaves a set that is stable under meet, so idempotence still holds and only
  // a direct check notices.
  assert.deepEqual(
    normalize({ version: V, network: { allowHosts: ["*.example.com", "api.example.com"] } }),
    { version: V, network: { allowHosts: ["*.example.com"] } },
  );
});

test("path containment is by segment — /opt/tool does not cover /opt/toolkit", () => {
  // A raw `startsWith` would call /opt/toolkit/data a child of /opt/tool and
  // keep the grant, handing the narrowed run a subtree neither operand allowed.
  // The narrowest kind of widening, and the easiest to write by accident.
  const tool = { version: V, fs: { allow: ["/opt/tool"] } };
  const toolkit = { version: V, fs: { allow: ["/opt/toolkit/data"] } };
  assert.equal(meet(tool, toolkit).fs, undefined, "disjoint subtrees must meet to no grant");
  // …while a genuine segment-child is still covered.
  assert.deepEqual(
    meet(tool, { version: V, fs: { allow: ["/opt/tool/bin"] } }).fs,
    { allow: ["/opt/tool/bin"] },
  );
});

test("two concrete bind addresses on one port meet to no listener", () => {
  // Distinct interfaces are incomparable, not nested scopes: there is no
  // address on which both declarations permit a listener. `0.0.0.0` is the
  // exception — it means every interface, so it is top and meets down.
  const loopback = { version: V, port: { bind: 8443 } };
  const lan = { version: V, port: { bind: 8443, address: "10.0.0.5" } };
  const all = { version: V, port: { bind: 8443, address: "0.0.0.0" } };
  assert.equal(meet(loopback, lan).port, undefined);
  assert.deepEqual(meet(all, lan).port, { bind: 8443, address: "10.0.0.5" });
  assert.deepEqual(meet(all, loopback).port, { bind: 8443 });
});

test("socket paths match exactly — a directory grant does not reach a socket inside it", () => {
  // §6 grants an endpoint, not a subtree, so `/run/cloister/` and
  // `/run/cloister/shim.sock` are different sockets rather than parent and
  // child. Reading §2's prefix rule across into §6 would hand the narrowed run
  // a socket neither operand named.
  const dir = { version: V, unixSocket: { allow: ["/run/cloister/"] } };
  const sock = { version: V, unixSocket: { allow: ["/run/cloister/shim.sock"] } };
  assert.equal(meet(dir, sock).unixSocket, undefined);
});

test("connect and bind are incomparable — their meet is no socket grant at all", () => {
  // §6's rights are a powerset, not a chain: a capability that dials a shim
  // wants connect, the shim wants bind, and nothing legitimately holds the
  // intersection.
  const connect = { version: V, unixSocket: { allow: ["/run/cloister/shim.sock"] } };
  const bind = { version: V, unixSocket: { allow: [{ path: "/run/cloister/shim.sock", mode: "bind" }] } };
  assert.equal(meet(connect, bind).unixSocket, undefined);
  assert.ok(eq(meet(connect, { version: V, unixSocket: { allow: [{ path: "/run/cloister/shim.sock", mode: "connect-bind" }] } }), connect));
});

test("meeting across contract versions is refused, not silently reconciled", () => {
  assert.throws(
    () => meet({ version: V }, { version: "cloister/confinement/v2" }),
    /two contracts/,
  );
});

test("canonicalJson sorts keys, indents by two, and adds no trailing newline", () => {
  // §7's contract. The digest itself is pinned against LLO's vector by
  // test/wire/confinement-digest.test.ts; this only pins that the lattice's
  // comparison uses the same shape, so `leq` cannot disagree with a digest.
  const out = canonicalJson({ version: V, port: { bind: 8443 }, fs: { allow: ["/a/"] } });
  assert.equal(out, [
    "{",
    '  "fs": {',
    '    "allow": [',
    '      "/a/"',
    "    ]",
    "  },",
    '  "port": {',
    '    "bind": 8443',
    "  },",
    `  "version": "${V}"`,
    "}",
  ].join("\n"));
  assert.ok(!out.endsWith("\n"));
});
