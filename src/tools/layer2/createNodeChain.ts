import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { friendlyTdError } from "../../td-client/types.js";
import { errorResult, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { connectNodesViaBridge } from "./connectHelper.js";

const ChainNodeSchema = z.object({
  type: z.string().describe("Operator type, e.g. 'noiseTOP'."),
  name: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});

export const createNodeChainSchema = z.object({
  parent_path: z.string().describe("Parent COMP to create the chain inside."),
  nodes: z.array(ChainNodeSchema).min(1).describe("Ordered list of nodes to create."),
  connect_sequentially: z
    .boolean()
    .default(true)
    .describe("Wire output[0] → input[0] for each consecutive pair."),
});
type CreateNodeChainArgs = z.infer<typeof createNodeChainSchema>;

interface CreatedNode {
  path: string;
  type: string;
  name: string;
}

export async function createNodeChainImpl(
  ctx: ToolContext,
  args: CreateNodeChainArgs,
): Promise<CallToolResult> {
  const created: CreatedNode[] = [];
  const warnings: string[] = [];

  for (const node of args.nodes) {
    if (!ctx.knowledge.operatorExists(node.type)) {
      warnings.push(`Operator type "${node.type}" was not found in the knowledge base.`);
    }
  }

  for (const node of args.nodes) {
    try {
      const ref = await ctx.client.createNode({
        parent_path: args.parent_path,
        type: node.type,
        name: node.name,
        parameters: node.parameters,
      });
      created.push({
        path: ref.path,
        type: ref.type || node.type,
        name: ref.name || node.name || "",
      });
    } catch (err) {
      return errorResult(
        `Stopped after creating ${created.length}/${args.nodes.length} node(s). ` +
          `Failed to create "${node.type}": ${friendlyTdError(err)}. ` +
          `Created so far: ${created.map((c) => c.path).join(", ") || "(none)"}. ` +
          "No nodes were deleted.",
      );
    }
  }

  const connections: Array<{ from: string; to: string; method: string }> = [];
  if (args.connect_sequentially && created.length > 1) {
    for (let i = 0; i < created.length - 1; i++) {
      const from = created[i];
      const to = created[i + 1];
      if (!from || !to) continue;
      try {
        const result = await connectNodesViaBridge(ctx.client, from.path, to.path);
        connections.push({ from: from.path, to: to.path, method: result.method });
      } catch (err) {
        warnings.push(`Failed to connect ${from.path} → ${to.path}: ${friendlyTdError(err)}`);
      }
    }
  }

  return jsonResult(
    `Created ${created.length} node(s) and ${connections.length} connection(s) under ${args.parent_path}.`,
    { created, connections, warnings },
  );
}

export const registerCreateNodeChain: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_node_chain",
    {
      title: "Create node chain",
      description:
        "Create multiple nodes and (optionally) connect them in sequence. Returns all created paths; on failure it stops and reports partial progress without deleting anything.",
      inputSchema: createNodeChainSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createNodeChainImpl(ctx, args),
  );
};
