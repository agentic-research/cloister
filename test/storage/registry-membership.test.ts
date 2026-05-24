/// <reference types="@cloudflare/vitest-pool-workers/types" />
//
// Unit tests for the registry_blob_membership storage helpers
// (cloister-7c0a0b, ADR-0029). Borrows a BEAD_STORE DO's real
// SqlStorage as the substrate so we exercise actual workerd SQL
// semantics (PRIMARY KEY, ON CONFLICT, ORDER BY, etc.) — mirrors
// the pattern in test/storage/workerd.test.ts.

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  SCHEMA_REGISTRY_BLOB_MEMBERSHIP,
  hasMembership,
  recordMembership,
  listReposWithMembership,
  type SqlExecutor,
} from "../../src/storage/registry-membership.js";

let counter = 0;
function freshStub() {
  const id = env.BEAD_STORE.idFromName(`membership-test-${counter++}-${Math.random()}`);
  return env.BEAD_STORE.get(id);
}

/**
 * Adapt workerd's `SqlStorage` to our pure-function helper's `SqlExecutor`
 * shape. The helper module is workerd-agnostic; the test gives it the real
 * thing via this thin adapter.
 */
function adapt(sql: SqlStorage): SqlExecutor {
  return {
    exec(query: string, ...bindings: unknown[]) {
      const cursor = sql.exec(query, ...(bindings as SqlStorageValue[]));
      return { toArray: () => cursor.toArray() as Record<string, unknown>[] };
    },
  };
}

async function withFreshSubstrate<T>(
  fn: (sqlExec: SqlExecutor) => T,
): Promise<T> {
  const stub = freshStub();
  return await runInDurableObject(stub, async (_inst, state) => {
    // Run the schema migration first — the helper assumes the table exists.
    for (const stmt of SCHEMA_REGISTRY_BLOB_MEMBERSHIP.split(";")) {
      const trimmed = stmt.trim();
      if (trimmed) state.storage.sql.exec(trimmed);
    }
    return fn(adapt(state.storage.sql));
  });
}

describe("registry-membership helpers", () => {
  const DIGEST = "bfc7feb1382c50dfc6e389aa9b4c6608ca9a18d004b84b6959c624450da52f6a";
  const REPO_A = "tenant-a/cache";
  const REPO_B = "tenant-b/cache";
  const NOW    = 1_748_345_600_000;

  it("recordMembership + hasMembership round-trip (same repo, same digest, same kind)", async () => {
    await withFreshSubstrate((sql) => {
      recordMembership(sql, REPO_A, DIGEST, "blob", NOW);
      expect(hasMembership(sql, REPO_A, DIGEST, "blob")).toBe(true);
    });
  });

  it("hasMembership returns false when no row has been recorded (the fresh-substrate case)", async () => {
    await withFreshSubstrate((sql) => {
      expect(hasMembership(sql, REPO_A, DIGEST, "blob")).toBe(false);
    });
  });

  it("CROSS-TENANT GUARANTEE: recording under REPO_A does NOT grant REPO_B membership", async () => {
    // This is the core ADR-0029 invariant. If this test ever passes by
    // accident (membership leaks across repos), the constant-shape 404
    // story is broken and the build-cache/v1 substrate isn't
    // multi-tenant-safe.
    await withFreshSubstrate((sql) => {
      recordMembership(sql, REPO_A, DIGEST, "blob", NOW);
      expect(hasMembership(sql, REPO_A, DIGEST, "blob")).toBe(true);
      expect(hasMembership(sql, REPO_B, DIGEST, "blob")).toBe(false);
    });
  });

  it("blob and manifest kinds are independent — recording one does NOT grant the other", async () => {
    await withFreshSubstrate((sql) => {
      recordMembership(sql, REPO_A, DIGEST, "blob", NOW);
      expect(hasMembership(sql, REPO_A, DIGEST, "blob")).toBe(true);
      expect(hasMembership(sql, REPO_A, DIGEST, "manifest")).toBe(false);
    });
  });

  it("recordMembership is idempotent on (repo, digest, kind) — no duplicate-row error", async () => {
    await withFreshSubstrate((sql) => {
      recordMembership(sql, REPO_A, DIGEST, "blob", NOW);
      recordMembership(sql, REPO_A, DIGEST, "blob", NOW + 1000);
      recordMembership(sql, REPO_A, DIGEST, "blob", NOW + 2000);
      // Membership still holds, no exception.
      expect(hasMembership(sql, REPO_A, DIGEST, "blob")).toBe(true);
    });
  });

  it("recordMembership UPSERT refreshes recorded_at + recorded_by", async () => {
    await withFreshSubstrate((sql) => {
      recordMembership(sql, REPO_A, DIGEST, "blob", NOW, "peerfp1");
      recordMembership(sql, REPO_A, DIGEST, "blob", NOW + 5000, "peerfp2");
      // Verify the latest values stuck by reading directly.
      const rows = sql.exec(
        "SELECT recorded_at, recorded_by FROM registry_blob_membership WHERE repo = ? AND digest = ? AND kind = ?",
        REPO_A, DIGEST, "blob",
      ).toArray() as { recorded_at: number; recorded_by: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].recorded_at).toBe(NOW + 5000);
      expect(rows[0].recorded_by).toBe("peerfp2");
    });
  });

  it("recordMembership without peerFp stores NULL (dev mode / pre-lease-wiring)", async () => {
    await withFreshSubstrate((sql) => {
      recordMembership(sql, REPO_A, DIGEST, "blob", NOW);
      const rows = sql.exec(
        "SELECT recorded_by FROM registry_blob_membership WHERE repo = ? AND digest = ?",
        REPO_A, DIGEST,
      ).toArray() as { recorded_by: string | null }[];
      expect(rows[0].recorded_by).toBeNull();
    });
  });

  it("listReposWithMembership returns repos sorted lexicographically", async () => {
    await withFreshSubstrate((sql) => {
      recordMembership(sql, "zebra/cache", DIGEST, "blob", NOW);
      recordMembership(sql, "alpha/cache", DIGEST, "blob", NOW);
      recordMembership(sql, "mango/cache", DIGEST, "blob", NOW);
      expect(listReposWithMembership(sql, DIGEST))
        .toEqual(["alpha/cache", "mango/cache", "zebra/cache"]);
    });
  });

  it("listReposWithMembership does not double-count when the same repo holds blob + manifest kinds", async () => {
    await withFreshSubstrate((sql) => {
      recordMembership(sql, REPO_A, DIGEST, "blob", NOW);
      recordMembership(sql, REPO_A, DIGEST, "manifest", NOW);
      expect(listReposWithMembership(sql, DIGEST)).toEqual([REPO_A]);
    });
  });

  it("listReposWithMembership returns empty when nobody has membership", async () => {
    await withFreshSubstrate((sql) => {
      expect(listReposWithMembership(sql, DIGEST)).toEqual([]);
    });
  });
});
