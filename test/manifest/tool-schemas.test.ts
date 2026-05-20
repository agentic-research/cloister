// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Parity tests for cloister-7ca96c — manifest↔handler schema drift.
//
// What this enforces:
//
// 1. Every MCP tool declared in cloister.capnp has a registered zod
//    schema in src/tool-schemas/. The build-time injector relies on
//    this; without it, a tool would ship with `inputSchemaJson = ""`,
//    which the build script does reject — but failing in a test gives
//    a sharper error.
//
// 2. The reverse: every TS-registered schema corresponds to a declared
//    tool. Catches "I added a zod schema and forgot to wire the tool
//    into cloister.capnp" — otherwise the schema is dead code.
//
// 3. Every generated `inputSchemaJson` is valid JSON and parses to a
//    well-formed JSON Schema object. The build script already does
//    this, but the test pins the contract.
//
// The reason this matters: prior to cloister-7ca96c, inline JSON
// schemas in cloister.capnp could disagree with the TS handler shape
// — nothing checked. An MCP client would call the tool, the handler
// would silently ignore an unknown field, and a typo'd flag would
// produce surprising results. Build-time injection from the TS source
// closes that gap; these tests prevent regression on the contract.

import { describe, expect, it } from "vitest";
import { manifest } from "../../src/generated/manifest.js";
import { schemas as tsSchemas, TOOL_SCHEMAS_RECIPES_ONLY } from "../../src/tool-schemas/index.js";

/** Tool names declared anywhere in the manifest's mcp routes. */
function manifestToolNames(): Set<string> {
  const names = new Set<string>();
  for (const r of manifest.routes) {
    if (!("mcp" in r.kind) || !r.kind.mcp) continue;
    for (const b of r.kind.mcp.backends ?? []) {
      // `b.kind` is a discriminated union; we need the inner.tools list
      // regardless of which variant won.
      const inner =
        ("durableObject" in b.kind && b.kind.durableObject) ||
        ("mcpProxy"      in b.kind && b.kind.mcpProxy)      ||
        ("serviceBinding" in b.kind && b.kind.serviceBinding) ||
        ("udsForward"    in b.kind && b.kind.udsForward)    ||
        ("leylineNet"    in b.kind && b.kind.leylineNet);
      if (!inner) continue;
      // mache uses dynamicTools=true and ships an empty static list —
      // its schemas come from a live tools/list query, not our registry.
      // Skip those.
      const dynamic = "dynamicTools" in inner && inner.dynamicTools;
      if (dynamic) continue;
      for (const t of inner.tools ?? []) names.add(t.name);
    }
  }
  return names;
}

describe("tool-schema parity (cloister-7ca96c)", () => {
  it("every manifest tool has a TS schema registered", () => {
    const manifestTools = manifestToolNames();
    const missing: string[] = [];
    for (const name of manifestTools) {
      if (!(name in tsSchemas)) missing.push(name);
    }
    expect(missing, `manifest declares tool(s) with no zod schema in src/tool-schemas/: ${missing.join(", ")}`).toEqual([]);
  });

  it("every TS schema is wired to a manifest tool (no dead schemas)", () => {
    const manifestTools = manifestToolNames();
    const orphans: string[] = [];
    for (const name of Object.keys(tsSchemas)) {
      // cloister-05334b: schemas that live on for per-recipe use
      // (rosary-dev) but aren't in the root manifest are documented in
      // TOOL_SCHEMAS_RECIPES_ONLY. The exemption is named so future
      // readers see the why — not just a silent allow-list.
      if (TOOL_SCHEMAS_RECIPES_ONLY.has(name)) continue;
      if (!manifestTools.has(name)) orphans.push(name);
    }
    expect(orphans, `TS schema(s) registered with no corresponding manifest entry: ${orphans.join(", ")}`).toEqual([]);
  });

  it("every manifest tool ships a parseable JSON Schema object", () => {
    for (const r of manifest.routes) {
      if (!("mcp" in r.kind) || !r.kind.mcp) continue;
      for (const b of r.kind.mcp.backends ?? []) {
        const inner =
          ("durableObject" in b.kind && b.kind.durableObject) ||
          ("mcpProxy"      in b.kind && b.kind.mcpProxy)      ||
          ("serviceBinding" in b.kind && b.kind.serviceBinding) ||
          ("udsForward"    in b.kind && b.kind.udsForward)    ||
          ("leylineNet"    in b.kind && b.kind.leylineNet);
        if (!inner) continue;
        const dynamic = "dynamicTools" in inner && inner.dynamicTools;
        if (dynamic) continue;
        for (const t of inner.tools ?? []) {
          // Empty string would mean the build-time overlay didn't run —
          // a hard fail since the runtime advertises this on tools/list.
          expect(t.inputSchemaJson, `${t.name}: inputSchemaJson is empty — TS schema overlay didn't run`).not.toBe("");
          const parsed = JSON.parse(t.inputSchemaJson);
          expect(parsed.type, `${t.name}: schema must declare top-level type`).toBe("object");
          expect(parsed.properties, `${t.name}: schema must have properties`).toBeTypeOf("object");
        }
      }
    }
  });
});
