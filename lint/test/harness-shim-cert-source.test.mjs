// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `CertSource` may be async (cloister-f2338f). The type change is only half the
// claim — these assert the runtime half, because the interesting cases are the
// ones the old signature made unreachable:
//
//   1. an async source is actually awaited, not passed to the signer as a
//      Promise (which would fail far from the cause);
//   2. a source that REJECTS becomes the shim's 502, not an unhandled rejection;
//   3. a source that throws SYNCHRONOUSLY does too — this is the one that used
//      to escape, because `source()` was evaluated as an argument rather than
//      inside the promise chain whose `.catch` writes the 502.
//
// Case 3 is the regression this file exists for. It was latent while the only
// source read three env vars at startup and could not fail per request; a
// notme-minting source can fail on any request.
//
// node:test under the tsx loader, NOT vitest: the shim is a host-side Node
// program (ADR-0033 — workerd cannot spawn processes) and cloister's whole
// vitest suite runs inside real workerd, where `node:http.createServer` throws
// "not implemented". Same reasoning as test:cluster-toml.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createShimServer } from "../../src/harness-shim/index.ts";

/** @typedef {import("../../src/harness-shim/lease-signer.ts").EphemeralIdentity} EphemeralIdentity */

/**
 * REAL Ed25519 key material, generated once and pinned — not a placeholder.
 *
 * That distinction is what makes the async test non-vacuous. With junk bytes the
 * signer rejects them ("Invalid keyData") and every case 502s for the same
 * reason, so "an un-awaited Promise reaches the signer" and "an identity reaches
 * the signer" are indistinguishable — the test would pass either way. With a
 * usable key, signing SUCCEEDS and the 502 comes from the unreachable upstream;
 * a Promise in its place fails at the signer instead. The two outcomes separate.
 *
 * Obviously not a secret: generated for this file, used nowhere else, and the
 * cert it pairs with is not a real cert — nothing verifies the chain here.
 *
 * @type {EphemeralIdentity}
 */
const IDENTITY = {
  certB64: "Y2VydA",
  privSeedB64: "JCf735vyJ_CotXD1DuCiuuOkozyUlCpA6XdZ-87qWEI",
  pubKeyB64: "UCpF_Di0jnTp0EoFJ-wT2ZNR1kJmXAwTPqanYELTSZE",
};

/**
 * Drive one real request through a shim server on an ephemeral port.
 *
 * `cloisterBaseUrl` is deliberately unreachable: these assert cert-source
 * behaviour, which resolves BEFORE any upstream dial. A request that SUCCEEDED
 * would mean the test needed a live cloister, i.e. it was testing the proxy.
 * So 502 is the expected terminal status in every case here, and the status is
 * never the whole assertion — each test also pins what happened on the way.
 *
 * Captures the shim's operator-facing `console.error` so a test can assert WHY
 * a 502 happened. Without that, every failure mode here looks identical from the
 * outside — the shim deliberately returns one opaque body so it never leaks
 * internals to the harness, which is right for the harness and useless for a
 * test trying to distinguish "signing failed" from "upstream unreachable".
 *
 * @param {() => any} source
 * @returns {Promise<{status: number, body: string, failure: string}>}
 */
async function request(source) {
  const server = createShimServer(
    {
      port: 0,
      cloisterBaseUrl: "http://127.0.0.1:1",
      identity: IDENTITY,
      preserveAuth: false,
    },
    source,
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const realError = console.error;
  let failure = "";
  console.error = (...args) => {
    failure = args.map(String).join(" ");
  };
  try {
    const res = await fetch(`http://127.0.0.1:${port}/vault/proxy/svc/v1/messages`, {
      method: "POST",
      body: "{}",
      // A deadline, because the failure this file guards is NO RESPONSE, not a
      // wrong one: revert `await source()` back to an argument and a
      // synchronously-throwing source escapes the `.catch`, so nothing ever
      // writes a status and the request hangs forever. Verified by doing exactly
      // that — without this the suite hung instead of failing, which is a worse
      // signal than red and indistinguishable from an unrelated deadlock.
      signal: AbortSignal.timeout(5_000),
    });
    return { status: res.status, body: await res.text(), failure };
  } finally {
    console.error = realError;
    await new Promise((r) => server.close(r));
  }
}

test("an async source is awaited, not handed to the signer as a Promise", async () => {
  let resolved = null;
  const source = async () => {
    // Where a real notme source mints over the network. A resolved promise is
    // the same shape as far as the call site is concerned.
    await Promise.resolve();
    resolved = IDENTITY;
    return IDENTITY;
  };
  const { status, failure } = await request(source);
  // `resolved` would be set even if the Promise were never awaited, so it is not
  // the assertion by itself — it pins only that the source RAN. The load-bearing
  // half is `failure`: signing SUCCEEDED and the request died dialling the
  // unreachable upstream. Hand `signLeaseHeaders` a Promise instead and it dies
  // at "Invalid keyData", which is what the second assertion excludes.
  assert.deepEqual(resolved, IDENTITY, "the async source must have been invoked");
  assert.equal(status, 502);
  assert.doesNotMatch(
    failure,
    /keyData|key/i,
    `signing must have succeeded — got a key error (${failure}), which is what an ` +
      `un-awaited Promise reaching the signer looks like`,
  );
});

test("a REJECTED source becomes a 502, not an unhandled rejection", async () => {
  const source = async () => {
    throw new Error("notme mint refused: session expired");
  };
  const { status, body } = await request(source);
  assert.equal(status, 502);
  assert.deepEqual(JSON.parse(body), { error: "shim_failure" });
});

test("a SYNCHRONOUSLY throwing source becomes a 502 as well", async () => {
  // The regression. With `handleRequest(cfg, source(), ...)` this throw was
  // raised while evaluating the argument, so it never entered the promise whose
  // `.catch` writes the 502 — the request died with no response at all.
  const source = () => {
    throw new Error("HARNESS_SHIM_CERT_B64 is required");
  };
  const { status, body } = await request(source);
  assert.equal(status, 502);
  assert.deepEqual(JSON.parse(body), { error: "shim_failure" });
});

test("a plain synchronous source still works — envCertSource is unchanged", async () => {
  let calls = 0;
  const source = () => {
    calls += 1;
    return IDENTITY;
  };
  const { status } = await request(source);
  assert.equal(calls, 1, "the source is consulted once per request");
  assert.equal(status, 502);
});
