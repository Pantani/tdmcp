import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { friendlyTdError } from "../../td-client/types.js";
import {
  allowsCallerCode,
  callerCodeDenied,
  genericNodeCodeBearingSources,
} from "../codeBearing.js";
import { computeDataflowLayout, type LayoutEdge } from "../layout.js";
import { errorResult, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { connectNodesViaBridge } from "./connectHelper.js";

const ChainNodeSchema = z.object({
  type: z.string().describe("Operator type, e.g. 'noiseTOP'."),
  name: z.string().optional().describe("Name for this node; auto-generated when omitted."),
  parameters: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Initial parameter values for this node, as a { parName: value } map."),
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
  already_existed?: boolean;
}

/** Parenthetical note when some nodes were reused rather than freshly created. */
function reusedNote(created: CreatedNode[]): string {
  const reused = created.filter((c) => c.already_existed).length;
  if (reused === 0) return "";
  return ` (${reused} already existed and ${reused === 1 ? "was" : "were"} reused)`;
}

function callerCodeDenial(ctx: ToolContext, args: CreateNodeChainArgs): CallToolResult | undefined {
  if (allowsCallerCode(ctx)) return undefined;
  for (const node of args.nodes) {
    const codeSources = genericNodeCodeBearingSources(node.type, node.parameters);
    if (codeSources.length > 0) {
      return callerCodeDenied(
        `Node-chain creation with ${codeSources.join(", ")} on ${node.name ?? node.type}`,
      );
    }
  }
  return undefined;
}

function knowledgeWarnings(ctx: ToolContext, args: CreateNodeChainArgs): string[] {
  return args.nodes
    .filter((node) => !ctx.knowledge.operatorExists(node.type))
    .map((node) => `Operator type "${node.type}" was not found in the knowledge base.`);
}

function plannedChainPositions(args: CreateNodeChainArgs): Array<[number, number]> {
  const ids = args.nodes.map((_, index) => `planned-${index}`);
  const edges: LayoutEdge[] = [];
  if (args.connect_sequentially) {
    for (let index = 0; index < ids.length - 1; index++) {
      const from = ids[index];
      const to = ids[index + 1];
      if (from && to) edges.push({ from, to });
    }
  }
  const positions = computeDataflowLayout(ids, edges);
  return ids.map((id) => positions[id] ?? [0, 0]);
}

export async function createNodeChainImpl(
  ctx: ToolContext,
  args: CreateNodeChainArgs,
): Promise<CallToolResult> {
  const denied = callerCodeDenial(ctx, args);
  if (denied) return denied;
  const created: CreatedNode[] = [];
  const warnings = knowledgeWarnings(ctx, args);
  const positions = plannedChainPositions(args);

  for (const [index, node] of args.nodes.entries()) {
    try {
      const [nodeX, nodeY] = positions[index] ?? [0, 0];
      const ref = await ctx.client.createNode({
        parent_path: args.parent_path,
        type: node.type,
        name: node.name,
        parameters: node.parameters,
        placement: "explicit",
        node_x: nodeX,
        node_y: nodeY,
      });
      created.push({
        path: ref.path,
        type: ref.type || node.type,
        name: ref.name || node.name || "",
        already_existed: ref.already_existed,
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
    `Created ${created.length} node(s)${reusedNote(created)} and ${connections.length} connection(s) under ${args.parent_path}.`,
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
