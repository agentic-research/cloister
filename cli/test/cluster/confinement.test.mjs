// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A bundle placed "microvm" declares no confinement grant the microVM tier
// cannot apply (cli/lib/cluster/confinement.mjs, cloister-ca2582). Such a grant
// used to pass every gate, reach the launch plan, and be refused by the host
// runtime at launch: the shipped mache bundle counted as isolated and could not
// run. These hold the rule, and hold its one definition of "declared" to the
// generated schema.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { DIMENSIONS, declaredDimensions } from "../../lib/cluster/confinement.mjs";
import { loadClusterSchema } from "../../lib/cluster/cluster-schema.mjs";
import { parseTomlToCluster } from "../../lib/cluster/toml-to-cluster.mjs";
import { planFromToml } from "../../commands/runtime-plan.mjs";

const toml = ({ mode = "microvm", placement = "", confinement = "" } = {}) => `
[metadata]
name = "confinement-fixture"
version = "0.0.1"

[storage]
doStoragePath = "/data/do"

[[bundles]]
name = "tool"
kind = "external"
tier = "cluster"

[bundles.external]
entryPoint = "/usr/bin/tool"
executionMode = "${mode}"
${mode === "process" ? 'executionModeRationale = "a fixture"' : ""}
${confinement}
${placement}
`;

// One grant per dimension, with the remedy its refusal must name.
const GRANTS = {
  fs: ['[[bundles.confinement.fs.allow]]\npath = "/workspace"\nmode = "rw"', /workspace only through LLO's execution daemon/],
  network: ['[bundles.confinement.network]\nallowHosts = ["api.example.com"]', /LLO's broker \(ley-line-open-e2c5ce\)/],
  port: ["[bundles.confinement.port]\nbind = 7532", /declare the listener as a \[\[bundles\.ports\]\] entry/],
  credentialSource: ['[bundles.confinement]\ncredentialSource = "keychain://cloister/x"', /through a vault slice/],
};

test("the dimensions read here are exactly the generated schema's", async () => {
  const { ConfinementSchema } = await loadClusterSchema();
  const shape = ConfinementSchema?._def?.getter?.()?.shape ?? ConfinementSchema?.def?.getter?.()?.shape;
  assert.ok(shape, "the generated ConfinementSchema exposes its shape");
  // A dimension the schema gains must be added to DIMENSIONS (and given a
  // remedy), or this fails: a new grant is never silently "not declared".
  assert.deepEqual(DIMENSIONS.map(([key]) => key).sort(), Object.keys(shape).sort());
  assert.deepEqual(Object.keys(GRANTS).sort(), Object.keys(shape).sort(), "every dimension has a case below");
});

test("the deny-all default declares nothing, and each grant alone is declared", async () => {
  const none = (await parseTomlToCluster(toml())).bundles[0].confinement;
  assert.deepEqual(declaredDimensions(none), []);
  for (const [dimension, [snippet]] of Object.entries(GRANTS)) {
    const process = (await parseTomlToCluster(toml({ mode: "process", confinement: snippet }))).bundles[0];
    assert.deepEqual(declaredDimensions(process.confinement), [dimension], dimension);
  }
});

for (const [dimension, [snippet, remedy]] of Object.entries(GRANTS)) {
  test(`a microvm bundle declaring confinement.${dimension} is refused by cluster:toml and by runtime plan`, async () => {
    const implicit = toml({ confinement: snippet });
    const pattern = new RegExp(
      `bundle "tool" is placed "microvm" \\(executionMode = "microvm" with no placement rows, so in every env\\) and declares confinement\\.${dimension}\\.`,
    );
    await assert.rejects(parseTomlToCluster(implicit), pattern);
    await assert.rejects(parseTomlToCluster(implicit), remedy);
    await assert.rejects(parseTomlToCluster(implicit), /its only channels are the confinement\/v1 §6 grants/);
    await assert.rejects(planFromToml(implicit, {}, { bundle: "tool", workspace: "/w" }), pattern);

    // A placement row says "microvm" for one env: still refused, naming it.
    const placed = toml({ confinement: snippet, placement: '[[bundles.placements]]\nenv = "local"\nkind = "microvm"' });
    await assert.rejects(parseTomlToCluster(placed), /placed "microvm" \(env "local"\) and declares/);
  });
}

test("every grant a microvm bundle declares is named, with its remedy", async () => {
  const both = toml({ confinement: `${GRANTS.port[0]}\n\n${GRANTS.fs[0]}` });
  await assert.rejects(parseTomlToCluster(both), /declares confinement\.fs and confinement\.port\./);
  await assert.rejects(parseTomlToCluster(both), GRANTS.fs[1]);
  await assert.rejects(parseTomlToCluster(both), GRANTS.port[1]);
});

test("the rule is the microVM tier's: a process bundle, or an explicitly empty grant, is accepted", async () => {
  for (const [snippet] of Object.values(GRANTS)) {
    await parseTomlToCluster(toml({ mode: "process", confinement: snippet }));
  }
  // An empty list declares nothing, as the round trip already reads it.
  await parseTomlToCluster(toml({ confinement: "[bundles.confinement.network]\nallowHosts = []" }));
});
