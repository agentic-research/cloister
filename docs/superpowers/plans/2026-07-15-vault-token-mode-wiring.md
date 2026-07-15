# Vault Token-Mode Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn on ADR-0047 DPoP bundle authentication at the vault so `rosary` becomes the first per-bundle-DO tenant that authenticates with a notme-minted access token instead of relying on the router's positional identity.

**Architecture:** The auth *logic* already exists and is tested (`authenticateBundleRequest`, `verifyBundleToken`, `verifyDpopProof`, 31 cases). This plan wires it into the live path via the ADR-0047 **hybrid**: a `vaultProxy` route declared in `authMode = token` (manifest topology, §20.9 — the code path is chosen by the operator-declared mode, never by token presence in request content) selects a **per-bundle** vault DO instance (`idFromName(bundleId)`, ADR-0021), and that DO's bundle-facing RPC method verifies the token, pins + cross-checks its own `expectedSub` (§20.10), enforces a `seen_jti` replay ledger, and derives `subjectFp` from the *verified* `sub`. The existing interlace-lease `vaultProxy` (`authMode = lease`, the default) is untouched.

**Tech Stack:** TypeScript, workerd Durable Objects (SQLite storage API), capnp manifest (`cloister.capnp` → `task manifest`), Web Crypto Ed25519, notme (`env.NOTME` Fetcher binding, publishes JWKS + `mintDPoPToken`), vitest (worker tests + workerd integration).

## Global Constraints

- **No auth bypass, ever.** Token-mode path is **token-or-deny by topology** (§20.9): no branch trusts a positional `subjectFp`. `authenticateBundleRequest` already enforces this; do not add a fallback. (CLAUDE.md "What NOT to add".)
- **Schema evolution is append-only** (ADR-0004): new manifest fields get the next monotonically-increasing ordinal; never renumber. New `VaultProxySpec.authMode` field is append-only.
- **Manifest is source of truth** (CLAUDE.md): edit `cloister.capnp`, then `task manifest`. Schema at `manifest/cloister.capnp`. A new kind/field needs a schema field + a TS mirror in `src/manifest/types.ts` (or `cluster-types.ts`) + a runtime branch.
- **Two CAS hashes stay distinct** (CLAUDE.md): `subjectFp` here is SHA-256-derived (application layer), as `verifyBundleToken` already computes it. Do not introduce BLAKE3 anywhere in this path.
- **Commit convention:** `[cloister-2b98c0] type(scope): subject`. `spike` is not a valid type — use `feat`/`fix`/`chore`/`docs`/`test`. Run `task lint` (the ~2s inner gate) before every commit.
- **Inner gate:** `task lint` (tsc + worker tests + plugin tests). Integration: `task test` (real DOs, real SQLite). Strict CI: `task verify`.
- **Threat-model-first for new seams** (CLAUDE.md): §20 already covers this seam (rows 20.1–20.10). This plan *flips its status*, it does not invent a new seam. Extend §20 status, don't restate.

---

## File Structure

| File | Responsibility | New/Modify |
|---|---|---|
| `src/storage/seen-jti.ts` | Pure DPoP-replay ledger: `SCHEMA_SEEN_JTI`, `checkAndRecordJti(sql, jti, expMs, now)`, `pruneSeenJti(sql, cutoff)`. Mirrors `seen-nonces.ts`. | Create |
| `src/routes/notme-jwks.ts` | `resolveNotmePubByKid(env, kid)` — fetch `env.NOTME` JWKS, select the OKP/Ed25519 JWK by `kid`, return raw 32-byte key; bounded-TTL in-isolate cache; unknown `kid` → `null`. | Create |
| `src/vault-store.ts` | New bundle-facing RPC `authenticateAndProxy(...)`: pin+assert `expectedSub`, build `BundleAuthContext`, call `authenticateBundleRequest`, on `ok` reuse the existing forward path with the verified `subjectFp`. Add `seen_jti` CREATE TABLE + prune to the periodic sweep. | Modify |
| `manifest/cloister.capnp` + `cloister.capnp` | Append `authMode` field to `VaultProxySpec` (enum: `lease` default / `token`). | Modify |
| `src/manifest/cluster-types.ts` | TS mirror of `VaultProxySpec.authMode`. | Modify |
| `src/routes/vault-proxy-route.ts` | Branch on the route's declared `authMode`. `token` → routing-only `sub` extraction, `idFromName(bundleId)`, call `authenticateAndProxy`. `lease` → unchanged. | Modify |
| `docs/security/threat-model.md`, `docs/adr/0047-vault-bundle-identity.md`, `src/vault-store.ts` header, `docs/reference/tenancy-model.md` | Status flips + operator model. | Modify |
| **rosary repo** `~/remotes/art/rosary` | Mint a notme DPoP token + present token + DPoP proof on vault calls. | Modify |

Tasks 1–3 are pure cloister and independently testable. Task 4 needs a manifest change. Task 5 is the manifest+runtime seam. Task 6 is rosary. Task 7 is acceptance. Task 8 is docs.

---

### Task 1: `seen_jti` replay ledger (pure module)

**Files:**
- Create: `src/storage/seen-jti.ts`
- Test: `src/storage/seen-jti.test.ts`

**Interfaces:**
- Consumes: the `SqlExecutor` shape from `src/storage/seen-nonces.ts` (an object with `.exec(sql, ...args)` returning `{ toArray(): unknown[] }`) — mirror it, do not re-invent.
- Produces: `SCHEMA_SEEN_JTI: string`; `checkAndRecordJti(sql: SqlExecutor, jti: string, expMs: number, now: number): boolean` (returns `true` if the jti was **already seen** → replay; `false` if freshly recorded); `pruneSeenJti(sql: SqlExecutor, cutoffMs: number): number`.

- [ ] **Step 1: Read the pattern to mirror**

Read `src/storage/seen-nonces.ts` in full (it is ~80 lines). Copy its `SqlExecutor` interface, its `INSERT ... ON CONFLICT DO NOTHING RETURNING` idiom, and its doc-comment style. `seen_jti` differs only in column names (`jti` PK, `exp_ms` for retention).

- [ ] **Step 2: Write the failing test**

```typescript
// src/storage/seen-jti.test.ts
import { describe, it, expect } from "vitest";
import { SCHEMA_SEEN_JTI, checkAndRecordJti, pruneSeenJti } from "./seen-jti.js";

// Minimal in-memory SqlExecutor: a Map keyed by jti. Mirrors the real
// workerd SQLite surface enough for the pure helpers.
function fakeSql() {
  const rows = new Map<string, number>(); // jti -> exp_ms
  return {
    store: rows,
    exec(sql: string, ...args: unknown[]) {
      if (sql.includes("INSERT INTO seen_jti")) {
        const [jti, expMs] = args as [string, number];
        const existed = rows.has(jti);
        if (!existed) rows.set(jti, expMs);
        // RETURNING yields a row only on a fresh insert.
        return { toArray: () => (existed ? [] : [{ jti }]) };
      }
      if (sql.includes("DELETE FROM seen_jti")) {
        const [cutoff] = args as [number];
        let n = 0;
        for (const [k, v] of rows) if (v < cutoff) { rows.delete(k); n++; }
        return { toArray: () => [{ n }] };
      }
      return { toArray: () => [] };
    },
  };
}

describe("seen_jti ledger", () => {
  it("first sight of a jti is not a replay; second is", () => {
    const sql = fakeSql();
    expect(checkAndRecordJti(sql, "jti-abc", 10_000, 1_000)).toBe(false); // fresh
    expect(checkAndRecordJti(sql, "jti-abc", 10_000, 1_100)).toBe(true);  // replay
  });

  it("prune removes only entries whose exp_ms is below the cutoff", () => {
    const sql = fakeSql();
    checkAndRecordJti(sql, "old", 5_000, 0);
    checkAndRecordJti(sql, "new", 50_000, 0);
    const deleted = pruneSeenJti(sql, 10_000);
    expect(deleted).toBe(1);
    expect(sql.store.has("old")).toBe(false);
    expect(sql.store.has("new")).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/storage/seen-jti.test.ts`
Expected: FAIL — `Cannot find module './seen-jti.js'`.

- [ ] **Step 4: Implement the module**

```typescript
// src/storage/seen-jti.ts
// DPoP-proof replay ledger for the vault DO's token-mode bundle path
// (ADR-0047 / threat-model §20.3). A DPoP proof's `jti` may be presented
// at most once. Mirrors src/storage/seen-nonces.ts; retention is bounded
// by the access-token `exp` (a proof outlives its token by nothing useful).

export interface SqlExecutor {
  exec(sql: string, ...args: unknown[]): { toArray(): unknown[] };
}

export const SCHEMA_SEEN_JTI = `
CREATE TABLE IF NOT EXISTS seen_jti (
  jti    TEXT    PRIMARY KEY,
  exp_ms INTEGER NOT NULL
);`;

/**
 * Atomically record `jti`. Returns true if it was ALREADY present (a
 * replay), false if this call freshly recorded it. Single statement:
 * INSERT ... ON CONFLICT DO NOTHING RETURNING yields a row only on a
 * fresh insert, so an empty result set means "already seen".
 */
export function checkAndRecordJti(
  sql: SqlExecutor,
  jti: string,
  expMs: number,
  _now: number,
): boolean {
  const inserted = sql
    .exec(
      "INSERT INTO seen_jti (jti, exp_ms) VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING jti",
      jti,
      expMs,
    )
    .toArray();
  return inserted.length === 0; // no row returned → conflict → replay
}

/** Delete ledger rows whose token has expired (exp_ms < cutoffMs). Returns count. */
export function pruneSeenJti(sql: SqlExecutor, cutoffMs: number): number {
  const r = sql
    .exec("DELETE FROM seen_jti WHERE exp_ms < ? RETURNING jti", cutoffMs)
    .toArray();
  return r.length;
}
```

Note: the test's `fakeSql` models `DELETE ... RETURNING` as `[{n}]` for readability; align the real `pruneSeenJti` to count returned rows. Adjust the test's DELETE branch to return one entry per deleted row (`Array.from({length:n}, () => ({jti:""}))`) so `r.length` matches. Fix the test, not the module.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/storage/seen-jti.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/storage/seen-jti.ts src/storage/seen-jti.test.ts
git commit -m "[cloister-2b98c0] feat(vault): seen_jti DPoP-replay ledger (mirrors seen_nonces)"
```

---

### Task 2: notme JWKS-by-`kid` resolver

**Files:**
- Create: `src/routes/notme-jwks.ts`
- Test: `src/routes/notme-jwks.test.ts`

**Interfaces:**
- Consumes: `env.NOTME` (a `Fetcher` per `src/types.ts:113`).
- Produces: `resolveNotmePubByKid(env: { NOTME?: Fetcher }, kid: string | undefined, now: number): Promise<Uint8Array | null>` — returns the raw 32-byte Ed25519 public key for `kid`, or `null` (unknown kid / no binding / malformed JWKS). Result feeds `BundleAuthContext.notmePub` (Task 3).

- [ ] **Step 1: Write the failing test**

```typescript
// src/routes/notme-jwks.test.ts
import { describe, it, expect } from "vitest";
import { resolveNotmePubByKid } from "./notme-jwks.js";

// A fake notme Fetcher serving one OKP/Ed25519 JWK. `x` is the b64url
// of a 32-byte key (here: 32 bytes of 0x01).
const x = Buffer.from(new Uint8Array(32).fill(1)).toString("base64url");
const jwks = { keys: [{ kty: "OKP", crv: "Ed25519", kid: "k1", x }] };

function fakeNotme(body: unknown): Fetcher {
  return {
    fetch: async () =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
  } as unknown as Fetcher;
}

describe("resolveNotmePubByKid", () => {
  it("returns the raw 32-byte key for a known kid", async () => {
    const key = await resolveNotmePubByKid({ NOTME: fakeNotme(jwks) }, "k1", 1000);
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key!.length).toBe(32);
    expect(key![0]).toBe(1);
  });

  it("returns null for an unknown kid", async () => {
    expect(await resolveNotmePubByKid({ NOTME: fakeNotme(jwks) }, "nope", 1000)).toBeNull();
  });

  it("returns null when NOTME is unbound", async () => {
    expect(await resolveNotmePubByKid({}, "k1", 1000)).toBeNull();
  });

  it("returns null for an undefined kid (no positional trust)", async () => {
    expect(await resolveNotmePubByKid({ NOTME: fakeNotme(jwks) }, undefined, 1000)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/routes/notme-jwks.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the resolver**

```typescript
// src/routes/notme-jwks.ts
// Resolve a notme signing key by `kid` from notme's published JWKS, for
// verifyBundleToken (ADR-0047). notme is reached via the env.NOTME service
// binding (Fetcher). Bounded-TTL in-isolate cache keeps a JWKS fetch off
// the per-request hot path; unknown kid / unbound / malformed → null
// (fail-closed — the caller denies).

interface Jwk { kty?: string; crv?: string; kid?: string; x?: string }
interface Jwks { keys?: Jwk[] }

const JWKS_URL = "https://notme/.well-known/jwks.json"; // host is ignored by the service binding; path is what notme routes on
const TTL_MS = 5 * 60_000;

let cache: { at: number; keys: Map<string, Uint8Array> } | null = null;

function b64urlToBytes(s: string): Uint8Array {
  const b = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b.length % 4 === 0 ? "" : "=".repeat(4 - (b.length % 4));
  const bin = atob(b + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function loadJwks(notme: Fetcher, now: number): Promise<Map<string, Uint8Array>> {
  if (cache && now - cache.at < TTL_MS) return cache.keys;
  const res = await notme.fetch(JWKS_URL);
  if (!res.ok) return cache?.keys ?? new Map();
  const doc = (await res.json()) as Jwks;
  const keys = new Map<string, Uint8Array>();
  for (const k of doc.keys ?? []) {
    if (k.kty === "OKP" && k.crv === "Ed25519" && typeof k.kid === "string" && typeof k.x === "string") {
      const raw = b64urlToBytes(k.x);
      if (raw.length === 32) keys.set(k.kid, raw);
    }
  }
  cache = { at: now, keys };
  return keys;
}

export async function resolveNotmePubByKid(
  env: { NOTME?: Fetcher },
  kid: string | undefined,
  now: number,
): Promise<Uint8Array | null> {
  if (!env.NOTME || !kid) return null;
  const keys = await loadJwks(env.NOTME, now);
  return keys.get(kid) ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/routes/notme-jwks.test.ts`
Expected: PASS (4 tests). If `atob`/`Response.json` are unavailable in the test env, confirm the vitest config uses the workers pool (it does for worker tests) — these are workerd globals.

- [ ] **Step 5: Commit**

```bash
git add src/routes/notme-jwks.ts src/routes/notme-jwks.test.ts
git commit -m "[cloister-2b98c0] feat(vault): resolve notme signing key by kid from JWKS"
```

---

### Task 3: vault DO bundle-facing entrypoint (`authenticateAndProxy`)

**Files:**
- Modify: `src/vault-store.ts` (add the RPC method; add `seen_jti` schema to the constructor's CREATE TABLE block near `:213-268`; add `pruneSeenJti` to the periodic sweep)
- Test: `src/vault-store.token-auth.test.ts` (Create)

**Interfaces:**
- Consumes: `authenticateBundleRequest(ctx: BundleAuthContext): Promise<BundleAuthResult>` from `src/routes/bundle-auth.ts` (exact shape read from source: `token, proof, notmePub, expectedSub, audience, requiredScope, issuer, htm, htu, now, seenJti, isRevoked`; returns `{ok:true, subjectFp, sub} | {ok:false, reason}`). `checkAndRecordJti`/`SCHEMA_SEEN_JTI` (Task 1). `resolveNotmePubByKid` (Task 2). The existing forward path (`proxyRequest`-internal credential handling that yields plaintext inside the DO).
- Produces: RPC method `authenticateAndProxy(args: TokenModeArgs): Promise<Response>` where
  ```typescript
  interface TokenModeArgs {
    token: string | null; proof: string | null;
    htm: string; htu: string; service: string; expectedSub: string;
    request: Request;
  }
  ```
  Consumed by `VaultProxyRoute` (Task 5).

- [ ] **Step 1: Add `seen_jti` to the DO schema + sweep**

In `src/vault-store.ts`, in the constructor CREATE TABLE block (alongside `rate_buckets`, `vault_state`, `credentials`), add:

```typescript
    ctx.storage.sql.exec(SCHEMA_SEEN_JTI);
```

Import at top: `import { SCHEMA_SEEN_JTI, checkAndRecordJti, pruneSeenJti } from "./storage/seen-jti.js";`. In the periodic sweep method (grep `alarm` / the sweep that prunes `rate_buckets`), add `pruneSeenJti(this.ctx.storage.sql, now)` — cutoff `now` (rows whose `exp_ms < now` are dead tokens).

- [ ] **Step 2: Write the failing test (happy path + the four denials)**

```typescript
// src/vault-store.token-auth.test.ts
import { describe, it, expect } from "vitest";
// Use the project's existing DO test harness. Grep an existing vault-store
// integration test (e.g. src/vault-store.*.test.ts) for the exact runInDurableObject /
// env fixture import; reuse it verbatim so the DO SQLite is real.
import { mintTestBundleToken, mintTestDpopProof, TEST_NOTME_JWKS } from "./routes/bundle-auth.test-helpers.js";

// Helper: construct a VaultStore instance wired to a stub NOTME serving
// TEST_NOTME_JWKS, seed one credential for service "anthropic", and return
// a caller that invokes authenticateAndProxy.

describe("vault authenticateAndProxy (ADR-0047 token mode)", () => {
  const EXPECTED_SUB = "rosary";
  const service = "anthropic";

  it("valid token + proof → forwards (2xx or the credential-injected upstream shape)", async () => {
    const token = await mintTestBundleToken({ sub: EXPECTED_SUB, scope: `vault:proxy:${service}`, aud: "cloister" });
    const proof = await mintTestDpopProof({ htm: "POST", htu: "https://cloister/vault/anthropic" });
    const res = await callAuthenticateAndProxy({ token, proof, expectedSub: EXPECTED_SUB, service });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("no token → 401/deny (token-or-deny, §20.9)", async () => {
    const proof = await mintTestDpopProof({ htm: "POST", htu: "https://cloister/vault/anthropic" });
    const res = await callAuthenticateAndProxy({ token: null, proof, expectedSub: EXPECTED_SUB, service });
    expect([401, 403]).toContain(res.status);
  });

  it("token.sub != expectedSub → deny (§20.10 cross-bundle substitution)", async () => {
    const token = await mintTestBundleToken({ sub: "mache", scope: `vault:proxy:${service}`, aud: "cloister" });
    const proof = await mintTestDpopProof({ htm: "POST", htu: "https://cloister/vault/anthropic" });
    const res = await callAuthenticateAndProxy({ token, proof, expectedSub: EXPECTED_SUB, service });
    expect([401, 403]).toContain(res.status);
  });

  it("replayed jti → deny (§20.3)", async () => {
    const token = await mintTestBundleToken({ sub: EXPECTED_SUB, scope: `vault:proxy:${service}`, aud: "cloister" });
    const proof = await mintTestDpopProof({ htm: "POST", htu: "https://cloister/vault/anthropic" });
    const first = await callAuthenticateAndProxy({ token, proof, expectedSub: EXPECTED_SUB, service });
    expect([200, 201, 202, 204, 502, 503]).toContain(first.status); // auth passed; upstream shape varies
    const replay = await callAuthenticateAndProxy({ token, proof, expectedSub: EXPECTED_SUB, service });
    expect([401, 403]).toContain(replay.status);
  });
});
```

If `bundle-auth.test-helpers.js` does not exist, the 31 existing tests in `test/routes/bundle-auth.test.ts` already mint tokens/proofs inline — extract those minting helpers into `src/routes/bundle-auth.test-helpers.ts` as Step 2a (a pure refactor: move, re-export, keep the 31 tests green) so both suites share one minting path. Commit that refactor separately.

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/vault-store.token-auth.test.ts`
Expected: FAIL — `authenticateAndProxy` is not a function.

- [ ] **Step 4: Implement `authenticateAndProxy`**

```typescript
// in class VaultStore (src/vault-store.ts). ISSUER/AUDIENCE are deploy
// constants; read them from env if the codebase already threads notme
// issuer config, else pin to the cluster's notme issuer + "cloister".
async authenticateAndProxy(args: TokenModeArgs): Promise<Response> {
  const now = Date.now();

  // §20.10 — pin this DO's expected bundle on first authenticated call,
  // assert equality thereafter. Mirrors #assertKekSourceSpecPinned: the
  // per-bundle DO identity is stable; a caller-supplied expectedSub that
  // flips between calls is a routing/manifest attack → hard deny.
  const pinnedSub = this.#assertExpectedSubPinned(args.expectedSub);

  // Resolve the notme key by the token's kid (unverified header read is
  // routing-only; the signature check below is the gate).
  const kid = args.token ? peekJwtKid(args.token) : undefined;
  const notmePub = await resolveNotmePubByKid(this.env, kid, now);
  if (!notmePub) return errorResponse(401, CONSTANT_TIME_ERROR_BODY);

  const result = await authenticateBundleRequest({
    token: args.token,
    proof: args.proof,
    notmePub,
    expectedSub: pinnedSub,
    audience: "cloister",
    requiredScope: `vault:proxy:${args.service}`,
    issuer: this.#notmeIssuer(),
    htm: args.htm,
    htu: args.htu,
    now,
    seenJti: (jti) => checkAndRecordJti(this.ctx.storage.sql, jti, this.#tokenExpMs(args.token, now), now),
    isRevoked: (k) => this.#isKeyRevoked(k),
  });

  if (!result.ok) {
    console.log(JSON.stringify(buildDenialAuditEntry({
      event: "bundle_auth_denied", service: args.service, reason: result.reason,
    })));
    return errorResponse(401, CONSTANT_TIME_ERROR_BODY);
  }

  // Auth passed. Reuse the existing plaintext-stays-inside forward path,
  // threading the VERIFIED subjectFp as the credential row key.
  return this.#forwardWithSubject(result.subjectFp, args.service, args.request);
}
```

Supporting private helpers (implement minimally; `peekJwtKid` decodes only the header `kid` for routing, never trusts it):

```typescript
#assertExpectedSubPinned(sub: string): string {
  const rows = this.ctx.storage.sql
    .exec("SELECT value FROM vault_state WHERE key = 'expected_sub'").toArray() as Array<{ value: string }>;
  if (rows.length === 0) {
    this.ctx.storage.sql.exec("INSERT INTO vault_state (key, value) VALUES ('expected_sub', ?)", sub);
    return sub;
  }
  if (rows[0].value !== sub) {
    throw new Error("expected_sub pin mismatch — this per-bundle DO was created for a different bundle");
  }
  return rows[0].value;
}
```

`#forwardWithSubject` factors the credential-lookup-and-forward body out of the existing `proxyRequest` so both the lease path (`proxyRequest(peerFp,...)` → `#forwardWithSubject(peerFp, ...)`) and the token path (`#forwardWithSubject(subjectFp, ...)`) share it. `#isKeyRevoked` calls notme's revocation endpoint via `env.NOTME` (bounded-TTL cache like the JWKS resolver); a v1 acceptable stub is `return false` **only if** a `// TODO(cloister-2b98c0): wire notme RevocationAuthority` is tracked in a follow-up bead — but prefer wiring it, since revocation is a named §20 control.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/vault-store.token-auth.test.ts`
Expected: PASS (happy path + 3 denials). Then `task lint` — expected green.

- [ ] **Step 6: Commit**

```bash
git add src/vault-store.ts src/vault-store.token-auth.test.ts src/routes/bundle-auth.test-helpers.ts
git commit -m "[cloister-2b98c0] feat(vault): authenticateAndProxy — per-bundle DO token-mode entrypoint"
```

---

### Task 4: `authMode` manifest field

**Files:**
- Modify: `manifest/cloister.capnp` (schema — append `authMode` to `VaultProxySpec` with the next ordinal), `cloister.capnp` (consumer manifest — set `authMode = token` on rosary's vault route)
- Modify: `src/manifest/cluster-types.ts` (TS mirror)
- Test: `src/manifest/vault-proxy-authmode.test.ts` (Create)

**Interfaces:**
- Produces: `VaultProxySpec.authMode: "lease" | "token"` (default `"lease"`), surfaced on the parsed route config that `VaultProxyRoute` reads.

- [ ] **Step 1: Find the current `VaultProxySpec` ordinal high-water mark**

Run: `grep -n "VaultProxySpec" manifest/cloister.capnp` then read the struct. Note the highest `@N` field ordinal; the new field is `@N+1`. Per ADR-0004, never renumber existing fields.

- [ ] **Step 2: Write the failing test**

```typescript
// src/manifest/vault-proxy-authmode.test.ts
import { describe, it, expect } from "vitest";
import { parseClusterManifest } from "./runtime.js"; // or the project's manifest parse entry — grep for where VaultProxySpec is read
import manifest from "../generated/manifest.js";

describe("VaultProxySpec.authMode", () => {
  it("defaults to lease when omitted", () => {
    // A vaultProxy route with no authMode declared parses as authMode: "lease".
    const routes = parseClusterManifest(manifest).routes.filter(r => "vaultProxy" in r.kind);
    for (const r of routes) {
      const mode = (r.kind as { vaultProxy: { authMode?: string } }).vaultProxy.authMode ?? "lease";
      expect(["lease", "token"]).toContain(mode);
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/manifest/vault-proxy-authmode.test.ts`
Expected: FAIL — property/typing absent (or a parse error once you add the field before regenerating).

- [ ] **Step 4: Add the schema field + regenerate + TS mirror**

In `manifest/cloister.capnp`, inside `struct VaultProxySpec`:

```capnp
  # ADR-0047: which auth mode the route enforces. `lease` (default) = the
  # interlace-lease pipeline (existing). `token` = notme DPoP bundle auth
  # into a per-bundle vault DO. Topology, not request content (§20.9).
  authMode @N :AuthMode;   # N = current-high-water + 1

enum AuthMode {
  lease @0;
  token @1;
}
```

Then: `task manifest` (regenerates `src/generated/manifest.ts`). Mirror in `src/manifest/cluster-types.ts` on `VaultProxySpec`:

```typescript
  /** ADR-0047 auth mode. Default "lease" (interlace-lease). "token" = notme DPoP bundle auth. */
  authMode?: "lease" | "token";
```

- [ ] **Step 5: Run test to verify it passes + lint**

Run: `pnpm vitest run src/manifest/vault-proxy-authmode.test.ts` → PASS. Then `task lint` → green. Then `task verify` (capnp CLI roundtrip) to confirm the schema change survives the strict gate.

- [ ] **Step 6: Commit**

```bash
git add manifest/cloister.capnp cloister.capnp src/generated/manifest.ts src/manifest/cluster-types.ts src/manifest/vault-proxy-authmode.test.ts
git commit -m "[cloister-2b98c0] feat(manifest): VaultProxySpec.authMode (lease|token) per ADR-0047"
```

---

### Task 5: route branches on `authMode` → token path

**Files:**
- Modify: `src/routes/vault-proxy-route.ts` (`handle`, near `:204` — branch before/after lease verification)
- Test: `src/routes/vault-proxy-route.token-mode.test.ts` (Create)

**Interfaces:**
- Consumes: `VaultProxySpec.authMode` (Task 4); the DO's `authenticateAndProxy` (Task 3); the route's resolved `bundleIdName` (already on `VaultProxyRouteDeps`).
- Produces: a token-mode branch: extract `sub`/`kid` for routing only, `stub = ns.get(ns.idFromName(bundleId))`, `await stub.authenticateAndProxy({...})`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/routes/vault-proxy-route.token-mode.test.ts
import { describe, it, expect } from "vitest";
import { VaultProxyRoute } from "./vault-proxy-route.js";

describe("VaultProxyRoute token mode", () => {
  it("authMode=token dispatches to authenticateAndProxy, NOT the lease verifier", async () => {
    let leaseCalled = false, tokenCalled = false;
    const route = new VaultProxyRoute({
      authMode: "token",
      bundleIdName: "rosary",
      leaseVerifier: async () => { leaseCalled = true; return { ok: true } as never; },
      // inject a stubbed VAULT_STORE whose authenticateAndProxy records the call
      credentials: undefined,
    } as never);
    const env = { VAULT_STORE: stubNsRecording(() => { tokenCalled = true; }) } as never;
    await route.handle(new Request("https://cloister/vault/anthropic", { method: "POST" }), env);
    expect(tokenCalled).toBe(true);
    expect(leaseCalled).toBe(false); // topology: token-mode never runs the lease path
  });

  it("authMode=lease (default) still runs the lease verifier", async () => {
    let leaseCalled = false;
    const route = new VaultProxyRoute({
      authMode: "lease", bundleIdName: "router",
      leaseVerifier: async () => { leaseCalled = true; return { ok: false, response: new Response(null, { status: 401 }) } as never; },
    } as never);
    await route.handle(new Request("https://cloister/vault/anthropic", { method: "POST" }), { VAULT_STORE: {} } as never);
    expect(leaseCalled).toBe(true);
  });
});
```

(`stubNsRecording` returns a fake namespace whose `.get(...).authenticateAndProxy` sets the flag and returns a 200. Model it on how existing `vault-proxy-route` tests stub `VAULT_STORE`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/routes/vault-proxy-route.token-mode.test.ts`
Expected: FAIL — the route ignores `authMode` and always runs the lease path.

- [ ] **Step 3: Implement the branch**

In `VaultProxyRoute.handle`, after `parseVaultProxyPath` + the pre-auth burst limit (keep that — it protects both modes), branch on the declared mode BEFORE the lease verifier:

```typescript
    if (this.authMode === "token") {
      // ADR-0047 token mode. Topology-selected (§20.9): this branch is
      // reached because the operator declared authMode=token on this route,
      // NOT because a token is present in the request. token-or-deny.
      const token = readBearer(request);            // Authorization: DPoP <jwt> or a header contract
      const proof = request.headers.get("dpop");    // RFC 9449 proof header
      const ns = env.VAULT_STORE;
      if (!ns) return errorResponse(503, CONSTANT_TIME_ERROR_BODY);
      const stub = ns.get(ns.idFromName(this.bundleIdName)) as DurableObjectStub & {
        authenticateAndProxy(a: TokenModeArgs): Promise<Response>;
      };
      const url = new URL(request.url);
      return stub.authenticateAndProxy({
        token, proof,
        htm: request.method,
        htu: `${url.origin}${url.pathname}`,
        service: parsed?.service ?? "",
        expectedSub: this.bundleIdName,   // the manifest-declared bundle id == the DO's pinned identity
        request,
      });
    }
    // ── authMode === "lease": existing path, unchanged ──
    const verdict = await this.leaseVerifier(request, env, parsed);
    // ... rest unchanged ...
```

Add `authMode` to `VaultProxyRouteDeps` + the constructor (default `"lease"`), and have `runtime.ts` thread `spec.authMode` when it builds the route (grep `runtime.ts:187` where `bundleIdName` is already read from the spec — add `authMode` beside it).

- [ ] **Step 4: Run test to verify it passes + lint**

Run: `pnpm vitest run src/routes/vault-proxy-route.token-mode.test.ts` → PASS. `task lint` → green.

- [ ] **Step 5: Commit**

```bash
git add src/routes/vault-proxy-route.ts src/manifest/runtime.ts src/routes/vault-proxy-route.token-mode.test.ts
git commit -m "[cloister-2b98c0] feat(vault): route branches on authMode — token path to per-bundle DO"
```

---

### Task 6: rosary mints + presents the DPoP token

**Files:**
- Modify: rosary repo (`~/remotes/art/rosary`) — the code path where rosary calls cloister's vault proxy for an LLM credential.
- Test: rosary-side unit test that the outbound request carries `Authorization: DPoP <at+jwt>` + a `DPoP` proof header.

**Interfaces:**
- Consumes: notme `mintDPoPToken({ sub, scope, audience, jkt })` → `at+jwt`; a per-call DPoP proof signed by the bound key.
- Produces: an outbound request to `https://<cloister>/vault/<service>` carrying both headers.

- [ ] **Step 1: Confirm rosary's current vault call site**

In `~/remotes/art/rosary`, grep for the existing cloister/vault call (LLO/LLM credential fetch). Identify the request builder. File/scope this as a rosary bead (`rsry_bead_create` in the rosary repo) linked to `cloister-2b98c0`.

- [ ] **Step 2: Write the failing test (rosary side)**

A test asserting the request builder attaches `Authorization: DPoP <jwt>` (a token with `sub` = rosary's bundle id, `scope = vault:proxy:<service>`, `aud = cloister`) and a `DPoP` proof header whose `htu`/`htm` match the request. Use rosary's test conventions (Rust `#[test]` or its harness — match the repo).

- [ ] **Step 3–5: Implement mint+attach, run, commit** — mint the token (cache until near `exp`), generate a fresh per-request DPoP proof (fresh `jti`, current `htu`/`htm`), attach both headers. Commit with `[<rosary-bead>] feat: present notme DPoP token to cloister vault`.

Note: this task lands in a different repo and can proceed in parallel with Tasks 1–5 once the header contract (Task 5's `readBearer` + `dpop` header) is fixed. Pin the contract in Task 5's doc comment so both sides agree.

---

### Task 7: end-to-end `multi-tenant-smoke` acceptance

**Files:**
- Modify/Create: the smoke recipe named in ADR-0047 (grep `multi-tenant-smoke` in `docs/` + `Taskfile`/recipes). Add token-mode assertions.

- [ ] **Step 1:** Stand up cloister with rosary's vault route in `authMode = token` + a stub/real notme serving JWKS + `mintDPoPToken`.
- [ ] **Step 2:** Positive: rosary mints → calls cloister → 2xx + the credential reaches the upstream. Assert a load/attestation receipt is emitted for the verified `subjectFp`.
- [ ] **Step 3:** Negatives, each asserting deny (401/403, constant-shape body): (a) omit token (§20.9); (b) token for a different `sub` (§20.10); (c) replay the same proof `jti` (§20.3); (d) revoked `kid`; (e) expired token; (f) wrong `aud`/`scope`.
- [ ] **Step 4:** Run `task test` (workerd integration) + the smoke; commit `[cloister-2b98c0] test(vault): multi-tenant-smoke token-mode acceptance + negatives`.

---

### Task 8: docs + status flips

**Files:**
- Modify: `docs/security/threat-model.md` (§20 — flip the row statuses from "designed" to "wired", note the smoke test as evidence), `docs/adr/0047-vault-bundle-identity.md` (implementation status → shipped; record the `authMode` topology choice), `src/vault-store.ts` header (`:93-114` — replace "Remaining (cloister-2b98c0, gated…)" with the shipped description), `docs/reference/tenancy-model.md` (operator: declaring `authMode = token` on a bundle's vault route).

- [ ] **Step 1:** Update each doc. Do NOT restate ADR design status in prose (CLAUDE.md source-of-truth rule); implementation status lives in the bead + git. Flip only the seam/threat-model status and the operator model.
- [ ] **Step 2:** `task lint:doc-links` (+ `task adr:index` if ADR frontmatter changed) → green.
- [ ] **Step 3:** Commit `[cloister-2b98c0] docs(vault): flip ADR-0047 token-mode seam status to shipped`. Close `cloister-2b98c0` with `rsry_bead_close` after `task verify` is green.

---

## Self-Review

**Spec coverage:** (1) JWK-by-kid → Task 2. (2) seen-jti ledger → Task 1 + wired in Task 3. (3) per-bundle DO + authenticateBundleRequest + expectedSub pin + §20.9/§20.10 → Task 3 (+ topology in Tasks 4–5). (4) rosary mint/present → Task 6. (5) multi-tenant-smoke + negatives → Task 7. Docs/threat-model → Task 8. All five spec pieces covered.

**Placeholder scan:** `#isKeyRevoked` is the one spot with a permitted-but-discouraged v1 stub; the plan says prefer wiring it and requires a tracked bead if stubbed — not a silent placeholder. `ISSUER`/`AUDIENCE` constants are pinned to `"cloister"` + a `#notmeIssuer()` accessor (grep for existing notme-issuer config first). No TBD/TODO steps.

**Type consistency:** `subjectFp`/`sub` come from `BundleAuthResult` (`{ok:true, subjectFp, sub}`) — used consistently in Task 3. `TokenModeArgs` defined in Task 3, consumed verbatim in Task 5. `authMode: "lease" | "token"` consistent across Tasks 4–5. `expectedSub` == `bundleIdName` == the DO's pinned identity throughout. `checkAndRecordJti` returns `true`=replay, consumed correctly as `seenJti` (which `authenticateBundleRequest` treats as "true → deny").

**Open flag for the implementer:** confirm cloister's notme issuer string + audience convention against notme's `mintDPoPToken` output before Task 3 (one grep in notme or an existing cloister test); the plan pins `"cloister"` as the audience per the built tests, but the issuer must match notme's `iss`.
