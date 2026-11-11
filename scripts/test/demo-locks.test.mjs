// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The dolt-grpc-demo locks are committed (cloister-2af014): the images are
// built reproducibly, so a clean build pins the same digests. These tests hold
// the COMMITTED locks to what the demo declares, through the real lock readers:
//   - every microvm bundle is pinned by sha256 and has a linux/arm64 rootfs row
//     imported from that pin, which `runtime plan` selects;
//   - the orders image is the same in both demos (same build, same digest);
//   - the published dolt pin is the digest build.sh pulls, and the one the
//     k8s manifest runs;
//   - each locally built bundle's cluster.toml entryPoint is the command its
//     apko config declares (the image and the plan cannot drift apart).
// Whether a rebuild reproduces the pins needs melange + apko + a container
// runtime, so it is `task demo:images:check`, not part of `task lint`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";

import { planFromToml } from "../../cli/commands/runtime-plan.mjs";
import { lockedRootfsRows } from "../../cli/lib/runtime/rootfs-lock.mjs";
import { isSha256Digest } from "../../cli/lib/oci-artifact.mjs";

const DEMO = join(import.meta.dirname, "../../tools/dolt-grpc-demo");
const DEMOS = ["microvm", "microvm-published"];
const ARM = "linux/arm64";

function demo(name) {
  const dir = join(DEMO, name);
  const toml = readFileSync(join(dir, "cluster.toml"), "utf8");
  const lock = parseToml(readFileSync(join(dir, "cluster.lock.toml"), "utf8"));
  const bundles = parseToml(toml).bundles.filter((b) => b.external?.executionMode === "microvm");
  return { dir, toml, lock, bundles };
}

for (const name of DEMOS) {
  test(`${name}: the committed lock pins every microvm bundle with a linux/arm64 row that plan selects`, async () => {
    const { toml, lock, bundles } = demo(name);
    assert.ok(bundles.length > 0);
    for (const bundle of bundles) {
      const oci = lock.inputs?.[bundle.name]?.oci;
      assert.ok(isSha256Digest(oci?.digest), `${bundle.name} is pinned by sha256`);
      assert.equal(oci.identifier, bundle.external.image, `${bundle.name}'s identifier is its declared image`);
      const rows = lockedRootfsRows(lock, bundle.name);
      const arm = rows.find((r) => r.platform === ARM);
      assert.ok(arm, `${bundle.name} has a ${ARM} row`);
      assert.equal(arm.image, oci.digest, `${bundle.name}'s row was imported from the pin`);
      const plan = await planFromToml(toml, lock, {
        bundle: bundle.name,
        workspace: "/w",
        controlSocket: `/tmp/${bundle.name}.sock`,
        env: "local",
        channelDir: "/tmp/ch",
        rootfsInCas: () => ({ present: true, casRoot: "/cas" }),
        guestPlatform: () => ARM,
      });
      // The plan carries the row's rootfs, not the image digest.
      assert.notEqual(plan.artifact.digest, oci.digest);
    }
  });
}

test("the orders image is the same build in both demos", () => {
  const [a, b] = DEMOS.map((n) => demo(n).lock.inputs.orders.oci);
  assert.equal(a.digest, b.digest);
  assert.deepEqual(lockedRootfsRows({ inputs: { orders: { oci: a } } }, "orders"), lockedRootfsRows({ inputs: { orders: { oci: b } } }, "orders"));
});

test("the published dolt pin is the digest build.sh pulls and k8s/dolt.yaml runs", () => {
  const pin = demo("microvm-published").lock.inputs.dolt.oci.digest;
  // lint-allow-rawparse: shell and k8s YAML carry the digest as plain text; this asserts it appears verbatim.
  const buildSh = readFileSync(join(DEMO, "microvm-published/build.sh"), "utf8");
  // lint-allow-rawparse: same — a verbatim-presence check, no structure read.
  const k8s = readFileSync(join(DEMO, "k8s/dolt.yaml"), "utf8");
  assert.ok(buildSh.includes(`DOLT_DIGEST=${pin}`), "build.sh pulls the pinned digest");
  assert.ok(k8s.includes(pin), "k8s/dolt.yaml runs the pinned digest");
});

// ── the image's entrypoint is the plan's ─────────────────────────────────

/**
 * The entrypoint apko-<bundle>.yaml declares. Only a bundle the demo builds
 * itself has one: pin-layouts records such a pin as `version = "local"`, a
 * published image as "published".
 */
function apkoEntrypoint(bundle) {
  const text = readFileSync(join(DEMO, "microvm", `apko-${bundle}.yaml`), "utf8");
  return parseYaml(text)?.entrypoint?.command ?? null;
}
const builtLocally = (lock, b) => lock.inputs?.[b.name]?.oci?.version === "local";

/** Built bundles whose cluster.toml entryPoint differs from their apko entrypoint. */
function entrypointDrift(lock, bundles) {
  const drift = [];
  for (const b of bundles.filter((x) => builtLocally(lock, x))) {
    const command = apkoEntrypoint(b.name);
    if (command !== b.external.entryPoint) {
      drift.push(`${b.name}: cluster.toml entryPoint ${b.external.entryPoint}, apko-${b.name}.yaml entrypoint ${command}`);
    }
  }
  return drift;
}

for (const name of DEMOS) {
  test(`${name}: every locally built bundle's entryPoint is its apko entrypoint`, () => {
    const { lock, bundles } = demo(name);
    assert.ok(bundles.some((b) => builtLocally(lock, b)), "at least one bundle is built by apko here");
    assert.deepEqual(entrypointDrift(lock, bundles), []);
  });
}

test("the entrypoint rail catches a drift", () => {
  const { lock, bundles } = demo("microvm");
  const drifted = bundles.map((b) => (b.name === "orders" ? { ...b, external: { ...b.external, entryPoint: "/orders" } } : b));
  assert.deepEqual(entrypointDrift(lock, drifted), ["orders: cluster.toml entryPoint /orders, apko-orders.yaml entrypoint /usr/bin/orders"]);
});
