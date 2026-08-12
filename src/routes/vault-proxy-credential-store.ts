// src/routes/vault-proxy-credential-store.ts — credential-store seam
// for the cloister/credential-isolation/v1 route.
//
// Per cloister-8f57f0 — the v1 route handler (`vault-proxy.ts`) takes
// `storedCredential` + optional `storedUsername` as input. The route
// ENTRY (composition root) is responsible for the lookup, which lets
// the handler stay pure over its inputs (the entire 34-test suite
// is unit-testable without a backing store).
//
// This file defines the seam — `CredentialStore` — and ships one
// reference impl (`InMemoryCredentialStore`) suitable for dev /
// recipe smoke / integration tests. The production impl (probably
// routed through the vault DO so plaintext bytes never leave the
// trust boundary in steady state) lands in a follow-on bead alongside
// the route mount.
//
// Lookup key: `(peerFp, service)`. Same composite key the vault DO's
// `credentials` table uses (cloister-26546a / `(subject_fp, service)`
// composite PK) — they MUST stay congruent so the eventual
// vault-DO-backed impl can use the same tuple without translation.
//
// Spec: leyline-schema-spec/credential-isolation/v1/
// ADR: docs/adr/0024-credential-isolation-capability.md

/**
 * What the route entry hands to `vaultProxyHandler` for the
 * credential-bearing fields of `VaultProxyRequest`. `null` means
 * "no credential stored for this (peerFp, service)" — the handler
 * collapses that to a 404 with constant-shape body (preserves the
 * §9.4.b enumeration-oracle closure from cloister-aa9376).
 */
export interface CredentialLookup {
  /** The credential bytes — e.g., the OpenAI API key for service="openai". */
  readonly credential: string;
  /**
   * Optional username for `authorizationBasic` injection. Defaults to
   * the service name when absent.
   */
  readonly username?: string;
}

/**
 * Async resolver. The production impl routes through `env.VAULT_STORE`
 * (the existing credential vault DO) so the seal + KEK boundary is
 * preserved; the in-memory impl below is for dev + tests only.
 *
 * Two seams (cloister-e26ea8 / D1 of the DO saga):
 *
 *   - `resolve` — looks up the credential bytes; returns `null` when
 *     no row exists. Used by the dev/in-memory composition path where
 *     the handler injects the credential into the request itself.
 *
 *   - `forward` (optional, production) — delegates the entire Request
 *     to the vault DO's `proxyRequest`, which decrypts + injects +
 *     fetches upstream inside the DO. Plaintext never crosses the
 *     trust boundary. When defined, the route composition (D2,
 *     cloister-e2a12a) prefers this path over `resolve + inject`.
 *
 * Both methods return wire-shape-compatible responses. The branch is
 * a composition-root concern, not a handler concern.
 */
export interface CredentialStore {
  resolve(peerFp: string, service: string): Promise<CredentialLookup | null>;
  /** Host-side broker ingress. Plaintext is accepted only at this boundary
   * and must be sealed by the production store before returning. */
  putCredential?(
    peerFp: string,
    service: string,
    credential: string,
    options?: { upstream?: string; headers?: Record<string, string>; allowedSubs?: string[] },
  ): Promise<void>;
  /**
   * Production seam — delegate the full Request to vault DO. Returns
   * the proxied upstream Response. When implemented, the composition
   * root should prefer this path to preserve the ADR-0013 slice-grant
   * invariant (plaintext stays inside the DO trust boundary). Optional
   * because `InMemoryCredentialStore` doesn't have a meaningful
   * upstream-delegation path.
   */
  forward?(
    peerFp: string,
    service: string,
    callerSub: string,
    request: Request,
  ): Promise<Response>;
}

/**
 * Dev / test backing — a plain Map keyed by `${peerFp}::${service}`.
 * NOT for production use; documented as such in the constructor.
 * Provides `set` / `delete` / `size` for test ergonomics.
 *
 * Same composite-key shape as the vault DO. Switching to the
 * vault-DO-backed impl is a `new VaultDoCredentialStore(env)` swap
 * at the composition root; the handler doesn't change.
 */
export class InMemoryCredentialStore implements CredentialStore {
  private readonly map = new Map<string, CredentialLookup>();

  constructor(_opts: { dev: true } = { dev: true }) {
    // The `dev: true` opt is the only way to construct — a small
    // gate that makes "I'm using the in-memory store in prod by
    // accident" a grep-able phrase. Production code constructs
    // VaultDoCredentialStore (follow-up bead) instead.
  }

  async resolve(peerFp: string, service: string): Promise<CredentialLookup | null> {
    return this.map.get(InMemoryCredentialStore.key(peerFp, service)) ?? null;
  }

  async putCredential(peerFp: string, service: string, credential: string): Promise<void> {
    this.set(peerFp, service, { credential });
  }

  set(peerFp: string, service: string, lookup: CredentialLookup): void {
    this.map.set(InMemoryCredentialStore.key(peerFp, service), lookup);
  }

  delete(peerFp: string, service: string): boolean {
    return this.map.delete(InMemoryCredentialStore.key(peerFp, service));
  }

  /** Number of stored credentials. Useful for test cleanup assertions. */
  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  private static key(peerFp: string, service: string): string {
    return `${peerFp}::${service}`;
  }
}
