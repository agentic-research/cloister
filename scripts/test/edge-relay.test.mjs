// SPDX-License-Identifier: AGPL-3.0-or-later
//
// expose = "edge" for microvm placements (cloister-991e65, ADR-0069 §1):
// cli/lib/cluster/edge-relay.mjs, with real sockets — a fake bind socket that
// echoes bytes stands in for the guest service.

import assert from "node:assert/strict";
import { test } from "node:test";
import { connect, createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EDGE_HOST, describeEdge, edgePorts, isEdge, openEdgeListeners } from "../../cli/lib/cluster/edge-relay.mjs";

/** A port nothing listens on right now (bind 0, read it, release it). */
async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen({ host: EDGE_HOST, port: 0 }, r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

const cluster = (ports) => ({ bundles: [{ name: "dolt", ports }, { name: "orders", ports: [] }] });
const port = (name, number, expose) => ({ name, port: number, appProtocol: "art.mysql", expose });

test("only expose = \"edge\" is published on the host: cluster and none are not", () => {
  assert.equal(isEdge({ expose: "edge" }), true);
  for (const expose of ["cluster", "none", ""]) assert.equal(isEdge({ expose }), false, expose);
  const edges = edgePorts(
    cluster([port("mysql", 3306, "edge"), port("admin", 3307, "cluster"), port("metrics", 9090, "none"), port("x", 9091, "")]),
    ["dolt", "orders"],
    "/c",
  );
  assert.deepEqual(edges, [{ bundle: "dolt", name: "mysql", port: 3306, appProtocol: "art.mysql", socketPath: "/c/dolt.mysql.sock" }]);
  assert.equal(describeEdge(edges[0]), "edge: 127.0.0.1:3306 → dolt.mysql (art.mysql)");
  // A bundle `up` does not start publishes nothing.
  assert.deepEqual(edgePorts(cluster([port("mysql", 3306, "edge")]), ["orders"], "/c"), []);
});

test("two bundles publishing one host port are refused by name", () => {
  const c = { bundles: [
    { name: "a", ports: [port("p", 7000, "edge")] },
    { name: "b", ports: [port("q", 7000, "edge")] },
  ] };
  assert.throws(() => edgePorts(c, ["a", "b"], "/c"), /host port 127\.0\.0\.1:7000 is wanted by both a\.p and b\.q \(expose = "edge"\)/);
});

test("a busy host port is refused by name, and nothing stays bound", async (t) => {
  const busy = await freePort();
  const free = await freePort();
  const holder = createServer();
  await new Promise((r) => holder.listen({ host: EDGE_HOST, port: busy }, r));
  t.after(() => holder.close());
  const edges = [
    { bundle: "orders", name: "grpc", port: free, appProtocol: "art.grpc", socketPath: "/nowhere" },
    { bundle: "dolt", name: "mysql", port: busy, appProtocol: "art.mysql", socketPath: "/nowhere" },
  ];
  await assert.rejects(
    openEdgeListeners(edges, { errLog: () => {} }),
    new RegExp(`host port 127\\.0\\.0\\.1:${busy} is already in use, and bundle "dolt" port "mysql" \\(expose = "edge"\\) publishes on it\\. Nothing was started\\.`),
  );
  // The listener that DID bind first was closed again.
  const again = createServer();
  await new Promise((resolve, reject) => { again.once("error", reject); again.listen({ host: EDGE_HOST, port: free }, resolve); });
  await new Promise((r) => again.close(r));
});

// On macOS a loopback bind succeeds while the same user listens on a wildcard
// address (SO_REUSEADDR), which silently took the port from that holder.
for (const [label, listenArgs] of [
  ["Node's default address", []],
  ["0.0.0.0", ["0.0.0.0"]],
  ["::", ["::"]],
]) {
  test(`a port held on ${label} is refused by name, nothing stays bound, and the holder keeps it`, async (t) => {
    const holder = createServer((c) => c.end("held"));
    const bound = await new Promise((resolve) => {
      holder.once("error", (e) => resolve(e));
      holder.listen(0, ...listenArgs, () => resolve(null));
    });
    if (bound) {
      t.skip(`cannot bind ${label} on this host: ${bound.code}`);
      return;
    }
    t.after(() => holder.close());
    const held = holder.address().port;
    const free = await freePort();
    const edges = [
      { bundle: "orders", name: "grpc", port: free, appProtocol: "art.grpc", socketPath: "/nowhere" },
      { bundle: "dolt", name: "mysql", port: held, appProtocol: "art.mysql", socketPath: "/nowhere" },
    ];
    await assert.rejects(
      openEdgeListeners(edges, { errLog: () => {} }),
      new RegExp(`host port 127\\.0\\.0\\.1:${held} is already in use, and bundle "dolt" port "mysql" \\(expose = "edge"\\) publishes on it\\. Nothing was started\\.`),
    );
    // The listener that bound first was released; the holder still serves.
    const again = createServer();
    await new Promise((resolve, reject) => { again.once("error", reject); again.listen({ host: EDGE_HOST, port: free }, resolve); });
    await new Promise((r) => again.close(r));
    assert.equal(await exchange(held, ""), "held", "the holder still serves its port");
  });
}

test("listeners bind loopback only, relay bytes after activation, and free the port on close", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "edge-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const socketPath = join(dir, "dolt.mysql.sock");
  const echo = createServer((c) => c.pipe(c));
  await new Promise((r) => echo.listen(socketPath, r));
  t.after(() => echo.close());
  const p = await freePort();
  const [l] = await openEdgeListeners([{ bundle: "dolt", name: "mysql", port: p, appProtocol: "art.mysql", socketPath }], { errLog: () => {} });
  try {
    assert.equal(l.address().address, "127.0.0.1", "never 0.0.0.0");

    // Before activation (bundle not bound yet): the connection is closed, no bytes.
    const early = await exchange(p, "early");
    assert.equal(early, "");

    l.activate();
    assert.equal(await exchange(p, "hello over tcp"), "hello over tcp");
  } finally {
    await l.close();
  }
  await assert.rejects(exchange(p, "x"), /ECONNREFUSED/, "nothing listens after close");
});

test("a relay whose bind socket is gone closes the client, and says why", async () => {
  const p = await freePort();
  const errors = [];
  const [l] = await openEdgeListeners([{ bundle: "dolt", name: "mysql", port: p, appProtocol: "art.mysql", socketPath: "/nonexistent/dolt.mysql.sock" }], { errLog: (m) => errors.push(m) });
  try {
    l.activate();
    assert.equal(await exchange(p, "x"), "");
    assert.match(errors.join("\n"), /edge: 127\.0\.0\.1:\d+ → dolt\.mysql \(art\.mysql\): connect ENOENT/);
  } finally {
    await l.close();
  }
});

/** Send `text`, half-close, and collect everything until the peer closes. */
function exchange(p, text) {
  return new Promise((resolve, reject) => {
    const s = connect({ host: EDGE_HOST, port: p });
    let got = "";
    s.setEncoding("utf8");
    s.on("connect", () => { s.end(text); });
    s.on("data", (d) => { got += d; });
    s.on("error", (e) => (e.code === "ECONNRESET" || e.code === "EPIPE" ? resolve(got) : reject(e)));
    s.on("close", () => resolve(got));
  });
}
