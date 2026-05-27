/// <reference types="@cloudflare/vitest-pool-workers/types" />
// build-cache/v1 conformance harness — cloister-667ea6.
//
// Loads the committed `cloister-spec/build-cache/v1/vectors/` fixtures
// and runs the conformance contract from cloister-spec/build-cache/v1/
// README.md §"Conformance test":
//
//   for every file in vectors/ (chunks + config + manifest):
//     1. provider accepts POST/PUT with claimed digest sha256:<blake3-hex>
//     2. provider returns the SAME bytes on a subsequent GET by that digest
//
// The vectors are produced deterministically by LLO's
// `gen_build_cache_vectors` example (rs/ll-core/schema-capnp/examples/).
// Two runs on different machines produce byte-equal output, so the
// committed fixtures are the conformance contract.

import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { blake3Hex as blake3HexCas } from "../../src/wire/cas-hash.js";
import { OciRegistryRoute } from "../../src/routes/oci-registry.js";

// ── Vectors ──────────────────────────────────────────────────────────────
//
// Base64-encoded byte-for-byte copies of `cloister-spec/build-cache/v1/
// vectors/*` files. The sanity-check describe block below asserts each
// decoded buffer matches the expected size + BLAKE3 in digests.json — if
// that fails, the fixtures regenerated and these constants need updating.

const VECTORS_B64: Record<string, string> = {
  "chunk-001.bin":
    "Ly8gR0VORVJBVEVEIENIVU5LIDAwMSAtIGNsb2lzdGVyL2J1aWxkLWNhY2hlL3YxIGNvbmZvcm1hbmNlIHZlY3RvcgovLyBTb3VyY2U6IHNyYy9tYWluLmdvLCBraW5kPWdvLXNvdXJjZQovLyBUaGlzIGlzIGZhdXggcGFyc2Ugb3V0cHV0OyByZWFsIGNodW5rcyB3b3VsZCBiZSBjYXBucC1lbmNvZGVkCi8vIF9hc3QgdGFibGVzIGZyb20gbWFjaGUuIFRoZSBwb2ludCBvZiB0aGlzIGZpeHR1cmUgaXMgdGhlCi8vIGhhc2ggY2hhaW4sIG5vdCB0aGUgY2h1bmsgZm9ybWF0Lgo=",
  "chunk-002.bin":
    "Ly8gR0VORVJBVEVEIENIVU5LIDAwMiAtIGNsb2lzdGVyL2J1aWxkLWNhY2hlL3YxIGNvbmZvcm1hbmNlIHZlY3RvcgovLyBTb3VyY2U6IHNyYy9hdXRoLmdvLCBraW5kPWdvLXNvdXJjZQovLyBGYXV4IHBhcnNlIG91dHB1dCAoc2VlIGNodW5rLTAwMS5iaW4gZm9yIHJhdGlvbmFsZSkuCg==",
  "lockfile-config.bin":
    "AAAAAEgAAAAAAAAAAAAEAAwAAAABAAQAUQAAAEcAAADhAAAAFwAAAPgAAAAAAAEAALiEEZcBAAANAAAAMgAAAA0AAAAyAAAADQAAADIAAAANAAAAJwAAAG1hY2hlAAAAMC43LjEAAAAwLjEuMAAAAAgAAAAAAAIADQAAAHoAAAARAAAAOgAAABEAAAA6AAAAEQAAADIAAAB0cmVlLXNpdHRlci1nbwAAMC4yMS4wAABibGFrZTMAADEuNS4wAAAACAAAAAAABAAdAAAAYgAAACAAAAAAAAEAMAAAAAAAAQBBAAAAUgAAAEUAAABiAAAASAAAAAAAAQBYAAAAAAABAGkAAABSAAAAc3JjL21haW4uZ28AAAAAAAEAAAACAQAAx1laHUJJY1Un3rKp22sum03DPJRqkw+QTrXa/Xyp/0gBAAAAAgEAAL/H/rE4LFDfxuOJqptMZgjKmhjQBLhLaVnGJEUNpS9qZ28tc291cmNlAAAAAAAAAHNyYy9hdXRoLmdvAAAAAAABAAAAAgEAAA5uSg0gpYIK714HzS7s6ugXA0jAdqLrNXnjIjxFsvgcAQAAAAIBAAB+FJNP04yu4lFza+RQucTjI970KSYzqskWesfHaB28N2dvLXNvdXJjZQAAAAAAAAAEAAAAAAACAAUAAABiAAAACQAAAGIAAABzcmMvbWFpbi5nbwAAAAAAc3JjL2F1dGguZ28AAAAAAAEAAAACAQAABfhjxB8PZ1puXiu5k7lVCkumVjq21fF3APF+NrPUdrg=",
  "manifest.json":
    "ewogICJzY2hlbWFWZXJzaW9uIjogMiwKICAibWVkaWFUeXBlIjogImFwcGxpY2F0aW9uL3ZuZC5vY2kuaW1hZ2UubWFuaWZlc3QudjEranNvbiIsCiAgImNvbmZpZyI6IHsKICAgICJtZWRpYVR5cGUiOiAiYXBwbGljYXRpb24vdm5kLmNsb2lzdGVyLmJ1aWxkLWNhY2hlLnYxLmNvbmZpZytqc29uIiwKICAgICJkaWdlc3QiOiAic2hhMjU2OjFhOGY5M2MxNjNjODM2YWVjYWUyZmQzZTMzYjAzNjQ0Mzk5YzA4ODg0NzRlOWQ3YjJjMWY2MTg3N2U4ZjhjNDkiLAogICAgInNpemUiOiA1ODQKICB9LAogICJsYXllcnMiOiBbCiAgICB7CiAgICAgICJtZWRpYVR5cGUiOiAiYXBwbGljYXRpb24vdm5kLmNsb2lzdGVyLmJ1aWxkLWNhY2hlLnYxLmNodW5rIiwKICAgICAgImRpZ2VzdCI6ICJzaGEyNTY6YmZjN2ZlYjEzODJjNTBkZmM2ZTM4OWFhOWI0YzY2MDhjYTlhMThkMDA0Yjg0YjY5NTljNjI0NDUwZGE1MmY2YSIsCiAgICAgICJzaXplIjogMjY5LAogICAgICAiYW5ub3RhdGlvbnMiOiB7CiAgICAgICAgIm9yZy5jbG9pc3Rlci5idWlsZC1jYWNoZS5raW5kIjogImdvLXNvdXJjZSIsCiAgICAgICAgIm9yZy5jbG9pc3Rlci5idWlsZC1jYWNoZS5wYXRoIjogInNyYy9tYWluLmdvIgogICAgICB9CiAgICB9LAogICAgewogICAgICAibWVkaWFUeXBlIjogImFwcGxpY2F0aW9uL3ZuZC5jbG9pc3Rlci5idWlsZC1jYWNoZS52MS5jaHVuayIsCiAgICAgICJkaWdlc3QiOiAic2hhMjU2OjdlMTQ5MzRmZDM4Y2FlZTI1MTczNmJlNDUwYjljNGUzMjNkZWY0MjkyNjMzYWFjOTE2N2FjN2M3NjgxZGJjMzciLAogICAgICAic2l6ZSI6IDE2MywKICAgICAgImFubm90YXRpb25zIjogewogICAgICAgICJvcmcuY2xvaXN0ZXIuYnVpbGQtY2FjaGUua2luZCI6ICJnby1zb3VyY2UiLAogICAgICAgICJvcmcuY2xvaXN0ZXIuYnVpbGQtY2FjaGUucGF0aCI6ICJzcmMvYXV0aC5nbyIKICAgICAgfQogICAgfQogIF0sCiAgImFubm90YXRpb25zIjogewogICAgIm9yZy5jbG9pc3Rlci5idWlsZC1jYWNoZS5wcm9kdWNlciI6ICJtYWNoZSIsCiAgICAib3JnLmNsb2lzdGVyLmJ1aWxkLWNhY2hlLnByb2R1Y2VyX3ZlcnNpb24iOiAiMC43LjEiLAogICAgIm9yZy5jbG9pc3Rlci5idWlsZC1jYWNoZS5zY2hlbWFfdmVyc2lvbiI6ICIwLjEuMCIKICB9Cn0K",
};

const EXPECTED: Record<string, { size: number; blake3: string }> = {
  "chunk-001.bin":      { size:  269, blake3: "bfc7feb1382c50dfc6e389aa9b4c6608ca9a18d004b84b6959c624450da52f6a" },
  "chunk-002.bin":      { size:  163, blake3: "7e14934fd38caee251736be450b9c4e323def4292633aac9167ac7c7681dbc37" },
  "lockfile-config.bin":{ size:  584, blake3: "1a8f93c163c836aecae2fd3e33b03644399c0888474e9d7b2c1f61877e8f8c49" },
  "manifest.json":      { size: 1149, blake3: "8c93ee7314cecf98a6dd04cbf7c38de1094720e36f1efd1316ec750b07e4b0d0" },
};

const REPO = "mache/conformance";

function decodeB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function blake3Hex(bytes: Uint8Array): string {
  return blake3HexCas(bytes);
}

beforeEach(async () => {
  const trust = env.TRUST_STORE.get(env.TRUST_STORE.idFromName("cluster"));
  await runInDurableObject(trust, async (_, state) => {
    state.storage.sql.exec("DELETE FROM registry_tags");
  });
});

describe("build-cache/v1 vectors — fixture integrity", () => {
  for (const [name, exp] of Object.entries(EXPECTED)) {
    it(`${name}: matches committed (size=${exp.size}, blake3=${exp.blake3.slice(0, 12)}…)`, () => {
      const bytes = decodeB64(VECTORS_B64[name]);
      expect(bytes.byteLength).toBe(exp.size);
      expect(blake3Hex(bytes)).toBe(exp.blake3);
    });
  }
});

describe("build-cache/v1 conformance — blob round-trip via OciRegistryRoute", () => {
  const route = new OciRegistryRoute();

  for (const name of ["chunk-001.bin", "chunk-002.bin", "lockfile-config.bin"] as const) {
    it(`${name}: POST .../blobs/uploads/?digest=sha256:<blake3> → 201, GET back byte-equal`, async () => {
      const bytes = decodeB64(VECTORS_B64[name]);
      const claim = `sha256:${EXPECTED[name].blake3}`;

      const pushRes = await route.handle(
        new Request(`http://x/v2/${REPO}/blobs/uploads/?digest=${claim}`, {
          method: "POST",
          body: bytes,
        }),
        env,
      );
      expect(pushRes.status).toBe(201);
      expect(pushRes.headers.get("docker-content-digest")).toBe(claim);
      expect(pushRes.headers.get("location")).toBe(`/v2/${REPO}/blobs/${claim}`);

      const pullRes = await route.handle(
        new Request(`http://x/v2/${REPO}/blobs/${claim}`, { method: "GET" }),
        env,
      );
      expect(pullRes.status).toBe(200);
      const pulled = new Uint8Array(await pullRes.arrayBuffer());
      expect(pulled.byteLength).toBe(bytes.byteLength);
      expect(Array.from(pulled)).toEqual(Array.from(bytes));
    });
  }
});

describe("build-cache/v1 conformance — manifest round-trip via OciRegistryRoute", () => {
  const route = new OciRegistryRoute();

  it("manifest.json: PUT .../manifests/sha256:<blake3> → 201, GET back byte-equal", async () => {
    const bytes = decodeB64(VECTORS_B64["manifest.json"]);
    const ref = `sha256:${EXPECTED["manifest.json"].blake3}`;

    const pushRes = await route.handle(
      new Request(`http://x/v2/${REPO}/manifests/${ref}`, {
        method: "PUT",
        body: bytes,
        headers: { "content-type": "application/vnd.oci.image.manifest.v1+json" },
      }),
      env,
    );
    expect(pushRes.status).toBe(201);

    const pullRes = await route.handle(
      new Request(`http://x/v2/${REPO}/manifests/${ref}`, { method: "GET" }),
      env,
    );
    expect(pullRes.status).toBe(200);
    const pulled = new Uint8Array(await pullRes.arrayBuffer());
    expect(pulled.byteLength).toBe(bytes.byteLength);
    expect(Array.from(pulled)).toEqual(Array.from(bytes));
  });
});

describe("build-cache/v1 conformance — end-to-end consumer walk", () => {
  const route = new OciRegistryRoute();

  it("push everything, then walk manifest → config digest → layer digests; every pull byte-equal", async () => {
    for (const name of ["chunk-001.bin", "chunk-002.bin", "lockfile-config.bin"] as const) {
      const bytes = decodeB64(VECTORS_B64[name]);
      const claim = `sha256:${EXPECTED[name].blake3}`;
      const res = await route.handle(
        new Request(`http://x/v2/${REPO}/blobs/uploads/?digest=${claim}`, {
          method: "POST", body: bytes,
        }),
        env,
      );
      expect(res.status, `push ${name}`).toBe(201);
    }

    const manBytes = decodeB64(VECTORS_B64["manifest.json"]);
    const manRef = `sha256:${EXPECTED["manifest.json"].blake3}`;
    const manPush = await route.handle(
      new Request(`http://x/v2/${REPO}/manifests/${manRef}`, {
        method: "PUT", body: manBytes,
        headers: { "content-type": "application/vnd.oci.image.manifest.v1+json" },
      }),
      env,
    );
    expect(manPush.status, "push manifest").toBe(201);

    const manPull = await route.handle(
      new Request(`http://x/v2/${REPO}/manifests/${manRef}`, { method: "GET" }),
      env,
    );
    expect(manPull.status, "pull manifest").toBe(200);
    const pulledManifest = new Uint8Array(await manPull.arrayBuffer());
    expect(Array.from(pulledManifest)).toEqual(Array.from(manBytes));

    const manifest = JSON.parse(new TextDecoder().decode(pulledManifest));
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.config.digest).toBe(`sha256:${EXPECTED["lockfile-config.bin"].blake3}`);
    expect(manifest.layers).toHaveLength(2);
    expect(manifest.layers[0].digest).toBe(`sha256:${EXPECTED["chunk-001.bin"].blake3}`);
    expect(manifest.layers[1].digest).toBe(`sha256:${EXPECTED["chunk-002.bin"].blake3}`);

    const cfgPull = await route.handle(
      new Request(`http://x/v2/${REPO}/blobs/${manifest.config.digest}`, { method: "GET" }),
      env,
    );
    expect(cfgPull.status, "pull config").toBe(200);
    const cfgBytes = new Uint8Array(await cfgPull.arrayBuffer());
    expect(Array.from(cfgBytes))
      .toEqual(Array.from(decodeB64(VECTORS_B64["lockfile-config.bin"])));

    const layerNames = ["chunk-001.bin", "chunk-002.bin"] as const;
    for (let i = 0; i < manifest.layers.length; i++) {
      const layer = manifest.layers[i];
      const lyrPull = await route.handle(
        new Request(`http://x/v2/${REPO}/blobs/${layer.digest}`, { method: "GET" }),
        env,
      );
      expect(lyrPull.status, `pull layer ${i}`).toBe(200);
      const lyrBytes = new Uint8Array(await lyrPull.arrayBuffer());
      expect(Array.from(lyrBytes), `layer ${i} bytes`)
        .toEqual(Array.from(decodeB64(VECTORS_B64[layerNames[i]])));
    }
  });
});
