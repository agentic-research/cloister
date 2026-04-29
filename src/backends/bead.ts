/**
 * BeadToolBackend — bead_* MCP tools backed by the BEAD_STORE Durable Object.
 *
 * One DO instance per repo (keyed by `args.repo`). The backend forwards the
 * full JSON-RPC inner call to the DO and unwraps the result; DO-level failures
 * surface as JsonRpcInvocationError so the MCP edge maps them to JSON-RPC errors.
 */

import type { Env, JsonRpcRequest, JsonRpcResponse, McpTool } from "../types.js";
import { JsonRpcInvocationError, type ToolBackend } from "../backends.js";

export const BEAD_TOOLS: McpTool[] = [
  {
    name: "bead_create",
    description: "Create a new bead (work item) in the store for the given repo.",
    inputSchema: {
      type: "object",
      properties: {
        repo:        { type: "string", description: "Absolute path to the repo." },
        title:       { type: "string", description: "Short title for the bead." },
        description: { type: "string", description: "Detailed description." },
        priority:    { type: "integer", description: "0=none 1=low 2=medium 3=high 4=urgent.", enum: [0,1,2,3,4] },
        labels:      { type: "array", items: { type: "string" } },
        created_by:  { type: "string", description: "Git username of creator." },
      },
      required: ["repo", "title"],
    },
  },
  {
    name: "bead_update",
    description: "Update fields on an existing bead.",
    inputSchema: {
      type: "object",
      properties: {
        repo:        { type: "string" },
        id:          { type: "string" },
        title:       { type: "string" },
        description: { type: "string" },
        state:       { type: "string", enum: ["open","in_progress","done","blocked"] },
        priority:    { type: "integer", enum: [0,1,2,3,4] },
        labels:      { type: "array", items: { type: "string" } },
        notes:       { type: "string", description: "JSON blob for provenance / extras." },
      },
      required: ["repo", "id"],
    },
  },
  {
    name: "bead_search",
    description: "Full-text search beads by title/description.",
    inputSchema: {
      type: "object",
      properties: {
        repo:  { type: "string" },
        query: { type: "string" },
      },
      required: ["repo", "query"],
    },
  },
  {
    name: "bead_list",
    description: "List beads, optionally filtered by state.",
    inputSchema: {
      type: "object",
      properties: {
        repo:  { type: "string" },
        state: { type: "string", enum: ["open","in_progress","done","blocked"] },
      },
      required: ["repo"],
    },
  },
  {
    name: "bead_close",
    description: "Mark a bead as done.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        id:   { type: "string" },
      },
      required: ["repo", "id"],
    },
  },
  {
    name: "bead_comment",
    description: "Add a comment to a bead.",
    inputSchema: {
      type: "object",
      properties: {
        repo:   { type: "string" },
        id:     { type: "string" },
        body:   { type: "string" },
        author: { type: "string" },
      },
      required: ["repo", "id", "body"],
    },
  },
];

export class BeadToolBackend implements ToolBackend {
  constructor(private readonly toolDefs: McpTool[] = BEAD_TOOLS) {}

  tools(): McpTool[] { return this.toolDefs; }

  handles(toolName: string): boolean { return toolName.startsWith("bead_"); }

  async invoke(toolName: string, args: Record<string, unknown>, env: Env): Promise<unknown> {
    const repo = String(args["repo"] ?? "");
    if (!repo) {
      throw new JsonRpcInvocationError(-32602, "repo is required for bead tools");
    }
    const ns   = env.BEAD_STORE;
    const stub = ns.get(ns.idFromName(repo));
    const innerReq: JsonRpcRequest = {
      jsonrpc: "2.0", method: toolName, params: args, id: 0,
    };
    const res = await stub.fetch(new Request("https://internal/", {
      method:  "POST",
      body:    JSON.stringify(innerReq),
      headers: { "Content-Type": "application/json" },
    }));
    const body = await res.json<JsonRpcResponse>();
    if (body.error) {
      throw new JsonRpcInvocationError(body.error.code, body.error.message);
    }
    return body.result;
  }
}
