/**
 * Helpers for converting spec types from the manifest into runtime types.
 *
 * The manifest carries `inputSchemaJson` as a string (capnp doesn't model
 * JSON Schema natively); the runtime needs `inputSchema` as a parsed
 * `McpTool['inputSchema']`. Convert once at startup.
 */

import type { McpTool } from "../types.js";
import type { McpToolSpec } from "./types.js";

export function toolFromSpec(spec: McpToolSpec): McpTool {
  let inputSchema: McpTool["inputSchema"];
  try {
    inputSchema = JSON.parse(spec.inputSchemaJson) as McpTool["inputSchema"];
  } catch (e) {
    throw new Error(
      `manifest: tool "${spec.name}" has invalid inputSchemaJson: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  return {
    name:        spec.name,
    description: spec.description,
    inputSchema,
  };
}

export function toolsFromSpecs(specs: readonly McpToolSpec[]): McpTool[] {
  return specs.map(toolFromSpec);
}
