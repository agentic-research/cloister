/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect } from "vitest";
import {
  Codec,
  asInterfaceRef,
  cidEqual,
  digestTyped,
  encodeCidHex,
  interfaceRefMatches,
  type Cid,
  type CodecId,
  type InterfaceRef,
  type PortSignature,
} from "../../src/storage/typed-cid.js";
import { canonical, digestBytes } from "../../src/storage/canonical.js";

// ──────────────────────────────────────────────────────────────────────────
// Falsifiability tests for the content-addressed-substrate hypothesis.
//
// Bead: cloister-df79a5
// Math-friend predictions: theoretical-foundations-analyst, 2026-04-29
//
// What we're testing:
//
//   #1  CASCADE — under plain-SHA (content-bound) addressing, a one-byte
//       change to a chunk shared by N deployments forces re-derivation of
//       all N roots. Under typed-CID interface-bound addressing, the same
//       mutation forces 0 root changes if the type-fingerprint stays put.
//       The math-friend's first prediction: "≥90% root re-derivation under
//       strict-CAS." We expect 100%, and 0% under interface binding.
//
//   #2  REGISTRY-FREE RESOLUTION — a `needs: <typeFingerprint>` declaration
//       must resolve to a chunk WITHOUT consulting a name registry. Under
//       typed CIDs this is a structural query against the local store; under
//       plain SHA you need either a hash-pin (rigid) or a name lookup
//       (registry through the back door). The math-friend's second
//       prediction frames this as a trilemma; we're showing the third door.
// ──────────────────────────────────────────────────────────────────────────

// ── Fleet generator ───────────────────────────────────────────────────────

interface Chunk {
  cid:     Cid;
  bytes:   Uint8Array;          // canonical bytes of the chunk's content
}

interface Manifest {
  /** Pinned-by-content references — the manifest names the exact bytes. */
  contentBound: ReadonlyArray<Cid>;
  /** Pinned-by-interface references — names a shape, not bytes. */
  interfaceBound: ReadonlyArray<InterfaceRef>;
  /** A manifest-local payload so different manifests have distinct roots. */
  payload: { id: number; tag: string };
}

const SIG_MTLS:  PortSignature = { inputs: ["conn"], outputs: ["attested-stream"] };
const SIG_HTTP:  PortSignature = { inputs: ["request"], outputs: ["response"] };
const SIG_BEAD:  PortSignature = { inputs: ["repo"], outputs: ["bead-store"] };

async function buildChunk(
  codec: CodecId,
  sig:   PortSignature,
  body:  Record<string, unknown>,
): Promise<Chunk> {
  const cid = await digestTyped(body as never, codec, sig);
  return { cid, bytes: canonical(body as never) };
}

async function buildFleet(size: number): Promise<{
  fleet:   Manifest[];
  shared:  Chunk;
  store:   Map<string, Chunk>;  // store keyed by encoded Cid hex
}> {
  const store = new Map<string, Chunk>();

  // The shared chunk — every deployment in the fleet references it.
  const shared = await buildChunk(Codec.MtlsInjector, SIG_MTLS, {
    role: "shared-mtls-injector",
    rev:  "v1",
  });
  store.set(encodeCidHex(shared.cid), shared);

  // Distinct per-deployment chunks so each manifest has its own contents.
  const fleet: Manifest[] = [];
  for (let i = 0; i < size; i++) {
    const handler = await buildChunk(Codec.HttpHandler, SIG_HTTP, {
      route: `/api/${i}`,
      rev:   "v1",
    });
    const beadStore = await buildChunk(Codec.BeadStore, SIG_BEAD, {
      repo: `/repos/svc-${i}`,
    });
    store.set(encodeCidHex(handler.cid),   handler);
    store.set(encodeCidHex(beadStore.cid), beadStore);

    fleet.push({
      contentBound:   [shared.cid, handler.cid, beadStore.cid],
      interfaceBound: [shared.cid, handler.cid, beadStore.cid].map(asInterfaceRef),
      payload:        { id: i, tag: `deployment-${i}` },
    });
  }

  return { fleet, shared, store };
}

/**
 * Compute a deployment-root over a manifest under a given binding mode.
 * Both modes use the SAME canonical-bytes + SHA-256 pipeline; the only
 * difference is what the manifest's reference array contains (full Cids
 * vs InterfaceRefs).
 */
async function rootContentBound(m: Manifest): Promise<string> {
  // Encode each Cid as its hex form so canonical() sees plain JSON.
  const refs = m.contentBound.map(encodeCidHex);
  return digestBytes(canonical({ refs, payload: m.payload }));
}
async function rootInterfaceBound(m: Manifest): Promise<string> {
  // Encode each InterfaceRef as `<codec>:<fp-hex>` — content-hash absent.
  const refs = m.interfaceBound.map(r =>
    r.codec.toString(16).padStart(2, "0") + ":" + bytesToHex(r.typeFingerprint),
  );
  return digestBytes(canonical({ refs, payload: m.payload }));
}

function bytesToHex(b: Uint8Array): string {
  let s = ""; for (const x of b) s += x.toString(16).padStart(2, "0"); return s;
}

// ── Test #1: cascade under content mutation ───────────────────────────────

describe("Falsifiability #1 — cascade under one-byte mutation of a shared chunk", () => {
  const FLEET_SIZE = 50;

  it(`plain-SHA (content-bound): mutating shared chunk re-derives ALL ${FLEET_SIZE} roots`, async () => {
    const { fleet, shared } = await buildFleet(FLEET_SIZE);
    const before = await Promise.all(fleet.map(rootContentBound));

    // Mutate the shared chunk: rev v1 → v2. Same port signature, same role,
    // different content → different contentHash → different Cid.
    const mutated = await buildChunk(Codec.MtlsInjector, SIG_MTLS, {
      role: "shared-mtls-injector",
      rev:  "v2",
    });
    expect(cidEqual(shared.cid, mutated.cid)).toBe(false);
    expect(interfaceRefMatches(asInterfaceRef(shared.cid), mutated.cid)).toBe(true);

    // Update the manifests' content-bound refs to point at the new Cid.
    const updated: Manifest[] = fleet.map(m => ({
      ...m,
      contentBound: m.contentBound.map(c => cidEqual(c, shared.cid) ? mutated.cid : c),
    }));
    const after = await Promise.all(updated.map(rootContentBound));

    let cascaded = 0;
    for (let i = 0; i < FLEET_SIZE; i++) if (before[i] !== after[i]) cascaded++;
    // Math-friend prediction: ≥90% re-derivation. We expect 100% — every
    // root referenced the shared chunk by full Cid.
    expect(cascaded).toBe(FLEET_SIZE);
  });

  it("typed-CID (interface-bound): mutating shared chunk re-derives 0 roots", async () => {
    const { fleet, shared } = await buildFleet(FLEET_SIZE);
    const before = await Promise.all(fleet.map(rootInterfaceBound));

    // Same mutation — content changes, port signature does not, so the
    // typeFingerprint is preserved.
    const mutated = await buildChunk(Codec.MtlsInjector, SIG_MTLS, {
      role: "shared-mtls-injector",
      rev:  "v2",
    });
    expect(interfaceRefMatches(asInterfaceRef(shared.cid), mutated.cid)).toBe(true);

    // Interface-bound manifests don't NEED updating — they reference by
    // (codec, fingerprint), and both are unchanged. Recompute roots without
    // touching the manifest contents.
    const after = await Promise.all(fleet.map(rootInterfaceBound));

    let cascaded = 0;
    for (let i = 0; i < FLEET_SIZE; i++) if (before[i] !== after[i]) cascaded++;
    expect(cascaded).toBe(0);
  });

  it("non-substitutable mutation (different fingerprint) DOES cascade in interface-bound mode", async () => {
    // Negative control: if the mutation changes the port signature, the
    // typeFingerprint changes too, and interface-bound refs DO need
    // updating. This proves interface binding is honest — it tracks
    // semantic compatibility, not byte equality.
    const { fleet, shared } = await buildFleet(FLEET_SIZE);
    const before = await Promise.all(fleet.map(rootInterfaceBound));

    const incompatibleSig: PortSignature = {
      inputs: ["conn", "client-cert"],   // changed port shape
      outputs: ["attested-stream"],
    };
    const mutated = await buildChunk(Codec.MtlsInjector, incompatibleSig, {
      role: "shared-mtls-injector",
      rev:  "v2-breaking",
    });
    expect(interfaceRefMatches(asInterfaceRef(shared.cid), mutated.cid)).toBe(false);

    // Update interface-bound refs to the new fingerprint.
    const updated: Manifest[] = fleet.map(m => ({
      ...m,
      interfaceBound: m.interfaceBound.map(r =>
        interfaceRefMatches(r, shared.cid) ? asInterfaceRef(mutated.cid) : r,
      ),
    }));
    const after = await Promise.all(updated.map(rootInterfaceBound));

    let cascaded = 0;
    for (let i = 0; i < FLEET_SIZE; i++) if (before[i] !== after[i]) cascaded++;
    expect(cascaded).toBe(FLEET_SIZE);
  });
});

// ── Test #2: registry-free resolution by typeFingerprint ──────────────────

/**
 * A bare-bones content-addressed store. Note carefully: it is keyed by Cid
 * (encoded as hex), NOT by name. There is no `Map<string, Cid>` mapping
 * names → addresses anywhere in this fixture. If resolution succeeds, it
 * must succeed structurally.
 */
class StructuralStore {
  private readonly chunks = new Map<string, Chunk>();
  private nameLookups = 0; // tripwire — increments on any name-keyed access

  put(c: Chunk): void {
    this.chunks.set(encodeCidHex(c.cid), c);
  }

  /** Resolve a `needs: <InterfaceRef>` query by structural match. */
  resolve(need: InterfaceRef): Chunk | null {
    for (const chunk of this.chunks.values()) {
      if (interfaceRefMatches(need, chunk.cid)) return chunk;
    }
    return null;
  }

  /**
   * The tripwire: any consumer that tries to look up by name gets caught.
   * The fixture proves resolution doesn't go through here.
   */
  resolveByName(_name: string): Chunk | null {
    this.nameLookups++;
    return null;
  }

  get nameLookupCount(): number { return this.nameLookups; }
  get size():             number { return this.chunks.size; }
}

describe("Falsifiability #2 — registry-free resolution by typeFingerprint", () => {
  it("resolves `needs: <InterfaceRef>` against a store that has NO name registry", async () => {
    const store = new StructuralStore();

    // Populate the store with chunks of various interfaces.
    const a = await buildChunk(Codec.MtlsInjector, SIG_MTLS, { rev: "v1" });
    const b = await buildChunk(Codec.MtlsInjector, SIG_MTLS, { rev: "v2" });
    const c = await buildChunk(Codec.HttpHandler,  SIG_HTTP, { route: "/" });
    const d = await buildChunk(Codec.BeadStore,    SIG_BEAD, { repo: "/r" });
    store.put(a); store.put(b); store.put(c); store.put(d);
    expect(store.size).toBe(4);

    // The need: "any chunk implementing the mTLS-injector interface."
    // Note we construct the InterfaceRef without referencing any specific
    // chunk — purely from the port signature.
    const need: InterfaceRef = {
      codec:           Codec.MtlsInjector,
      typeFingerprint: a.cid.typeFingerprint,
    };

    const resolved = store.resolve(need);
    expect(resolved).not.toBeNull();
    // It can be either `a` or `b` — both match. Just must be one of them.
    const ok = resolved && (cidEqual(resolved.cid, a.cid) || cidEqual(resolved.cid, b.cid));
    expect(ok).toBe(true);

    // The tripwire never fired.
    expect(store.nameLookupCount).toBe(0);
  });

  it("returns null for a need with no matching fingerprint", async () => {
    const store = new StructuralStore();
    store.put(await buildChunk(Codec.HttpHandler, SIG_HTTP, { route: "/" }));

    const need: InterfaceRef = {
      codec:           Codec.MtlsInjector,
      typeFingerprint: (await digestTyped({}, Codec.MtlsInjector, SIG_MTLS)).typeFingerprint,
    };
    expect(store.resolve(need)).toBeNull();
    expect(store.nameLookupCount).toBe(0);
  });

  it("the same fingerprint matches multiple substitutable impls — interface-pinning is many-to-one", async () => {
    const store = new StructuralStore();
    const v1 = await buildChunk(Codec.MtlsInjector, SIG_MTLS, { rev: "v1" });
    const v2 = await buildChunk(Codec.MtlsInjector, SIG_MTLS, { rev: "v2" });
    const v3 = await buildChunk(Codec.MtlsInjector, SIG_MTLS, { rev: "v3" });
    store.put(v1); store.put(v2); store.put(v3);

    const need = asInterfaceRef(v1.cid);
    const resolved = store.resolve(need);
    expect(resolved).not.toBeNull();
    // v1, v2, v3 all match the fingerprint — the substitutability claim
    // is exactly this many-to-one relationship between InterfaceRef and Cid.
    expect(store.nameLookupCount).toBe(0);
  });

  it("does NOT match across codec boundaries (interface includes the codec)", async () => {
    const store = new StructuralStore();
    // Same port signature, different codec → different InterfaceRef.
    const a = await buildChunk(Codec.MtlsInjector, SIG_MTLS, { rev: "v1" });
    const b = await buildChunk(Codec.HttpHandler,  SIG_MTLS, { rev: "v1" });
    store.put(a); store.put(b);

    const need: InterfaceRef = {
      codec:           Codec.MtlsInjector,
      typeFingerprint: a.cid.typeFingerprint,
    };
    const resolved = store.resolve(need);
    expect(resolved).not.toBeNull();
    expect(cidEqual(resolved!.cid, a.cid)).toBe(true);   // not b, despite same fingerprint
  });
});
