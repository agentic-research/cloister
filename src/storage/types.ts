/**
 * Storage primitives — see ADR-0003.
 *
 * Two algebraic layers:
 *
 *   1. BlobStore — immutable content-addressed monoid. Writes are deterministic
 *      functions of content (digest = hash(bytes)), so put is idempotent and
 *      no consistency story is needed.
 *
 *   2. RefStore — small array of mutable single-writer registers. Each ref is
 *      a linearizable cell holding one Digest, updated by compare-and-swap.
 *      On workerd, the DO's single-threadedness IS the consensus boundary.
 *
 * Substrate-free: anywhere these five ops exist, the higher-level DAG +
 * branch-per-agent abstraction is implementable identically. Mappings live in
 * src/storage/workerd.ts (DO SQLite) — future native and edge-KV mappings
 * implement the same interfaces.
 */

/**
 * Hex-encoded SHA-256 of canonical bytes (64 lowercase hex chars).
 * Branded so the type system catches "passed a regular string where a
 * digest is required."
 */
export type Digest = string & { readonly __digest: unique symbol };

/** Alphabet check for a 64-char lowercase hex string. */
export function isDigest(value: string): value is Digest {
  return /^[0-9a-f]{64}$/.test(value);
}

/** Cast a known-good hex string to Digest without re-checking. */
export function asDigest(hex: string): Digest {
  return hex as Digest;
}

export interface BlobStore {
  /**
   * Write bytes; returns the storage key.
   *
   * Default behavior (`key` omitted): compute SHA-256 of `bytes` and store
   * under that key — the substrate is content-addressed. Idempotent: putting
   * identical bytes twice yields the same Digest and is a no-op the second
   * time.
   *
   * Override (`key` provided): store under the caller-provided key. Used by
   * the OCI registry route to honor the BLAKE3-in-`sha256:` convention from
   * `leyline-schema-spec/build-cache/v1` — the route has already verified the body
   * matches the key under either SHA-256 or BLAKE3 via
   * `verifyClaimedDigest()`, so the substrate's content-addressed invariant
   * holds under the union "key is SHA-256 OR BLAKE3 of the bytes." Callers
   * that pass a `key` are responsible for that verification.
   */
  put(bytes: Uint8Array, key?: Digest): Promise<Digest>;

  /** Read bytes by digest, or null if not present. */
  get(digest: Digest): Promise<Uint8Array | null>;

  /** Cheap existence check — useful for GC reachability scans. */
  has(digest: Digest): Promise<boolean>;
}

export interface RefStore {
  /**
   * Atomically swap the digest at `name` from `expected` to `next`.
   *
   * - `expected = null` → succeeds only if the ref is currently absent
   *   (use this to create a new ref)
   * - `expected = <digest>` → succeeds only if the ref currently holds that
   *   digest (use this for ordinary updates)
   *
   * Returns `true` if the swap happened, `false` otherwise. The cell is
   * unchanged on failure.
   */
  cas(name: string, expected: Digest | null, next: Digest): Promise<boolean>;

  /** Return all refs whose name starts with `prefix`, in arbitrary order. */
  list(prefix: string): Promise<Array<[string, Digest]>>;
}
