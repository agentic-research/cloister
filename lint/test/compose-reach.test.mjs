// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The gateway's image dials some of its backends at a fixed loopback address
// (config.capnp: `external = ( address = "127.0.0.1:<port>" )`). Under compose
// a backend is at the gateway's loopback only if its container joins the
// gateway's network namespace. Nothing tied the two together: a bundle given a
// network of its own would be emitted without complaint, and the gateway would
// dial 127.0.0.1 and find nothing (ADR-0075 §8).
//
// This holds them together for the shipped tree: every bundle the compose file
// runs whose `httpPort` is one the gateway dials at loopback must join the
// gateway's namespace there.
//
// It reads config.capnp by pattern because nothing in this repository parses
// capnp text, and it fails rather than passes if the pattern finds nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { composeView, namespaceHosts } from "../../cli/lib/cluster/compose-placement.mjs";
import { parseTomlToCluster } from "../../cli/lib/cluster/toml-to-cluster.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** `name → port` for every service config.capnp reaches at a loopback address. */
function loopbackServices(configText) {
  const found = new Map();
  // lint-allow-rawparse: .capnp has no parser in this repository (structured-parse exempts it).
  for (const m of configText.matchAll(/\(\s*name\s*=\s*"([^"]+)",\s*external\s*=\s*\(\s*address\s*=\s*"(?:127\.0\.0\.1|localhost):(\d+)"/g)) {
    found.set(m[1], Number(m[2]));
  }
  return found;
}

test("a backend the gateway dials at loopback joins the gateway's network namespace under compose", async () => {
  const services = loopbackServices(readFileSync(resolve(ROOT, "config.capnp"), "utf8"));
  assert.ok(services.size >= 3, "config.capnp's loopback backends were found");
  assert.equal(services.get("mache-mcp"), 7532, "the one this was written for is among them");

  const cluster = await parseTomlToCluster(readFileSync(resolve(ROOT, "cluster.toml"), "utf8"));
  const view = composeView(cluster);
  const gateway = view.cluster.bundles.find((b) => b.workerdServiceName !== "" && b.kind?.external);
  assert.ok(gateway, "the compose cluster runs the gateway");
  const hosts = namespaceHosts(view.cluster, view.env);

  let checked = 0;
  for (const b of view.cluster.bundles) {
    const port = b.kind?.external?.httpPort ?? 0;
    if (b.name === gateway.name || port === 0) continue;
    const dialled = [...services].filter(([, p]) => p === port).map(([name]) => name);
    if (dialled.length === 0) continue;
    checked += 1;
    assert.equal(
      hosts.get(b.name),
      gateway.name,
      `config.capnp reaches ${dialled.join(", ")} at 127.0.0.1:${port}, which is "${b.name}"'s httpPort. ` +
        `Under compose that is "${gateway.name}"'s own loopback, so "${b.name}" must declare ` +
        `sharesNetworkOf = "${gateway.name}" on its compose placement, or the gateway cannot reach it`,
    );
  }
  assert.ok(checked >= 1, "at least one compose bundle is dialled at loopback, so this checked something");
});

test("the pattern reads what it is meant to, and nothing else", () => {
  const found = loopbackServices(`
    ( name = "a", external = ( address = "127.0.0.1:7532", http = () ), ),
    ( name = "b",
      external = ( address = "localhost:9000", http = () ),
    ),
    ( name = "c", external = ( address = "10.0.0.5:80", http = () ), ),
    ( name = "d", network = ( allow = ["public"] ), ),
  `);
  assert.deepEqual([...found], [["a", 7532], ["b", 9000]]);
});
